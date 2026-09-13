/**
 * 平台级只读投递诊断端点（N0-G1）—— /api/v2/admin/delivery-diagnostics
 *
 * 设计纪律（N0-G1 冻结契约）：
 * - 单一端点：GET /api/v2/admin/delivery-diagnostics
 *   query: mode=stale_reserved | terminal_failure；stale_reserved 可带 threshold（秒）。
 * - 授权：requirePermission('audit.log.view')（DB-backed，非硬编码角色）
 *   且仅限「平台级全局」绑定（requirePlatformAuditView）—— team-scoped 的 audit.log.view
 *   不足以获得跨用户平台诊断能力，故 team_admin / team_auditor / team_owner 一律拒绝。
 * - 不要求 active team（platform 角色平台级绑定恒生效）。
 * - 响应严格白名单（N0-G1 §4）；不含任何 PII / provider payload。
 * - 无 mutation / resend / retry / recovery / dead-letter。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import { DeliveryDiagnosticService } from '../services/delivery-diagnostic-service';
import { requirePermission } from '../middleware/rbac';
import { authorizePermissionDecision } from '../services/permission-provider';
import { ok } from '../utils/response';
import { authRequired, forbidden, internalError } from '../utils/errors';

const deliveryDiagnostics = new Hono<{ Bindings: Env; Variables: AppVars }>();

function svc(c: Context) {
  return new DeliveryDiagnosticService({
    db: c.env.DB,
    auth: c.get('auth'),
    tenant: c.get('tenant'),
  });
}

/**
 * 平台作用域细化：audit.log.view 必须来自「平台级全局」绑定（scopeTeamId = null）。
 * 仅校验权限 + 其作用域，不读取角色名，不硬编码角色判定。
 * - 未认证 → 401
 * - audit.log.view 仅以 team 作用域持有（如 team_admin）→ 403
 * - 未知 permission code（配置错误）→ 500
 * - 否则放行。
 */
function requirePlatformAuditView() {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    const decision = await authorizePermissionDecision(
      c.env,
      { ...c.get('auth'), teamId: null },
      'audit.log.view',
    );
    switch (decision) {
      case 'allow':
        return next();
      case 'unauthenticated':
        throw authRequired();
      case 'unknown_permission':
        throw internalError();
      case 'forbidden':
        throw forbidden();
    }
  });
}

// GET /api/v2/admin/delivery-diagnostics
deliveryDiagnostics.get(
  '/',
  requirePermission('audit.log.view'),
  requirePlatformAuditView(),
  async (c) => {
    const parsed = svc(c).parseQuery(c.req.query());
    const data = await svc(c).diagnose(parsed);
    return ok(c, data);
  },
);

export default deliveryDiagnostics;
