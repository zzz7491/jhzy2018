/**
 * /api/v2/attendance-anomalies —— 考勤异常处置端点（S2-6j V1：handling ONLY）。
 *
 * 资源键为 attendance_anomalies.id（INTEGER PRIMARY KEY）。
 * 推荐路由（§3）：
 *   GET  /api/v2/attendance-anomalies
 *   GET  /api/v2/attendance-anomalies/:anomalyId
 *   POST /api/v2/attendance-anomalies/:anomalyId/resolve
 * 不实现 POST /attendance-anomalies（无手工创建端点，§0 / §3；测试 fixture 直接写 local D1 造异常）。
 *
 * 授权链（§14）：requirePermission(attendance.anomaly.handle)（TEAM / HIGH，
 *   仅 platform_super_admin / team_owner / team_admin 持有）。
 * 租户隔离在 Repository 层收口（WHERE id=? AND team_id=?）；跨团队 → 404（§9）。
 * PSA 即便 catalog 持有该权限，也因 TenantContext.teamId=null 在 service.requireActor() 处被拒为
 * 403 TEAM_SCOPE_REQUIRED（与 S2-6i 已知 gap 一致，不在本阶段修复）。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { AttendanceAnomalyService } from '../services/attendance-anomaly-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';
import { requirePositiveIntParam } from '../utils/validation';

const anomalies = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** GET /api/v2/attendance-anomalies —— TEAM 作用域列表（status / anomaly_type / limit / cursor）。 */
anomalies.get('/', requirePermission('attendance.anomaly.handle'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new AttendanceAnomalyService({ db: c.env.DB, auth, tenant: c.get('tenant'), env: c.env });
  const result = await svc.list({
    status: c.req.query('status'),
    anomalyType: c.req.query('anomaly_type'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  return ok(c, result);
});

/** GET /api/v2/attendance-anomalies/:anomalyId —— TEAM 作用域详情（跨团队 / 不存在 → 404）。 */
anomalies.get('/:anomalyId', requirePermission('attendance.anomaly.handle'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const anomalyId = requirePositiveIntParam(c.req.param('anomalyId'), 'anomalyId');
  const svc = new AttendanceAnomalyService({ db: c.env.DB, auth, tenant: c.get('tenant'), env: c.env });
  const detail = await svc.detail(anomalyId);
  return ok(c, { anomaly: detail });
});

/**
 * POST /api/v2/attendance-anomalies/:anomalyId/resolve —— 处置（confirm|dismiss）。
 * 决策 + resolution 校验在 service 内；status 由服务端按决策映射，客户端不得直接传数字。
 */
anomalies.post('/:anomalyId/resolve', requirePermission('attendance.anomaly.handle'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const anomalyId = requirePositiveIntParam(c.req.param('anomalyId'), 'anomalyId');

  let body: { decision?: unknown; resolution?: unknown } = {};
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') body = json as { decision?: unknown; resolution?: unknown };
  } catch {
    body = {};
  }

  const svc = new AttendanceAnomalyService({ db: c.env.DB, auth, tenant: c.get('tenant'), env: c.env });
  const detail = await svc.resolve(anomalyId, body);
  return ok(c, { anomaly: detail });
});

export default anomalies;
