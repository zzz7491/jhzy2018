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
import { ActivityRepository } from '../repository/activities';
import { ActivitySignupService } from '../services/activity-signup-service';
import { ActivityAttendanceService } from '../services/attendance-service';
import { requirePermission } from '../middleware/rbac';
import { D1PermissionProvider } from '../services/permission-provider';
import { ok } from '../utils/response';
import { authRequired, invalidParam, AppError, ErrorCode } from '../utils/errors';
import { requireUlidParam, parsePagination, isUlid } from '../utils/validation';
import { parseAttendanceLocation, type AttendanceLocation } from '../utils/location';

const activities = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** GET /api/v2/activities —— 本团队活动列表（分页，page/page_size 上限 clamp）。 */
activities.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const pagination = parsePagination(c.req.query());
  const repo = new ActivityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const result = await repo.listByMyTeam(pagination.page, pagination.pageSize, pagination.offset);

  return ok(c, result);
});

/** GET /api/v2/activities/:id —— 本团队单个活动详情。 */
activities.get('/:id', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');
  const repo = new ActivityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const activity = await repo.findByPublicId(publicId);

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

export default activities;
