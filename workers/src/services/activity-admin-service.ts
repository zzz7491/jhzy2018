/**
 * ActivityAdminService（P31-P1A）—— 活动管理端业务逻辑层。
 *
 * 纪律（与全仓一致）：
 * - team_id / created_by / 内部 numeric id 一律由服务端派生（R1 铁律），
 *   绝不接受客户端提交的 team_id / 内部 id / creator_user_id。
 * - 租户隔离由 Repository 层（WHERE team_id = ?）二次收口；PermissionProvider
 *   只裁决"能否执行动作"。
 * - 创建采用「先全量校验、后原子批写」：校验失败在 batch 之前抛出，DB 不留半成品；
 *   batch 内任一语句失败整批回滚（§4 原子性）。
 * - 更新 v1 仅支持标量字段；嵌套 occurrence/position/slot 重配置显式拒绝
 *   （避免破坏既有 participation 的 FK/业务一致性，§5）。
 * - P34-C2：发布不再有 direct publish runtime path。唯一正式发布路径 = approve
 *   （audit_status PENDING → APPROVED 且 status → SIGNUP_OPEN）；
 *   创建恒为草稿（status=0 / audit_status=0），任何业务编辑统一回到草稿待审（UNIFORM RE-REVIEW）。
 * - N0-F2：submit / approve / reject 三者改为「跃迁 + audit log（+ approve/reject 的 IN_APP 通知）
 *   同一 db.batch 原子提交」（repository 层谓词门控，UPDATE 恒在最后）；不存在
 *   「UPDATE 成功但 audit log / 通知失败」的部分成功窗口。发布审核结果通知仅 IN_APP
 *   （WECHAT = DEFERRED，见 planPublicationNotification）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  ActivityRepository,
  type CreateActivityCommand,
  type ActivityScalarUpdate,
  type OccurrenceInput,
  type PositionInput,
  type SlotInput,
} from '../repository/activities';
import {
  invalidParam,
  authRequired,
  teamScopeRequired,
  notFound,
  forbidden,
  conflict,
  ConflictReason,
  internalError,
} from '../utils/errors';
import { ACTIVITY_AUDIT, ACTIVITY_STATUS, type ActivityApprovalState } from '../repository/activities';
import { NotificationService, type NotificationCreationPlan } from './notification-service';
import { buildActivityDetailTarget } from '../utils/notification-target';
import type { NotificationInsertGate } from '../repository/notification';
import type { RepositoryContext } from '../types/tenant';

export interface ActivityAdminDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

/** 驳回原因长度上限（P34-B §E 冻结：trim 后 1–500 字符）。 */
export const REJECT_REASON_MAX_LENGTH = 500;

/**
 * 活动主地址长度上限（N0-E5A）。
 *
 * 人类可读地址（如「浙江省嘉兴市南湖区某某路 1 号」）以 200 字符为上限；
 * 沿用本文件既有「常量 + trim 后判长」的字符串校验风格（对照 REJECT_REASON_MAX_LENGTH）。
 */
export const ACTIVITY_ADDRESS_MAX_LENGTH = 200;

/** 审核结果最小 DTO（禁止 internal id / 审核人 numeric id，§14）。 */
export interface ActivityApprovalView {
  activity_public_id: string;
  status: number;
  audit_status: number;
  submitted_at: number | null;
  reviewed_at: number | null;
  reject_reason: string | null;
}

export class ActivityAdminService {
  private readonly repo: ActivityRepository;
  private readonly ctx: RepositoryContext;
  private readonly db: D1Database;

  constructor(deps: ActivityAdminDeps) {
    this.repo = new ActivityRepository(deps);
    this.ctx = deps.ctx;
    this.db = deps.db;
  }

  // ===== 嵌套结构校验（全部在 batch 之前完成）=====

