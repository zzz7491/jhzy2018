/**
 * /api/v2/attendance-sessions —— 考勤端点（S2-6i：Review 审核 + Force Checkout；G1：SELF 活跃会话查询）。
 *
 * G1 追加：GET /api/v2/attendance-sessions/me（SELF / GLOBAL_PER_USER / 纯读，见文件内注释）。
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
import { AttendanceSessionRepository } from '../repository/attendance-sessions';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired, invalidParam } from '../utils/errors';
import { requirePositiveIntParam, isUlid, parsePagination } from '../utils/validation';

const sessions = new Hono<{ Bindings: Env; Variables: AppVars }>();

// =========================================================================
// G1：GET /api/v2/attendance-sessions/me —— 本人当前【活跃】考勤会话（AUTHORITATIVE ACTIVE SESSION）。
//
// 语义（G1 冻结）：
// - ACTIVE predicate = status = 1 AND checkout_at IS NULL（与 checkin/checkout 同一业务语义）。
// - SCOPE = GLOBAL_PER_USER：不按当前 X-Team-Id 过滤，用户在他队的活跃会话同样必须被发现。
// - SELF BY CONSTRUCTION：查询对象恒为 server-authenticated user，客户端不得指定 user_id / team_id。
// - 纯读：本 handler 不产生任何 DB 写（无 INSERT/UPDATE/DELETE/batch/points/audit）。
//
// 路由纪律：字面量 /me 必须注册在任意动态段之前（与 routes/forms.ts、routes/service-records.ts 同纪律）。
// 授权：复用 attendance.record.checkin（USER scope）—— 本端点是"签到动作的前置状态查询"，
//       不是通用 attendance read；本阶段不新增权限、不改 catalog、不改 seed、不建 migration。
// =========================================================================
sessions.get('/me', requirePermission('attendance.record.checkin'), async (c) => {
  // strict-input（G1 §8）：本端点不接受任何 query 参数。
  // 特别禁止 ?user_id= / ?team_id= 覆盖服务端身份（analytics-service 的 FORBIDDEN_QUERY_KEYS 同纪律）。
  for (const k of Object.keys(c.req.query() ?? {})) {
    throw invalidParam(
      k,
      k === 'user_id' || k === 'team_id'
        ? 'query parameter is not allowed (identity is server-derived)'
        : 'unknown query parameter',
    );
  }

  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const userId = auth.userId;
  if (userId == null) throw authRequired();

  const repo = new AttendanceSessionRepository({
    db: c.env.DB,
    ctx: { auth, tenant: c.get('tenant') },
  });
  const row = await repo.findOwnActiveSessionGlobal(userId);

  // 响应 allowlist（G1 §10）：active；active=true 时仅 session.activity_public_id + session.checkin_at。
  if (!row) return ok(c, { active: false });
  return ok(c, {
    active: true,
    session: {
      activity_public_id: row.activity_public_id,
      checkin_at: row.checkin_at,
    },
  });
});

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

// =========================================================================
// P31-P1A：团队考勤 roster（管理员查看，供 review / force-checkout 使用）。
// GET /api/v2/attendance-sessions —— TEAM_SCOPED；不新增 repository 文件，
// 查询直接落在本路由（符合 §8「不新增第 5 production file」约束）。
// 投影只暴露公开/安全字段：session_id（动作键）+ 活动/志愿者 public_id + 名称；
// 不泄露 numeric user_id / team_id / activity_id / 内部 id。
// =========================================================================
sessions.get('/', requirePermission('attendance.record.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const tenant = c.get('tenant');
  const teamId = tenant.teamId;
  if (teamId == null) throw teamScopeRequired();

  const { page, pageSize, offset } = parsePagination(c.req.query());
  const activityPublicId = c.req.query('activity_public_id');
  const statusRaw = c.req.query('status');

  const where: string[] = ['s.team_id = ?', 'a.deleted_at IS NULL'];
  const params: unknown[] = [teamId];
  if (activityPublicId) {
    if (!isUlid(activityPublicId)) throw invalidParam('activity_public_id', 'must be a 26-char ULID');
    where.push('a.public_id = ?');
    params.push(activityPublicId);
  }
  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== '') {
    const st = Number(statusRaw);
    if (!Number.isInteger(st) || st < 0 || st > 4) throw invalidParam('status', 'must be 0..4');
    where.push('s.status = ?');
    params.push(st);
  }
  const whereSql = where.join(' AND ');

  const listRes = await c.env.DB.prepare(
    `SELECT s.id AS session_id,
            a.public_id AS activity_public_id,
            a.title AS activity_title,
            u.public_id AS volunteer_public_id,
            u.nickname AS volunteer_name,
            s.checkin_at,
            s.checkout_at,
            s.status,
            s.review_status,
            s.created_at
       FROM attendance_sessions s
       JOIN activities a ON a.id = s.activity_id
       JOIN users u ON u.id = s.user_id
      WHERE ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Record<string, unknown>>();

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total
       FROM attendance_sessions s
       JOIN activities a ON a.id = s.activity_id
      WHERE ${whereSql}`,
  )
    .bind(...params)
    .first<{ total: number }>();

  const total = totalRow?.total ?? 0;
  return ok(c, {
    sessions: listRes.results ?? [],
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    },
  });
});

export default sessions;
