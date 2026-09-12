/**
 * /api/v2/auth —— 登录 / 登出 / 会话管理（S2-6c-2 基线 + S2-6c-3 收口）。
 *
 * 冻结决策：Server-side Session + 不透明 Token（S2-6B ADR）；小程序 Bearer（30d）；
 * 管理端 __Host-session HttpOnly Cookie（12h）。
 *
 * S2-6c-3 变更：
 * - OPEN-1：首登（身份未命中且无冲突）→ 原子创建最小 users + user_identities + session。
 * - OPEN-2：首登不授予任何角色、不建团队、不建 team_members、不授 permission。
 * - OPEN-7：unionid 优先 / openid 兜底；二者指向不同主体 → 拒绝 + 审计 + 不合并。
 * - 指令 §四：TTL 统一取自 config/session-ttl.ts；Cookie Max-Age 与服务端 expires_at 同源。
 * - 指令 §五：Cookie 状态改变请求受 CSRF（Origin + X-JHZY-CSRF）保护（middleware/csrf.ts）。
 * - 指令 §六：session 列表返回派生 device_name，不返回 token_hash，不新增数据库字段。
 * - 指令 §七：新增 logout-all（全端下线，仅本人）；logout 清除 __Host-session。
 *
 * 安全纪律：
 * - 响应绝不包含 session_key / AppSecret / 原始 openid / 原始 unionid / 微信原始错误 / token_hash。
 * - 冲突分支只返回统一安全错误，不泄露任何账户映射信息。
 * - D1 Session 是权威状态：Cookie 存在但会话已撤销/过期 → 401。
 */

import { Hono, type Context } from 'hono';
import type { Env, AppVars } from '../env';
import type { AuthContext } from '../types/auth';
import { buildTenantContext } from '../types/tenant';
import { SessionService } from '../services/session-service';
import { DeliveryIdentityService } from '../services/delivery-identity-service';
import {
  wechatCodeToSession,
  resolveWechatIdentity,
  hasDisabledIdentityBinding,
  getIdentityKeys,
} from '../services/wechat-auth-service';
import { provisionFirstLogin } from '../services/first-login-service';
import {
  createSecurityEventSink,
  recordIdentityConflict,
  detectAndRecordAbnormalLogin,
} from '../services/security-event-service';
import { sessionTtlSeconds, type SessionChannel } from '../config/session-ttl';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from '../utils/session-cookie';
import { deriveDeviceName, normalizeUserAgentForStore } from '../utils/device-name';
import { ok } from '../utils/response';
import { authRequired, invalidParam, notFound, identityConflict } from '../utils/errors';
import { sha256Hex } from '../utils/crypto';

const auth = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** 从请求提取原始 token（Bearer / x-session-token / __Host-session Cookie），供 logout 复用。 */
export function extractRawToken(getHeader: (n: string) => string | null | undefined): string | null {
  const authz = getHeader('authorization') ?? null;
  if (authz != null) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
    if (m) return m[1];
  }
  const direct = getHeader('x-session-token');
  if (direct) return direct;
  return readSessionCookie(getHeader('cookie'));
}

function isLocalEnv(env: Env): boolean {
  return (env.ENVIRONMENT ?? 'local') === 'local';
}

/** 从请求派生 IP 哈希（用于异常登录检测）；无可靠来源 → null（不上报 IP）。 */
async function computeIpHash(c: Context): Promise<string | null> {
  const raw =
    c.req.header('cf-connecting-ip') ??
    (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null);
  if (raw == null || raw.length === 0) return null;
  return sha256Hex(raw);
}

/**
 * POST /api/v2/auth/wechat/login
 * body: { code }
 * query: cookie=1（local-only：按管理端通道签发 __Host-session Cookie，TTL=12h）
 */
