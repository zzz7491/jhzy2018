/**
 * Session Service（S2-6c-1）—— D1 服务端 Session 核心（S2-6B ADR 裁决的 RECOMMENDED 实现）。
 *
 * 冻结决策（不再讨论）：
 * - D1 Server-side Session + 不透明 Token；JWT 排除。
 * - 直接使用现有 sessions 表（不新增认证表、不改 Schema）。
 * - D1 为权威：角色变化 / 撤销 / 过期在【下一次请求】立即生效（per-request 查库）。
 * - 明文 token 只在客户端持有；D1 只存 SHA-256 摘要（token_hash UNIQUE）。
 * - 不引入 KV / DO 保存认证状态。
 * - 团队上下文通过请求头（X-Team-Id）选择，不把 team_id 固化为用户属性（多团队多角色行）。
 *
 * 安全纪律：
 * - 本服务【永不】记录/返回/输出原始 token（含异常路径）。
 * - 撤销/过期/停用用户一律收敛为 resolve()=null → 上层 401，不泄露具体原因给客户端。
 *
 * SCHEMA GAP（S2-6b 已记录，本阶段不修改 Schema，不阻塞）：
 * - GAP-1 无 rotated_from（本实现采用登录新建 + 撤销置 status=2，不需要轮换链）。
 * - sessions 无独立 revoked_at 列 → 语义由 status=2 承载（S2-3 原设计）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext, RoleCode } from '../types/auth';
import { generateSessionToken, generateUlid, sha256Hex } from '../utils/crypto';
import { isUlid } from '../utils/validation';
import { SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS } from '../config/session-ttl';

/**
 * TTL 唯一来源 = src/config/session-ttl.ts（S2-6c-3 指令 §四：禁止散落硬编码）。
 * 本文件只在调用方未显式传 ttlSeconds 时，用【小程序默认 TTL】兜底；
 * 正常路径由 middleware / route 按通道显式传入。
 */

/** 当前团队上下文请求头（多团队多角色时的选择机制，AUTH-IDENTITY-MODEL §5.7/5.8）。 */
export const TEAM_CONTEXT_HEADER = 'x-team-id';

/** user_roles 行（来自 D1 实时查询，绝不缓存进 token）。 */
export interface UserRoleRow {
  role: RoleCode;
  scopeTeamId: number | null;
}

export interface SessionUserInfo {
  userId: number;
  status: number;
}

export interface ResolvedSession {
  auth: AuthContext;
  roles: UserRoleRow[];
  sessionId: number;
  expiresAt: number;
}

export interface CreateSessionResult {
  token: string;
  sessionId: number;
  expiresAt: number;
}

/** 冻结角色优先级（同上下文多角色时取最高；仅用于粗门禁展示，精确判定由 service 层 can() 承担）。 */
const ROLE_PRECEDENCE: RoleCode[] = [
  'platform_super_admin',
  'platform_operator',
  'team_owner',
  'team_admin',
  'team_auditor',
  'volunteer',
];

export class SessionService {
  constructor(private readonly db: D1Database) {}

