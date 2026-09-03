/**
 * ActivitySignupService（S2-6g）—— 活动报名 use-case（创建 / 取消本人报名）。
 *
 * 分层（用户 §十八）：route（HTTP/校验） → authorization（middleware 权限裁决）
 *   → service/use-case（业务不变式 + 归属判定 + 编排） → repository（SQL + 租户范围）。
 * 本文件【不】做认证、不读 Cookie、不发响应；只做业务编排。
 *
 * 判定模型（RESOURCE-OWNERSHIP-RULES §7）：
 *   Authenticated AND Permission AND Tenant Scope AND Ownership AND Business invariant
 *
 * 冻结权限码（唯一事实 = workers/scripts/permission-catalog.json，禁止新增/改名）：
 *   signup.signup.create  —— 报名活动（scopeType USER, risk LOW）
 *   signup.signup.cancel  —— 取消自己的报名（scopeType USER, risk LOW）
 *   signup.signup.review  —— 审核活动报名（scopeType TEAM，本阶段不使用：审核 ≠ 取消他人）
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { ActivityRepository } from '../repository/activities';
import {
  ActivitySignupRepository,
  SIGNUP_REVIEW_STATUS,
  SIGNUP_STATUS,
} from '../repository/activity-signups';
import { ActivitySignupOwnershipPolicy } from '../policies/ownership';
import { authRequired, conflict, notFound, teamScopeRequired, ConflictReason } from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装，Service 不接触 HTTP 对象）。 */
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

  /**
   * 公共前置：已认证 + 有 userId + 有合法团队上下文。
   * - 未认证 → 401（与 middleware 语义一致，双保险）。
   * - 无团队上下文 → 403 TEAM_SCOPE_REQUIRED（activity_signups 为 TEAM_SCOPED 派生表）。
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
    };
  }

  /**
   * 报名创建（POST /api/v2/activities/:activityId/signups）。
   *
   * 顺序（§十九：任何一步失败都必须零写入）：
   * 1) 身份 + 团队上下文
   * 2) 活动存在 + 属于当前租户（跨团队 / 不存在 → 同一 404，不泄露存在性）
   * 3) 业务不变式：activities.status = 1（报名中）→ 否则 409
   * 4) 重复报名预检（快路径）→ 409
   * 5) INSERT（真正的重复防护 = UNIQUE(user_id, activity_id)，race → 409）
   */
  async createOwn(activityPublicId: string): Promise<SignupView> {
    const { userId } = this.requireActor();
    const { activities, signups } = this.repos();

    // 2) 活动 + 租户范围（Repository 内已强制 team_id = tenant.teamId AND deleted_at IS NULL）。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);

    // 3) 业务不变式：仅"报名中"状态开放报名。
    //    字典来源：docs/嘉禾志愿2.0数据库设计方案V1.0.md §4.2 activities.status（0草稿/1报名中/2进行中/3已结束/4已取消/5已下架）。
    if (activity.status !== ACTIVITY_STATUS_SIGNUP_OPEN) {
      throw conflict(ConflictReason.ACTIVITY_SIGNUP_CLOSED);
    }

    // 4) 重复报名预检（UNIQUE 覆盖全 status，故预检也不限定 status）。
    const existing = await signups.findOwnSignup(activity.id, userId);
    if (existing != null) throw conflict(ConflictReason.SIGNUP_ALREADY_EXISTS);

    // 5) INSERT。review_status 由 activities.need_audit 决定
    //    （证据：docs/嘉禾志愿V2.0 最终产品与技术架构蓝图V1.0.md ——「活动免审 → 报名成功 / 活动需审 → 待审核」）。
    const reviewStatus =
      activity.need_audit === 1 ? SIGNUP_REVIEW_STATUS.PENDING : SIGNUP_REVIEW_STATUS.APPROVED;
    const now = Math.floor(Date.now() / 1000);
    const id = await signups.insertSignup(activity.id, userId, reviewStatus, now);

    return {
      id,
      activity_id: activity.id,
      user_id: userId,
      review_status: reviewStatus,
      status: SIGNUP_STATUS.REGISTERED,
      cancel_count: 0,
    };
  }

  /**
   * 取消本人报名（DELETE /api/v2/activities/:activityId/signups/me）。
   *
   * 顺序：
   * 1) 身份 + 团队上下文
   * 2) 活动存在 + 属于当前租户 → 404
   * 3) 业务不变式：activities.allow_cancel = 1（RESOURCE-OWNERSHIP-RULES §3 明示约束）→ 否则 409
   * 4) 查本人有效报名（status=1，经 activities 派生租户隔离）→ 无 → 404
   * 5) Ownership 策略判定（signup.user_id === auth.userId）→ 不成立 → 404（不泄露存在）
   * 6) 原子 UPDATE（租户 + 归属 + 状态在同一 WHERE）→ 0 命中 → 404
   *
   * §十九：步骤 5 之前不产生任何写；步骤 6 的 WHERE 自带归属与租户条件，
   *        因此归属/租户不成立时 changes = 0 —— 无 UPDATE、无 status 变化、无副作用。
   */
  async cancelOwn(activityPublicId: string): Promise<SignupView> {
    const { userId } = this.requireActor();
    const { activities, signups } = this.repos();

    // 2) 活动 + 租户范围。
    const activity = await activities.findSignupTargetByPublicId(activityPublicId);

    // 3) 冻结不变式：allow_cancel = 0 的活动禁止取消（RESOURCE-OWNERSHIP-RULES §3）。
    if (activity.allow_cancel !== 1) {
      throw conflict(ConflictReason.ACTIVITY_CANCEL_NOT_ALLOWED);
    }

    // 4) 本人有效报名（已取消 → 查不到 → 404，符合"取消是单向终态"的冻结语义）。
    const signup = await signups.findOwnActiveSignup(activity.id, userId);
    if (signup == null) throw notFound('Signup');

    // 5) Ownership（SELF）：策略判定失败直接 404，不泄露资源存在性（§六/§十三）。
    if (!ownershipPolicy.canAct(signup, this.auth)) throw notFound('Signup');

    // 6) 原子取消（租户 + 归属 + 状态同在 WHERE）。
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
}

/**
 * activities.status 中"开放报名"的取值。
 * 字典来源：docs/嘉禾志愿2.0数据库设计方案V1.0.md §4.2（0草稿/1报名中/2进行中/3已结束/4已取消/5已下架）。
 * 本阶段只实现"报名中"；其余状态是否允许报名属 OPEN BUSINESS RULE（见报告 §17）。
 */
export const ACTIVITY_STATUS_SIGNUP_OPEN = 1;
