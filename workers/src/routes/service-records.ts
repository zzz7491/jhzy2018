/**
 * /api/v2/service-records —— 服务时长记录（ServiceRecord）只读 + 人工修正端点（S2-NEW-ARCH-P22-P4）。
 *
 * 授权链（DB-backed，D1PermissionProvider）：
 *   GET  /service-records/mine              → service.record.read（USER/SELF；volunteer + platform_super_admin）
 *   GET  /service-records                   → service.record.view（TEAM；owner/admin/auditor + platform 角色）
 *   GET  /service-records/:publicId         → service.record.view（TEAM）
 *   POST /service-records/:publicId/adjust  → service.record.adjust（TEAM）
 *
 * 路由纪律（与 routes/forms.ts 一致）：**字面量段优先注册**——/mine 必须注册在 /:publicId 之前，
 * 否则会被参数路由吞掉。
 *
 * 对外投影纪律（P22-P4 §3）：响应【零内部 numeric FK】——不返回 service_records.id /
 * session_id / user_id / team_id / activity_id；关联实体只返回 public_id（ULID）。
 * 【刻意不返回 session_public_id】：attendance_sessions 无 public_id 列，不硬造。
 *
 * 租户隔离在 Repository 层收口（WHERE team_id=?）：跨团队与不存在统一 404，不构成 existence oracle。
 * platform_super_admin / platform_operator 的 TEAM 上下文行为沿用既有 middleware 语义，本路由不新造特权逻辑。
 *
 * 结算端点【不公开】：settlement 只由 attendance 状态转换内部触发（P22-P3）。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ServiceRecordService } from '../services/service-record-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';
import { isUlid } from '../utils/validation';

/**
 * ServiceRecord public_id 校验（本地实现，不修改 utils/validation.ts）。
 *
 * 为什么不能用 requireUlidParam：0017 对 0017 之前的存量行回填的 legacy public_id 形如
 * `'L' + 12 位零填充 id`（如 L000000000001）——'L' 刻意落在 Crockford ULID 字母表之外，
 * 用于与 runtime generateUlid() 永久隔离命名空间。这些存量行是 UNVERIFIED(0) 且对外可见，
 * 因此必须可寻址，不能被 ULID 正则误杀。
 *
 * 安全性：仅格式白名单校验；实际取值经 repository 的 `WHERE public_id = ?` 参数化绑定，
 * 不存在注入面。不存在 / 跨团队 → 404。
 */
const LEGACY_PUBLIC_ID_RE = /^L[0-9]{12}$/;

function requireServiceRecordPublicId(value: string | undefined, name: string): string {
  if (value == null || !(isUlid(value) || LEGACY_PUBLIC_ID_RE.test(value))) {
    throw invalidParam(name, 'must be a 26-char ULID or legacy L-prefixed id');
  }
  return value;
}

/** business_service_date 过滤值校验（YYYY-MM-DD）。 */
const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optionalBusinessDate(raw: string | undefined): string | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (!BUSINESS_DATE_RE.test(trimmed)) {
    throw invalidParam('business_service_date', 'must be YYYY-MM-DD');
  }
  return trimmed;
}

/**
 * adjust 请求体中【客户端禁止提交】的字段（P22-P4 §6）。
 * 出现即 400：宁可显式拒绝，也不静默忽略——静默忽略会让调用方误以为设置生效。
 */
const FORBIDDEN_ADJUST_FIELDS = [
  'points_awarded_units',
  'points_min_minutes',
  'points_base_units_per_hour',
  'points_multiplier_pct',
  'settlement_status',
  'public_id',
  'user_id',
  'user_public_id',
  'team_id',
  'activity_id',
  'session_id',
  'minutes',
  'effectiveMinutes',
  'id',
] as const;

const serviceRecords = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * GET /api/v2/service-records/mine —— SELF 列表。
 *
 * 硬约束：只返回【当前认证用户本人】的记录；不接受任何指定他人的 query 参数
 * （userPublicId 等一律不解析，避免越权读取）。
 * 历史 UNVERIFIED(0) / REVOKED(2) 记录如实返回，并带明确的 settlement_status；
 * 「可见」不等于「可消费」——下游统计/积分仍只消费 EFFECTIVE(1)。
 *
 * Query（全部可选）：business_service_date=YYYY-MM-DD、limit（1..200，默认 50）
 */
serviceRecords.get('/mine', requirePermission('service.record.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const records = await svc.listMine({
    businessServiceDate: optionalBusinessDate(c.req.query('business_service_date')),
    limit: c.req.query('limit'),
  });

  return ok(c, { records });
});

/**
 * GET /api/v2/service-records —— TEAM 列表。
 * Query（全部可选）：business_service_date=YYYY-MM-DD、user_public_id=ULID、limit（1..200，默认 50）
 */
serviceRecords.get('/', requirePermission('service.record.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const records = await svc.listTeam({
    businessServiceDate: optionalBusinessDate(c.req.query('business_service_date')),
    userPublicId: c.req.query('user_public_id'),
    limit: c.req.query('limit'),
  });

  return ok(c, { records });
});

/**
 * GET /api/v2/service-records/:publicId —— TEAM 详情。
 * 跨团队与不存在统一 404（不区分）。
 */
serviceRecords.get('/:publicId', requirePermission('service.record.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireServiceRecordPublicId(c.req.param('publicId'), 'publicId');

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const record = await svc.getByPublicId(publicId);

  return ok(c, { record });
});

/**
 * POST /api/v2/service-records/:publicId/adjust —— 人工修正（TEAM）。
 *
 * Body（严格）：{ "effective_minutes": 25, "reason": "人工核验修正" }
 * - effective_minutes：整数、>= 0、<= 525600；与当前值相同 → 409 service_record_no_change（不写审计）。
 * - reason：非空、<= 500 字符。
 * - 出现任何 FORBIDDEN_ADJUST_FIELDS（points / multiplier / base rate / settlement_status /
 *   任何主体 ID）→ 400 INVALID_PARAM。
 *
 * 计分使用 ServiceRecord 自身冻结的政策快照重算，不回查 activities。
 * 成功后 settlement_status 恒为 EFFECTIVE(1)（人工重新认证）。
 * 并发 lost update → 409 service_record_stale。
 */
serviceRecords.post('/:publicId/adjust', requirePermission('service.record.adjust'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireServiceRecordPublicId(c.req.param('publicId'), 'publicId');

  let body: Record<string, unknown> = {};
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') body = json as Record<string, unknown>;
  } catch {
    body = {};
  }

  // 客户端禁止提交的字段：显式 400（先于业务校验）。
  for (const field of FORBIDDEN_ADJUST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw invalidParam(field, 'must not be provided by client');
    }
  }

  const rawMinutes = body.effective_minutes;
  const rawReason = body.reason;

  if (typeof rawMinutes !== 'number' || !Number.isInteger(rawMinutes)) {
    throw invalidParam('effective_minutes', 'must be an integer');
  }
  if (typeof rawReason !== 'string') {
    throw invalidParam('reason', 'must be a string');
  }

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const record = await svc.adjustServiceRecord(publicId, {
    effectiveMinutes: rawMinutes,
    reason: rawReason,
  });

  return ok(c, { record });
});

export default serviceRecords;
