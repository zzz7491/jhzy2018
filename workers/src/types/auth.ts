/**
 * 鉴权与租户上下文类型（S2-4 骨架）。
 *
 * 纪律：本骨架【不】接入真实 JWT / OAuth / 生产 Secret，【不】创建真实用户。
 * AuthContext 仅提供稳定接口，供后续 middleware / repository 使用。
 */

/** 6 个冻结角色 code（S2-2G 裁定：volunteer = team scope）。 */
export const ROLE_CODES = [
  'platform_super_admin',
  'platform_operator',
  'team_owner',
  'team_admin',
  'team_auditor',
  'volunteer',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

/** 四类租户作用域（S2-3 矩阵分类）。 */
export type TenantScope = 'PLATFORM_GLOBAL' | 'TEAM_SCOPED' | 'USER_SCOPED' | 'AUDIT_ONLY';

/**
 * 单条角色绑定（S2-6f：来自 D1 user_roles 的实时解析，绝不固化进 Session）。
 * - role：6 个冻结角色之一。
 * - scopeTeamId：绑定作用域团队 id；null = 平台级绑定（platform scope，不依赖 active team）。
 *   团队级绑定必须携带真实 team_id（禁止 0 哨兵）。
 */
export interface UserRoleBinding {
  role: RoleCode;
  scopeTeamId: number | null;
}

/** 当前请求的身份上下文。 */
export interface AuthContext {
  /** 是否已认证（骨架默认 false；local 仅允许用测试头注入，生产禁用）。 */
  authenticated: boolean;
  /** 当前用户 id（未认证为 null）。 */
  userId: number | null;
  /** 当前【生效】角色 code（由 X-Team-Id 上下文推导的单一最高角色，供粗门禁 / 展示）。 */
  role: RoleCode | null;
  /** 当前团队上下文 id（未认证 / 平台级为 null）。 */
  teamId: number | null;
  /**
   * 当前请求的全部角色绑定（S2-6f）。
   * - 每请求由 SessionService 从 user_roles 实时加载，角色变化下一请求立即生效。
   * - PermissionProvider 据此解析有效 permissions（platform 绑定恒生效；team 绑定仅当
   *   其 scopeTeamId === 当前 active teamId 时生效）。
   * - 未认证为空数组。
   */
  roles: UserRoleBinding[];
}

/** 默认未认证上下文。 */
export const UNAUTHENTICATED: AuthContext = {
  authenticated: false,
  userId: null,
  role: null,
  teamId: null,
  roles: [],
};
