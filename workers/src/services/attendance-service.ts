/**
 * ActivityAttendanceService（S2-6h）—— 活动签到 use-case（本人签到 / 本人签退）。
 *
 * 分层（用户 §十八）：route（HTTP/校验） → authorization（middleware 权限裁决）
 *   → service/use-case（业务不变式 + 归属判定 + 编排） → repository（SQL + 租户范围）。
 * 本文件【不】做认证、不读 Cookie、不发响应；只做业务编排。
 *
 * 判定模型（RESOURCE-OWNERSHIP-RULES §7，与 S2-6g 同构）：
 *   Authenticated AND Permission AND Tenant Scope AND Ownership AND Business invariant
 *
 * 冻结权限码（唯一事实 = workers/scripts/permission-catalog.json，禁止新增/改名）：
 *   attendance.record.checkin  —— 本人签到（scopeType USER, risk LOW）
 *   attendance.record.checkout —— 本人签退（scopeType USER, risk LOW）
 *   force/review/anomaly 为 TEAM scope，本阶段不使用（管理员操作他人考勤属后续切片）。
 *
 * 范围纪律（用户 §三 / §十七）：本切片【只】实现本人签到/签退 + 最小 evidence 写入。
 * 不实现 force_checkout / review / anomaly / heartbeat / 设备指纹 / 风险打分。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { ActivityRepository } from '../repository/activities';
import { ActivitySignupRepository, SIGNUP_STATUS } from '../repository/activity-signups';
import { AttendanceSessionRepository, ATTENDANCE_STATUS } from '../repository/attendance-sessions';
import { AttendanceSessionOwnershipPolicy } from '../policies/ownership';
import { toBusinessDate } from '../utils/time';
import {
  authRequired,
  conflict,
  notFound,
  teamScopeRequired,
  ConflictReason,
} from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装，Service 不接触 HTTP 对象）。 */
export interface AttendanceServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export interface AttendanceView {
  session_id: number;
  signup_id: number;
  activity_id: number;
  user_id: number;
  status: number;
  checkin_at: number | null;
  checkout_at: number | null;
}

const ownershipPolicy = new AttendanceSessionOwnershipPolicy();

