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
 * - 发布仅支持草稿（status 0）→ 1 的最小转换；不做 scheduled_publish / 审批流。
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
import { invalidParam, authRequired, teamScopeRequired, notFound } from '../utils/errors';
import type { RepositoryContext } from '../types/tenant';

export interface ActivityAdminDeps {
  db: D1Database;
  ctx: RepositoryContext;
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
    if (cmd.status !== undefined && (typeof cmd.status !== 'number' || cmd.status < 0 || cmd.status > 7)) {
      throw invalidParam('status', 'must be 0..7');
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

  async publish(publicId: string): Promise<void> {
    const status = await this.repo.getPublishStatus(publicId);
    if (status === null) throw notFound('Activity');
    if (status !== 0) throw invalidParam('status', 'only draft (status=0) can be published');
    await this.repo.publishActivity(publicId);
  }
}
