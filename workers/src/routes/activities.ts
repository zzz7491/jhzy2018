/**
 * /api/v2/activities —— 活动端点（S2-5 只读 + S2-6g 报名垂直切片）。
 *
 * S2-5（保留）：
 * - activities 为 TEAM_SCOPED（S2-3 矩阵）：列表 / 详情强制 team_id = 当前团队上下文。
 * - :id 为 ULID public_id；非法格式 400（先于 DB 访问，兼作注入防护第一层）。
 *
 * S2-6g（新增，仅两个写端点，不做整套 Signup CRUD）：
 * - POST   /api/v2/activities/:activityId/signups     —— 当前登录用户报名活动
 * - DELETE /api/v2/activities/:activityId/signups/me  —— 当前登录用户取消【本人】报名
 *   （路由形态依据 docs/嘉禾志愿V2.0 最终产品与技术架构蓝图V1.0.md §活动接口
 *     `POST|DELETE /activities/{id}/signup`；`signups/me` 显式表达"本人"，
 *     与 Ownership 的 SELF 语义对齐，避免留下"按 id 操作任意报名"的歧义入口。）
 *
 * 授权链（用户 §八：必须复用 S2-6f D1PermissionProvider）：
 *   requirePermission(signup.signup.create | signup.signup.cancel)
 *     → D1PermissionProvider（permissions=83 / role_permissions=238）
 *   禁止 role === volunteer / super_admin shortcut / JSON 运行时查表 / 手写矩阵。
 * 权限只裁决"能否执行动作"；资源归属与租户范围由 Service + Repository 二次收口。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import {
  ActivityRepository,
  ACTIVITY_FORBIDDEN_PUBLICATION_FIELDS,
  type CreateActivityCommand,
  type ActivityScalarUpdate,
  type OccurrenceInput,
} from '../repository/activities';
import { ActivitySignupService } from '../services/activity-signup-service';
import { ActivityAdminService } from '../services/activity-admin-service';
import { ActivityAttendanceService } from '../services/attendance-service';
import { requirePermission } from '../middleware/rbac';
import { D1PermissionProvider, can } from '../services/permission-provider';
import { ok } from '../utils/response';
import { authRequired, invalidParam, AppError, ErrorCode } from '../utils/errors';
import { requireUlidParam, parsePagination, isUlid } from '../utils/validation';
import { parseAttendanceLocation, type AttendanceLocation } from '../utils/location';

const activities = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * P34-C2 §3 / §8：发布与审核字段一律服务端权威。
 * create / update body 中若出现任一 forbidden publication field → 400 INVALID_PARAM
 * （不静默忽略，避免"借 update 绕过审批"）。
 */
function assertNoForbiddenPublicationFields(body: Record<string, unknown>): void {
  for (const field of ACTIVITY_FORBIDDEN_PUBLICATION_FIELDS) {
    if (body[field] !== undefined) {
      throw invalidParam(field, 'publication/approval fields are server-authoritative and must not be supplied');
    }
  }
}

/** GET /api/v2/activities —— 本团队活动列表（分页，page/page_size 上限 clamp）。 */
activities.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const pagination = parsePagination(c.req.query());
  const repo = new ActivityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  // P34-C3：无活动管理权限者（志愿者）仅可见"已审核公开"活动；具备 review/submit 的管理员走完整列表（§5 不得误伤 admin）。
  const isManager = (await can(c.env, auth, c.get('tenant'), 'activity.activity.review')) ||
    (await can(c.env, auth, c.get('tenant'), 'activity.activity.submit'));
  const result = isManager
    ? await repo.listByMyTeam(pagination.page, pagination.pageSize, pagination.offset)
    : await repo.listVolunteerVisible(pagination.page, pagination.pageSize, pagination.offset);

  return ok(c, result);
});

/** GET /api/v2/activities/:id —— 本团队单个活动详情。 */
activities.get('/:id', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');
  const repo = new ActivityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const isManager = (await can(c.env, auth, c.get('tenant'), 'activity.activity.review')) ||
    (await can(c.env, auth, c.get('tenant'), 'activity.activity.submit'));
  const activity = isManager
    ? await repo.findByPublicId(publicId)
    : await repo.findVolunteerVisibleByPublicId(publicId);

  return ok(c, { activity });
});

