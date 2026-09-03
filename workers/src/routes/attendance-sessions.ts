/**
 * /api/v2/attendance-sessions —— 考勤管理端点（S2-6i：Review 审核 + Force Checkout）。
 *
 * 资源键为 attendance_session.id（多参加模型下 signup → N sessions，管理操作必须针对 sessionId，
 * 绝不通过 signup_id 唯一定位，§2 / §11）。
 *
 * 推荐路由（§2）：
 *   POST /api/v2/attendance-sessions/:sessionId/review
 *   POST /api/v2/attendance-sessions/:sessionId/force-checkout
 *
 * 授权链（§三/§五/§九）：requirePermission(attendance.record.review | attendance.record.force)
 *   → D1PermissionProvider（permissions=83 / role_permissions=238）。本路由【不】把管理端点塞进
 *   /activities/:id/attendance/checkin 这类 SELF 路由结构（§十四）。
 *
 * 租户隔离在 Repository 层（WHERE id=? AND team_id=?）收口；跨团队 sessionId → 404（§八）。
 * PSA 即便 catalog 持有该权限，也因 TenantContext.teamId=null 在 service.requireActor() 处被拒
 * 为 403 TEAM_SCOPE_REQUIRED（已知 architecture gap，不在本阶段修复）。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { AttendanceManagementService } from '../services/attendance-management-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';
import { requirePositiveIntParam } from '../utils/validation';

const sessions = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * POST /api/v2/attendance-sessions/:sessionId/review
 * Body: { "decision": "approve" | "reject", "reason": "..." }
 * - decision 必填；reason：approve 可选、reject 建议非空；统一 ≤500 字符（见 service）。
 * - 响应：更新后的会话视图（仅 review_status 变化，status 不变）。
 */
sessions.post('/:sessionId/review', requirePermission('attendance.record.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const sessionId = requirePositiveIntParam(c.req.param('sessionId'), 'sessionId');

  let body: { decision?: unknown; reason?: unknown } = {};
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') body = json as { decision?: unknown; reason?: unknown };
  } catch {
    // 空 body 视为 { decision: undefined } → 后续校验阶段自然 400。
    body = {};
  }

  const svc = new AttendanceManagementService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
    env: c.env,
  });
  const view = await svc.reviewSession(sessionId, body);

  return ok(c, { session: view });
});

/**
 * POST /api/v2/attendance-sessions/:sessionId/force-checkout
 * Body: { "reason": "..." }（必填、非空、≤500）
 * - 响应：更新后的会话视图（status 1→2、checkout_at 写入；review_status 不变）。
 */
sessions.post(
  '/:sessionId/force-checkout',
  requirePermission('attendance.record.force'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const sessionId = requirePositiveIntParam(c.req.param('sessionId'), 'sessionId');

    let body: { reason?: unknown } = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object') body = json as { reason?: unknown };
    } catch {
      body = {};
    }

    const svc = new AttendanceManagementService({
      db: c.env.DB,
      auth,
      tenant: c.get('tenant'),
      env: c.env,
    });
    const view = await svc.forceCheckout(sessionId, body);

    return ok(c, { session: view });
  },
);

export default sessions;