auth.post('/wechat/login', async (c) => {
  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw invalidParam('code', 'invalid code');
  }
  const code = typeof body?.code === 'string' ? body.code : '';
  if (code.length === 0) throw invalidParam('code', 'invalid code');

  // ① code2Session（真实/mock 由 Secret 存在性与环境决定；错误统一收敛）
  const wechat = await wechatCodeToSession(c.env, code);

  // ② 通道与 TTL（唯一配置入口）
  const wantsCookie = c.req.query('cookie') === '1' && isLocalEnv(c.env);
  const channel: SessionChannel = wantsCookie ? 'admin' : 'miniprogram';
  const ttl = sessionTtlSeconds(c.env, channel);
  const userAgent = normalizeUserAgentForStore(c.req.header('user-agent'));

  // ③ 身份解析（unionid 优先 → openid → 未命中首登 / 冲突拒绝）
  const keys = await getIdentityKeys(c.env);
  const resolution = await resolveWechatIdentity(c.env.DB, keys, wechat);

  if (resolution.kind === 'conflict') {
    // OPEN-7：禁止合并、禁止择一继续；审计后返回统一安全错误（不含任何身份信息）。
    await recordIdentityConflict(createSecurityEventSink(c.env.DB), {
      unionidUserId: resolution.unionidUserId,
      openidUserId: resolution.openidUserId,
      traceId: c.get('requestId') ?? null,
    });
    throw identityConflict();
  }

  let userId: number;
  let isNewUser = false;
  let token: string;
  let expiresAt: number;

  if (resolution.kind === 'matched') {
    // ④-a 用户状态校验（停用/不存在 → 401 统一，不泄露原因）
    const user = await c.env.DB.prepare(
      `SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(resolution.userId)
      .first<{ id: number; status: number }>();
    if (!user || user.status !== 1) throw authRequired();

    // ④-a-1 异常登录检测（S2-6c-4）：在创建新会话【前】比对历史，新设备/IP → 记 abnormal_login（不阻断）。
    const ipHash = await computeIpHash(c);
    await detectAndRecordAbnormalLogin(createSecurityEventSink(c.env.DB), c.env.DB, {
      userId: user.id,
      ipHash,
      userAgent,
      traceId: c.get('requestId') ?? null,
    });

    const created = await new SessionService(c.env.DB).create(user.id, { userAgent, ipHash, ttlSeconds: ttl });
    userId = user.id;
    token = created.token;
    expiresAt = created.expiresAt;
  } else if (await hasDisabledIdentityBinding(c.env.DB, keys, wechat)) {
    // ④-b-0 该标识存在【停用身份行】（active_marker=1 + status=2），仍占用唯一槽位，
    //        无法绑定到任何新主体 → 不可登录。与"身份不存在"同构返回 401，
    //        不泄露该 openid/unionid 的历史绑定状态。
    throw authRequired();
  } else {
    // ④-b 首登建档（OPEN-1）：users + user_identities + session 单 batch 原子写入。
    //      并发重复建档会撞 UNIQUE(identity_type, identity_hash, active_marker) 而整批回滚，
    //      此处重新解析一次，命中既有用户即按正常登录处理（绝不留下半成品用户）。
    try {
      const provisioned = await provisionFirstLogin({
        db: c.env.DB,
        identityKey: keys.primary,
        openid: wechat.openid,
        unionid: wechat.unionid,
        userAgent,
        ttlSeconds: ttl,
      });
      userId = provisioned.userId;
      token = provisioned.token;
      expiresAt = provisioned.expiresAt;
      isNewUser = true;
    } catch {
      const retry = await resolveWechatIdentity(c.env.DB, keys, wechat);
      if (retry.kind !== 'matched') throw authRequired();
      const user = await c.env.DB.prepare(
        `SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(retry.userId)
        .first<{ id: number; status: number }>();
      if (!user || user.status !== 1) throw authRequired();
      const created = await new SessionService(c.env.DB).create(user.id, { userAgent, ttlSeconds: ttl });
      userId = user.id;
      token = created.token;
      expiresAt = created.expiresAt;
    }
  }

  // ④-c N0-C：登录交换期 raw openid 仍存在 → 尽力幂等 upsert 微信投递身份（最小 hook）。
  //   绝不阻断登录：失败静默（不打印 openid / Secret）；legacy 老用户下次 refresh 补齐。
  //   仅建立投递身份基础，不发送任何微信消息、不改变既有认证语义。
  try {
    const loginAuth: AuthContext = { authenticated: true, userId, role: null, teamId: null, roles: [] };
    await new DeliveryIdentityService({
      env: c.env,
      auth: loginAuth,
      tenant: buildTenantContext(loginAuth),
    }).upsertFromWechatLogin({ userId, openid: wechat.openid });
  } catch {
    // best-effort：投递身份建立失败不影响认证（readiness 保持 false）。
  }

  // ⑤ 回读用户（首登建档后统一走一次查询，保证响应字段一致）
  const userRow = await c.env.DB.prepare(
    `SELECT public_id, nickname, cert_level FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ public_id: string; nickname: string | null; cert_level: number }>();

  // ⑥ Cookie 通道（管理端；属性冻结：HttpOnly/Secure/Path=/SameSite=Lax/无 Domain；Max-Age 与服务端同源）
  if (wantsCookie) {
    c.header('Set-Cookie', buildSessionCookie(token, expiresAt - Math.floor(Date.now() / 1000)));
  }

  // 绝不返回：session_key / openid / unionid / token_hash / 微信原始错误。
  return ok(c, {
    status: 'OK',
    token,
    expires_at: expiresAt,
    channel,
    is_new_user: isNewUser,
    user: {
      public_id: userRow?.public_id ?? null,
      nickname: userRow?.nickname ?? null,
      cert_level: userRow?.cert_level ?? null,
    },
  });
});

/**
 * POST /api/v2/auth/logout
 * 幂等：已撤销/重复 logout 一律安全返回 OK；无 token → 401。不影响其他设备 Session。
 * 指令 §七：无论当前走的是 Bearer 还是 Cookie 通道，都清除 __Host-session（同属性、Max-Age=0）。
 */
auth.post('/logout', async (c) => {
  const token = extractRawToken((n) => c.req.header(n));
  if (token == null) throw authRequired();

  const svc = new SessionService(c.env.DB);
  await svc.revokeByToken(token); // 幂等：已撤销时 changes=0，同样返回 OK
  c.header('Set-Cookie', clearSessionCookie());
  return ok(c, { status: 'OK' });
});

/**
 * POST /api/v2/auth/logout-all —— 全端下线（指令 §七）。
 * 只能由当前用户对自己执行；不涉及管理员踢人。返回受影响会话数。
 */
auth.post('/logout-all', async (c) => {
  const authCtx = c.get('auth');
  if (!authCtx.authenticated || authCtx.userId == null) throw authRequired();

  const revoked = await new SessionService(c.env.DB).revokeAllForUser(authCtx.userId);
  c.header('Set-Cookie', clearSessionCookie());
  return ok(c, { status: 'OK', revoked });
});

/**
 * GET /api/v2/auth/sessions —— 当前用户的会话（设备）列表。
 * 仅返回安全摘要：不含 token_hash；device_name 为展示层派生（不新增数据库字段）。
 * SCHEMA GAP（不阻塞）：无 last_seen_at 列，以 updated_at 近似（S2-6b 已记录）。
 */
auth.get('/sessions', async (c) => {
  const authCtx = c.get('auth');
  if (!authCtx.authenticated || authCtx.userId == null) throw authRequired();

  const rows = await c.env.DB.prepare(
    `SELECT id, public_id, status, created_at, updated_at, expires_at, user_agent
       FROM sessions
      WHERE user_id = ? AND status = 1
      ORDER BY created_at DESC`,
  )
    .bind(authCtx.userId)
    .all<{
      id: number;
      public_id: string;
      status: number;
      created_at: number;
      updated_at: number | null;
      expires_at: number;
      user_agent: string | null;
    }>();

  const items = (rows.results ?? []).map((r) => ({
    id: r.id,
    public_id: r.public_id,
    status: r.status,
    created_at: r.created_at,
    last_seen_at: r.updated_at ?? r.created_at, // GAP 近似
    expires_at: r.expires_at,
    device_name: deriveDeviceName(r.user_agent), // 派生展示值；异常 UA → 'Unknown Device'
    user_agent_summary: (r.user_agent ?? '').slice(0, 64),
  }));
  return ok(c, { items });
});

/**
 * POST /api/v2/auth/sessions/:id/revoke —— 撤销自己的单个会话（单设备下线）。
 * 仅限当前认证用户拥有的 Session；越权/不存在一律 404。
 */
auth.post('/sessions/:id/revoke', async (c) => {
  const authCtx = c.get('auth');
  if (!authCtx.authenticated || authCtx.userId == null) throw authRequired();

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw invalidParam('id', 'must be a positive integer');

  const res = await c.env.DB.prepare(
    `UPDATE sessions SET status = 2, updated_at = ? WHERE id = ? AND user_id = ? AND status = 1`,
  )
    .bind(Math.floor(Date.now() / 1000), id, authCtx.userId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) throw notFound('Session');
  return ok(c, { status: 'OK' });
});

/**
 * POST /api/v2/auth/session/rotate —— Session 轮换（S2-6c-4）。
 * 校验当前有效 token → 签发新 token 并使旧 token 立即失效（防长期固定 token 滥用）。
 * 仅本人（auth 中间件已确认认证主体）；无 token → 401；无效/过期/撤销 → 401。
 * 管理端 Cookie 通道：传 ?cookie=1（local-only）则同时重设 __Host-session（Max-Age 与新 expiry 一致）。
 */
auth.post('/session/rotate', async (c) => {
  const authCtx = c.get('auth');
  if (!authCtx.authenticated || authCtx.userId == null) throw authRequired();

  const token = extractRawToken((n) => c.req.header(n));
  if (token == null) throw authRequired();

  const channel: SessionChannel = c.req.query('channel') === 'admin' ? 'admin' : 'miniprogram';
  const ttl = sessionTtlSeconds(c.env, channel);
  const rotated = await new SessionService(c.env.DB).rotate(token, { ttlSeconds: ttl });
  if (rotated == null) throw authRequired();

  const wantsCookie = c.req.query('cookie') === '1' && isLocalEnv(c.env);
  if (wantsCookie) {
    c.header('Set-Cookie', buildSessionCookie(rotated.token, rotated.expiresAt - Math.floor(Date.now() / 1000)));
  }
  return ok(c, { status: 'OK', token: rotated.token, expires_at: rotated.expiresAt, channel });
});

/** 导出 Cookie 名常量，供测试 / 文档引用（避免魔法字符串散落）。 */
export { SESSION_COOKIE_NAME };

export default auth;