/**
 * POST /api/v2/activities/:activityId/signups —— 报名（S2-6g / P21：create + reapply）。
 *
 * - 权限：signup.signup.create（D1 裁决；未认证 401 / 无授权 403）。
 * - :activityId 为 ULID public_id；非法格式 → 400 INVALID_PARAM（先于任何 DB 访问）。
 * - Body（向后兼容）：可选 `form_submission_public_id`（P20 已 submitted 表单证据，ULID）
 *   与 legacy `form_data`（保持兼容接受，但 P21 不写入、不双写、不以此替代 submission）。
 * - user_id / team_id 仍全部由服务端派生（R1 铁律）。
 */
activities.post('/:activityId/signups', requirePermission('signup.signup.create'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');

  let formSubmissionPublicId: string | undefined;
  try {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const f = (body as Record<string, unknown>).form_submission_public_id;
      if (f !== undefined && f !== null) {
        if (typeof f !== 'string' || !isUlid(f)) {
          throw invalidParam('form_submission_public_id', 'must be a 26-char ULID');
        }
        formSubmissionPublicId = f;
      }
    }
  } catch (e) {
    if (e instanceof AppError && e.code === ErrorCode.INVALID_PARAM) throw e;
    throw invalidParam('request', 'invalid request body');
  }

  const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const signup = await service.createOwn(activityPublicId, { formSubmissionPublicId });

  return ok(c, { signup }, 201);
});

// =========================================================================
// P21 —— Signup 读端点（SELF / TEAM；字面量 `/signups/me` 优先注册）
// =========================================================================

/** 动态二次鉴权（answers/schema 额外门控；真实 PermissionProvider，非角色名硬编码）。 */
const hasPerm = async (c: import('hono').Context, code: string): Promise<boolean> => {
  const auth = c.get('auth');
  if (!auth?.authenticated) return false;
  const provider = new D1PermissionProvider(c.env.DB);
  return provider.hasPermission(auth, code);
};

/** GET /api/v2/activities/:activityId/signups/me —— 本人报名详情（含自有答案/schema）。 */
activities.get('/:activityId/signups/me', requirePermission('signup.signup.create'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');

  const includeAnswers = await hasPerm(c, 'form.submission.read');
  const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const view = await service.getOwnSignupDetail(activityPublicId, {
    includeAnswers,
    includeLegacyFormData: includeAnswers,
  });
  return ok(c, { signup: view });
});

/** GET /api/v2/activities/:activityId/signups —— 团队报名列表（默认不含 answers/schema/legacy form_data）。 */
activities.get('/:activityId/signups', requirePermission('signup.signup.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');
  const { page, pageSize } = parsePagination(c.req.query());

  const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const result = await service.listSignups(activityPublicId, page, pageSize);
  return ok(c, { signups: result.items });
});

/** GET /api/v2/activities/:activityId/signups/users/:userPublicId —— 指定志愿者报名详情（TEAM）。 */
activities.get('/:activityId/signups/users/:userPublicId', requirePermission('signup.signup.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');
  const userPublicId = c.req.param('userPublicId');
  if (!isUlid(userPublicId)) throw invalidParam('userPublicId', 'must be a 26-char ULID');

  const includeAnswers = await hasPerm(c, 'form.submission.manage');
  const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const view = await service.getSignupDetailByUser(activityPublicId, userPublicId, {
    includeAnswers,
    includeLegacyFormData: includeAnswers,
  });
  return ok(c, { signup: view });
});

/**
 * DELETE /api/v2/activities/:activityId/signups/me —— 取消本人报名（S2-6g）。
 *
 * - 权限：signup.signup.cancel（D1 裁决）。
 * - 只作用于【本人】【有效（status=1）】且【位于当前租户内】的报名行。
 * - 本阶段不提供取消他人报名的入口：冻结目录与 Ownership Rules 中均无此规则（用户 §七）。
 */
activities.delete('/:activityId/signups/me', requirePermission('signup.signup.cancel'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');
  const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const signup = await service.cancelOwn(activityPublicId);

  return ok(c, { signup });
});

