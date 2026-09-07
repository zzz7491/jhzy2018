/**
 * ActivityRepository（S2-5 最小只读；S2-6g 增量：报名目标查询）。
 *
 * scope 事实（S2-3 矩阵）：
 * - activities：TEAM_SCOPED —— 查询【必须】限定 team_id = ctx.tenant.teamId，
 *   这是租户隔离的核心（A 团队用户不能读 B 团队活动）。
 *   注意：不能对全部表统一 WHERE team_id=?；仅 TEAM_SCOPED 表这样限定。
 * - activity_signups：TEAM_SCOPED 但 team_id 为派生（activity_id → activities.team_id），
 *   见 repository/activity-signups.ts（S2-6g），必须 JOIN activities 派生隔离。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired } from '../utils/errors';
import { isUlid } from '../utils/validation';
import { generateUlid } from '../utils/crypto';
import type { Paginated } from '../types/api';

/**
 * 报名所需的最小活动视图（S2-6g）。
 *
 * 刻意与 ActivityRow 分离：本视图只含报名判定所需字段，
 * 不进入既有 GET /activities 响应结构（避免改动 S2-5 已冻结的响应契约）。
 */
export interface ActivitySignupTarget {
  id: number;
  team_id: number;
  status: number;
  allow_cancel: number;
  need_audit: number;
}

export interface ActivityRow {
  id: number;
  public_id: string;
  team_id: number;
  title: string;
  summary: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  /** 活动级单次最大服务时长（分钟）；NULL = 该活动未冻结时长规则（未来 overlong detector 必须 SKIP）。S2-6k1 新增。 */
  max_session_minutes: number | null;
}

// =========================================================================
// P31-P1A：活动管理端（team-scoped）数据契约与原子写。
// 以下接口仅暴露 Beta 管理必需字段；team_id / created_by / 内部 numeric id
// 一律由服务端派生（R1 铁律），绝不接受客户端提交。
// =========================================================================

export interface SlotInput {
  name: string;
  start_time: number;
  end_time: number;
  capacity?: number;
}

export interface PositionInput {
  name: string;
  description?: string | null;
  required_count?: number;
  slots?: SlotInput[];
}

export interface OccurrenceInput {
  start_time: number;
  end_time: number;
  positions?: PositionInput[];
  /** 场次级时段（schema 外键指向 occurrence_id；不挂在岗位下）。 */
  slots?: SlotInput[];
}

export interface CreateActivityCommand {
  title: string;
  summary?: string | null;
  start_time: number;
  end_time: number;
  signup_deadline?: number | null;
  quota?: number;
  status?: number;
  max_session_minutes?: number | null;
  occurrences?: OccurrenceInput[];
}

export interface ActivityScalarUpdate {
  title?: string;
  summary?: string | null;
  start_time?: number;
  end_time?: number;
  signup_deadline?: number | null;
  quota?: number;
  max_session_minutes?: number | null;
}

export class ActivityRepository extends BaseRepository {
  /** 团队活动分页列表（TEAM_SCOPED：强制 team_id 隔离）。 */
  async listByMyTeam(page: number, pageSize: number, offset: number): Promise<Paginated<ActivityRow>> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();

    const teamId = this.ctx.tenant.teamId;
    const items = await this.all<ActivityRow>(
      `SELECT id, public_id, team_id, title, summary, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes
         FROM activities
        WHERE team_id = ? AND deleted_at IS NULL
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );

    const totalRow = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM activities WHERE team_id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    const total = totalRow?.total ?? 0;
    return {
      items,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /** 按 ULID 读取单个活动（TEAM_SCOPED：team_id 双重限定 → 跨团队访问返回 404）。 */
  async findByPublicId(publicId: string): Promise<ActivityRow> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<ActivityRow>(
      `SELECT id, public_id, team_id, title, summary, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }

