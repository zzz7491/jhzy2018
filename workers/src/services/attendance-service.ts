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
import {
  AttendanceSessionRepository,
  ATTENDANCE_STATUS,
  type AttendanceSessionRow,
} from '../repository/attendance-sessions';
import { ParticipationRepository, PARTICIPATION_STATUS } from '../repository/participation';
import { AttendanceSessionOwnershipPolicy } from '../policies/ownership';
import { ServiceRecordService } from './service-record-service';
import { toBusinessDate } from '../utils/time';
import type { AttendanceLocation } from '../utils/location';
import {
  authRequired,
  conflict,
  notFound,
  teamScopeRequired,
  internalError,
  ConflictReason,
} from '../utils/errors';
import { assertVolunteerQualified } from '../services/volunteer-qualification-service';

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
  participation_id: number | null;
  participation_public_id: string | null;
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

  private repos(tenantOverride?: TenantContext) {
    const ctx = { auth: this.auth, tenant: tenantOverride ?? this.tenant };
    return {
      activities: new ActivityRepository({ db: this.db, ctx }),
      signups: new ActivitySignupRepository({ db: this.db, ctx }),
      attendance: new AttendanceSessionRepository({ db: this.db, ctx }),
      participation: new ParticipationRepository({ db: this.db, ctx }),
    };
  }

  /**
   * 本人签到（POST /api/v2/activities/:activityId/attendance/checkin）。
   *
   * 可观察校验顺序（P15 REV1 冻结；任何一步失败都必须零写入）：
   * 1) 身份 + 团队上下文                      → 401 / 403（requireActor）
   * 2) 权限（路由层 requirePermission）         → 401 / 403 / 500
   * 3) 请求体 participation_public_id 必填 + ULID（路由层；auth/permission 之后）
   * 4) Participation 租户隔离解析              → 404（不存在 / 跨团队同一响应）
   * 5) SELF 归属（signup_user_id === auth.userId）→ 404（与不存在同构，不泄露存在性）
   * 6) Signup 资格（REGISTERED + APPROVED）+ 路由活动一致性
   * 7) Activity 可用性（findSignupTargetByPublicId 已收口 team + deleted_at）
   * 8) Occurrence 可用性（status IN (1,2)）
   * 9) Slot / OccurrencePosition / Position / PSP 父级一致性
   * 10) 参与级活跃会话预检（findActiveByParticipation）
   * 11) 用户级活跃会话预检（findOwnActiveSessionAny）
   * 12) INSERT（写入 participation_id）
   * 13) UNIQUE 失败重分类（复查参与级 / 用户级活跃 → 409）
   */
  async checkInOwn(
    activityPublicId: string,
    participationPublicId: string,
    location: AttendanceLocation | null = null,
  ): Promise<AttendanceView> {
    const { userId, teamId } = this.requireActor();
    // P0-C：签到入口资格门（actor 本人必须已具备志愿者资格）。
    await assertVolunteerQualified(this.db, this.auth, this.tenant, userId);
    const { activities, signups, attendance, participation } = this.repos();

    // 2) 活动 + 租户范围（Repository 内已强制 team_id = tenant.teamId AND deleted_at IS NULL）。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);

    // 4) Participation 解析（经 signup→activity→team 派生隔离）。
    const p = await participation.findByPublicIdWithSignup(participationPublicId, teamId);
    if (p == null) throw notFound('Participation'); // 不存在 / 跨团队：统一 404

    // 5) SELF 归属：participation 必须属于当前用户本人。
    if (p.signup_user_id !== userId) throw notFound('Participation'); // 与不存在同构

    // 6) Signup 资格：本人有效报名（REGISTERED + APPROVED），且必须指向本路由活动。
    //    findOwnActiveSignup 已按 activity.id 过滤，故其返回即"本活动本人有效报名"；
    //    再断言 participation.signup_id === signup.id，确保 participation 确实挂靠在该 signup 上
    //    （否则 participation 指向他处，属不一致 → 404）。
    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw conflict(ConflictReason.ATTENDANCE_NOT_SIGNED_UP);
    if (p.signup_id !== signup.id) throw notFound('Participation'); // 挂靠 signup 不一致

    // participation 已取消（status=2 / cancelled_at 非空）→ 409（与 not_signed_up 区分）。
    if (p.status !== PARTICIPATION_STATUS.ASSIGNED || p.cancelled_at != null) {
      throw conflict(ConflictReason.ATTENDANCE_PARTICIPATION_NOT_ACTIVE);
    }

    // 8) Occurrence 可用性：status IN (1 scheduled, 2 in_progress)。
    const occ = await participation.resolveOccurrenceById(p.occurrence_id, teamId);
    if (occ == null || occ.status < 1 || occ.status > 2) {
      throw conflict(ConflictReason.PARENT_MISMATCH);
    }
    // occurrence 必须属于本活动（一致性防御）。
    if (occ.activity_id !== activity.id) throw conflict(ConflictReason.PARENT_MISMATCH);

    // 9) Slot / OccurrencePosition / Position / PSP 父级一致性（消费 Participation 的引用，
    //    不得仅信 participation 行而跳过跨父级检查）。
    if (p.slot_id != null) {
      const slot = await participation.resolveSlotById(p.slot_id, teamId);
      if (slot == null || slot.deleted_at != null || slot.occurrence_id !== p.occurrence_id) {
        throw conflict(ConflictReason.PARENT_MISMATCH);
      }
    }
    if (p.occurrence_position_id != null) {
      // opCompatibleWithOccurrence 已覆盖：op 活跃 + 同 occurrence + underlying activity_position
      // 同 activity 且活跃 + 团队隔离（P16 步骤 9 全部子校验）。
      const opOk = await participation.opCompatibleWithOccurrence(
        p.occurrence_position_id,
        p.occurrence_id,
        teamId,
      );
      if (!opOk) throw conflict(ConflictReason.PARENT_MISMATCH);
    }
    if (p.slot_id != null && p.occurrence_position_id != null) {
      // slot + op 同时给定：必须存在活跃 participation_slot_positions 配置。
      const pspOk = await participation.pspExists(p.slot_id, p.occurrence_position_id);
      if (!pspOk) throw conflict(ConflictReason.PARENT_MISMATCH);
    }

    // 10) 参与级活跃会话预检（uq_active_participation 快路径）。
    const activeByP = await attendance.findActiveByParticipation(p.id, userId, teamId);
    if (activeByP != null) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN);

    // 11) 用户级活跃会话预检（uq_active_attendance 快路径，跨活动/跨参与唯一闸门）。
    const activeByU = await attendance.findOwnActiveSessionAny(userId, teamId);
    if (activeByU != null) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN);

    // 12) INSERT。service_date = UTC 当天；business_service_date = Asia/Shanghai 业务自然日；
    //     slot 永远写 ''（P15 冻结：slot TEXT 为 legacy 快照，不写 slot.name）。
    //     参与级/用户级唯一性由 uq_active_participation / uq_active_attendance 兜底：
    //     insertCheckIn 内部已捕获 UNIQUE 冲突并收敛为 409 ATTENDANCE_ALREADY_CHECKED_IN
    //     （不依赖 SQLite 错误字符串区分索引名；两个约束共用同一 token）。
    //     快路径预检（步骤 10/11）已覆盖绝大多数重复；此处仅作并发兜底（race）。
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
      p.id,
    );

    // 写最小证据行（append-only）；nonce 仅为审计标记，非 session 唯一性机制。
    const nonce = `${sessionId}:checkin:${now}`;
    await attendance.insertEvent(
      sessionId,
      activity.id,
      userId,
      teamId,
      'checkin',
      now,
      userId,
      nonce,
      location ? location.latitude : null,
      location ? location.longitude : null,
      location ? location.accuracy ?? null : null,
    );

    return {
      session_id: sessionId,
      signup_id: signup.id,
      activity_id: activity.id,
      user_id: userId,
      participation_id: p.id,
      participation_public_id: p.public_id,
      status: ATTENDANCE_STATUS.CHECKED_IN,
      checkin_at: now,
      checkout_at: null,
    };
  }

  /**
   * 本人签退（POST /api/v2/activities/:activityId/attendance/checkout）。
   *
   * ── G1-CROSS-TEAM-CLOSEOUT：权威 team 来源 ──────────────────────────────
   * 冻结规则：ONE_VOLUNTEER_ONE_ACTIVE_SESSION = YES / ACTIVE_SESSION_SCOPE = GLOBAL_PER_USER。
   * 因此：只要 `GET /attendance-sessions/me` 返回 active=true，本端点【必须】允许签退，
   * 无论当前 X-Team-Id 是否等于该会话所属 team。签退所需的一切 team 归属
   * （tenant 过滤 / 事件 team_id / settlement / ServiceRecord）一律取自【会话自身 team_id】，
   * 而不是请求头 —— 否则跨团队会写入 TEAM_B 的错误业务记录（§3 / §7）。
   *
   * 分支策略（保证同队行为零回归）：
   *   - 无全局 active session                      → 走 checkOutOwnInTeam（原有路径，原错误语义）
   *   - 有 active session 但请求活动 ≠ 会话活动     → 走 checkOutOwnInTeam（原 404 / 409 分类不变）
   *   - 有 active session 且请求活动 == 会话活动    → 以会话 team 为权威完成签退（Case A / Case B）
   *
   * Case C（当前 X-Team-Id 为 null）：不予支持，也不绕过。
   *   attendance_sessions 在 S2-3 表矩阵中为 TEAM_SCOPED，BaseRepository.ensureTableRead →
   *   tenant-scope.ts::checkReadAccess 对 TEAM_SCOPED 恒定要求 auth.teamId != null，
   *   因此无团队上下文时 requireActor() 抛 403 TEAM_SCOPE_REQUIRED（与 G1 /me 完全一致的既有门禁）。
   *   绕过该 guard 等于破坏全局租户隔离，本轮不实施，作为 AUTH_TEAM_CONTEXT_BLOCKER 上报。
   *
   * 顺序（同队路径，与历史完全一致）：
   * 1) 身份 + 团队上下文
   * 2) 活动存在 + 属于当前租户 → 404
   * 3) 本人有效报名 → 无 → 409 NOT_SIGNED_UP
   * 4) 本人活跃考勤会话 → 无 → 409 CHECKIN_REQUIRED
   * 5) Ownership 策略（SELF）断言 → 不成立 → 404（不泄露存在）
   * 6) 已签退（status=2）→ 409 ALREADY_CHECKED_OUT
   * 7) 原子 UPDATE + 证据事件 + 强事务 settlement
   */
  async checkOutOwn(activityPublicId: string): Promise<AttendanceView> {
    const { userId, teamId } = this.requireActor();
    const { attendance } = this.repos();

    // 权威定位：authenticated user 自己的全局唯一 active session（GLOBAL_PER_USER）。
    const activeSession = await attendance.findOwnActiveSessionForCheckout(userId);

    // 分支 1/2：没有 active session，或请求的活动不是持有 active session 的那个活动
    // → 严格沿用既有（当前团队）路径，404 / 409 错误语义零变化（Case D / Case E）。
    if (activeSession == null || activeSession.activity_public_id !== activityPublicId) {
      return this.checkOutOwnInTeam(activityPublicId, userId, teamId);
    }

    // 分支 3：请求活动 == active session 的活动 → team 权威来源 = 会话自身（Case A / Case B）。
    const sessionTeamId = activeSession.team_id;
    const sessionTenant: TenantContext = { scope: 'TEAM_SCOPED', teamId: sessionTeamId, userId };

    // 本人有效报名（在会话真实 team 内解析；跨团队时不再是"当前团队查不到"）。
    const signup = await this.repos(sessionTenant).signups.findOwnActiveSignup(
      activeSession.activity_id,
      userId,
    );
    if (signup == null) throw conflict(ConflictReason.ATTENDANCE_NOT_SIGNED_UP);

    return this.finalizeCheckout({
      session: activeSession,
      signupId: signup.id,
      activityId: activeSession.activity_id,
      teamId: sessionTeamId,
      tenant: sessionTenant,
      userId,
    });
  }

  /**
   * 既有（当前团队）签退路径 —— 逐行保持 S2-6h 原始语义与错误分类，未做任何放宽。
   * 仅在「没有全局 active session」或「请求活动 ≠ active session 活动」时进入。
   */
  private async checkOutOwnInTeam(
    activityPublicId: string,
    userId: number,
    teamId: number,
  ): Promise<AttendanceView> {
    const { activities, signups, attendance } = this.repos();

    const activity = await activities.findSignupTargetByPublicId(activityPublicId);
    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw conflict(ConflictReason.ATTENDANCE_NOT_SIGNED_UP);

    const session = await attendance.findOwnActiveSession(signup.id, userId);
    if (session == null) throw conflict(ConflictReason.ATTENDANCE_CHECKIN_REQUIRED);

    return this.finalizeCheckout({
      session,
      signupId: signup.id,
      activityId: activity.id,
      teamId,
      tenant: this.tenant,
      userId,
    });
  }

  /**
   * 签退收口：Ownership → 已签退判定 → 原子写（事件 + UPDATE + settlement）。
   *
   * @param p.teamId   【权威】team —— 同队 = 当前团队；跨队 = 会话自身团队（§3 / §7）。
   * @param p.tenant   与 p.teamId 一致的 TenantContext，用于构造 repository / settlement service。
   */
  private async finalizeCheckout(p: {
    session: AttendanceSessionRow;
    signupId: number;
    activityId: number;
    teamId: number;
    tenant: TenantContext;
    userId: number;
  }): Promise<AttendanceView> {
    const { session, teamId, tenant, userId } = p;

    // Ownership（SELF）：策略判定失败直接 404，不泄露资源存在性（§六/§十三）。
    if (!ownershipPolicy.canAct(session, this.auth)) throw notFound('Attendance session');

    // 已签退 → 409（不被下方 0 命中掩盖）。
    if (session.status === ATTENDANCE_STATUS.CHECKED_OUT) {
      throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_OUT);
    }

    // 原子签退 + 证据事件 + 强事务 settlement（同批原子，P22-P3）。
    // nonce 同时作为 settlement 的 transition-gate（EXISTS 本次 transition event）。
    const now = Math.floor(Date.now() / 1000);
    const nonce = `checkout:${session.id}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;

    // settlement / 积分一律按【会话自身 team】归属 —— 绝不写入当前 TEAM_B（§7 downstream integrity）。
    const srService = new ServiceRecordService({ db: this.db, auth: this.auth, tenant });
    const settleStmts = await srService.buildSettleStatementWithPoints(
      session.id,
      teamId,
      'automatic',
      nonce,
      'checkout',
      null,
    );

    const ok = await this.repos(tenant).attendance.checkOutAtomically(
      p.signupId,
      userId,
      teamId,
      now,
      p.activityId,
      { nonce, extraStatements: settleStmts },
    );
    if (!ok) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_OUT);

    return {
      session_id: session.id,
      signup_id: p.signupId,
      activity_id: p.activityId,
      user_id: userId,
      participation_id: session.participation_id,
      participation_public_id: null,
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