/**
 * POST /api/v2/activities/:activityId/signups/:signupId/review —— 报名审核（N0-E0）。
 *
 * - 权限：signup.signup.review（D1 裁决；未认证 401 / 无授权 403）。
 * - :activityId 为 ULID public_id（沿用既有活动路由契约，§9）。
 * - :signupId 为报名行 integer id（由 signup-list API 经 signup.id 暴露，§9；不引入 public_id migration）。
 * - decision = approve | reject；reject 时 reason 必填（trim 后 1..500），approve 时 reason 可选归并 NULL。
 * - 前端不得传 operatorId / reviewBy / teamId / userId（服务端派生，§8）。
 * - 不接通知 / 不接微信（§13）；仅写 review_status / review_by / review_at / review_reason / updated_at。
 */
activities.post(
  '/:activityId/signups/:signupId/review',
  requirePermission('signup.signup.review'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');
    const rawSignupId = c.req.param('signupId');
    const signupId = Number.parseInt(rawSignupId, 10);
    if (!Number.isInteger(signupId) || signupId <= 0) {
      throw invalidParam('signupId', 'must be a positive integer');
    }

    let decision: unknown;
    let reason: unknown = undefined;
    try {
      const body = await c.req.json().catch(() => null);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        decision = (body as Record<string, unknown>).decision;
        reason = (body as Record<string, unknown>).reason;
      }
    } catch {
      throw invalidParam('request', 'invalid request body');
    }
    if (decision !== 'approve' && decision !== 'reject') {
      throw invalidParam('decision', 'must be "approve" or "reject"');
    }

    const service = new ActivitySignupService({ db: c.env.DB, auth, tenant: c.get('tenant') });
    const view = await service.reviewSignup(activityPublicId, signupId, decision as 'approve' | 'reject', reason);
    return ok(c, { signup: view.signup });
  },
);

/**
 * POST /api/v2/activities/:activityId/attendance/checkin —— 本人签到（S2-6h）。
 *
 * - 权限：attendance.record.checkin（D1 裁决；USER scope，volunteer / platform_super_admin 持有）。
 * - 必须已报名该活动（本人有效报名，status=1），且报名与活动均位于当前租户内。
 * - 不提供"按 sessionId 操作任意考勤"的入口：签到只作用于【本人】当前活动，从根上杜绝 IDOR（§十四）。
 * - 请求体本阶段【不接受任何字段】：signup_id / user_id / team_id 全部由服务端派生（R1 铁律）。
 */
activities.post(
  '/:activityId/attendance/checkin',
  requirePermission('attendance.record.checkin'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');

    // P16：解析请求体。participation_public_id 必填（Crockford ULID 26 字符）；
    // location 可选（GPS 不可用时为 null）。两者均在 auth + permission 之后校验，
    // 故未认证 / 无权限请求不会因 malformed body 先得 400（P15 REV1 顺序冻结）。
    let participationPublicId: string;
    let location: AttendanceLocation | null = null;
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw invalidParam('participation_public_id', 'required');
      }
      const pp = (body as Record<string, unknown>).participation_public_id;
      if (typeof pp !== 'string' || !isUlid(pp)) {
        throw invalidParam('participation_public_id', 'required 26-char Crockford ULID');
      }
      participationPublicId = pp;

      const rawLoc = (body as Record<string, unknown>).location;
      location = rawLoc !== undefined ? parseAttendanceLocation(rawLoc) : null;
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.INVALID_PARAM) throw e;
      throw invalidParam('request', 'invalid request body');
    }

    const service = new ActivityAttendanceService({ db: c.env.DB, auth, tenant: c.get('tenant') });
    const view = await service.checkInOwn(activityPublicId, participationPublicId, location);

    return ok(c, { attendance: view }, 201);
  },
);

/**
 * POST /api/v2/activities/:activityId/attendance/checkout —— 本人签退（S2-6h）。
 *
 * - 权限：attendance.record.checkout（D1 裁决；USER scope）。
 * - 只作用于【本人】【已签到】且【位于当前租户内】的考勤会话。
 * - 本阶段不提供签退他人考勤的入口：force_checkout 属 TEAM scope（attendance.record.force），留后续切片。
 */
activities.post(
  '/:activityId/attendance/checkout',
  requirePermission('attendance.record.checkout'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const activityPublicId = requireUlidParam(c.req.param('activityId'), 'activityId');
    const service = new ActivityAttendanceService({ db: c.env.DB, auth, tenant: c.get('tenant') });
    const view = await service.checkOutOwn(activityPublicId);

    return ok(c, { attendance: view });
  },
);