  /**
   * 创建 Session：生成不透明 token → SHA-256 → sessions 插入。
   * 返回值含明文 token（仅在登录响应中出现一次）；本函数不打印任何日志。
   */
  async create(
    userId: number,
    opts: { userAgent?: string | null; ipHash?: string | null; ttlSeconds?: number } = {},
  ): Promise<CreateSessionResult> {
    const token = generateSessionToken();
    const tokenHash = await sha256Hex(token);
    const ttl = opts.ttlSeconds ?? SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;

    const res = await this.db
      .prepare(
        `INSERT INTO sessions (public_id, user_id, token_hash, ip_hash, user_agent, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(generateUlid(), userId, tokenHash, opts.ipHash ?? null, opts.userAgent ?? null, expiresAt)
      .run();

    return { token, sessionId: Number(res.meta?.last_row_id ?? 0), expiresAt };
  }

  /**
   * 解析 Session（每请求调用）：
   * 1) token → SHA-256 → 唯一索引定位；
   * 2) status=1 且未过期；
   * 3) 用户存在且 status=1（未停用）；
   * 4) 实时加载 user_roles（角色/撤销变更即时生效）；
   * 5) 团队上下文：X-Team-Id ∈ 用户团队作用域集合 → 团队角色；否则平台角色；否则无角色。
   * 任一步失败 → null（上层统一 401，不泄露原因）。滑动续期：剩余 < 1/2 TTL 时写一次。
   */
  async resolve(
    token: string,
    opts: { teamHeader?: string | null; ttlSeconds?: number } = {},
  ): Promise<ResolvedSession | null> {
    if (typeof token !== 'string' || token.length < 8 || token.length > 128) return null;
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);

    // 1) 定位会话
    const session = await this.db
      .prepare(`SELECT id, user_id, expires_at, status FROM sessions WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ id: number; user_id: number; expires_at: number; status: number }>();
    if (!session) return null;

    // 2) 撤销 / 过期判断（D1 权威，即时生效）
    if (session.status !== 1) return null;
    if (session.expires_at <= now) return null;

    // 3) 用户存在且未停用
    const user = await this.db
      .prepare(`SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL`)
      .bind(session.user_id)
      .first<{ id: number; status: number }>();
    if (!user || user.status !== 1) return null;

    // 4) 实时角色集合（role/permission 变更下一次请求生效）
    const roleRows = await this.db
      .prepare(
        `SELECT r.code AS role, ur.scope_team_id AS scopeTeamId
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ? AND r.status = 1
            AND (ur.expires_at IS NULL OR ur.expires_at > ?)`,
      )
      .bind(user.id, now)
      .all<{ role: RoleCode; scopeTeamId: number | null }>();
    const roles: UserRoleRow[] = (roleRows.results ?? []).map((r) => ({
      role: r.role,
      scopeTeamId: r.scopeTeamId == null ? null : Number(r.scopeTeamId),
    }));

    // 5) 团队上下文选择（请求头 ∈ 作用域集合才生效；绝不从 Session 本身绕过 Tenant Scope）
    //    P30 FIX: 接受 public_id ULID（前端 activeTeamPublicId）+ 向后兼容 numeric teams.id。
    //    ULID 路径：查 teams 表解析成 numeric id；不自动授权，后续 user_roles 校验不变。
    let teamHeader: number | null = null;
    if (opts.teamHeader != null && opts.teamHeader !== '') {
      if (isUlid(opts.teamHeader)) {
        const teamRow = await this.db
          .prepare(`SELECT id FROM teams WHERE public_id = ? AND deleted_at IS NULL`)
          .bind(opts.teamHeader)
          .first<{ id: number }>();
        teamHeader = teamRow?.id ?? null;
      } else {
        const n = Number(opts.teamHeader);
        teamHeader = Number.isInteger(n) && n > 0 ? n : null;
      }
    }

    let auth: AuthContext;
    if (teamHeader != null) {
      const teamRoles = roles.filter((r) => r.scopeTeamId === teamHeader).map((r) => r.role);
      if (teamRoles.length > 0) {
        auth = {
          authenticated: true,
          userId: user.id,
          role: highest(teamRoles),
          teamId: teamHeader,
          roles,
        };
      } else {
        // 请求的团队不在用户作用域内：保持已认证身份，但不给任何团队上下文（防越权）。
        auth = { authenticated: true, userId: user.id, role: null, teamId: null, roles };
      }
    } else {
      const platformRoles = roles.filter((r) => r.scopeTeamId == null).map((r) => r.role);
      auth = {
        authenticated: true,
        userId: user.id,
        role: platformRoles.length > 0 ? highest(platformRoles) : null,
        teamId: null,
        roles,
      };
    }

    // 滑动续期：剩余 < 1/2 TTL 时按【该通道 TTL】续期一次（写量控制；失败不阻塞请求）。
    const ttl = opts.ttlSeconds ?? SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS;
    const remaining = session.expires_at - now;
    if (remaining < ttl / 2) {
      const nextExpiry = now + ttl;
      await this.db
        .prepare(`UPDATE sessions SET expires_at = ?, updated_at = ? WHERE id = ? AND status = 1`)
        .bind(nextExpiry, now, session.id)
        .run();
    }

    return { auth, roles, sessionId: session.id, expiresAt: session.expires_at };
  }

