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
  ConflictReason,
} from '../utils/errors';
import { isUlid } from '../utils/validation';

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
