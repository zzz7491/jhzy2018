/**
 * ActivitySignupService锛圫2-6g 鈫?S2-NEW-ARCH-P21锛夆€斺€?娲诲姩鎶ュ悕 use-case銆? *
 * P21 鎺ョ嚎锛歴ignup 鍙€滅粦瀹氣€漃20 宸?submitted 鐨?form submission锛堜笉鍒涘缓/涓嶅鍒惰〃鍗曢€昏緫锛夈€? * - consumer policy 鍒ゅ畾璧?form_bindings.consume_policy锛? none / 1 optional / 2 required锛夈€? * - 琛ㄥ崟缁戝畾 = repo 鍗曟潯鍘熷瓙 INSERT鈥ELECT / UPDATE鈥orrelated predicates锛実uard 鍏ㄥ惈锛屼互 changes 鍒ゅ畾銆? * - 鍙栨秷=鍘熻 status=2锛涢噸鎶?reactivation锛坰tatus=2鈫?锛夛紝缁濅笉 INSERT 绗簩琛岋紙UNIQUE(user_id,activity_id)锛夈€? * - 璇绘姇褰辨寜鏉冮檺瑁佸壀锛圫ELF / TEAM review / submission answers,legacy form_data 闅愮锛夈€? */
import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { ActivityRepository } from '../repository/activities';
import {
  ActivitySignupRepository,
  type SignupReadRow,
  SIGNUP_REVIEW_STATUS,
  SIGNUP_STATUS,
} from '../repository/activity-signups';
import { FormEngineRepository, FORM_SUBMISSION_STATUS, FORM_CONSUME_POLICY } from '../repository/form-engine';
import { ActivitySignupOwnershipPolicy } from '../policies/ownership';
import {
  authRequired,
  conflict,
  notFound,
  notFoundReason,
  teamScopeRequired,
  internalError,
  invalidParam,
  ConflictReason,
} from '../utils/errors';
import { REJECT_REASON_MAX_LENGTH } from '../services/activity-admin-service';
import { NotificationService } from '../services/notification-service';
import { isUlid } from '../utils/validation';
import { assertVolunteerQualified } from '../services/volunteer-qualification-service';

/** 鏈嶅姟渚濊禆锛堢敱璺敱灞備粠 Context 缁勮锛孲ervice 涓嶆帴瑙?HTTP 瀵硅薄锛夈€?*/
export interface SignupServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export interface SignupView {
  id: number;
  activity_id: number;
  user_id: number;
  review_status: number;
  status: number;
  cancel_count: number;
}

export interface SignupCreateOptions {
  formSubmissionPublicId?: string;
}

/** N0-E0 审核结果最小 DTO（禁止暴露 internal reviewer user id）。 */
export interface SignupReviewView {
  signup: {
    id: number;
    review_status: number;
    review_at: number;
    review_reason: string | null;
  };
}

/** 璇绘姇褰辫鍓紑鍏筹紙鐢?route 缁忕湡瀹?PermissionProvider 璁＄畻锛岄潪瑙掕壊鍚嶇‖缂栫爜锛夈€?*/
export interface SignupReadOptions {
  includeAnswers: boolean;
  includeLegacyFormData: boolean;
}

const ownershipPolicy = new ActivitySignupOwnershipPolicy();

export class ActivitySignupService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;

  constructor(deps: SignupServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
  }

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
      forms: new FormEngineRepository({ db: this.db, ctx }),
    };
  }

  /**
   * 鎶ュ悕鍏ュ彛 = create + reapply锛圥21锛夈€?   * 淇℃伅娴侊細鏃?binding 鈫?legacy锛沺olicy none 鈫?legacy锛堝甫 submission 鈫?form_not_available锛夛紱
   * optional 鈫?鍙甫鍙己锛況equired 鈫?缂?submission 409銆?   */
