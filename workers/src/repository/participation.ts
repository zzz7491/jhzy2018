/**
 * ParticipationRepository（S2-NEW-ARCH-P11）—— activity_participations 的唯一写入口。
 *
 * scope 事实（repository/tenant-scope.ts）：
 * - activity_participations = TEAM_SCOPED 且【无 team_id 列】→ DERIVED_TEAM_TABLES 成员。
 *   team 由 signup_id → activity_signups → activities.team_id 派生；所有查询必须
 *   JOIN activity_signups + activities 以 a.team_id = ? 限定，禁止简单 WHERE team_id=?。
 * - PermissionProvider 只裁决"当前用户能否分配参与"，【不】替代租户范围过滤
 *   （用户 §九：PermissionProvider != Tenant filter；中间件放行后 Repository 仍必须收口）。
 *
 * SQL 纪律（用户 §十）：全部 prepare().bind()，禁止字符串插值。
 *   signupId / occurrenceId / slotId / opId / publicId / teamId 全部参数化。
 *
 * 并发安全（用户 §十二）：
 * - 唯一真相 = Schema 既有 partial UNIQUE idx_ap_occ / idx_ap_slot + public_id UNIQUE。
 * - 预检 SELECT 只是快路径（给出稳定的 409 reason）；真正的"不可能产生第二条"由数据库约束保证，
 *   INSERT 命中约束时也收敛为 409（不泄露 SQL 原文 / 冲突行）。
 * - 原子写（createParticipationAtomically / reassignAtomically）采用单条
 *   INSERT...SELECT...WHERE 在原子 SQL 内复核 parent consistency / active slot+op / PSP /
 *   capacity / CROSS-MODE / duplicate / NOT EXISTS(public_id)，并经 db.batch() 与取消旧行绑定为事务，
 *   复刻 attendance-sessions 的 reviewSessionAtomically 模式（无 BEGIN/COMMIT，无 changes()/raise()）。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired, conflict, ConflictReason } from '../utils/errors';

export interface ParticipationRow {
  id: number;
  public_id: string;
  signup_id: number;
  occurrence_id: number;
  slot_id: number | null;
  occurrence_position_id: number | null;
  status: number;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number | null;
}

/** activity_participations.status 字典（0013 冻结）。1=assigned, 2=cancelled。 */
export const PARTICIPATION_STATUS = {
  ASSIGNED: 1,
  CANCELLED: 2,
} as const;

/** P19 GET setup / ensure 对外的参与行 public-id 投影（绝不输出内部 integer id）。 */
export interface ParticipationPublicRow {
  public_id: string;
  occurrence_public_id: string;
  slot_public_id: string | null;
  occurrence_position_public_id: string | null;
  status: number;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number | null;
}

/** 解析用最小父级视图（均经 activities 派生租户隔离）。 */
export interface ResolvedActivity {
  id: number;
  team_id: number;
  status: number;
}
export interface ResolvedOccurrence {
  id: number;
  activity_id: number;
  status: number;
}
export interface ResolvedSignup {
  id: number;
  activity_id: number;
  user_id: number;
  status: number;
  review_status: number;
}
export interface ResolvedSlot {
  id: number;
  occurrence_id: number;
  capacity: number;
  deleted_at: number | null;
}
export interface ResolvedOccurrencePosition {
  id: number;
  occurrence_id: number;
  position_id: number;
  deleted_at: number | null;
}

/** SQLite/D1 UNIQUE 冲突错误特征（仅服务端判定使用，不向客户端回显）。 */
const UNIQUE_VIOLATION_RE = /unique\s+constraint\s+failed/i;

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return UNIQUE_VIOLATION_RE.test(msg);
}

