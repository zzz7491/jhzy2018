/**
 * Tenant Scope middleware（S2-5）。
 *
 * 纪律（用户 §十二）：
 * - 从 AuthContext 派生 TenantContext（scope/teamId/userId）。
 * - 表级 scope 判定以 S2-3 Table Matrix 为准（repository/tenant-scope.ts 的 TABLE_SCOPE）。
 * - 禁止统一 WHERE team_id=?；TEAM_SCOPED 表必须有团队上下文（或派生），USER_SCOPED
 *   表必须有用户上下文，PLATFORM_GLOBAL 不强制 team_id，AUDIT_ONLY 仅审计角色可读。
 */

import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import { buildTenantContext } from '../types/tenant';
import type { AuthContext } from '../types/auth';
import { getScope } from '../repository/tenant-scope';
import { teamScopeRequired, userScopeRequired, forbidden, authRequired } from '../utils/errors';

/** 全局：派生并注入 TenantContext（在 authContextMiddleware 之后运行）。 */
export const tenantContextMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVars }>(
  async (c, next) => {
    const auth = c.get('auth');
    c.set('tenant', buildTenantContext(auth));
    await next();
  },
);

/**
 * 表级读访问 guard（路由层在调用 Repository 前使用）。
 * 判定逻辑与 repository/tenant-scope.ts 的 checkReadAccess 完全一致，保证单一事实来源。
 */
export function assertTableRead(table: string, auth: AuthContext): void {
  if (!auth.authenticated) throw authRequired();

  const scope = getScope(table);
  if (scope == null) throw forbidden('Unknown resource');

  switch (scope) {
    case 'PLATFORM_GLOBAL':
      // 平台级资源不要求 team_id。
      return;
    case 'TEAM_SCOPED':
      if (auth.teamId == null) throw teamScopeRequired();
      return;
    case 'USER_SCOPED':
      if (auth.userId == null) throw userScopeRequired();
      return;
    case 'AUDIT_ONLY':
      // 审计表不对普通业务 API 暴露（本阶段无审计读端点）。
      throw forbidden('Audit resources are not exposed');
  }
}