  private validateSlot(slot: SlotInput, path: string): void {
    if (typeof slot.name !== 'string' || slot.name.trim() === '') {
      throw invalidParam(`${path}.name`, 'required non-empty string');
    }
    if (typeof slot.start_time !== 'number' || typeof slot.end_time !== 'number') {
      throw invalidParam(`${path}.start_time/end_time`, 'required epoch seconds');
    }
    if (slot.start_time >= slot.end_time) {
      throw invalidParam(`${path}.start_time`, 'must be < end_time');
    }
    if (slot.capacity !== undefined && (typeof slot.capacity !== 'number' || slot.capacity < 0)) {
      throw invalidParam(`${path}.capacity`, 'must be >= 0');
    }
  }

  private validatePosition(pos: PositionInput, base: string): void {
    if (typeof pos.name !== 'string' || pos.name.trim() === '') {
      throw invalidParam(`${base}.name`, 'required non-empty string');
    }
    if (pos.description !== undefined && typeof pos.description !== 'string') {
      throw invalidParam(`${base}.description`, 'must be string');
    }
    if (pos.required_count !== undefined && (typeof pos.required_count !== 'number' || pos.required_count < 0)) {
      throw invalidParam(`${base}.required_count`, 'must be >= 0');
    }
    (pos.slots ?? []).forEach((s, i) => this.validateSlot(s, `${base}.slots[${i}]`));
  }

  private validateOccurrence(occ: OccurrenceInput, idx: number): void {
    const p = `occurrences[${idx}]`;
    if (typeof occ.start_time !== 'number' || typeof occ.end_time !== 'number') {
      throw invalidParam(`${p}.start_time/end_time`, 'required epoch seconds');
    }
    if (occ.start_time >= occ.end_time) {
      throw invalidParam(`${p}.start_time`, 'must be < end_time');
    }
    (occ.positions ?? []).forEach((pos, i) => this.validatePosition(pos, `${p}.positions[${i}]`));
    (occ.slots ?? []).forEach((s, i) => this.validateSlot(s, `${p}.slots[${i}]`));
  }