async createOwn(activityPublicId: string, options: SignupCreateOptions = {}): Promise<SignupView> {
    const { userId } = this.requireActor();
    // P0-C：报名入口资格门（actor 本人必须已具备志愿者资格）。
    await assertVolunteerQualified(this.db, this.auth, this.tenant, userId);
    const { activities, signups } = this.repos();

    if (options.formSubmissionPublicId != null && !isUlid(options.formSubmissionPublicId)) {
      throw notFound('Form submission');
    }

    // P34-C3 blocker fix：创建新报名必须先过"报名资格"查询。
    // findSignupEligibleByPublicId 仅在 audit_status=APPROVED(2) AND status=SIGNUP_OPEN(1) 时返回，
    // 否则 404（与不可见态一致，不泄露活动存在性）。历史流程（cancel/读/attendance）仍走共享 lookup，不受影响。
    const activity = await activities.findSignupEligibleByPublicId(activityPublicId);
    if (activity.status !== 1) throw conflict(ConflictReason.ACTIVITY_SIGNUP_CLOSED);

    const binding = await this.resolvePolicy(activityPublicId);
    const policy = binding == null ? FORM_CONSUME_POLICY.NONE : binding.consume_policy;

    const existing = await signups.findOwnSignup(activity.id, userId);
    const now = Math.floor(Date.now() / 1000);

    if (existing == null) {
      // ---------- CREATE ----------
      if (policy === FORM_CONSUME_POLICY.REQUIRED && options.formSubmissionPublicId == null) {
        throw conflict(ConflictReason.SIGNUP_FORM_REQUIRED);
      }
      if (options.formSubmissionPublicId != null && policy === FORM_CONSUME_POLICY.NONE) {
        throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
      }
      if (options.formSubmissionPublicId != null) {
        // 本请求成功 sentinel = INSERT 实际命中行数（meta.changes）。
        // 严禁用 findOwnSignup 的"存在性"判成功：并发报名竞争时 request B 的 INSERT 0 行，
        // 但随后会读到 request A 的 active signup，若以"存在即成功"会误报 200（false-success）。
        const created = await signups.insertSignupWithFormAtomically({
          activityPublicId,
          userId,
          teamId: this.tenant.teamId!,
          submissionPublicId: options.formSubmissionPublicId,
          now,
        });
        if (created !== 1) {
          // INSERT 未实际发生（并发报名已存在 / submission 已被占用 / 证据不合法）→ 安全重分类为 409/404。
          await this.reclassifyFormBindFail(activityPublicId, userId, options.formSubmissionPublicId!);
          throw internalError(); // reclassifyFormBindFail 必然抛错，此行不可达
        }
        const fresh = await signups.findOwnSignup(activity.id, userId);
        if (fresh == null) throw internalError();
        return this.toView(fresh.id, activity.id, userId, fresh.review_status, SIGNUP_STATUS.REGISTERED, fresh.cancel_count);
      }
      const reviewStatus = activity.need_audit === 1 ? SIGNUP_REVIEW_STATUS.PENDING : SIGNUP_REVIEW_STATUS.APPROVED;
      await signups.insertSignup(activity.id, userId, reviewStatus, now);
      const fresh = await signups.findOwnSignup(activity.id, userId);
      if (fresh == null) throw internalError();
      return this.toView(fresh.id, activity.id, userId, fresh.review_status, SIGNUP_STATUS.REGISTERED, fresh.cancel_count);
    }

    // ---------- REAPPLY（reaction：原行 status=2→1，不 INSERT 第二行）----------
    if (existing.status === SIGNUP_STATUS.REGISTERED) throw conflict(ConflictReason.SIGNUP_ALREADY_EXISTS);
    if (policy === FORM_CONSUME_POLICY.REQUIRED && options.formSubmissionPublicId == null) {
      throw conflict(ConflictReason.SIGNUP_FORM_REQUIRED);
    }
    if (options.formSubmissionPublicId != null && policy === FORM_CONSUME_POLICY.NONE) {
      throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    }
    if (options.formSubmissionPublicId != null) {
      const subId = await this.ensureBindable(activityPublicId, userId, options.formSubmissionPublicId, existing.id);
      await signups.reactivateSignupWithGivenSubmissionAtomically({
        activityPublicId,
        userId,
        teamId: this.tenant.teamId!,
        submissionId: subId,
        now,
      });
      const fresh = await signups.findOwnSignup(activity.id, userId);
      if (fresh == null || fresh.status !== SIGNUP_STATUS.REGISTERED) {
        await this.reclassifyFormBindFail(activityPublicId, userId, options.formSubmissionPublicId!, existing.id);
        throw internalError();
      }
      return this.toView(fresh.id, activity.id, userId, fresh.review_status, SIGNUP_STATUS.REGISTERED, fresh.cancel_count);
    }
    await signups.reactivateSignupAtomically({ activityPublicId, userId, teamId: this.tenant.teamId!, now });
    const fresh = await signups.findOwnSignup(activity.id, userId);
    if (fresh == null || fresh.status !== SIGNUP_STATUS.REGISTERED) throw internalError();
    return this.toView(fresh.id, activity.id, userId, fresh.review_status, SIGNUP_STATUS.REGISTERED, fresh.cancel_count);
  }

  /** 鍙栨秷鏈汉鎶ュ悕锛堝師琛?status 2锛涗笉鏀?form_submission 鐘舵€侊級銆?*/
  async cancelOwn(activityPublicId: string): Promise<SignupView> {
    const { userId } = this.requireActor();
    const { activities, signups } = this.repos();

    const activity = await activities.findSignupTargetByPublicId(activityPublicId);
    if (activity.allow_cancel !== 1) throw conflict(ConflictReason.ACTIVITY_CANCEL_NOT_ALLOWED);

    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw notFound('Signup');
    if (!ownershipPolicy.canAct(signup, this.auth)) throw notFound('Signup');

    const now = Math.floor(Date.now() / 1000);
    const cancelled = await signups.cancelOwnSignup(signup.id, activity.id, userId, now);
    if (!cancelled) throw notFound('Signup');

    return {
      id: signup.id,
      activity_id: activity.id,
      user_id: userId,
      review_status: signup.review_status,
      status: SIGNUP_STATUS.CANCELLED,
      cancel_count: signup.cancel_count + 1,
    };
  }

  /** 娑堣垂绛栫暐瑙ｆ瀽锛氭棤 active binding 鈫?null锛堢瓑浠?policy none锛夈€?*/
  /**
   * N0-E0：报名审核状态机（PENDING(0) → APPROVED(1) / REJECTED(2)）。
   *
   * 纪律（用户 §3 / §5 / §7 / §13）：
   * - 仅允许 PENDING → APPROVED 或 PENDING → REJECTED；其余跃迁一律禁止。
   * - repository 条件 UPDATE 强制 `review_status = 0` guard，并以 `changes === 1` 判定本次跃迁真正成功；
   *   重复 / 并发 / 跨团队 / 不存在均不产生第二次状态变化。
   * - 不接通知（不调用 NotificationService）、不接微信（不调用 WeChatSubscribeAdapter）、不写 notification_deliveries。
   * - 复用 ActivityAdminService 的 permission / tenant / transition / race / reason 校验风格，
   *   但【不】复制 assertNotSelfReview（本轮未冻结 signup 自审产品规则，§5）。
   * - review_by / review_at 全部服务端派生：review_by = 当前认证操作者；review_at = 服务端时间戳。
   * - 前端不得传 team_id / user_id / review_by / review_at（§6 / §8）。
   */
  async reviewSignup(
    activityPublicId: string,
    signupId: number,
    decision: 'approve' | 'reject',
    rawReason?: unknown,
  ): Promise<SignupReviewView> {
    const { userId } = this.requireActor();

    if (decision !== 'approve' && decision !== 'reject') {
      throw invalidParam('decision', 'must be "approve" or "reject"');
    }

    // reason 归一化（镜像 ActivityAdminService.reject 风格）：
    // - REJECT：reason 必填，trim 后 1..500；空 / 超长 → 400。
    // - APPROVE：reason 可选；提供则 trim，空串归并为 NULL，1..500 长度校验。
    let reviewReason: string | null = null;
    if (decision === 'reject') {
      if (typeof rawReason !== 'string') {
        throw invalidParam('reason', 'required non-empty string (1..500 chars)');
      }
      const trimmed = rawReason.trim();
      if (trimmed === '' || trimmed.length > REJECT_REASON_MAX_LENGTH) {
        throw invalidParam('reason', `required non-empty string, max ${REJECT_REASON_MAX_LENGTH} chars`);
      }
      reviewReason = trimmed;
    } else if (rawReason != null) {
      if (typeof rawReason !== 'string') {
        throw invalidParam('reason', 'must be string when provided');
      }
      const trimmed = rawReason.trim();
      reviewReason = trimmed === '' ? null : trimmed;
    }

    const { activities, signups } = this.repos();

    // 活动解析：TEAM_SCOPED（跨团队 / 不存在 → 404，不泄露存在性）。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);
    if (activity == null) throw notFound('Activity');

    // 报名解析：TEAM_SCOPED 派生隔离（跨团队 / 不存在 → 404，不泄露存在性）。
    const signup = await signups.findReviewableByIdForTeam(signupId, activity.id);
    if (signup == null) throw notFound('Signup');

    const targetReviewStatus =
      decision === 'approve' ? SIGNUP_REVIEW_STATUS.APPROVED : SIGNUP_REVIEW_STATUS.REJECTED;
    const now = Math.floor(Date.now() / 1000);

    // N0-E1：业务事件契约（IN_APP only）。一次报名只产生 APPROVED 或 REJECTED 之一，
    // 与本次唯一 PENDING 跃迁一一对应。
    const approved = decision === 'approve';
    const eventType = approved ? 'ACTIVITY_SIGNUP_APPROVED' : 'ACTIVITY_SIGNUP_REJECTED';
    const baseIdempotencyKey = `activity.signup.${approved ? 'approved' : 'rejected'}:${signup.id}`;

    // payload 只使用现存数据（最小化；不含 contact / checkin / phone / openid / nickname fallback）。
    const payload: Record<string, unknown> = {
      activity_public_id: activityPublicId,
      signup_id: signup.id,
    };
    if (!approved && reviewReason != null) payload.review_reason = reviewReason;

    // N0-E1：共享 PRE-state 谓词门（业务域构造）→ 通知创建计划（Notification Core 负责
    // 校验 / 归一化 / `:u<userId>` 幂等键；业务侧不复制这些规则，§4）。
    // 通知 INSERT + recipient INSERT + review UPDATE 放入同一 db.batch：
    //   P 真 → 1 transition / 1 notification / 1 recipient；P 假 → 0 / 0 / 0。
    const gate = signups.buildReviewGate({ signupId: signup.id, activityId: activity.id });
    const notificationPlan = new NotificationService({
      db: this.db,
      auth: this.auth,
      tenant: this.tenant,
    }).buildCreationPlan(
      {
        recipientUserIds: [signup.user_id],
        idempotencyKey: baseIdempotencyKey,
        eventType,
        category: 'activity',
        title: approved ? '报名审核通过' : '报名未通过',
        teamId: activity.team_id,
        businessEntityType: 'activity_signup',
        businessEntityId: signup.id,
        targetPage: `/pages/detail/detail?id=${activityPublicId}`,
        payload,
        createdBy: userId,
      },
      gate,
    );

    // 单次原子 batch：gated notification / recipient INSERT 在前，guarded review UPDATE 在最后；
    // transition 真相以 UPDATE 的 changes === 1 判定。
    const changes = await signups.reviewSignupAtomically({
      signupId: signup.id,
      activityId: activity.id,
      targetReviewStatus,
      reviewBy: userId,
      reviewAt: now,
      reviewReason,
      notificationStatements: notificationPlan.statements,
    });
    if (changes !== 1) {
      // 区分后续：行已非 PENDING（重复 / 竞态后续请求）→ 409 transition；行消失 → 404。
      // 因共享谓词门控，此时通知 / recipient 均为 0 行（零副作用）。
      const after = await signups.findReviewableByIdForTeam(signup.id, activity.id);
      if (after == null) throw notFound('Signup');
      if (after.review_status !== SIGNUP_REVIEW_STATUS.PENDING) {
        throw conflict(ConflictReason.SIGNUP_REVIEW_TRANSITION);
      }
      throw conflict(ConflictReason.SIGNUP_REVIEW_RACE);
    }

    return {
      signup: {
        id: signup.id,
        review_status: targetReviewStatus,
        review_at: now,
        review_reason: reviewReason,
      },
    };
  }

  private async resolvePolicy(activityPublicId: string) {
    const { forms } = this.repos();
    return forms.resolveBindingForConsumer(this.tenant.teamId!, 'activity.signup', activityPublicId);
  }

  /** 提交前完整校验（reapply-with-form 用）：返回可绑定 submission.id 或抛出对应 token。 */
  private async ensureBindable(
    activityPublicId: string,
    userId: number,
    submissionPublicId: string,
    excludeSignupId?: number,
  ): Promise<number> {
    const { signups, forms } = this.repos();
    const sub = await forms.findSubmissionByPublicIdTeamScope(submissionPublicId, this.tenant.teamId!);
    if (sub == null) throw notFound('Form submission');
    if (sub.status !== FORM_SUBMISSION_STATUS.SUBMITTED || sub.submitter_user_id !== userId) {
      throw notFound('Form submission');
    }
    if (sub.consumer_type !== 'activity.signup' || sub.consumer_public_id !== activityPublicId) {
      throw conflict(ConflictReason.PARENT_MISMATCH);
    }
    const def = await forms.resolveDefinitionById(sub.definition_id, this.tenant.teamId!);
    if (def == null || def.status !== 2) throw notFound('Form submission');
    const published = await forms.resolvePublishedVersion(def.id, this.tenant.teamId!);
    if (published == null || published.id !== sub.version_id) throw conflict(ConflictReason.FORM_VERSION_STALE);
    const binding = await forms.resolveBindingForConsumer(this.tenant.teamId!, 'activity.signup', activityPublicId);
    if (binding == null || binding.consume_policy === FORM_CONSUME_POLICY.NONE || binding.definition_id !== def.id) {
      throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    }
    const used = await signups.countFormSubmissionUsages(sub.id, excludeSignupId);
    if (used > 0) throw conflict(ConflictReason.FORM_SUBMISSION_DUPLICATE);
    return sub.id;
  }

  /** 0 changes 鍚庣殑瀹夊叏閲嶅垎绫伙紙涓嶆硠闇插唴閮級銆?*/
  private async reclassifyFormBindFail(activityPublicId: string, userId: number, submissionPublicId: string, excludeSignupId?: number): Promise<never> {
    const { signups, forms } = this.repos();
    const existing = await this.findOwnSignupByActivity(activityPublicId, userId);
    if (existing != null && existing.status === SIGNUP_STATUS.REGISTERED) {
      throw conflict(ConflictReason.SIGNUP_ALREADY_EXISTS);
    }
const sub = await forms.findSubmissionByPublicIdTeamScope(submissionPublicId, this.tenant.teamId!);
    if (sub == null) throw notFound('Form submission');
    if (sub.status !== FORM_SUBMISSION_STATUS.SUBMITTED || sub.submitter_user_id !== userId) {
      throw notFound('Form submission');
    }
    if (sub.consumer_type !== 'activity.signup' || sub.consumer_public_id !== activityPublicId) {
      throw conflict(ConflictReason.PARENT_MISMATCH); // 鍏跺畠 activity 鐨?submission
    }
    const def = await forms.resolveDefinitionById(sub.definition_id, this.tenant.teamId!);
    if (def == null || def.status !== 2) throw notFound('Form submission');
    const published = await forms.resolvePublishedVersion(def.id, this.tenant.teamId!);
    if (published == null || published.id !== sub.version_id) throw conflict(ConflictReason.FORM_VERSION_STALE);
    const binding = await forms.resolveBindingForConsumer(this.tenant.teamId!, 'activity.signup', activityPublicId);
    if (binding == null || binding.consume_policy === FORM_CONSUME_POLICY.NONE || binding.definition_id !== def.id) {
      throw notFoundReason(ConflictReason.FORM_NOT_AVAILABLE);
    }
    const used = await signups.countFormSubmissionUsages(sub.id, excludeSignupId);
    if (used > 0) throw conflict(ConflictReason.FORM_SUBMISSION_DUPLICATE);
    throw internalError();
  }

  private async findOwnSignupByActivity(activityPublicId: string, userId: number) {
    const { activities, signups } = this.repos();
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);
    if (activity == null) return null;
    return signups.findOwnSignup(activity.id, userId);
  }

  private toView(id: number, activityId: number, userId: number, reviewStatus: number, status: number, cancelCount: number): SignupView {
    return { id, activity_id: activityId, user_id: userId, review_status: reviewStatus, status, cancel_count: cancelCount };
  }

  // ================= P21 璇绘姇褰?=================

  /** SELF signup 璇︽儏銆?*/
  async getOwnSignupDetail(activityPublicId: string, opts: SignupReadOptions): Promise<Record<string, unknown> | null> {
    const { userId, teamId } = this.requireActor();
    const { activities, signups } = this.repos();
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);
    if (activity == null) throw notFound('Activity');
    const row = await signups.findOwnSignupDetail(activity.id, userId, teamId);
    if (row == null) throw notFound('Signup');
    return this.buildReadView(row, opts);
  }

  /** TEAM 鎸囧畾鐢ㄦ埛 signup 璇︽儏銆?*/
  async getSignupDetailByUser(activityPublicId: string, userPublicId: string, opts: SignupReadOptions): Promise<Record<string, unknown> | null> {
    const { teamId } = this.requireActor();
    const { signups } = this.repos();
    const row = await signups.findSignupDetailByUser(activityPublicId, userPublicId, teamId);
    if (row == null) throw notFound('Signup');
    return this.buildReadView(row, opts);
  }

  /** TEAM signup 鍒楄〃锛堥粯璁や笉杩斿洖 answers/schema/legacy form_data锛夈€?*/
  async listSignups(activityPublicId: string, page: number, pageSize: number): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const { teamId } = this.requireActor();
    const { signups } = this.repos();
    const opts: SignupReadOptions = { includeAnswers: false, includeLegacyFormData: false };
    const limit = Math.max(1, Math.min(pageSize, 100));
    const offset = (page - 1) * limit;
    const items = await signups.listSignupsForTeam(activityPublicId, teamId, limit, offset);
    return {
      items: items.map((r) => this.buildReadView(r, opts)),
      total: items.length === limit ? offset + items.length : -1,
    };
  }

  private buildReadView(row: SignupReadRow, opts: SignupReadOptions): Record<string, unknown> {
    const view: Record<string, unknown> = {
      activity_public_id: row.activity_public_id,
      user_public_id: row.user_public_id,
      signup: {
        id: row.id,
        review_status: row.review_status,
        status: row.status,
        cancel_count: row.cancel_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      form_submission:
        row.submission_public_id != null
          ? { public_id: row.submission_public_id, status: row.submission_status, version_public_id: row.version_public_id }
          : null,
    };
    if (opts.includeAnswers && row.submission_public_id != null) {
      let answers: unknown = null;
      let schema: unknown = null;
      try { answers = JSON.parse(row.answers_json ?? 'null'); } catch { answers = null; }
      try { schema = JSON.parse(row.version_schema_json ?? 'null'); } catch { schema = null; }
      view.answers = answers;
      view.schema = schema;
    }
    if (opts.includeLegacyFormData && row.form_data != null) {
      try { view.legacy_form_data = JSON.parse(row.form_data); } catch { view.legacy_form_data = null; }
    }
    return view;
  }
}

/**
 * activities.status 涓?寮€鏀炬姤鍚?鐨勫彇鍊硷紙0鑽夌/1鎶ュ悕涓?2杩涜涓?3宸茬粨鏉?4宸插彇娑?5宸蹭笅鏋讹級銆? */
export const ACTIVITY_STATUS_SIGNUP_OPEN = 1;