// =========================================================================
// P31-P1A：活动管理端（team-scoped）—— 创建 / 更新 / 发布。
// 权限：activity.activity.create / update / publish（D1 裁决）。
// team_id / created_by / 内部 id 全部服务端派生；隔离由 repo 层双重收口。
// =========================================================================

/** POST /api/v2/activities —— 团队管理员创建活动（含嵌套 occurrence/position/slot 物化）。 */
activities.post('/', requirePermission('activity.activity.create'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    throw invalidParam('request', 'invalid request body');
  }

  // P34-C2 §3：create 一律服务端权威（status/audit_status = DRAFT），客户端不得提交发布字段。
  assertNoForbiddenPublicationFields(body);

  const cmd: CreateActivityCommand = {
    title: body.title as string,
    summary: (body.summary as string) ?? null,
    start_time: body.start_time as number,
    end_time: body.end_time as number,
    signup_deadline: (body.signup_deadline as number) ?? null,
    quota: body.quota as number,
    status: body.status as number,
    max_session_minutes: (body.max_session_minutes as number) ?? null,
    occurrences: (body.occurrences as OccurrenceInput[]) ?? [],
  };

  const svc = new ActivityAdminService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const { public_id } = await svc.create(cmd);
  return ok(c, { activity: { public_id } }, 201);
});

/**
 * PUT /api/v2/activities/:id —— 团队管理员更新活动。
 * v1 仅标量字段；嵌套 occurrence/position/slot 重配置由 service 层显式拒绝。
 */
activities.put('/:id', requirePermission('activity.activity.update'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const publicId = requireUlidParam(c.req.param('id'), 'id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    throw invalidParam('request', 'invalid request body');
  }

  // P34-C2 §8：update 同样不得提交发布/审核字段（防止借 update 绕过审批）。
  assertNoForbiddenPublicationFields(body);

  // 透传原始 body 给 service：由 service 层裁决嵌套字段拒绝 + 标量校验（§5 v1 仅标量）。
  const patch = body as ActivityScalarUpdate;

  const svc = new ActivityAdminService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  await svc.update(publicId, patch);
  return ok(c, { activity: { public_id: publicId } });
});

// =========================================================================
// P34-C2：活动发布审核端点（submit / approve / reject）
//
// 冻结：
//   * 唯一正式发布路径 = approve（audit_status PENDING → APPROVED + status 1）。
//   * 原 direct publish 端点 `POST /:id/publish` 已从 runtime 移除（§9），
//     permission 定义 activity.activity.publish 保留于目录但不再授予发布能力。
//   * 职责分离（submitted_by / created_by != reviewer）在 service 层数据判定，403。
//   * 跨团队 / 不存在 / 已删除 → 404；无效状态跃迁 / 并发 → 409。
// =========================================================================

/** POST /api/v2/activities/:id/submit —— 提交发布审核（DRAFT / REJECTED → PENDING）。 */
activities.post('/:id/submit', requirePermission('activity.activity.submit'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const publicId = requireUlidParam(c.req.param('id'), 'id');

  const svc = new ActivityAdminService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const view = await svc.submit(publicId);
  return ok(c, { activity: view });
});

/** POST /api/v2/activities/:id/approve —— 审核通过并发布（PENDING → APPROVED + SIGNUP_OPEN）。 */
activities.post('/:id/approve', requirePermission('activity.activity.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const publicId = requireUlidParam(c.req.param('id'), 'id');

  const svc = new ActivityAdminService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const view = await svc.approve(publicId);
  return ok(c, { activity: view });
});

/**
 * POST /api/v2/activities/:id/reject —— 驳回（PENDING → REJECTED + DRAFT）。
 * body: { "reason": "..." }（trim 后 1–500 字符，空 / 超长 → 400）。
 */
activities.post('/:id/reject', requirePermission('activity.activity.review'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const publicId = requireUlidParam(c.req.param('id'), 'id');

  let reason: unknown;
  try {
    const body = await c.req.json();
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    reason = (body as Record<string, unknown>).reason;
  } catch {
    throw invalidParam('request', 'invalid request body');
  }

  const svc = new ActivityAdminService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const view = await svc.reject(publicId, reason);
  return ok(c, { activity: view });
});

export default activities;
