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
} from '../utils/errors';
import { ACTIVITY_AUDIT, type ActivityApprovalState } from '../repository/activities';
import type { RepositoryContext } from '../types/tenant';

export interface ActivityAdminDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

/** 驳回原因长度上限（P34-B §E 冻结：trim 后 1–500 字符）。 */
export const REJECT_REASON_MAX_LENGTH = 500;

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

  constructor(deps: ActivityAdminDeps) {
    this.repo = new ActivityRepository(deps);
    this.ctx = deps.ctx;
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
    return this.repo.createActivityWithNested(cmd, teamId, createdBy);
  }

  async update(publicId: string, patch: ActivityScalarUpdate): Promise<void> {
    // §5：Beta v1 不支持嵌套 occurrence/position/slot 重配置；显式拒绝避免 FK 破坏。
    const extra = patch as Record<string, unknown>;
    if (extra.occurrences || extra.positions || extra.slots) {
      throw invalidParam('body', 'nested occurrence/position/slot reconfiguration is not supported in v1');
    }
    this.validateScalar(patch);
    await this.repo.updateActivityScalar(publicId, patch);
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

  /** POST submit：DRAFT / REJECTED → PENDING。 */
  async submit(publicId: string): Promise<ActivityApprovalView> {
    const { operatorId } = this.requireActor();
    const state = await this.requireApprovalState(publicId);

    if (state.audit_status !== ACTIVITY_AUDIT.DRAFT && state.audit_status !== ACTIVITY_AUDIT.REJECTED) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }

    const now = Math.floor(Date.now() / 1000);
    const changes = await this.repo.submitForApproval(publicId, operatorId, now);
    if (changes !== 1) throw conflict(ConflictReason.ACTIVITY_APPROVAL_RACE);

    await this.repo.insertActivityAuditLog({
      activityId: state.id,
      action: 'submit',
      fromAudit: state.audit_status,
      toAudit: ACTIVITY_AUDIT.PENDING,
      reason: null,
      operatorId,
      now,
    });

    return {
      activity_public_id: publicId,
      status: 0,
      audit_status: ACTIVITY_AUDIT.PENDING,
      submitted_at: now,
      reviewed_at: null,
      reject_reason: null,
    };
  }

  /** POST approve：仅 PENDING → APPROVED + SIGNUP_OPEN（唯一正式发布路径）。 */
  async approve(publicId: string): Promise<ActivityApprovalView> {
    const { operatorId } = this.requireActor();
    const state = await this.requireApprovalState(publicId);

    if (state.audit_status !== ACTIVITY_AUDIT.PENDING) {
      throw conflict(ConflictReason.ACTIVITY_APPROVAL_TRANSITION);
    }
    this.assertNotSelfReview(state, operatorId);

    const now = Math.floor(Date.now() / 1000);
    const changes = await this.repo.approveForPublication(publicId, operatorId, now);
    if (changes !== 1) throw conflict(ConflictReason.ACTIVITY_APPROVAL_RACE);

    await this.repo.insertActivityAuditLog({
      activityId: state.id,
      action: 'approve',
      fromAudit: ACTIVITY_AUDIT.PENDING,
      toAudit: ACTIVITY_AUDIT.APPROVED,
      reason: null,
      operatorId,
      now,
    });

    return {
      activity_public_id: publicId,
      status: 1,
      audit_status: ACTIVITY_AUDIT.APPROVED,
      submitted_at: state.submitted_at,
      reviewed_at: now,
      reject_reason: null,
    };
  }

  /** POST reject：仅 PENDING → REJECTED + DRAFT；reason 必填（trim 后 1–500）。 */
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

    const now = Math.floor(Date.now() / 1000);
    const changes = await this.repo.rejectForRevision(publicId, operatorId, now, reason);
    if (changes !== 1) throw conflict(ConflictReason.ACTIVITY_APPROVAL_RACE);

    await this.repo.insertActivityAuditLog({
      activityId: state.id,
      action: 'reject',
      fromAudit: ACTIVITY_AUDIT.PENDING,
      toAudit: ACTIVITY_AUDIT.REJECTED,
      reason,
      operatorId,
      now,
    });

    return {
      activity_public_id: publicId,
      status: 0,
      audit_status: ACTIVITY_AUDIT.REJECTED,
      submitted_at: state.submitted_at,
      reviewed_at: now,
      reject_reason: reason,
    };
  }
}