  /**
   * 活动主地址规范化（N0-E5A §4）——单一 SSOT。
   *
   * - undefined / null → null（未填写）
   * - 非 string（number / object / array / bool）→ 400 INVALID_PARAM（不静默强转）
   * - trim 后为空串 → null（空白输入等同未填写）
   * - trim 后长度 > ACTIVITY_ADDRESS_MAX_LENGTH → 400
   * - 其余 → trim 后的字符串
   *
   * 注意：只处理 address 本身；province / city / district / lat / lng 一律不参与，
   * 也不做任何地址拼接（N0-E5A §3）。
   */
  private normalizeAddress(raw: unknown, field: string): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
      throw invalidParam(field, 'must be a string or null');
    }
    const v = raw.trim();
    if (v === '') return null;
    if (v.length > ACTIVITY_ADDRESS_MAX_LENGTH) {
      throw invalidParam(field, `must be <= ${ACTIVITY_ADDRESS_MAX_LENGTH} characters`);
    }
    return v;
  }

  /** 创建命令整体校验（Beta 最小字段 + 嵌套结构）。 */
  validateCreate(cmd: CreateActivityCommand): void {
    if (typeof cmd.title !== 'string' || cmd.title.trim() === '') {
      throw invalidParam('title', 'required non-empty string');
    }
    if (typeof cmd.start_time !== 'number' || typeof cmd.end_time !== 'number') {
      throw invalidParam('start_time/end_time', 'required epoch seconds');
    }
    if (cmd.start_time >= cmd.end_time) {
      throw invalidParam('start_time', 'must be < end_time');
    }
    // P34-C2 §3：status 属服务端权威的发布字段，客户端不得提交（路由层亦已拦截，此处纵深防御）。
    if (cmd.status !== undefined) {
      throw invalidParam('status', 'publication fields are server-authoritative and must not be supplied');
    }
    if (cmd.quota !== undefined && (typeof cmd.quota !== 'number' || cmd.quota < 0)) {
      throw invalidParam('quota', 'must be >= 0');
    }
    // N0-E5A：address 为 optional；类型 / 长度非法在 batch 之前抛出（DB 不留半成品）。
    this.normalizeAddress(cmd.address, 'address');
    if (
      cmd.max_session_minutes !== undefined &&
      cmd.max_session_minutes !== null &&
      (typeof cmd.max_session_minutes !== 'number' || cmd.max_session_minutes <= 0)
    ) {
      throw invalidParam('max_session_minutes', 'must be > 0 or null');
    }
    (cmd.occurrences ?? []).forEach((occ, i) => this.validateOccurrence(occ, i));
  }

  private validateScalar(patch: ActivityScalarUpdate): void {
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim() === '')) {
      throw invalidParam('title', 'required non-empty string');
    }
    if (patch.start_time !== undefined && typeof patch.start_time !== 'number') {
      throw invalidParam('start_time', 'required epoch seconds');
    }
    if (patch.end_time !== undefined && typeof patch.end_time !== 'number') {
      throw invalidParam('end_time', 'required epoch seconds');
    }
    if (patch.start_time !== undefined && patch.end_time !== undefined && patch.start_time >= patch.end_time) {
      throw invalidParam('start_time', 'must be < end_time');
    }
    if (patch.quota !== undefined && (typeof patch.quota !== 'number' || patch.quota < 0)) {
      throw invalidParam('quota', 'must be >= 0');
    }
    // N0-E5A：address 为 optional；显式 null / 空白串 → 清空为 NULL（见 normalizeAddress）。
    if (patch.address !== undefined) {
      this.normalizeAddress(patch.address, 'address');
    }
    if (
      patch.max_session_minutes !== undefined &&
      patch.max_session_minutes !== null &&
      (typeof patch.max_session_minutes !== 'number' || patch.max_session_minutes <= 0)
    ) {
      throw invalidParam('max_session_minutes', 'must be > 0 or null');
    }
  }

  // ===== 业务操作 =====

  async create(cmd: CreateActivityCommand): Promise<{ public_id: string }> {
    this.validateCreate(cmd);
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const createdBy = this.ctx.auth.userId;
    if (createdBy == null) throw authRequired();
    // N0-E5A：规范化 address（trim / 空白 → null）后再入批；其余字段原样透传，contract 不变。
    const normalized: CreateActivityCommand = {
      ...cmd,
      address: this.normalizeAddress(cmd.address, 'address'),
    };
    return this.repo.createActivityWithNested(normalized, teamId, createdBy);
  }

  async update(publicId: string, patch: ActivityScalarUpdate): Promise<void> {
    // §5：Beta v1 不支持嵌套 occurrence/position/slot 重配置；显式拒绝避免 FK 破坏。
    const extra = patch as Record<string, unknown>;
    if (extra.occurrences || extra.positions || extra.slots) {
      throw invalidParam('body', 'nested occurrence/position/slot reconfiguration is not supported in v1');
    }
    this.validateScalar(patch);
    // N0-E5A：仅当 address 出现在 patch 中才规范化 / 落库（不改变"未提供即不动"语义）。
    const normalized: ActivityScalarUpdate = { ...patch };
    if (patch.address !== undefined) {
      normalized.address = this.normalizeAddress(patch.address, 'address');
    }
    await this.repo.updateActivityScalar(publicId, normalized);
  }

  // =======================================================================
  // P34-C2：活动发布审核状态机（submit / approve / reject）
  //
  // 冻结原则：
  //   * CREATE != SUBMIT != REVIEW：审核人必须同时不同于 submitted_by 与 created_by（§5/§6）。
  //   * 无 super-admin bypass：职责分离以数据判定，不以角色判定。
  //   * 唯一正式发布路径 = approve（status 1）；direct publish runtime 已移除（§9）。
  // =======================================================================

  /** 当前操作者（团队上下文 + 用户身份），供审核链路复用。 */
  private requireActor(): { operatorId: number; teamId: number } {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const operatorId = this.ctx.auth.userId;
    if (operatorId == null) throw authRequired();
    return { operatorId, teamId };
  }

  /** 读取审核状态；跨团队 / 不存在 / 已删除 → 404（不泄露存在性，不降级为 403）。 */
  private async requireApprovalState(publicId: string): Promise<ActivityApprovalState> {
    const state = await this.repo.getApprovalState(publicId);
    if (state === null) throw notFound('Activity');
    return state;
  }

  /**
   * 职责分离：审核人不得为提交人，也不得为原始创建者。
   * （创建者即使不是提交人，也不得审核自己最初创建的活动。）
   */
  private assertNotSelfReview(state: ActivityApprovalState, operatorId: number): void {
    if (state.submitted_by != null && state.submitted_by === operatorId) {
      throw forbidden('提交人不能审核自己提交的活动（职责分离）');
    }
    if (state.created_by === operatorId) {
      throw forbidden('创建者不能审核自己创建的活动（职责分离）');
    }
  }

  /**
   * N0-F2：构造「活动发布审核结果」的 IN_APP 通知计划（业务域 → Notification Core）。
   *
   * 冻结契约（产品裁决：APPROVED/REJECTED 均 IN_APP=YES、WECHAT=DEFERRED）：
   *   - event_type     = activity.publication.approved | activity.publication.rejected
   *   - category       = activity
   *   - entity         = business_entity_type 'activity' / business_entity_id = activities.id
   *   - recipient      = activities.created_by 【ONLY】（绝不发给 submitted_by）
   *   - team_id        = 当前 team 上下文（= activities.team_id）
   *   - payload        = { activity_public_id, audit_status }，【禁止】放入 reject_reason
   *   - target_page    = 服务端权威构造（内部 allowlist + ULID 校验）
   *   - 多轮幂等键     = `activity.publication.<approved|rejected>:<activity_id>:<submit_audit_log_id>`
   *                      （submit_audit_log_id = 当前 PENDING 轮次 content_audit_logs 中
   *                        action='submit' 的最新 id = 轮次锚点）
   *   - N0-F2 R1 修复：以稳定单调的 submit audit log id 取代 submitted_at 作为轮次锚点，
   *     规避「同秒再审同决策」场景下两轮 submitted_at 相同导致 notification_recipients
   *     idempotency_key UNIQUE 冲突、整批回滚、通知丢失 + 活动滞留 PENDING 的缺陷。
   *   - `:u<userId>` 后缀仍由 NotificationService 统一生成（业务侧不复制该规则）
   *
   * 内容最小化：正文只在真实存在 reject_reason 时展示它（REJECTED），不伪造、不截断改义。
   * 本方法只【构造】计划；执行由 reviewActivityAtomically 在同一 db.batch 内完成。
   */
  private planPublicationNotification(p: {
    action: 'approve' | 'reject';
    publicId: string;
    activityId: number;
    activityTitle: string;
    createdBy: number;
    /** N0-F2 R1：当前 PENDING 轮次的 submit audit log id（调用方已校验非空；缺失由调用方批前失败）。 */
    submitAuditLogId: number;
    operatorId: number;
    rejectReason: string | null;
    gate: NotificationInsertGate;
  }): NotificationCreationPlan {
    const approved = p.action === 'approve';
    const auditStatus = approved ? ACTIVITY_AUDIT.APPROVED : ACTIVITY_AUDIT.REJECTED;
    // N0-F2 R1：轮次锚点 = 当前 PENDING 轮次的 submit audit log id（content_audit_logs.id）。
    // 同一 activity 跨轮（REJECTED→resubmit）submit 各自产生独立且单调的 audit log id，
    // 即便两轮 submitted_at 落在同一 epoch 秒，锚点仍互不相同 → 幂等键不冲突（MULTI_ROUND_CONTRACT 修复）。
    const idempotencyKey =
      `activity.publication.${approved ? 'approved' : 'rejected'}:${p.activityId}:${p.submitAuditLogId}`;

    const title = approved ? '活动审核通过' : '活动审核未通过';
    const summary = approved
      ? '您创建的活动已通过审核，现已开放报名'
      : '您创建的活动未通过审核，请查看驳回原因';
    const body = approved
      ? `您创建的活动《${p.activityTitle}》已通过发布审核，现已开放报名。`
      : `您创建的活动《${p.activityTitle}》未通过发布审核。驳回原因：${p.rejectReason ?? ''}。请修改后重新提交审核。`;

    return new NotificationService({
      db: this.db,
      auth: this.ctx.auth,
      tenant: this.ctx.tenant,
    }).buildCreationPlan(
      {
        recipientUserIds: [p.createdBy],
        idempotencyKey,
        eventType: approved ? 'activity.publication.approved' : 'activity.publication.rejected',
        category: 'activity',
        title,
        summary,
        body,
        teamId: this.ctx.tenant.teamId,
        businessEntityType: 'activity',
        businessEntityId: p.activityId,
        targetPage: buildActivityDetailTarget(p.publicId),
        payload: { activity_public_id: p.publicId, audit_status: auditStatus },
        createdBy: p.operatorId,
      },
      p.gate,
    );
  }

  /** POST submit：DRAFT / REJECTED → PENDING（跃迁 + audit log 同批原子，无 IN_APP 通知）。 */
  async submit(publicId: string): Promise<ActivityApprovalView> {
    const { operatorId } = this.requireActor();
    const state = await this.requireApprovalState(publicId);

    if (state.audit_status !== ACTIVITY_AUDIT.DRAFT && state.audit_status !== ACTIVITY_AUDIT.REJECTED) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }

    const now = Math.floor(Date.now() / 1000);
    // N0-F2 §3：gated audit log INSERT + guarded UPDATE 放入同一 db.batch，UPDATE 恒在最后。
    const gate = this.repo.buildSubmitGate({ activityId: state.id, activityPublicId: publicId });
    const changes = await this.repo.submitForApprovalAtomically({
      activityId: state.id,
      activityPublicId: publicId,
      operatorId,
      now,
      fromAudit: state.audit_status,
      gate,
    });
    if (changes !== 1) throw conflict(ConflictReason.ACTIVITY_APPROVAL_RACE);

    return {
      activity_public_id: publicId,
      status: ACTIVITY_STATUS.DRAFT,
      audit_status: ACTIVITY_AUDIT.PENDING,
      submitted_at: now,
      reviewed_at: null,
      reject_reason: null,
    };
  }

  /** POST approve：仅 PENDING → APPROVED + SIGNUP_OPEN（唯一正式发布路径 + IN_APP 通知，同批原子）。 */
  async approve(publicId: string): Promise<ActivityApprovalView> {
    const { operatorId } = this.requireActor();
    const state = await this.requireApprovalState(publicId);

    if (state.audit_status !== ACTIVITY_AUDIT.PENDING) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }
    this.assertNotSelfReview(state, operatorId);

    // N0-F2 R1-A：解析当前 PENDING 轮次 submit audit log id（批前；缺失 / 仅历史旧 log / 时间窗不符
    // → 数据一致性缺失，批前失败）。submittedAt 透传 state.submitted_at（同源 now，见 §1 证明）。
    const submitAuditLogId = await this.repo.findCurrentSubmitAuditLogId(state.id, state.submitted_at);
    if (submitAuditLogId == null) throw internalError();

    const now = Math.floor(Date.now() / 1000);
    const gate = this.repo.buildReviewGate({ activityId: state.id, activityPublicId: publicId });
    const plan = this.planPublicationNotification({
      action: 'approve',
      publicId,
      activityId: state.id,
      activityTitle: state.title,
      createdBy: state.created_by,
      submitAuditLogId,
      operatorId,
      rejectReason: null,
      gate,
    });

    // 单次原子 batch：[gated notification INSERT, gated recipient INSERT, gated audit log INSERT,
    // guarded activities UPDATE(最后)]；跃迁真相以 UPDATE 的 changes === 1 判定。
    const changes = await this.repo.reviewActivityAtomically({
      action: 'approve',
      activityId: state.id,
      activityPublicId: publicId,
      auditStatus: ACTIVITY_AUDIT.APPROVED,
      status: ACTIVITY_STATUS.SIGNUP_OPEN,
      reviewBy: operatorId,
      reviewAt: now,
      rejectReason: null,
      gate,
      notificationStatements: plan.statements,
    });
    if (changes !== 1) await this.throwReviewConflict(publicId);

    return {
      activity_public_id: publicId,
      status: ACTIVITY_STATUS.SIGNUP_OPEN,
      audit_status: ACTIVITY_AUDIT.APPROVED,
      submitted_at: state.submitted_at,
      reviewed_at: now,
      reject_reason: null,
    };
  }

  /** POST reject：仅 PENDING → REJECTED + DRAFT；reason 必填（trim 后 1–500）+ IN_APP 通知，同批原子。 */
  async reject(publicId: string, rawReason: unknown): Promise<ActivityApprovalView> {
    const { operatorId } = this.requireActor();

    if (typeof rawReason !== 'string') {
      throw invalidParam('reason', 'required non-empty string (1..500 chars)');
    }
    const reason = rawReason.trim();
    if (reason === '' || reason.length > REJECT_REASON_MAX_LENGTH) {
      throw invalidParam('reason', `required non-empty string, max ${REJECT_REASON_MAX_LENGTH} chars`);
    }

    const state = await this.requireApprovalState(publicId);

    if (state.audit_status !== ACTIVITY_AUDIT.PENDING) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }
    this.assertNotSelfReview(state, operatorId);

    // N0-F2 R1-A：解析当前 PENDING 轮次 submit audit log id（批前；缺失 / 仅历史旧 log / 时间窗不符
    // → 数据一致性缺失，批前失败）。submittedAt 透传 state.submitted_at（同源 now，见 §1 证明）。
    const submitAuditLogId = await this.repo.findCurrentSubmitAuditLogId(state.id, state.submitted_at);
    if (submitAuditLogId == null) throw internalError();

    const now = Math.floor(Date.now() / 1000);
    const gate = this.repo.buildReviewGate({ activityId: state.id, activityPublicId: publicId });
    const plan = this.planPublicationNotification({
      action: 'reject',
      publicId,
      activityId: state.id,
      activityTitle: state.title,
      createdBy: state.created_by,
      submitAuditLogId,
      operatorId,
      rejectReason: reason,
      gate,
    });

    const changes = await this.repo.reviewActivityAtomically({
      action: 'reject',
      activityId: state.id,
      activityPublicId: publicId,
      auditStatus: ACTIVITY_AUDIT.REJECTED,
      status: ACTIVITY_STATUS.DRAFT,
      reviewBy: operatorId,
      reviewAt: now,
      rejectReason: reason,
      gate,
      notificationStatements: plan.statements,
    });
    if (changes !== 1) await this.throwReviewConflict(publicId);

    return {
      activity_public_id: publicId,
      status: ACTIVITY_STATUS.DRAFT,
      audit_status: ACTIVITY_AUDIT.REJECTED,
      submitted_at: state.submitted_at,
      reviewed_at: now,
      reject_reason: reason,
    };
  }

  /**
   * 跃迁 0 行时的确定性判定（谓词落空 ⇒ 通知 / audit log 均 0 行，零副作用）：
   *   - 行已不存在（跨团队 / 删除）→ 404；
   *   - 行已非 PENDING（重复请求 / 竞态后续）→ 409 TRANSITION；
   *   - 其余 → 409 RACE。
   */
  private async throwReviewConflict(publicId: string): Promise<never> {
    const after = await this.repo.getApprovalState(publicId);
    if (after === null) throw notFound('Activity');
    if (after.audit_status !== ACTIVITY_AUDIT.PENDING) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }
    throw conflict(ConflictReason.ACTIVITY_APPROVAL_RACE);
  }
}