  /** 撤销单个会话（按 token）；返回是否撤销了有效会话。 */
  async revokeByToken(token: string): Promise<boolean> {
    const tokenHash = await sha256Hex(token);
    const res = await this.db
      .prepare(`UPDATE sessions SET status = 2, updated_at = ? WHERE token_hash = ? AND status = 1`)
      .bind(Math.floor(Date.now() / 1000), tokenHash)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** 撤销某用户全部会话（全端下线 / 封禁联动）。 */
  async revokeAllForUser(userId: number): Promise<number> {
    const res = await this.db
      .prepare(`UPDATE sessions SET status = 2, updated_at = ? WHERE user_id = ? AND status = 1`)
      .bind(Math.floor(Date.now() / 1000), userId)
      .run();
    return res.meta?.changes ?? 0;
  }

  /**
   * Session 轮换（S2-6c-4）：校验当前有效 token，签发新 token 并使旧 token 立即失效。
   * 返回新明文 token（仅响应出现一次）；无效/过期/撤销 → null（上层 401）。
   * 目的：避免长期固定 token 被持续滥用；旧 token_hash 被新值覆盖，无法再用于认证。
   * 纪律：本函数不打印任何日志，不返回旧 token。
   */
  async rotate(
    token: string,
    opts: { ttlSeconds?: number } = {},
  ): Promise<{ token: string; expiresAt: number } | null> {
    if (typeof token !== 'string' || token.length < 8 || token.length > 128) return null;
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);

    const session = await this.db
      .prepare(`SELECT id, status, expires_at FROM sessions WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ id: number; status: number; expires_at: number }>();
    if (!session || session.status !== 1 || session.expires_at <= now) return null;

    const newToken = generateSessionToken();
    const newHash = await sha256Hex(newToken);
    const ttl = opts.ttlSeconds ?? SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS;
    const expiresAt = now + ttl;
    await this.db
      .prepare(`UPDATE sessions SET token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status = 1`)
      .bind(newHash, expiresAt, now, session.id)
      .run();
    return { token: newToken, expiresAt };
  }
}

/**
 * 构造 sessions 插入【计划】（不执行），供首登在【同一 D1 batch】内与
 * users / user_identities 原子落库（S2-6c-3 指令 §二）。
 *
 * 为什么需要它：D1 batch 内无法跨语句读取 last_insert_rowid()，
 * 因此用 (SELECT id FROM users WHERE public_id = ?) 在同一事务中引用刚插入的用户。
 *
 * 纪律：返回的 token 明文只在调用方构造登录响应时使用一次；本函数不打印任何日志。
 */
export interface SessionInsertPlan {
  sql: string;
  binds: unknown[];
  token: string;
  sessionPublicId: string;
  expiresAt: number;
  ttlSeconds: number;
}

export async function planSessionInsert(opts: {
  /** batch 内引用新用户（public_id 子查询）。 */
  usersPublicId: string;
  userAgent?: string | null;
  ipHash?: string | null;
  ttlSeconds?: number;
}): Promise<SessionInsertPlan> {
  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const ttl = opts.ttlSeconds ?? SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const sessionPublicId = generateUlid();

  return {
    sql: `INSERT INTO sessions (public_id, user_id, token_hash, ip_hash, user_agent, expires_at, status)
          VALUES (?, (SELECT id FROM users WHERE public_id = ?), ?, ?, ?, ?, 1)`,
    binds: [
      sessionPublicId,
      opts.usersPublicId,
      tokenHash,
      opts.ipHash ?? null,
      opts.userAgent ?? null,
      expiresAt,
    ],
    token,
    sessionPublicId,
    expiresAt,
    ttlSeconds: ttl,
  };
}

function highest(roles: RoleCode[]): RoleCode {
  let best = roles[0];
  for (const r of roles) {
    if (ROLE_PRECEDENCE.indexOf(r) < ROLE_PRECEDENCE.indexOf(best)) best = r;
  }
  return best;
}
