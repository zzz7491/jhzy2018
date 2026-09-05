/**
 * ParticipationService（S2-NEW-ARCH-P11）—— 参与/排班分配 use-case。
 *
 * 分层（用户 §十八）：route（HTTP/校验） → authorization（middleware 权限裁决）
 *   → service/use-case（业务不变式 + 归属判定 + 编排） → repository（SQL + 租户范围）。
 * 本文件【不】做认证、不读 Cookie、不发响应；只做业务编排。
 *
 * 判定模型（RESOURCE-OWNERSHIP-RULES §7）：
 *   Authenticated AND Permission AND Tenant Scope AND Ownership AND Business invariant
 *
 * 冻结权限码（唯一事实 = workers/scripts/permission-catalog.json，本切片不新增/不改码）：
 *   participation.assignment.create  —— 本人报名参与（scopeType USER, risk LOW）
 *   participation.assignment.cancel  —— 取消本人参与（scopeType USER, risk LOW）
 *   participation.assignment.update  —— 更新本人参与的岗位（scopeType USER, risk LOW）
 *   participation.assignment.manage  —— 团队协调员代分配/改派/取消（scopeType TEAM, risk MEDIUM）
 *
 * 关键不变量（P11 REV4 冻结）：
 * - 粒度 = signup + occurrence + optional slot；Position 仅为属性（不新增 slot_position 关联/列）。
 * - 客户端提交 new_public_id（Crockford ULID，26 字符）；服务端【绝不再生成】，命中 replay 指纹 → 200。
 * - 所有 public_id 冲突/重复判定必须在 authentication + permission + ownership/team-scope 之后；
 *   ownership/scope 不因子知 public_id 而被绕过（用户 §十三/§十四）。
 * - reassign 采用 db.batch() 原子双语句（插入新行 + 条件取消旧行），复刻 reviewSessionAtomically 模式。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { ParticipationRepository, type ParticipationRow, type ParticipationPublicRow, type ResolvedSignup } from '../repository/participation';
import { authRequired, conflict, notFound, internalError, invalidParam, ConflictReason } from '../utils/errors';
import { isUlid } from '../utils/validation';
import { generateUlid } from '../utils/crypto';

/** 参与行视图（对外响应，与 ParticipationRow 同构）。 */
export type ParticipationView = ParticipationRow;

type Mode = 'self' | 'team';

export interface CreateParticipationInput {
  occurrence_public_id: string;
  slot_public_id?: string;
  position_public_id?: string;
  user_public_id?: string; // 仅 TEAM manage 使用（P11-TEAM-ASSIGN-IDENTITY-FIX：signup 以 activity+user 唯一解析）
  new_public_id: string; // 客户端提交（Crockford ULID）
}

export interface ReassignInput {
  new_slot_public_id: string;
  new_position_public_id?: string;
  new_public_id: string; // 客户端提交（Crockford ULID）
}

export interface ParticipationServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

/** 创建/改派结果：replay=true 表示命中 new_public_id 幂等重放（应返回 200），否则新建（应返回 201）。 */
export interface CreateResult {
  participation: ParticipationView;
  replay: boolean;
}

// =========================================================================
// P19 Participation Onboarding（GET setup / POST ensure）
// =========================================================================

/** activity/signup 级 setup 状态（固定顺序：NONE → NOT_APPROVED → ACTIVITY_NOT_OPEN → NO_ACTIVE_OCCURRENCE → PARTICIPATION_AVAILABLE）。 */
export type ParticipationSetupStatus =
  | 'NONE'
  | 'NOT_APPROVED'
  | 'ACTIVITY_NOT_OPEN'
  | 'NO_ACTIVE_OCCURRENCE'
  | 'PARTICIPATION_AVAILABLE';

/** occurrence 级 setup 状态（逐场独立）。 */
export type OccurrenceSetupState = 'READY' | 'AVAILABLE_DETERMINISTIC' | 'NEEDS_MANUAL_SETUP';

/** GET setup 中单个 occurrence 的配置视图（全 public_id）。 */
export interface OccurrenceSetupView {
  public_id: string;
  state: OccurrenceSetupState;
  can_ensure: boolean;
  has_occurrence_level_participation: boolean;
  has_slot_level_participation: boolean;
  slots: { public_id: string; capacity: number }[];
  positions: { public_id: string }[];
  psp_pairs: { slot_public_id: string; position_public_id: string }[];
}

