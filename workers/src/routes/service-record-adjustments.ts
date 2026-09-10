/**
 * /api/v2/service-record-adjustments —— 服务时长修正「申请 → 双人审批」的审批/拒绝端点（P35-C2）。
 *
 * 授权链（DB-backed，D1PermissionProvider）：
 *   POST /service-record-adjustments/:adjustmentPublicId/approve  → service.record.review（TEAM）
 *   POST /service-record-adjustments/:adjustmentPublicId/reject   → service.record.review（TEAM）
 *
 * 申请本身由 routes/service-records.ts 的
 *   POST /service-records/:serviceRecordPublicId/adjustments  （service.record.adjust）
 *   GET  /service-records/:serviceRecordPublicId/adjustments  （service.record.view OR service.record.review）
 * 承担；本文件只处理「第二人审批」这一半工作流（审批/拒绝）。
 *
 * 设计纪律（P35-C2 冻结）：
 * - 审批人不得审核/拒绝自己提交的申请（含 platform_super_admin，无 bypass）→ 403 forbidden。
 *   该判定在服务层执行（service.adjustment 依赖 requester_id 与当前 auth.userId 比对）；
 *   路由层只负责 permission code 门禁。
 * - 跨团队 / 不存在的申请统一 404（不构成 existence oracle）。
 * - 审批原子落地：audit + service_records UPDATE(source='correction') + request APPROVED + 积分三件套
 *   同一 db.batch；并发漂移 → 全部 0 行 → 零业务副作用，申请保持 PENDING（service 层转 409 STALE）。
 * - 拒绝仅更新 request 行（status=REJECTED + reviewer 字段），不触碰 service_records / points。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ServiceRecordService } from '../services/service-record-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';
import { isUlid } from '../utils/validation';

/**
 * 修正申请 public_id 校验：申请记录的 public_id 均为 runtime generateUlid() 生成的 26 字符 ULID，
 * 不存在 legacy（L 前缀）形态，故仅校验 ULID 格式。格式非法 → 400（先于任何 DB 访问）。
 * 实际取值经 repository 的 `WHERE public_id = ? AND team_id = ?` 参数化绑定，不存在注入面；
 * 不存在 / 跨团队 → 由 service 层统一 404。
 */
function requireAdjustmentPublicId(value: string | undefined, name: string): string {
  if (value == null || !isUlid(value)) {
    throw invalidParam(name, 'must be a 26-char ULID');
  }
  return value;
}

/** 解析 reject 请求体的 reason 字段（拒绝理由，必填 1..500，由 service 层做最终校验）。 */
function parseRejectReason(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw invalidParam('reason', 'must be a string');
  }
  return raw;
}

const serviceRecordAdjustments = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * POST /api/v2/service-record-adjustments/:adjustmentPublicId/approve —— 审批通过（TEAM）。
 *
 * 权限 = service.record.review（路由层门禁）。自审拦截、状态机校验、stale 检测、原子落地均委托 service 层。
 * 返回被修正后的 ServiceRecord 投影（零内部 numeric FK）。
 */
serviceRecordAdjustments.post(
  '/:adjustmentPublicId/approve',
  requirePermission('service.record.review'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const adjustmentPublicId = requireAdjustmentPublicId(c.req.param('adjustmentPublicId'), 'adjustmentPublicId');

    const svc = new ServiceRecordService({
      db: c.env.DB,
      auth,
      tenant: c.get('tenant'),
    });
    const record = await svc.approveAdjustment(adjustmentPublicId);

    return ok(c, { record });
  },
);

/**
 * POST /api/v2/service-record-adjustments/:adjustmentPublicId/reject —— 拒绝（TEAM）。
 *
 * 权限 = service.record.review（路由层门禁）。Body 仅允许 { "reason": "非合规拒绝理由" }（1..500）。
 * 自拒拦截、状态机校验均委托 service 层；拒绝仅标记 request 行，不产生任何 service_records / points 副作用。
 */
serviceRecordAdjustments.post(
  '/:adjustmentPublicId/reject',
  requirePermission('service.record.review'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const adjustmentPublicId = requireAdjustmentPublicId(c.req.param('adjustmentPublicId'), 'adjustmentPublicId');

    let body: Record<string, unknown> = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object') body = json as Record<string, unknown>;
    } catch {
      body = {};
    }

    const reason = parseRejectReason(body.reason);

    const svc = new ServiceRecordService({
      db: c.env.DB,
      auth,
      tenant: c.get('tenant'),
    });
    await svc.rejectAdjustment(adjustmentPublicId, reason);

    return ok(c, { rejected: true });
  },
);

export default serviceRecordAdjustments;