export class ParticipationRepository extends BaseRepository {
  /** 当前租户团队 id；缺失即拒绝（DERIVED_TEAM_TABLES 同样必须落在团队上下文）。 */
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    return teamId;
  }

  // ===== 解析（均经 activities 派生租户隔离）=====

  async resolveActivity(publicId: string, teamId: number): Promise<ResolvedActivity | null> {
    this.ensureTableRead('activities');
    return this.first<ResolvedActivity>(
      `SELECT id, team_id, status FROM activities WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  async resolveOccurrence(publicId: string, teamId: number): Promise<ResolvedOccurrence | null> {
    this.ensureTableRead('activity_occurrences');
    return this.first<ResolvedOccurrence>(
      `SELECT o.id, o.activity_id, o.status
         FROM activity_occurrences o
         JOIN activities a ON a.id = o.activity_id
        WHERE o.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  /**
   * 按 (activity, user public_id) 解析 TEAM 目标 signup（P11-TEAM-ASSIGN-IDENTITY-FIX）。
   * 真实 schema：activity_signups 无 public_id 列（0001 未定义，0002–0014 也未增补），
   * 故 TEAM assign 不能再用 signup_public_id（旧 resolveSignup 会在真实 D1 报
   * `no such column: s.public_id`）。此处以
   *   route activity（activities.public_id 已由上一步 resolveActivity 定位）+ users.public_id
   * 经 activity_signups→activities JOIN 派生租户隔离解析唯一 signup。
   * UNIQUE(user_id, activity_id) ⇒ 1:1 确定；跨团队 / 该活动无此用户报名 → null → 404。
   */
  async resolveSignupByUser(
    activityId: number,
    userPublicId: string,
    teamId: number,
  ): Promise<ResolvedSignup | null> {
    this.ensureTableRead('activity_signups');
    return this.first<ResolvedSignup>(
      `SELECT s.id, s.activity_id, s.user_id, s.status, s.review_status
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
         JOIN users u ON u.id = s.user_id
        WHERE s.activity_id = ? AND u.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityId, userPublicId, teamId],
    );
  }

  async resolveSlot(publicId: string, teamId: number): Promise<ResolvedSlot | null> {
    this.ensureTableRead('activity_participation_slots');
    return this.first<ResolvedSlot>(
      `SELECT sl.id, sl.occurrence_id, sl.capacity, sl.deleted_at
         FROM activity_participation_slots sl
         JOIN activity_occurrences o ON o.id = sl.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE sl.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  async resolveOccurrencePosition(
    publicId: string,
    teamId: number,
  ): Promise<ResolvedOccurrencePosition | null> {
    this.ensureTableRead('occurrence_positions');
    return this.first<ResolvedOccurrencePosition>(
      `SELECT op.id, op.occurrence_id, op.position_id, op.deleted_at
         FROM occurrence_positions op
         JOIN activity_occurrences o ON o.id = op.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE op.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  // ===== 按 id 解析（S2-NEW-ARCH-P16 新增，纯增量只读）=====
  //
  // 【真实缺口说明】P16 签到链必须校验 participation 行所引用的 occurrence / slot 是否仍然
  // 有效且与父级一致（P15 冻结步骤 8/9）。既有 findByPublicIdWithSignup 只返回 participation
  // 自身的 occurrence_id / slot_id（内部 id），而仓库内既有的 resolveOccurrence / resolveSlot
  // 均以 public_id 为入参，无法按内部 id 查询；activity_signups 亦无 public_id 列（0001 未定义），
  // 故无法通过既有方法补齐。此处仅新增两个【只读】按 id 解析方法，不新增写路径、
  // 不扩大 P15 已冻结的设计范围。

  /** 按 id 读取 occurrence（团队经 occurrence→activities 派生隔离）。 */
  async resolveOccurrenceById(occurrenceId: number, teamId: number): Promise<ResolvedOccurrence | null> {
    this.ensureTableRead('activity_occurrences');
    return this.first<ResolvedOccurrence>(
      `SELECT o.id, o.activity_id, o.status
         FROM activity_occurrences o
         JOIN activities a ON a.id = o.activity_id
        WHERE o.id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [occurrenceId, teamId],
    );
  }

  /** 按 id 读取 slot（团队经 slot→occurrence→activities 派生隔离）。 */
  async resolveSlotById(slotId: number, teamId: number): Promise<ResolvedSlot | null> {
    this.ensureTableRead('activity_participation_slots');
    return this.first<ResolvedSlot>(
      `SELECT sl.id, sl.occurrence_id, sl.capacity, sl.deleted_at
         FROM activity_participation_slots sl
         JOIN activity_occurrences o ON o.id = sl.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE sl.id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [slotId, teamId],
    );
  }

  // ===== 读取 =====

  /** 按 public_id 读取（经 signup→activity 派生租户隔离）。status 不限，供 replay/state 判定。 */
  async findByPublicId(publicId: string, teamId: number): Promise<ParticipationRow | null> {
    this.ensureTableRead('activity_participations');
    return this.first<ParticipationRow>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  /** 同上，并附带 signup.user_id（SELF 归属判定用）。 */
  async findByPublicIdWithSignup(
    publicId: string,
    teamId: number,
  ): Promise<(ParticipationRow & { signup_user_id: number }) | null> {
    this.ensureTableRead('activity_participations');
    return this.first<ParticipationRow & { signup_user_id: number }>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at, s.user_id AS signup_user_id
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, teamId],
    );
  }

  /**
   * 按 (signup, occurrence, slot) 读取活跃参与行（status=1 且 cancelled_at IS NULL）。
   * slot 为 NULL 表示 occurrence-level；非 NULL 表示 slot-level。NULL-safe 比对。
   */
  async findActiveBySignupOccurrence(
    signupId: number,
    occurrenceId: number,
    slotId: number | null,
    teamId: number,
  ): Promise<ParticipationRow | null> {
    this.ensureTableRead('activity_participations');
    return this.first<ParticipationRow>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.signup_id = ? AND p.occurrence_id = ?
          AND ((? IS NULL AND p.slot_id IS NULL) OR (? IS NOT NULL AND p.slot_id = ?))
          AND p.status = 1 AND p.cancelled_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [signupId, occurrenceId, slotId, slotId, slotId, teamId],
    );
  }

  /** 统计某 slot 的活跃参与数（容量硬上限判定用）。 */
  async countActiveBySlot(slotId: number, teamId: number): Promise<number> {
    this.ensureTableRead('activity_participations');
    const row = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.slot_id = ? AND p.status = 1 AND p.cancelled_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [slotId, teamId],
    );
    return row?.n ?? 0;
  }

  /** participation_slot_positions 是否存在活跃 (slot_id, occurrence_position_id) 配置。 */
  async pspExists(slotId: number, opId: number): Promise<boolean> {
    this.ensureTableRead('participation_slot_positions');
    const row = await this.first<{ x: number }>(
      `SELECT 1 AS x FROM participation_slot_positions
        WHERE slot_id = ? AND occurrence_position_id = ? AND deleted_at IS NULL`,
      [slotId, opId],
    );
    return row != null;
  }

  /**
   * op 是否兼容某 occurrence（updatePosition / reassign 防御性校验）：
   * op 活跃 + 同一 occurrence + 其 activity_position 同 activity 且活跃 + 团队隔离。
   */
  async opCompatibleWithOccurrence(opId: number, occurrenceId: number, teamId: number): Promise<boolean> {
    this.ensureTableRead('occurrence_positions');
    const row = await this.first<{ x: number }>(
      `SELECT 1 AS x
         FROM occurrence_positions op
         JOIN activity_occurrences o ON o.id = op.occurrence_id
         JOIN activity_positions ap ON ap.id = op.position_id
         JOIN activities a ON a.id = o.activity_id
        WHERE op.id = ? AND op.occurrence_id = ? AND op.deleted_at IS NULL
          AND ap.activity_id = a.id AND ap.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [opId, occurrenceId, teamId],
    );
    return row != null;
  }

  /** 列出某 signup 下全部参与行（列表用；经 activities 派生租户隔离）。 */
  async listBySignup(signupId: number, teamId: number): Promise<ParticipationRow[]> {
    this.ensureTableRead('activity_participations');
    return this.all<ParticipationRow>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.signup_id = ? AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY p.created_at DESC`,
      [signupId, teamId],
    );
  }

  /** 列出某活动下全部参与行（协调员视图；经 activities 派生租户隔离）。 */
  async listByActivity(activityId: number, teamId: number): Promise<ParticipationRow[]> {
    this.ensureTableRead('activity_participations');
    return this.all<ParticipationRow>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE a.id = ? AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY p.created_at DESC`,
      [activityId, teamId],
    );
  }

  /** 查询本人名下某活动的报名（不限 status，供"未批准→409"判定），经 activities 派生租户隔离。 */
  async findOwnSignupAnyStatus(activityId: number, userId: number, teamId: number): Promise<ResolvedSignup | null> {
    this.ensureTableRead('activity_signups');
    return this.first<ResolvedSignup>(
      `SELECT s.id, s.activity_id, s.user_id, s.status, s.review_status
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.activity_id = ? AND s.user_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityId, userId, teamId],
    );
  }

  /** 查询某 activity_position 是否活跃（同 activity 且未软删），供 Position catalog 防御性校验。 */
  async activityPositionActive(positionId: number, activityId: number, teamId: number): Promise<boolean> {
    this.ensureTableRead('activity_positions');
    const row = await this.first<{ x: number }>(
      `SELECT 1 AS x
         FROM activity_positions ap
         JOIN activities a ON a.id = ap.activity_id
        WHERE ap.id = ? AND ap.activity_id = ? AND ap.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [positionId, activityId, teamId],
    );
    return row != null;
  }

  /** 查询 (signup, occurrence) 下任一活跃 slot-level 参与行（不限具体 slot），供 CROSS-MODE 守卫。 */
  async findActiveSlotAny(
    signupId: number,
    occurrenceId: number,
    teamId: number,
  ): Promise<ParticipationRow | null> {
    this.ensureTableRead('activity_participations');
    return this.first<ParticipationRow>(
      `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
        WHERE p.signup_id = ? AND p.occurrence_id = ? AND p.slot_id IS NOT NULL
          AND p.status = 1 AND p.cancelled_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [signupId, occurrenceId, teamId],
    );
  }

  // ===== P19 只读 onboarding 原语（GET setup / POST ensure；纯读）=====

  /** 列出某 activity 的全部【活跃】occurrence（status∈{1,2}；经 activities 派生租户隔离）。 */
  async listActiveOccurrences(
    activityId: number,
    teamId: number,
  ): Promise<{ id: number; public_id: string; status: number }[]> {
    this.ensureTableRead('activity_occurrences');
    return this.all<{ id: number; public_id: string; status: number }>(
      `SELECT o.id, o.public_id, o.status
         FROM activity_occurrences o
         JOIN activities a ON a.id = o.activity_id
        WHERE o.activity_id = ? AND o.status IN (1, 2)
          AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY o.start_time, o.id`,
      [activityId, teamId],
    );
  }

  /** occurrence 是否存在 active slot（occurrence-level deterministic ensure 的前置判定）。 */
  async hasActiveSlots(occurrenceId: number, teamId: number): Promise<boolean> {
    this.ensureTableRead('activity_participation_slots');
    const row = await this.first<{ x: number }>(
      `SELECT 1 AS x
         FROM activity_participation_slots sl
         JOIN activity_occurrences o ON o.id = sl.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE sl.occurrence_id = ? AND sl.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [occurrenceId, teamId],
    );
    return row != null;
  }

  /** occurrence 的 slot / position / PSP 选择数据（全 public_id；GET setup 用）。 */
  async listPickOptions(
    occurrenceId: number,
    teamId: number,
  ): Promise<{
    slots: { public_id: string; capacity: number }[];
    positions: { public_id: string }[];
    psp_pairs: { slot_public_id: string; position_public_id: string }[];
  }> {
    this.ensureTableRead('activity_participation_slots');
    this.ensureTableRead('occurrence_positions');
    this.ensureTableRead('participation_slot_positions');

    const slots = await this.all<{ public_id: string; capacity: number }>(
      `SELECT sl.public_id, sl.capacity
         FROM activity_participation_slots sl
         JOIN activity_occurrences o ON o.id = sl.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE sl.occurrence_id = ? AND sl.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY sl.sort_order, sl.id`,
      [occurrenceId, teamId],
    );
    const positions = await this.all<{ public_id: string }>(
      `SELECT op.public_id
         FROM occurrence_positions op
         JOIN activity_occurrences o ON o.id = op.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE op.occurrence_id = ? AND op.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY op.sort_order, op.id`,
      [occurrenceId, teamId],
    );
    const pairs = await this.all<{ slot_public_id: string; position_public_id: string }>(
      `SELECT sl.public_id AS slot_public_id, op.public_id AS position_public_id
         FROM participation_slot_positions psp
         JOIN activity_participation_slots sl ON sl.id = psp.slot_id
         JOIN occurrence_positions op ON op.id = psp.occurrence_position_id
         JOIN activity_occurrences o ON o.id = sl.occurrence_id
         JOIN activities a ON a.id = o.activity_id
        WHERE sl.occurrence_id = ? AND psp.deleted_at IS NULL
          AND sl.deleted_at IS NULL AND op.deleted_at IS NULL
          AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY sl.id, op.id`,
      [occurrenceId, teamId],
    );
    return { slots, positions, psp_pairs: pairs };
  }

  /** signup 下全部参与行的 public-id 投影（GET setup 的 participations[]；绝不输出内部 id）。 */
  async listOwnParticipationsPublic(signupId: number, teamId: number): Promise<ParticipationPublicRow[]> {
    this.ensureTableRead('activity_participations');
    return this.all<ParticipationPublicRow>(
      `SELECT p.public_id, o.public_id AS occurrence_public_id,
              sl.public_id AS slot_public_id, op.public_id AS occurrence_position_public_id,
              p.status, p.cancelled_at, p.created_at, p.updated_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a ON a.id = s.activity_id
         JOIN activity_occurrences o ON o.id = p.occurrence_id
         LEFT JOIN activity_participation_slots sl ON sl.id = p.slot_id
         LEFT JOIN occurrence_positions op ON op.id = p.occurrence_position_id
        WHERE p.signup_id = ? AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY p.created_at DESC, p.id DESC`,
      [signupId, teamId],
    );
  }

  // ===== 原子写 =====

  /**
   * 原子创建参与行（INSERT...SELECT...WHERE 复核全部不变式）。
   *
   * 参数化 builder（P(v) 顺序即 ? 顺序）保证 40+ 绑定参数顺序零错位。
   * 返回实际插入行数（1=成功插入；0=预状态谓词任一不成立/唯一冲突 → 调用方据 findActiveBy* 复判 reason）。
   */
  async createParticipationAtomically(input: {
    publicId: string;
    signupId: number;
    occurrenceId: number;
    slotId: number | null;
    opId: number | null;
    teamId: number;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('activity_participations');
    const { publicId, signupId, occurrenceId, slotId, opId, teamId, now } = input;

    const params: unknown[] = [];
    const P = (v: unknown): string => {
      params.push(v == null ? null : v);
      return '?';
    };

    const sql = `
      INSERT INTO activity_participations
        (public_id, signup_id, occurrence_id, slot_id, occurrence_position_id, status, created_at, updated_at)
      SELECT ${P(publicId)}, ${P(signupId)}, ${P(occurrenceId)}, ${P(slotId)}, ${P(opId)}, 1, ${P(now)}, NULL
      WHERE
        -- parent consistency: signup.activity_id === occurrence.activity_id
        (SELECT s.activity_id FROM activity_signups s WHERE s.id = ${P(signupId)})
          = (SELECT o.activity_id FROM activity_occurrences o WHERE o.id = ${P(occurrenceId)})
        -- signup 有效：status=1(REGISTERED) AND review_status=1(APPROVED) 且属当前租户
        AND (SELECT 1 FROM activity_signups s JOIN activities a ON a.id = s.activity_id
              WHERE s.id = ${P(signupId)} AND s.status = 1 AND s.review_status = 1
                AND a.team_id = ${P(teamId)} AND a.deleted_at IS NULL) IS NOT NULL
        -- occurrence 开放：status IN (1 scheduled, 2 in_progress) 且属当前租户
        AND (SELECT 1 FROM activity_occurrences o JOIN activities a ON a.id = o.activity_id
              WHERE o.id = ${P(occurrenceId)} AND o.status IN (1, 2)
                AND a.team_id = ${P(teamId)} AND a.deleted_at IS NULL) IS NOT NULL
        -- slot 活跃 + 同一 occurrence
        AND (${P(slotId)} IS NULL
             OR (SELECT 1 FROM activity_participation_slots sl JOIN activity_occurrences o ON o.id = sl.occurrence_id
                 WHERE sl.id = ${P(slotId)} AND sl.occurrence_id = ${P(occurrenceId)} AND sl.deleted_at IS NULL) IS NOT NULL)
        -- op 活跃 + 同一 occurrence
        AND (${P(opId)} IS NULL
             OR (SELECT 1 FROM occurrence_positions op JOIN activity_occurrences o ON o.id = op.occurrence_id
                 WHERE op.id = ${P(opId)} AND op.occurrence_id = ${P(occurrenceId)} AND op.deleted_at IS NULL) IS NOT NULL)
        -- activity_position 同 activity 且活跃（仅当 op 提供时）
        AND (${P(opId)} IS NULL
             OR (SELECT 1 FROM occurrence_positions op JOIN activity_positions ap ON ap.id = op.position_id
                 WHERE op.id = ${P(opId)} AND ap.activity_id = (SELECT o.activity_id FROM activity_occurrences o WHERE o.id = ${P(occurrenceId)})
                   AND ap.deleted_at IS NULL) IS NOT NULL)
        -- PSP 活跃（仅当 slot + op 同时提供）
        AND (${P(slotId)} IS NULL OR ${P(opId)} IS NULL
             OR (SELECT 1 FROM participation_slot_positions psp
                 WHERE psp.slot_id = ${P(slotId)} AND psp.occurrence_position_id = ${P(opId)} AND psp.deleted_at IS NULL) IS NOT NULL)
        -- capacity: 0=不限；>0 硬上限（本 slot 活跃参与数 < capacity）
        AND (${P(slotId)} IS NULL
             OR (SELECT capacity FROM activity_participation_slots sl WHERE sl.id = ${P(slotId)}) = 0
             OR (SELECT COUNT(*) FROM activity_participations p WHERE p.slot_id = ${P(slotId)} AND p.status = 1 AND p.cancelled_at IS NULL)
                  < (SELECT capacity FROM activity_participation_slots sl WHERE sl.id = ${P(slotId)}))
        -- CROSS-MODE 守卫：同 signup+occurrence 已存在另一模式的活跃参与 → 互斥
        AND (
              (${P(slotId)} IS NULL
               AND NOT EXISTS (SELECT 1 FROM activity_participations p
                               WHERE p.signup_id = ${P(signupId)} AND p.occurrence_id = ${P(occurrenceId)}
                                 AND p.slot_id IS NOT NULL AND p.status = 1 AND p.cancelled_at IS NULL))
              OR
              (${P(slotId)} IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activity_participations p
                               WHERE p.signup_id = ${P(signupId)} AND p.occurrence_id = ${P(occurrenceId)}
                                 AND p.slot_id IS NULL AND p.status = 1 AND p.cancelled_at IS NULL))
            )
        -- 同模式自然重复（partial UNIQUE idx_ap_occ / idx_ap_slot 兜底）：同 (signup, occurrence, slot) 活跃存在 → 不插入
        AND NOT EXISTS (SELECT 1 FROM activity_participations p
                        WHERE p.signup_id = ${P(signupId)} AND p.occurrence_id = ${P(occurrenceId)}
                          AND ((p.slot_id IS NULL AND ${P(slotId)} IS NULL) OR (p.slot_id = ${P(slotId)} AND ${P(slotId)} IS NOT NULL))
                          AND p.status = 1 AND p.cancelled_at IS NULL)
        -- 客户端 new_public_id 不得与任何已有行冲突
        AND NOT EXISTS (SELECT 1 FROM activity_participations p WHERE p.public_id = ${P(publicId)})
    `;

    try {
      const res = await this.run(sql, params);
      // 用 changes（本语句实际插入行数）作"是否插入"判定，绝不依赖 last_row_id：
      // INSERT...SELECT...WHERE 无命中时 node:sqlite/D1 的 last_row_id 可能残留上一条已插入 id（伪成功）。
      return Number(res.meta?.changes ?? 0);
    } catch (err) {
      // 并发自然重复：partial UNIQUE 是唯一真相 → 收敛为 0（调用方据 findActiveBy* 复判为 PUBLIC_ID_CONFLICT），不泄露 SQL。
      if (isUniqueViolation(err)) return 0;
      throw err;
    }
  }

  /**
   * 取消（原子 UPDATE；租户 + 归属 + 状态同在 WHERE）。
   * 写谓词含 status=1 AND cancelled_at IS NULL，且经 signup→activity 派生租户隔离。
   * @returns true = 实际取消 1 行；false = 0 命中（跨团队 / 非本人 / 已取消 / 不存在）。
   */
  async cancelAtomically(id: number, teamId: number, now: number): Promise<boolean> {
    this.ensureTableRead('activity_participations');
    const res = await this.run(
      `UPDATE activity_participations
          SET status = 2, cancelled_at = ?, updated_at = ?
        WHERE id = ? AND status = 1 AND cancelled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM activity_signups s
            JOIN activities a ON a.id = s.activity_id
           WHERE s.id = activity_participations.signup_id
             AND a.team_id = ? AND a.deleted_at IS NULL
          )`,
      [now, now, id, teamId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * 更新 Position（仅改同一条活跃参与的 occurrence_position_id，不取消重建）。
   * 写谓词含 status=1 AND cancelled_at IS NULL，确保不会改动已取消旧行。
   * @returns true = 实际更新 1 行；false = 0 命中（已取消 / 不存在 / 跨团队）。
   */
  async updatePositionAtomically(
    id: number,
    opId: number | null,
    teamId: number,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('activity_participations');
    const res = await this.run(
      `UPDATE activity_participations
          SET occurrence_position_id = ?, updated_at = ?
        WHERE id = ? AND status = 1 AND cancelled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM activity_signups s
            JOIN activities a ON a.id = s.activity_id
           WHERE s.id = activity_participations.signup_id
             AND a.team_id = ? AND a.deleted_at IS NULL
          )`,
      [opId, now, id, teamId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * 原子 reassign（slot 级改派）：stmt0 条件 INSERT 新行 + stmt1 仅当新行已建且活跃时取消旧行。
   * 经真实 db.batch()（D1 事务原子；复刻 reviewSessionAtomically 模式）。
   *
   * 关键不变量：
   * - stmt0 预状态谓词含 old 必须活跃 slot-level（status=1, cancelled_at IS NULL, slot_id NOT NULL, slot_id != newSlot）。
   * - stmt1 取消旧行额外加 EXISTS(新行 public_id 活跃)，故 stmt0 未创建时 stmt1 必然 0 命中 → 旧行零改动。
   * - stmt0 失败（PSP/cross-parent/capacity/cross-mode/duplicate/public_id 任一不成立）→ changes=0 → 旧行保持活跃。
   *
   * @returns { created, cancelledOld } 变更行数（created: stmt0 新行; cancelledOld: stmt1 旧行）。
   */
  async reassignAtomically(input: {
    newPublicId: string;
    signupId: number;
    occurrenceId: number;
    newSlotId: number;
    newOpId: number | null;
    oldId: number;
    teamId: number;
    now: number;
  }): Promise<{ created: number; cancelledOld: number }> {
    this.ensureTableRead('activity_participations');
    const { newPublicId, signupId, occurrenceId, newSlotId, newOpId, oldId, teamId, now } = input;

    const params0: unknown[] = [];
    const P0 = (v: unknown): string => {
      params0.push(v == null ? null : v);
      return '?';
    };

    const stmt0 = this.db
      .prepare(
        `INSERT INTO activity_participations
          (public_id, signup_id, occurrence_id, slot_id, occurrence_position_id, status, created_at, updated_at)
        SELECT ${P0(newPublicId)}, ${P0(signupId)}, ${P0(occurrenceId)}, ${P0(newSlotId)}, ${P0(newOpId)}, 1, ${P0(now)}, NULL
        WHERE
          -- old 必须活跃 slot-level 且 slot 不同（reassign 前置）
          (SELECT 1 FROM activity_participations op
            WHERE op.id = ${P0(oldId)} AND op.status = 1 AND op.cancelled_at IS NULL
              AND op.slot_id IS NOT NULL AND op.slot_id != ${P0(newSlotId)}
              AND op.signup_id = ${P0(signupId)} AND op.occurrence_id = ${P0(occurrenceId)}) IS NOT NULL
          -- parent consistency
          AND (SELECT s.activity_id FROM activity_signups s WHERE s.id = ${P0(signupId)})
            = (SELECT o.activity_id FROM activity_occurrences o WHERE o.id = ${P0(occurrenceId)})
          AND (SELECT 1 FROM activity_signups s JOIN activities a ON a.id = s.activity_id
                WHERE s.id = ${P0(signupId)} AND s.status = 1 AND s.review_status = 1
                  AND a.team_id = ${P0(teamId)} AND a.deleted_at IS NULL) IS NOT NULL
          AND (SELECT 1 FROM activity_occurrences o JOIN activities a ON a.id = o.activity_id
                WHERE o.id = ${P0(occurrenceId)} AND o.status IN (1, 2)
                  AND a.team_id = ${P0(teamId)} AND a.deleted_at IS NULL) IS NOT NULL
          -- new slot 活跃 + 同一 occurrence
          AND (SELECT 1 FROM activity_participation_slots sl JOIN activity_occurrences o ON o.id = sl.occurrence_id
               WHERE sl.id = ${P0(newSlotId)} AND sl.occurrence_id = ${P0(occurrenceId)} AND sl.deleted_at IS NULL) IS NOT NULL
          -- new op 活跃 + 同一 occurrence
          AND (${P0(newOpId)} IS NULL
               OR (SELECT 1 FROM occurrence_positions op JOIN activity_occurrences o ON o.id = op.occurrence_id
                   WHERE op.id = ${P0(newOpId)} AND op.occurrence_id = ${P0(occurrenceId)} AND op.deleted_at IS NULL) IS NOT NULL)
          -- new activity_position 同 activity 且活跃
          AND (${P0(newOpId)} IS NULL
               OR (SELECT 1 FROM occurrence_positions op JOIN activity_positions ap ON ap.id = op.position_id
                   WHERE op.id = ${P0(newOpId)} AND ap.activity_id = (SELECT o.activity_id FROM activity_occurrences o WHERE o.id = ${P0(occurrenceId)})
                     AND ap.deleted_at IS NULL) IS NOT NULL)
          -- PSP 活跃（仅当 new slot + new op 同时提供）
          AND (${P0(newSlotId)} IS NULL OR ${P0(newOpId)} IS NULL
               OR (SELECT 1 FROM participation_slot_positions psp
                   WHERE psp.slot_id = ${P0(newSlotId)} AND psp.occurrence_position_id = ${P0(newOpId)} AND psp.deleted_at IS NULL) IS NOT NULL)
          -- capacity
          AND ((SELECT capacity FROM activity_participation_slots sl WHERE sl.id = ${P0(newSlotId)}) = 0
               OR (SELECT COUNT(*) FROM activity_participations p WHERE p.slot_id = ${P0(newSlotId)} AND p.status = 1 AND p.cancelled_at IS NULL)
                    < (SELECT capacity FROM activity_participation_slots sl WHERE sl.id = ${P0(newSlotId)}))
          -- CROSS-MODE 守卫：同 signup+occurrence 已存在 occurrence-level 活跃参与 → 互斥
          AND NOT EXISTS (SELECT 1 FROM activity_participations p
                          WHERE p.signup_id = ${P0(signupId)} AND p.occurrence_id = ${P0(occurrenceId)}
                            AND p.slot_id IS NULL AND p.status = 1 AND p.cancelled_at IS NULL)
          -- 同 (signup, occurrence, newSlot) 活跃存在 → 不插入（partial UNIQUE idx_ap_slot 兜底）
          AND NOT EXISTS (SELECT 1 FROM activity_participations p
                          WHERE p.signup_id = ${P0(signupId)} AND p.occurrence_id = ${P0(occurrenceId)}
                            AND p.slot_id = ${P0(newSlotId)} AND p.status = 1 AND p.cancelled_at IS NULL)
          -- 客户端 new_public_id 不得与任何已有行冲突
          AND NOT EXISTS (SELECT 1 FROM activity_participations p WHERE p.public_id = ${P0(newPublicId)})
        `,
      )
      .bind(...(params0 as never[]));

    const stmt1 = this.db
      .prepare(
        `UPDATE activity_participations
            SET status = 2, cancelled_at = ?, updated_at = ?
          WHERE id = ? AND status = 1 AND cancelled_at IS NULL
            AND EXISTS (
              SELECT 1 FROM activity_participations np
               WHERE np.public_id = ? AND np.status = 1 AND np.cancelled_at IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM activity_signups s
              JOIN activities a ON a.id = s.activity_id
             WHERE s.id = activity_participations.signup_id
               AND a.team_id = ? AND a.deleted_at IS NULL
            )`,
      )
      .bind(now, now, oldId, newPublicId, teamId);

    const results = await this.db.batch([stmt0, stmt1]);
    const created = Number(results[0]?.meta?.changes ?? 0);
    const cancelledOld = Number(results[1]?.meta?.changes ?? 0);
    return { created, cancelledOld };
  }
}
