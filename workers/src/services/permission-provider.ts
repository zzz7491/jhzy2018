/**
 * DB-backed Permission Provider（S2-6f：Runtime Authorization Core）。
 *
 * 职责（用户 §三/§四/§八/§十/§十一/§十二）：
 * - 唯一运行时权威 = D1 role_permissions（经 user_roles → roles → role_permissions → permissions 解析）。
 * - 禁止：硬编码六角色权限 / runtime 读 JSON / wildcard / 写死 super_admin => true /
 *   根据角色名写巨大 if/else / Session token 固化 permission list。
 * - 解析规则（§五/§六）：
 *    有效权限 = PlatformPermissions(user)  UNION  TeamPermissions(user, activeTeam)
 *    - platform 绑定（scopeTeamId == null）：恒生效，不依赖 active team。
 *    - team 绑定（scopeTeamId != null）：仅当其 scopeTeamId === 当前 active teamId 时生效。
 *    - 无合法 active team 时，team 绑定一律不生效（§七：middleware 拒绝）。
 * - 性能：单次参数化 JOIN 查询（`prepare().bind()`），禁字符串拼 SQL；禁随 83 条增长为 83 次查询。
 * - 缓存纪律：仅 request-local 缓存（Provider 实例每请求新建，见 rbac.ts）；
 *   角色变化下一请求立即生效，无跨请求长期缓存（§十二/§十三）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { Env } from '../env';

/** 权限解析接口（便于未来替换为 KV/DO 缓存实现，本阶段仅 D1 实现）。 */
export interface PermissionProvider {
  /** 当前请求的有效 permission code 集合（Platform ∪ Team(active)）。 */
  getPermissions(auth: AuthContext): Promise<Set<string>>;
  /** code 是否在权限目录中（存在性，用于区分"配置错误"与"无权限"）。 */
  isKnownPermission(code: string): Promise<boolean>;
  /** 当前用户是否被授权该 code（未知 code 直接返回 false，存在性由调用方另行判定）。 */
  hasPermission(auth: AuthContext, code: string): Promise<boolean>;
  /**
   * 解析"用户角色持有"的权限集合（PLATFORM ∪ TEAM(任意团队)，不按 active team 过滤）。
   * 仅用于读-only 能力投影（如前端入口/作用域判定），不影响授权边界：
   * 真实端点仍由 requirePermission + active team 强制。
   * 与 getPermissions 的区别：本方法不剔除 scopeTeamId != activeTeam 的团队绑定，
   * 因此可区分"持有团队权限但当前未选团队"（TEAM_CONTEXT_MISSING）与"无团队权限"（NO_PERMISSION）。
   */
  getPermissionsAcrossScopes(auth: AuthContext): Promise<Set<string>>;
}

export class D1PermissionProvider implements PermissionProvider {
  // request-local 缓存（实例由 rbac.ts 每请求新建，故天然不跨请求泄漏）。
  private permCache: Set<string> | null = null;
  private catalogCache: Set<string> | null = null;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly db: D1Database,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? ((m: string) => console.error(m));
  }

  /**
   * 计算"在本请求生效"的角色 code 列表：
   * - platform 绑定（scopeTeamId == null）恒生效；
   * - team 绑定仅当 scopeTeamId === 当前 active teamId 时生效。
   * 不读取任何硬编码角色→权限映射，完全依赖 D1。
   */
  private effectiveRoleCodes(auth: AuthContext): string[] {
    return auth.roles
      .filter((b) => b.scopeTeamId == null || b.scopeTeamId === auth.teamId)
      .map((b) => b.role);
  }

  async isKnownPermission(code: string): Promise<boolean> {
    if (this.catalogCache == null) {
      const rows = await this.db.prepare('SELECT code FROM permissions').all<{ code: string }>();
      this.catalogCache = new Set((rows.results ?? []).map((r) => r.code));
    }
    return this.catalogCache.has(code);
  }

  async getPermissions(auth: AuthContext): Promise<Set<string>> {
    if (this.permCache != null) return this.permCache;
    const set = new Set<string>();
    const codes = this.effectiveRoleCodes(auth);
    if (codes.length > 0) {
      const placeholders = codes.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT DISTINCT p.code
             FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
             JOIN permissions p ON p.id = rp.permission_id
            WHERE r.code IN (${placeholders})`,
        )
        .bind(...codes)
        .all<{ code: string }>();
      for (const r of rows.results ?? []) set.add(r.code);
    }
    this.permCache = set;
    return set;
  }

  async hasPermission(auth: AuthContext, code: string): Promise<boolean> {
    if (!(await this.isKnownPermission(code))) return false;
    const perms = await this.getPermissions(auth);
    return perms.has(code);
  }

  async getPermissionsAcrossScopes(auth: AuthContext): Promise<Set<string>> {
    const set = new Set<string>();
    // 关键差异：不调用 effectiveRoleCodes（其按 active team 过滤团队绑定），
    // 而是取 auth.roles 的全部 role code（PLATFORM + 任意 TEAM 绑定，忽略 scopeTeamId）。
    const codes = auth.roles.map((b) => b.role);
    if (codes.length > 0) {
      const placeholders = codes.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT DISTINCT p.code
             FROM roles r
             JOIN role_permissions rp ON rp.role_id = r.id
             JOIN permissions p ON p.id = rp.permission_id
            WHERE r.code IN (${placeholders})`,
        )
        .bind(...codes)
        .all<{ code: string }>();
      for (const r of rows.results ?? []) set.add(r.code);
    }
    return set;
  }
}

/** 授权裁决结果（§九：区分 403 FORBIDDEN 与 500 配置错误）。 */
export type AuthorizeDecision =
  | 'allow'
  | 'unauthenticated'
  | 'unknown_permission' // code 不在权限目录 → 服务端配置错误（稳定 500）
  | 'forbidden'; // code 存在但当前用户/上下文未持有（403）

/**
 * 统一授权裁决（DB-backed，§三/§九）。
 * - 未认证 → unauthenticated（401）。
 * - code 不在目录 → unknown_permission（500，含服务端日志，不向客户端泄露 code 细节）。
 * - code 存在但无授权 → forbidden（403）。
 * - 否则 allow。
 * 本函数不返回任何 role binding / SQL / 内部 id；泄露控制由 error-handler 统一负责。
 */
export async function authorizePermissionDecision(
  env: Env,
  auth: AuthContext,
  code: string,
): Promise<AuthorizeDecision> {
  if (!auth.authenticated) return 'unauthenticated';
  const provider = new D1PermissionProvider(env.DB);
  const known = await provider.isKnownPermission(code);
  if (!known) {
    console.error(`[authz] unknown permission code requested: ${code ?? '(empty)'}`);
    return 'unknown_permission';
  }
  const granted = await provider.hasPermission(auth, code);
  return granted ? 'allow' : 'forbidden';
}

/**
 * 便捷布尔判定（§八：can(authContext, permissionCode, tenantContext)）。
 * - 仅当裁决为 allow 时返回 true；unknown_permission / forbidden / unauthenticated 均返回 false。
 * - tenant 用于签名保真与未来 Ownership 扩展；当前有效权限已由 Provider 结合 active team 解析。
 * - 注意：本函数会"吞掉"unknown_permission（配置错误）信号；需要区分 403/500 的调用方
 *   应直接使用 authorizePermissionDecision。
 */
export async function can(
  env: Env,
  auth: AuthContext,
  _tenant: { scope: string; teamId: number | null; userId: number | null },
  code: string,
): Promise<boolean> {
  return (await authorizePermissionDecision(env, auth, code)) === 'allow';
}
