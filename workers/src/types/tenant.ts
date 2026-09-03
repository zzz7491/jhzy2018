/**
 * 租户上下文类型（S2-5）。
 *
 * 纪律（S2-3 矩阵 / 用户 §十二）：
 * - 四类 scope：PLATFORM_GLOBAL / TEAM_SCOPED / USER_SCOPED / AUDIT_ONLY。
 * - Repository 必须按【表的 scope】决定查询策略，禁止统一 WHERE team_id=?。
 * - volunteer = TEAM scope（S2-2G 用户裁定，禁止重新讨论）。
 */

import type { AuthContext, TenantScope } from './auth';

/** 请求级租户上下文（由 middleware 从 AuthContext 派生）。 */
export interface TenantContext {
  /** 调用方的访问层级（不是表的 scope）。 */
  scope: TenantScope;
  teamId: number | null;
  userId: number | null;
}

/** 仓库层上下文：身份 + 租户（由 middleware/context 传入，Repository 不读 HTTP）。 */
export interface RepositoryContext {
  auth: AuthContext;
  tenant: TenantContext;
}

const PLATFORM_ROLES: ReadonlySet<string> = new Set(['platform_super_admin', 'platform_operator']);

/**
 * 从 AuthContext 派生 TenantContext：
 * - 平台角色 → PLATFORM_GLOBAL（不强制 team 上下文，teamId 归一化为 null）。
 * - 团队角色（owner/admin/auditor/volunteer）且有 teamId → TEAM_SCOPED。
 * - 其余已认证 → USER_SCOPED（仅可访问自身数据）。
 * - 未认证 → USER_SCOPED + 全空（各 guard 会拒绝）。
 */
export function buildTenantContext(auth: AuthContext): TenantContext {
  if (!auth.authenticated) {
    return { scope: 'USER_SCOPED', teamId: null, userId: null };
  }
  // S2-6f：平台级绑定（scopeTeamId == null）恒生效，不依赖 active team（§五/§六）。
  // 任一 platform 角色绑定存在 → PLATFORM_GLOBAL（数据访问不强制 team_id）。
  const hasPlatformRole = auth.roles.some(
    (b) => b.scopeTeamId == null && PLATFORM_ROLES.has(b.role),
  );
  if (hasPlatformRole) {
    return { scope: 'PLATFORM_GLOBAL', teamId: null, userId: auth.userId };
  }
  if (auth.teamId != null) {
    return { scope: 'TEAM_SCOPED', teamId: auth.teamId, userId: auth.userId };
  }
  return { scope: 'USER_SCOPED', teamId: null, userId: auth.userId };
}
