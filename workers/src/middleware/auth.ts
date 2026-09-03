import { createMiddleware } from 'hono/factory';
import type { AuthContext, RoleCode, UserRoleBinding } from '../types/auth';
import { UNAUTHENTICATED, ROLE_CODES } from '../types/auth';
import type { AppVars, Env } from '../env';
import { SessionService, TEAM_CONTEXT_HEADER } from '../services/session-service';
import { sessionTtlSeconds, type SessionChannel } from '../config/session-ttl';
import { readSessionCookie } from '../utils/session-cookie';

/**
 * 鉴权 middleware（S2-6c-1：真实 D1 Session lookup 替换 S2-5 mock 为主通道）。
 *
 * 冻结决策（S2-6B ADR / 用户授权，不再讨论）：
 * - 认证 = D1 Server-side Session + 不透明 Token（Bearer / x-session-token）；JWT 排除。
 * - extractAuth 是 S2-5 预留的唯一替换点：AuthContext 接口不变，仅来源替换。
 * - 角色/团队上下文每请求由 user_roles 实时推导 + X-Team-Id 选择，Session 不携带权限。
 * - 仅 local/TEST 环境保留 x-test-* mock 注入通道（S2-5 角色矩阵回归依赖）；
 *   生产通道关闭。Session 通道存在时 mock 通道一律忽略（Session 优先）。
 * - S2-6c-2：Bearer / x-session-token / __Host-session Cookie 三通道统一解析到同一
 *   SessionService（单一认证逻辑）；微信登录端点见 routes/auth.ts。
 */

const FROZEN_ROLES: ReadonlySet<string> = new Set<string>(ROLE_CODES);

/** 平台级角色集合（scope = platform，绑定 scopeTeamId 恒为 null）。 */
const PLATFORM_ROLES: ReadonlySet<string> = new Set(['platform_super_admin', 'platform_operator']);

function isLocal(c: { env: Env }): boolean {
  return (c.env.ENVIRONMENT ?? 'local') === 'local';
}

/**
 * 由 local mock 注入头构造 UserRoleBinding 列表（S2-6f）。
 * - 平台角色 → scopeTeamId = null（平台级，不依赖 active team）。
 * - 团队角色 → scopeTeamId = 注入的 x-test-team；未注入团队时用哨兵 -1（永不与任何
 *   真实 teamId 匹配，确保"无团队的团队角色"不越权生效，与真实 user_roles 语义一致）。
 */
function mockRoleBindings(role: RoleCode, team: number | null): UserRoleBinding[] {
  if (PLATFORM_ROLES.has(role)) return [{ role, scopeTeamId: null }];
  return [{ role, scopeTeamId: team != null ? team : -1 }];
}

/**
 * 提取请求中的 Session Token：Authorization: Bearer → x-session-token → __Host-session Cookie。
 * 同时返回【通道】，用于选取该通道的 Session TTL（S2-6c-3：小程序 30d / 管理端 12h）。
 */
function parseSessionToken(getHeader: (name: string) => string | null | undefined): {
  token: string | null;
  channel: SessionChannel;
} {
  const authz = getHeader('authorization') ?? null;
  if (authz != null) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
    if (m) return { token: m[1], channel: 'miniprogram' };
  }
  const direct = getHeader('x-session-token');
  if (direct != null) return { token: direct, channel: 'miniprogram' };
  // Cookie 通道（管理端 __Host-session；与 Bearer 解析到同一 SessionService，单一认证逻辑）。
  const token = readSessionCookie(getHeader('cookie'));
  if (token != null) return { token, channel: 'admin' };
  return { token: null, channel: 'miniprogram' };
}

/** 从请求中提取 AuthContext：真实 Session（主）→ local mock（仅回归通道）→ 未认证。 */
export async function extractAuth(c: {
  req: { header: (n: string) => string | null | undefined };
  env: Env;
}): Promise<AuthContext> {
  // ===== 主通道：真实 D1 Session（任何环境均可，D1 为权威）=====
  const { token, channel } = parseSessionToken((n) => c.req.header(n));
  if (token != null) {
    const svc = new SessionService(c.env.DB);
    const resolved = await svc.resolve(token, {
      teamHeader: c.req.header(TEAM_CONTEXT_HEADER),
      // TTL 按通道取值（唯一入口 config/session-ttl.ts），用于滑动续期阈值与续期长度。
      ttlSeconds: sessionTtlSeconds(c.env, channel),
    });
    // resolve() 对 不存在/撤销/过期/停用 一律返回 null → 未认证（401），不泄露原因。
    return resolved ? { ...resolved.auth, roles: resolved.roles } : { ...UNAUTHENTICATED };
  }

  // ===== 回归通道：local 测试头注入 mock 身份（TEST-ONLY，生产关闭；S2-5 58/58 依赖）=====
  if (isLocal(c)) {
    const ctx: AuthContext = { ...UNAUTHENTICATED };
    const role = c.req.header('x-test-role');
    // S2-5 加固：仅接受 6 个冻结角色 code；未知角色一律忽略（保持未认证）。
    if (role != null && FROZEN_ROLES.has(role)) {
      ctx.authenticated = true;
      ctx.role = role as RoleCode;
      const u = Number(c.req.header('x-test-user'));
      const t = Number(c.req.header('x-test-team'));
      ctx.userId = Number.isFinite(u) && u > 0 ? u : null;
      ctx.teamId = Number.isFinite(t) && t > 0 ? t : null;
      // S2-6f：mock 通道同样填充 roles 列表，使 PermissionProvider 走与真实 Session 完全一致的解析路径。
      ctx.roles = mockRoleBindings(ctx.role, ctx.teamId);
    }
    return ctx;
  }

  return { ...UNAUTHENTICATED };
}

/** 全局中间件：为所有请求注入 AuthContext（Session 优先，mock 兜底，local 门禁）。 */
export const authContextMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVars }>(
  async (c, next) => {
    c.set('auth', await extractAuth(c));
    await next();
  },
);