/** GET /participations/setup 完整响应（纯读）。 */
export interface ParticipationSetupView {
  status: ParticipationSetupStatus;
  participations: ParticipationPublicRow[];
  occurrences: OccurrenceSetupView[];
}

/** POST /participations/ensure 结果：created=false → 200 READY（已有/收敛）；true → 201 新建。 */
export interface EnsureResult {
  participation: ParticipationPublicRow;
  created: boolean;
}

export class ParticipationService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;

  constructor(deps: ParticipationServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
  }

  private requireActor(): { userId: number; teamId: number } {
    const auth = this.auth;
    if (!auth.authenticated || auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw authRequired(); // DERIVED_TEAM_TABLES 必须有团队上下文
    return { userId: auth.userId, teamId: this.tenant.teamId };
  }

  private repos() {
    const ctx = { auth: this.auth, tenant: this.tenant };
    return {
      participations: new ParticipationRepository({ db: this.db, ctx }),
    };
  }

  private toView(row: ParticipationRow): ParticipationView {
    return {
      id: row.id,
      public_id: row.public_id,
      signup_id: row.signup_id,
      occurrence_id: row.occurrence_id,
      slot_id: row.slot_id,
      occurrence_position_id: row.occurrence_position_id,
      status: row.status,
      cancelled_at: row.cancelled_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** 指纹匹配（NULL-safe）：同 signup / occurrence / slot / op（occurrence_position_id）。 */
  private fingerprintMatches(
    row: ParticipationRow,
    signupId: number,
    occurrenceId: number,
    slotId: number | null,
    opId: number | null,
  ): boolean {
    return (
      row.signup_id === signupId &&
      row.occurrence_id === occurrenceId &&
      ((slotId == null && row.slot_id == null) || (slotId != null && row.slot_id === slotId)) &&
      ((opId == null && row.occurrence_position_id == null) ||
        (opId != null && row.occurrence_position_id === opId))
    );
  }

  /** SELF 模式下行归属判定：participation 所属 signup 的 user_id 必须等于当前用户。 */
  private actorOwnsRow(
    row: ParticipationRow & { signup_user_id: number },
    mode: Mode,
    userId: number,
  ): boolean {
    if (mode === 'team') return true;
    return row.signup_user_id === userId;
  }

  // =========================================================================
  // CREATE
  // =========================================================================

  async createSelf(activityPublicId: string, input: CreateParticipationInput): Promise<CreateResult> {
    return this.createCore(activityPublicId, input, 'self');
  }

  async createForTeam(activityPublicId: string, input: CreateParticipationInput): Promise<CreateResult> {
    if (!input.user_public_id) throw invalidParam('user_public_id', 'required for team assignment');
    if (!isUlid(input.user_public_id)) throw invalidParam('user_public_id', 'must be a 26-char Crockford ULID');
    return this.createCore(activityPublicId, input, 'team');
  }

  private async createCore(
    activityPublicId: string,
    input: CreateParticipationInput,
    mode: Mode,
  ): Promise<CreateResult> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();

    const newPublicId = input.new_public_id;
    if (!isUlid(newPublicId)) throw invalidParam('new_public_id', 'must be a 26-char Crockford ULID');

    // 活动（租户隔离）
    const activity = await participations.resolveActivity(activityPublicId, teamId);
    if (!activity) throw notFound('Activity');

    // 报名（SELF=本人；TEAM=目标用户：route activity + users.public_id 唯一解析 signup）
    let signup: ResolvedSignup;
    if (mode === 'self') {
      const s = await participations.findOwnSignupAnyStatus(activity.id, userId, teamId);
      if (!s) throw notFound('Signup');
      signup = s;
    } else {
      if (!input.user_public_id) throw invalidParam('user_public_id', 'required');
      const s = await participations.resolveSignupByUser(activity.id, input.user_public_id, teamId);
      if (!s) throw notFound('Signup');
      signup = s;
    }

    // occurrence
    const occurrence = await participations.resolveOccurrence(input.occurrence_public_id, teamId);
    if (!occurrence) throw notFound('Occurrence');

    // slot / op
    const slot = input.slot_public_id ? await participations.resolveSlot(input.slot_public_id, teamId) : null;
    if (input.slot_public_id && !slot) throw notFound('Slot');
    const op = input.position_public_id
      ? await participations.resolveOccurrencePosition(input.position_public_id, teamId)
      : null;
    if (input.position_public_id && !op) throw notFound('Position');

    // ---- 不变式预检（干净 409 reason）----
    if (signup.activity_id !== activity.id || occurrence.activity_id !== activity.id)
      throw conflict(ConflictReason.PARENT_MISMATCH);
    if (signup.status !== 1 || signup.review_status !== 1)
      throw conflict(ConflictReason.PARENT_MISMATCH); // 未批准 / 非 REGISTERED → 父级无效
    if (occurrence.status !== 1 && occurrence.status !== 2) throw conflict(ConflictReason.PARENT_MISMATCH);
    if (slot && (slot.occurrence_id !== occurrence.id || slot.deleted_at != null))
      throw conflict(ConflictReason.PARENT_MISMATCH);
    if (op && (op.occurrence_id !== occurrence.id || op.deleted_at != null))
      throw conflict(ConflictReason.PARENT_MISMATCH);
    if (op && !(await participations.activityPositionActive(op.position_id, activity.id, teamId)))
      throw conflict(ConflictReason.PARENT_MISMATCH);
    if (slot && op && !(await participations.pspExists(slot.id, op.id)))
      throw conflict(ConflictReason.PSP_MISSING);
    if (slot && slot.capacity > 0) {
      const used = await participations.countActiveBySlot(slot.id, teamId);
      if (used >= slot.capacity) throw conflict(ConflictReason.SLOT_AT_CAPACITY);
    }

    // ---- CROSS-MODE + 同模式自然重复 ----
    const modeIsSlot = slot != null;
    if (modeIsSlot) {
      const sameSlot = await participations.findActiveBySignupOccurrence(
        signup.id,
        occurrence.id,
        slot!.id,
        teamId,
      );
      if (sameSlot) {
        // 同模式重复：new_public_id 命中即 replay；否则 conflict（不泄露）
        if (sameSlot.public_id === newPublicId) return { participation: this.toView(sameSlot), replay: true };
        throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
      }
      const occLevel = await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId);
      if (occLevel) throw conflict(ConflictReason.CROSS_MODE_CONFLICT);
    } else {
      const occLevel = await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId);
      if (occLevel) {
        if (occLevel.public_id === newPublicId) return { participation: this.toView(occLevel), replay: true };
        throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
      }
      const anySlot = await participations.findActiveSlotAny(signup.id, occurrence.id, teamId);
      if (anySlot) throw conflict(ConflictReason.CROSS_MODE_CONFLICT);
    }

    // new_public_id 已存在（跨指纹）：命中指纹 + 授权 → replay；否则 conflict（不泄露冲突行）
    const existingByPid = await participations.findByPublicIdWithSignup(newPublicId, teamId);
    if (existingByPid) {
      const ok =
        this.fingerprintMatches(
          existingByPid,
          signup.id,
          occurrence.id,
          slot?.id ?? null,
          op?.id ?? null,
        ) && this.actorOwnsRow(existingByPid, mode, userId);
      if (ok) return { participation: this.toView(existingByPid), replay: true };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }

    // ---- 原子创建（SQL 内复核全部不变式，并发兜底）----
    const now = Math.floor(Date.now() / 1000);
    const id = await participations.createParticipationAtomically({
      publicId: newPublicId,
      signupId: signup.id,
      occurrenceId: occurrence.id,
      slotId: slot?.id ?? null,
      opId: op?.id ?? null,
      teamId,
      now,
    });
    if (id <= 0) {
      // 并发竞争：复判 reason（命中 replay 也在此收敛为 200）
      return this.reclassifyCreateFailure(signup, occurrence, slot, op, newPublicId, mode, userId, teamId);
    }
    const row = await participations.findByPublicId(newPublicId, teamId);
    if (!row) throw internalError();
    return { participation: this.toView(row), replay: false };
  }

  private async reclassifyCreateFailure(
    signup: ResolvedSignup,
    occurrence: { id: number },
    slot: { id: number; capacity: number } | null,
    op: { id: number } | null,
    newPublicId: string,
    mode: Mode,
    userId: number,
    teamId: number,
  ): Promise<CreateResult> {
    const { participations } = this.repos();
    const dup = slot
      ? await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, slot.id, teamId)
      : await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId);
    if (dup) {
      // 并发同指纹：若 new_public_id 命中 → replay；否则 conflict
      if (dup.public_id === newPublicId) return { participation: this.toView(dup), replay: true };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }
    const crossMode = slot
      ? await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId)
      : await participations.findActiveSlotAny(signup.id, occurrence.id, teamId);
    if (crossMode) throw conflict(ConflictReason.CROSS_MODE_CONFLICT);
    if (slot && slot.capacity > 0 && (await participations.countActiveBySlot(slot.id, teamId)) >= slot.capacity)
      throw conflict(ConflictReason.SLOT_AT_CAPACITY);
    // 退化：public_id 竞争
    throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
  }

  // =========================================================================
  // CANCEL
  // =========================================================================

  async cancelSelf(participationPublicId: string): Promise<ParticipationView> {
    return this.cancelCore(participationPublicId, 'self');
  }

  async cancelForTeam(participationPublicId: string): Promise<ParticipationView> {
    return this.cancelCore(participationPublicId, 'team');
  }

  private async cancelCore(participationPublicId: string, mode: Mode): Promise<ParticipationView> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(participationPublicId)) throw invalidParam('public_id', 'must be a ULID');

    const row = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!row) throw notFound('Participation');
    // SELF：仅本人 signup；TEAM：team scope 已收口（协调员可操作本团队任意）
    if (mode === 'self' && row.signup_user_id !== userId) throw notFound('Participation');

    // 已取消 → 幂等 200（P11 冻结：cancel retry → 200）
    if (row.status === 2) return this.toView(row);

    const now = Math.floor(Date.now() / 1000);
    const ok = await participations.cancelAtomically(row.id, teamId, now);
    if (!ok) {
      const re = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
      if (re && re.status === 2) return this.toView(re); // 并发取消 → 幂等
      throw notFound('Participation');
    }
    const updated = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!updated) throw internalError();
    return this.toView(updated);
  }

  // =========================================================================
  // UPDATE POSITION（仅改同一条参与行的 occurrence_position_id）
  // =========================================================================

  async updatePositionSelf(participationPublicId: string, positionPublicId: string): Promise<ParticipationView> {
    return this.updatePositionCore(participationPublicId, positionPublicId, 'self');
  }

  async updatePositionForTeam(participationPublicId: string, positionPublicId: string): Promise<ParticipationView> {
    return this.updatePositionCore(participationPublicId, positionPublicId, 'team');
  }

  private async updatePositionCore(
    participationPublicId: string,
    positionPublicId: string,
    mode: Mode,
  ): Promise<ParticipationView> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(participationPublicId)) throw invalidParam('public_id', 'must be a ULID');
    if (!isUlid(positionPublicId)) throw invalidParam('position_public_id', 'must be a ULID');

    const row = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!row) throw notFound('Participation');
    if (mode === 'self' && row.signup_user_id !== userId) throw notFound('Participation');
    // 仅活跃参与可改岗位；已取消 → 不改动（返回 404，无副作用）
    if (row.status !== 1) throw notFound('Participation');

    const op = await participations.resolveOccurrencePosition(positionPublicId, teamId);
    if (!op) throw notFound('Position');
    if (!(await participations.opCompatibleWithOccurrence(op.id, row.occurrence_id, teamId)))
      throw conflict(ConflictReason.PARENT_MISMATCH);
    // slot 级参与改岗位 → 必须存在活跃 PSP
    if (row.slot_id != null && !(await participations.pspExists(row.slot_id, op.id)))
      throw conflict(ConflictReason.PSP_MISSING);

    const now = Math.floor(Date.now() / 1000);
    const ok = await participations.updatePositionAtomically(row.id, op.id, teamId, now);
    if (!ok) {
      const re = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
      // 已取消 / 不存在 → 未改动
      if (!re || re.status !== 1) throw notFound('Participation');
      throw notFound('Participation');
    }
    const updated = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!updated) throw internalError();
    return this.toView(updated);
  }

  // =========================================================================
  // REASSIGN SLOT（原子：插入新行 + 条件取消旧行）
  // =========================================================================

  async reassignSelf(participationPublicId: string, input: ReassignInput): Promise<CreateResult> {
    return this.reassignCore(participationPublicId, input, 'self');
  }

  async reassignForTeam(participationPublicId: string, input: ReassignInput): Promise<CreateResult> {
    return this.reassignCore(participationPublicId, input, 'team');
  }

  private async reassignCore(
    participationPublicId: string,
    input: ReassignInput,
    mode: Mode,
  ): Promise<CreateResult> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(participationPublicId)) throw invalidParam('public_id', 'must be a ULID');
    const newPublicId = input.new_public_id;
    if (!isUlid(newPublicId)) throw invalidParam('new_public_id', 'must be a 26-char Crockford ULID');

    const old = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!old) throw notFound('Participation');
    if (mode === 'self' && old.signup_user_id !== userId) throw notFound('Participation');
    // old 必须活跃 slot-level 且目标 slot 不同
    if (old.status !== 1 || old.slot_id == null) throw conflict(ConflictReason.OLD_NOT_ACTIVE);

    const newSlot = await participations.resolveSlot(input.new_slot_public_id, teamId);
    if (!newSlot) throw notFound('Slot');
    if (newSlot.id === old.slot_id) throw conflict(ConflictReason.OLD_NOT_ACTIVE); // 同 slot 改派 → 用 updatePosition

    const newOp = input.new_position_public_id
      ? await participations.resolveOccurrencePosition(input.new_position_public_id, teamId)
      : null;
    if (input.new_position_public_id && !newOp) throw notFound('Position');

    // 父级一致性：reassign 锁定在同一 signup + occurrence
    if (newSlot.occurrence_id !== old.occurrence_id) throw conflict(ConflictReason.PARENT_MISMATCH);
    if (newOp) {
      if (newOp.occurrence_id !== old.occurrence_id || newOp.deleted_at != null)
        throw conflict(ConflictReason.PARENT_MISMATCH);
      if (!(await participations.opCompatibleWithOccurrence(newOp.id, old.occurrence_id, teamId)))
        throw conflict(ConflictReason.PARENT_MISMATCH);
    }
    if (newSlot && newOp && !(await participations.pspExists(newSlot.id, newOp.id)))
      throw conflict(ConflictReason.PSP_MISSING);
    if (newSlot.capacity > 0) {
      const used = await participations.countActiveBySlot(newSlot.id, teamId);
      if (used >= newSlot.capacity) throw conflict(ConflictReason.SLOT_AT_CAPACITY);
    }
    // CROSS-MODE：同 (signup, occurrence) 已存在 occurrence-level 活跃 → 互斥
    const occLevel = await participations.findActiveBySignupOccurrence(old.signup_id, old.occurrence_id, null, teamId);
    if (occLevel) throw conflict(ConflictReason.CROSS_MODE_CONFLICT);

    // 目标 (signup, occurrence, newSlot) 已存在活跃 → conflict（命中即 replay）
    const sameSlotExisting = await participations.findActiveBySignupOccurrence(
      old.signup_id,
      old.occurrence_id,
      newSlot.id,
      teamId,
    );
    if (sameSlotExisting) {
      if (sameSlotExisting.public_id === newPublicId) return { participation: this.toView(sameSlotExisting), replay: true };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }

    // new_public_id 已存在（跨指纹）→ replay 需全指纹 + old 已取消 + 授权；否则 conflict
    const existingByPid = await participations.findByPublicIdWithSignup(newPublicId, teamId);
    if (existingByPid) {
      if (this.reassignReplayMatches(existingByPid, old, newSlot.id, newOp?.id ?? null, mode, userId))
        return { participation: this.toView(existingByPid), replay: true };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }

    // 原子 reassign
    const now = Math.floor(Date.now() / 1000);
    const { created, cancelledOld } = await participations.reassignAtomically({
      newPublicId,
      signupId: old.signup_id,
      occurrenceId: old.occurrence_id,
      newSlotId: newSlot.id,
      newOpId: newOp?.id ?? null,
      oldId: old.id,
      teamId,
      now,
    });
    if (created === 1 && cancelledOld === 1) {
      const createdRow = await participations.findByPublicId(newPublicId, teamId);
      if (!createdRow) throw internalError();
      return { participation: this.toView(createdRow), replay: false };
    }
    // 失败：old 因 stmt1 的 EXISTS 守卫必然保持活跃 → 复判 reason
    return this.reclassifyReassignFailure(old, newSlot, newOp, newPublicId, mode, userId, teamId);
  }

  private reassignReplayMatches(
    existing: ParticipationRow & { signup_user_id: number },
    old: ParticipationRow,
    newSlotId: number,
    newOpId: number | null,
    mode: Mode,
    userId: number,
  ): boolean {
    return (
      existing.signup_id === old.signup_id &&
      existing.occurrence_id === old.occurrence_id &&
      existing.slot_id === newSlotId &&
      ((newOpId == null && existing.occurrence_position_id == null) ||
        (newOpId != null && existing.occurrence_position_id === newOpId)) &&
      existing.status === 1 &&
      old.status === 2 &&
      old.cancelled_at != null &&
      this.actorOwnsRow(existing, mode, userId)
    );
  }

  private async reclassifyReassignFailure(
    old: ParticipationRow,
    newSlot: { id: number; capacity: number },
    newOp: { id: number } | null,
    newPublicId: string,
    mode: Mode,
    userId: number,
    teamId: number,
  ): Promise<CreateResult> {
    const { participations } = this.repos();
    if (newSlot.capacity > 0 && (await participations.countActiveBySlot(newSlot.id, teamId)) >= newSlot.capacity)
      throw conflict(ConflictReason.SLOT_AT_CAPACITY);
    const sameSlot = await participations.findActiveBySignupOccurrence(
      old.signup_id,
      old.occurrence_id,
      newSlot.id,
      teamId,
    );
    if (sameSlot) {
      if (sameSlot.public_id === newPublicId) return { participation: this.toView(sameSlot), replay: true };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }
    const occLevel = await participations.findActiveBySignupOccurrence(old.signup_id, old.occurrence_id, null, teamId);
    if (occLevel) throw conflict(ConflictReason.CROSS_MODE_CONFLICT);
    if (newSlot && newOp && !(await participations.pspExists(newSlot.id, newOp.id)))
      throw conflict(ConflictReason.PSP_MISSING);
    // old 已被并发改派取消 → 视为 OLD_NOT_ACTIVE
    throw conflict(ConflictReason.OLD_NOT_ACTIVE);
  }

  // =========================================================================
  // P19 PARTICIPATION SETUP（READ setup + deterministic ensure；纯读 GET，无写副作用）
  // =========================================================================

  /** 逐场 setup 状态（occurrence 级，独立判定；positions 不影响 can_ensure）。 */
  private async buildOccurrenceSetupView(
    signupId: number,
    occurrenceId: number,
    occurrencePublicId: string,
    teamId: number,
  ): Promise<OccurrenceSetupView> {
    const { participations } = this.repos();
    const occLevel = await participations.findActiveBySignupOccurrence(signupId, occurrenceId, null, teamId);
    const slotLevel = await participations.findActiveSlotAny(signupId, occurrenceId, teamId);
    const ready = occLevel != null || slotLevel != null;

    let state: OccurrenceSetupState;
    let canEnsure: boolean;
    if (ready) {
      state = 'READY'; // 已有 active occ-level 或 slot-level → READY
      canEnsure = false;
    } else {
      // can_ensure 只由「是否存在 active slot」决定；positions 存在与否不影响。
      if (await participations.hasActiveSlots(occurrenceId, teamId)) {
        state = 'NEEDS_MANUAL_SETUP';
        canEnsure = false;
      } else {
        state = 'AVAILABLE_DETERMINISTIC';
        canEnsure = true;
      }
    }

    const opts = await participations.listPickOptions(occurrenceId, teamId);
    return {
      public_id: occurrencePublicId,
      state,
      can_ensure: canEnsure,
      has_occurrence_level_participation: occLevel != null,
      has_slot_level_participation: slotLevel != null,
      slots: opts.slots,
      positions: opts.positions,
      psp_pairs: opts.psp_pairs,
    };
  }

  /** GET /participations/setup —— 本人参与就绪状态（纯读零写副作用）。 */
  async getSetupSelf(activityPublicId: string): Promise<ParticipationSetupView> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();

    const activity = await participations.resolveActivity(activityPublicId, teamId);
    if (!activity) throw notFound('Activity'); // 跨团队 / 不存在 → 404，不泄露

    const signup = await participations.findOwnSignupAnyStatus(activity.id, userId, teamId);
    if (!signup) return { status: 'NONE', participations: [], occurrences: [] };

    const approved = signup.status === 1 && signup.review_status === 1;
    const openActivity = activity.status === 1 || activity.status === 2;

    if (!approved) return { status: 'NOT_APPROVED', participations: [], occurrences: [] };
    if (!openActivity) return { status: 'ACTIVITY_NOT_OPEN', participations: [], occurrences: [] };

    // 该 signup 全部参与行的 public-id 投影（含取消历史；供状态判定与展示）
    const publicRows = await participations.listOwnParticipationsPublic(signup.id, teamId);

    // 全部 active occurrence（status∈{1,2}），逐场独立，不得因其他场次 READY 而裁剪
    const activeOccurrences = await participations.listActiveOccurrences(activity.id, teamId);
    if (activeOccurrences.length === 0) {
      return { status: 'NO_ACTIVE_OCCURRENCE', participations: publicRows, occurrences: [] };
    }

    const occurrences: OccurrenceSetupView[] = [];
    for (const occ of activeOccurrences) {
      occurrences.push(await this.buildOccurrenceSetupView(signup.id, occ.id, occ.public_id, teamId));
    }
    return { status: 'PARTICIPATION_AVAILABLE', participations: publicRows, occurrences };
  }

  /** 参与行 → public-id 投影（ensure 响应用；绝不输出内部 id）。 */
  private async publicOf(row: ParticipationRow, teamId: number): Promise<ParticipationPublicRow> {
    const { participations } = this.repos();
    const rows = await participations.listOwnParticipationsPublic(row.signup_id, teamId);
    const found = rows.find((r) => r.public_id === row.public_id);
    if (!found) throw internalError();
    return found;
  }

  /**
   * POST /participations/ensure —— deterministic 物化 occurrence-level Participation。
   * 目标 occurrence 必须：同 activity、active（status∈{1,2}）、【无 active slot】。
   * 服务端生成 public_id；已有 active → 200；新建（slot=NULL, occurrence_position=NULL）→ 201；
   * 有 active slot → 409 participation_requires_manual。
   */
  async ensureSelf(activityPublicId: string, occurrencePublicId: string): Promise<EnsureResult> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(occurrencePublicId)) throw invalidParam('occurrence_public_id', 'must be a 26-char Crockford ULID');

    const activity = await participations.resolveActivity(activityPublicId, teamId);
    if (!activity) throw notFound('Activity');
    if (activity.status !== 1 && activity.status !== 2) throw conflict(ConflictReason.PARENT_MISMATCH);

    const signup = await participations.findOwnSignupAnyStatus(activity.id, userId, teamId);
    if (!signup) throw notFound('Signup'); // NONE
    if (signup.status !== 1 || signup.review_status !== 1) throw conflict(ConflictReason.PARENT_MISMATCH);

    const occurrence = await participations.resolveOccurrence(occurrencePublicId, teamId);
    if (!occurrence) throw notFound('Occurrence');
    if (occurrence.activity_id !== activity.id) throw conflict(ConflictReason.PARENT_MISMATCH); // wrong parent
    if (occurrence.status !== 1 && occurrence.status !== 2) throw conflict(ConflictReason.PARENT_MISMATCH);

    // 已有该 occurrence 任意 active Participation → 200 READY（幂等）
    const existingOccLevel = await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId);
    if (existingOccLevel) return { participation: await this.publicOf(existingOccLevel, teamId), created: false };
    const existingSlotLevel = await participations.findActiveSlotAny(signup.id, occurrence.id, teamId);
    if (existingSlotLevel) return { participation: await this.publicOf(existingSlotLevel, teamId), created: false };

    // 显式业务检查（不依赖 atomic INSERT 失败）：有 active slot → 必须人工，409
    if (await participations.hasActiveSlots(occurrence.id, teamId)) {
      throw conflict(ConflictReason.PARTICIPATION_REQUIRES_MANUAL);
    }

    // 确定性物化 occurrence-level（slot_id=NULL, occurrence_position_id=NULL）
    const now = Math.floor(Date.now() / 1000);
    const newPublicId = generateUlid();
    const id = await participations.createParticipationAtomically({
      publicId: newPublicId,
      signupId: signup.id,
      occurrenceId: occurrence.id,
      slotId: null,
      opId: null,
      teamId,
      now,
    });
    if (id > 0) {
      const created = await participations.findByPublicId(newPublicId, teamId);
      if (!created) throw internalError();
      return { participation: await this.publicOf(created, teamId), created: true };
    }

    // INSERT 0 → re-read 收敛（并发败方 / 状态退化）
    const reOccLevel = await participations.findActiveBySignupOccurrence(signup.id, occurrence.id, null, teamId);
    if (reOccLevel) return { participation: await this.publicOf(reOccLevel, teamId), created: false };
    const reSlotLevel = await participations.findActiveSlotAny(signup.id, occurrence.id, teamId);
    if (reSlotLevel) return { participation: await this.publicOf(reSlotLevel, teamId), created: false };

    // 条件退化：重新分类为冻结 token
    if (await participations.hasActiveSlots(occurrence.id, teamId)) {
      throw conflict(ConflictReason.PARTICIPATION_REQUIRES_MANUAL);
    }
    const a2 = await participations.resolveActivity(activityPublicId, teamId);
    if (!a2 || (a2.status !== 1 && a2.status !== 2)) throw conflict(ConflictReason.PARENT_MISMATCH);
    const occ2 = await participations.resolveOccurrence(occurrencePublicId, teamId);
    if (!occ2 || (occ2.status !== 1 && occ2.status !== 2) || occ2.activity_id !== activity.id)
      throw conflict(ConflictReason.PARENT_MISMATCH);
    const s2 = await participations.findOwnSignupAnyStatus(activity.id, userId, teamId);
    if (!s2 || s2.status !== 1 || s2.review_status !== 1) throw conflict(ConflictReason.PARENT_MISMATCH);

    throw internalError();
  }

  // =========================================================================
  // LIST / DETAIL
  // =========================================================================

  async listOwn(activityPublicId: string): Promise<ParticipationView[]> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    const activity = await participations.resolveActivity(activityPublicId, teamId);
    if (!activity) return [];
    const signup = await participations.findOwnSignupAnyStatus(activity.id, userId, teamId);
    if (!signup) return [];
    const rows = await participations.listBySignup(signup.id, teamId);
    return rows.map((r) => this.toView(r));
  }

  async listTeam(activityPublicId: string): Promise<ParticipationView[]> {
    const { teamId } = this.requireActor();
    const { participations } = this.repos();
    const activity = await participations.resolveActivity(activityPublicId, teamId);
    if (!activity) return [];
    const rows = await participations.listByActivity(activity.id, teamId);
    return rows.map((r) => this.toView(r));
  }

  async getDetailSelf(participationPublicId: string): Promise<ParticipationView> {
    const { userId, teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(participationPublicId)) throw invalidParam('public_id', 'must be a ULID');
    const row = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!row) throw notFound('Participation');
    if (row.signup_user_id !== userId) throw notFound('Participation');
    return this.toView(row);
  }

  async getDetailTeam(participationPublicId: string): Promise<ParticipationView> {
    const { teamId } = this.requireActor();
    const { participations } = this.repos();
    if (!isUlid(participationPublicId)) throw invalidParam('public_id', 'must be a ULID');
    const row = await participations.findByPublicIdWithSignup(participationPublicId, teamId);
    if (!row) throw notFound('Participation');
    return this.toView(row);
  }
}