  /**
   * 读取报名目标活动（S2-6g）。
   *
   * TEAM_SCOPED 双重限定：public_id = ? AND team_id = ? AND deleted_at IS NULL。
   * - 跨团队请求与不存在的活动走【同一 404 分支】，不泄露资源存在性（§十三）。
   * - 只返回报名判定字段，不查询 quota / signed_count —— 名额校验未冻结（OPEN BUSINESS RULE）。
   */
  async findSignupTargetByPublicId(publicId: string): Promise<ActivitySignupTarget> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<ActivitySignupTarget>(
      `SELECT id, team_id, status, allow_cancel, need_audit
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }

  // =======================================================================
  // P31-P1A：活动管理端写操作（全部 TEAM_SCOPED）。
  // 依赖 D1 batch 的「单事务、顺序执行」语义：同批内后发语句可通过
  // public_id 子查询引用先发语句插入的行（与 reviewSessionAtomically 的
  // INSERT...SELECT 同构，已为仓库既定模式）。任一语句失败 → 整批回滚，
  // DB 不留半成品（§4 原子性硬门禁）。
  // =======================================================================

  /**
   * 原子创建活动 + 嵌套 occurrence / position / slot 物化。
   * - team_id / created_by / public_id 全部服务端派生。
   * - occurrence 仅存 start_time/end_time/status（schema 无 title/capacity 列）。
   * - position 存 name/description（schema 无 title 列）。
   * - slot 存 occurrence_id + name/start_time/end_time/capacity（schema 外键指向 occurrence_id）。
   * - occurrence_positions 关联 occurrence ↔ position（required_count 软目标）。
   */
  async createActivityWithNested(
    cmd: CreateActivityCommand,
    teamId: number,
    createdBy: number,
  ): Promise<{ public_id: string }> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();

    const now = Math.floor(Date.now() / 1000);
    const activityPublicId = generateUlid();
    const status = typeof cmd.status === 'number' ? cmd.status : 0; // 默认草稿

    const statements: { sql: string; params: unknown[] }[] = [
      {
        sql: `INSERT INTO activities
                (public_id, team_id, title, summary, start_time, end_time,
                 signup_deadline, quota, status, max_session_minutes, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          activityPublicId,
          teamId,
          cmd.title,
          cmd.summary ?? null,
          cmd.start_time,
          cmd.end_time,
          cmd.signup_deadline ?? null,
          cmd.quota ?? 0,
          status,
          cmd.max_session_minutes ?? null,
          createdBy,
          now,
          now,
        ],
      },
    ];

    for (const occ of cmd.occurrences ?? []) {
      const occPublicId = generateUlid();
      statements.push({
        sql: `INSERT INTO activity_occurrences
                (public_id, activity_id, start_time, end_time, status, created_at, updated_at)
              VALUES (?, (SELECT id FROM activities WHERE public_id = ?), ?, ?, 1, ?, ?)`,
        params: [occPublicId, activityPublicId, occ.start_time, occ.end_time, now, now],
      });

      for (const pos of occ.positions ?? []) {
        const posPublicId = generateUlid();
        statements.push({
          sql: `INSERT INTO activity_positions
                  (public_id, activity_id, name, description, sort_order, created_at, updated_at)
                VALUES (?, (SELECT id FROM activities WHERE public_id = ?), ?, ?, 0, ?, ?)`,
          params: [posPublicId, activityPublicId, pos.name, pos.description ?? null, now, now],
        });
        statements.push({
          sql: `INSERT INTO occurrence_positions
                  (public_id, occurrence_id, position_id, required_count, sort_order, created_at, updated_at)
                VALUES (?, (SELECT id FROM activity_occurrences WHERE public_id = ?),
                        (SELECT id FROM activity_positions WHERE public_id = ?), ?, 0, ?, ?)`,
          params: [generateUlid(), occPublicId, posPublicId, pos.required_count ?? 0, now, now],
        });

        for (const slot of pos.slots ?? []) {
          const slotPublicId = generateUlid();
          statements.push({
            sql: `INSERT INTO activity_participation_slots
                    (public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, created_at, updated_at)
                  VALUES (?, (SELECT id FROM activity_occurrences WHERE public_id = ?), ?, ?, ?, ?, 0, ?, ?)`,
            params: [slotPublicId, occPublicId, slot.name, slot.start_time, slot.end_time, slot.capacity ?? 0, now, now],
          });
        }
      }

      // 场次级 slots（不挂在岗位下，schema 外键指向 occurrence_id）
      for (const slot of occ.slots ?? []) {
        const slotPublicId = generateUlid();
        statements.push({
          sql: `INSERT INTO activity_participation_slots
                  (public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, created_at, updated_at)
                VALUES (?, (SELECT id FROM activity_occurrences WHERE public_id = ?), ?, ?, ?, ?, 0, ?, ?)`,
          params: [slotPublicId, occPublicId, slot.name, slot.start_time, slot.end_time, slot.capacity ?? 0, now, now],
        });
      }
    }

    await this.batch(statements);
    return { public_id: activityPublicId };
  }

  /** 仅更新活动标量字段（Beta：不包含嵌套 occurrence/position/slot 重配置）。team_id 双重限定 → 跨团队 404。 */
  async updateActivityScalar(publicId: string, patch: ActivityScalarUpdate): Promise<void> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const sets: string[] = [];
    const params: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const apply = (col: string, val: unknown): void => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.title !== undefined) apply('title', patch.title);
    if (patch.summary !== undefined) apply('summary', patch.summary);
    if (patch.start_time !== undefined) apply('start_time', patch.start_time);
    if (patch.end_time !== undefined) apply('end_time', patch.end_time);
    if (patch.signup_deadline !== undefined) apply('signup_deadline', patch.signup_deadline);
    if (patch.quota !== undefined) apply('quota', patch.quota);
    if (patch.max_session_minutes !== undefined) apply('max_session_minutes', patch.max_session_minutes);

    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now, publicId, this.ctx.tenant.teamId);

    const res = await this.run(
      `UPDATE activities SET ${sets.join(', ')} WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      params,
    );
    // 跨团队 / 不存在 / 已逻辑删除 → 0 行 → 404（与 findByPublicId 一致，不泄露存在性，§7）。
    if ((res.meta?.changes ?? 0) === 0) throw notFound('Activity');
  }

  /** 读取发布前置状态（team-scoped；跨团队/不存在返回 null）。 */
  async getPublishStatus(publicId: string): Promise<number | null> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');
    const row = await this.first<{ status: number }>(
      `SELECT status FROM activities WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    return row ? row.status : null;
  }

  /** 发布草稿（status 0 → 1）。仅当当前为草稿时生效；否则 0 行（由 service 层转为 404/400）。 */
  async publishActivity(publicId: string): Promise<void> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const now = Math.floor(Date.now() / 1000);
    const res = await this.run(
      `UPDATE activities
          SET status = 1, published_at = ?, updated_at = ?
        WHERE public_id = ? AND team_id = ? AND status = 0 AND deleted_at IS NULL`,
      [now, now, publicId, this.ctx.tenant.teamId],
    );
    if ((res.meta?.changes ?? 0) === 0) throw notFound('Activity');
  }
}