export class ActivityAttendanceService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;

  constructor(deps: AttendanceServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
  }

  /**
   * 公共前置：已认证 + 有 userId + 有合法团队上下文。
   * - 未认证 → 401；无团队上下文 → 403 TEAM_SCOPE_REQUIRED
   *   （attendance_sessions 为 TEAM_SCOPED，必须有团队上下文）。
   */
  private requireActor(): { userId: number; teamId: number } {
    const auth = this.auth;
    if (!auth.authenticated || auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: auth.userId, teamId: this.tenant.teamId };
  }

  private repos() {
    const ctx = { auth: this.auth, tenant: this.tenant };
    return {
      activities: new ActivityRepository({ db: this.db, ctx }),
      signups: new ActivitySignupRepository({ db: this.db, ctx }),
      attendance: new AttendanceSessionRepository({ db: this.db, ctx }),
    };
  }

  /**
   * 本人签到（POST /api/v2/activities/:activityId/attendance/checkin）。
   *
   * 顺序（§十九：任何一步失败都必须零写入）：
   * 1) 身份 + 团队上下文
   * 2) 活动存在 + 属于当前租户（跨团队 / 不存在 → 同一 404，不泄露存在性）
   * 3) 本人有效报名（status=1，经 activities 派生租户隔离）→ 无 → 409 NOT_SIGNED_UP
   *    （OPEN：是否要求活动处于"进行中"等特定状态，本切片不强校验 —— 见报告 §17）
 * 4) 重复签到预检（同报名的【活跃】会话命中）→ 409 ALREADY_CHECKED_IN。
 *    已签退（status=2）的会话不命中 —— 允许再次签到（R2 修复 1:1 误绑）。
 * 5) INSERT 会话（status=1，写入 service_date/slot 锚定本次参加实例）；
 *    uq_active_attendance（per-user 单一活跃会话）冲突（race）→ 409。
 * 6) 写最小 checkin 事件证据行（append-only）
 */
  async checkInOwn(activityPublicId: string): Promise<AttendanceView> {
    const { userId, teamId } = this.requireActor();
    const { activities, signups, attendance } = this.repos();

    // 2) 活动 + 租户范围（Repository 内已强制 team_id = tenant.teamId AND deleted_at IS NULL）。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);

    // 3) 本人有效报名（status=1）。无报名或非有效 → 409（不泄露是否存在他人报名）。
    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw conflict(ConflictReason.ATTENDANCE_NOT_SIGNED_UP);

    // 4) 重复签到预检：仅当同报名存在【活跃】会话时阻止（签退后可再次签到）。
    const existing = await attendance.findOwnActiveSession(signup.id, userId);
    if (existing != null) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN);

    // 5) INSERT。真正的并发防护 = uq_active_attendance（per-user 单一活跃会话）。
    //    service_date = UTC 当天（天粒度锚定本次参加实例，FROZEN 语义保留）；
    //    business_service_date = 业务自然日（Asia/Shanghai，来源 checkin_at = now）。
    const now = Math.floor(Date.now() / 1000);
    const serviceDate = Math.floor(now / 86400);
    const businessServiceDate = toBusinessDate(now);
    const sessionId = await attendance.insertCheckIn(
      signup.id,
      activity.id,
      userId,
      teamId,
      serviceDate,
      '',
      businessServiceDate,
      now,
    );

    // 6) 写最小证据行（append-only）。
    const nonce = `${sessionId}:checkin:${now}`;
    await attendance.insertEvent(sessionId, activity.id, userId, teamId, 'checkin', now, userId, nonce);

    return {
      session_id: sessionId,
      signup_id: signup.id,
      activity_id: activity.id,
      user_id: userId,
      status: ATTENDANCE_STATUS.CHECKED_IN,
      checkin_at: now,
      checkout_at: null,
    };
  }

  /**
   * 本人签退（POST /api/v2/activities/:activityId/attendance/checkout）。
   *
   * 顺序：
   * 1) 身份 + 团队上下文
   * 2) 活动存在 + 属于当前租户 → 404
   * 3) 本人有效报名 → 无 → 409 NOT_SIGNED_UP
   * 4) 本人考勤会话（user_id + team_id 双过滤）→ 无 → 409 CHECKIN_REQUIRED
   * 5) Ownership 策略（SELF）断言 → 不成立 → 404（不泄露存在）
   * 6) 已签退（status=2）→ 409 ALREADY_CHECKED_OUT（不被 UPDATE 0 命中掩盖）
   * 7) 原子 UPDATE（signup_id+user_id+team_id+status=1 同在 WHERE）→ 0 命中 → 409
   * 8) 写最小 checkout 事件证据行
   */
  async checkOutOwn(activityPublicId: string): Promise<AttendanceView> {
    const { userId, teamId } = this.requireActor();
    const { activities, signups, attendance } = this.repos();

    // 2) 活动 + 租户范围。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);

    // 3) 本人有效报名。
    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw conflict(ConflictReason.ATTENDANCE_NOT_SIGNED_UP);

    // 4) 本人【活跃】考勤会话（SELF + 租户双重过滤）。已签退会话不命中 → 409 CHECKIN_REQUIRED。
    const session = await attendance.findOwnActiveSession(signup.id, userId);
    if (session == null) throw conflict(ConflictReason.ATTENDANCE_CHECKIN_REQUIRED);

    // 5) Ownership（SELF）：策略判定失败直接 404，不泄露资源存在性（§六/§十三）。
    if (!ownershipPolicy.canAct(session, this.auth)) throw notFound('Attendance session');

    // 6) 已签退 → 409（不被步骤 7 的 0 命中掩盖）。
    if (session.status === ATTENDANCE_STATUS.CHECKED_OUT) {
      throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_OUT);
    }

    // 7) 原子签退（租户 + 归属 + 状态同在 WHERE）。
    const now = Math.floor(Date.now() / 1000);
    const ok = await attendance.checkOut(signup.id, userId, teamId, now);
    if (!ok) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_OUT);

    // 8) 写最小证据行。
    const nonce = `${session.id}:checkout:${now}`;
    await attendance.insertEvent(session.id, activity.id, userId, teamId, 'checkout', now, userId, nonce);

    return {
      session_id: session.id,
      signup_id: signup.id,
      activity_id: activity.id,
      user_id: userId,
      status: ATTENDANCE_STATUS.CHECKED_OUT,
      checkin_at: session.checkin_at,
      checkout_at: now,
    };
  }
}

/**
 * 报名有效状态（S2-6g 已定义，本切片复用，避免重复导入带来的循环依赖噪声）。
 * 仅作为文档锚点引用：check-in/out 都要求 signup.status === REGISTERED(1)。
 */
export const ATTENDANCE_REQUIRED_SIGNUP_STATUS = SIGNUP_STATUS.REGISTERED;
