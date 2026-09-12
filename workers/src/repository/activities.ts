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

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { BaseRepository } from './base';
import { notFound, teamScopeRequired } from '../utils/errors';
import { isUlid } from '../utils/validation';
import { generateUlid } from '../utils/crypto';
import type { Paginated } from '../types/api';
import type { NotificationInsertGate } from './notification';

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
  /** N0-E5C：WeChat payload 需活动名称（非负）。 */
  title: string;
  /** N0-E5C：WeChat payload 需活动地点（OPTIONAL，可 NULL → WeChat 跳过）。 */
  address: string | null;
}

export interface ActivityRow {
  id: number;
  public_id: string;
  team_id: number;
  title: string;
  summary: string | null;
  /**
   * 活动主地址（N0-E5A 激活）。
   *
   * 冻结契约（N0-E5A §3）：activities.address = 活动对报名者公开的【人类可读主地址】。
   * - 列已存在于 0001_initial_schema.sql（此前 dormant：0 写 / 0 读）。
   * - 本轮只激活 address；province / city / district / latitude / longitude /
   *   geo_radius / checkin_config 一律保持 dormant，不得在本字段内拼接。
   * - NULL = 未填写（展示层负责 fallback，不在此处伪造）。
   */
  address: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  /** 活动级单次最大服务时长（分钟）；NULL = 该活动未冻结时长规则（未来 overlong detector 必须 SKIP）。S2-6k1 新增。 */
  max_session_minutes: number | null;
  // ---------------------------------------------------------------------------
  // P34-C4A：管理端读契约补充（发布审核状态）。
  // 注意：仅暴露「状态 + 时间 + 原因」，不暴露任何审核主体 numeric identity
  // （created_by / submitted_by / reviewed_by 一律不进 DTO；职责分离判定在 service 层）。
  // ---------------------------------------------------------------------------
  /** 发布审核状态：0 DRAFT / 1 PENDING / 2 APPROVED / 3 REJECTED。DB NOT NULL DEFAULT 0（migration 0027）。 */
  audit_status: number;
  /** 提交审核时间（epoch 秒）；NULL = 从未提交。 */
  submitted_at: number | null;
  /** 审核完成时间（epoch 秒）；NULL = 尚未审核。 */
  reviewed_at: number | null;
  /** 驳回原因；NULL = 未驳回 / 非驳回路径。 */
  reject_reason: string | null;
}

/**
 * 志愿者公开可见活动视图（P34-C3）。
 *
 * 仅含志愿者端所需字段，且不暴露内部 numeric id / team_id（避免 id 泄露，A.§14 / D.§12）。
 * 与 ActivityRow 分离：本视图不进入管理端 GET /activities 响应契约。
 */
export interface VolunteerActivityRow {
  public_id: string;
  title: string;
  summary: string | null;
  /** 活动主地址（N0-E5A 激活）：志愿者可见活动同样下发；NULL = 未填写。 */
  address: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  audit_status: number;
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
  /** 活动主地址（N0-E5A）：optional；服务端 trim 后写入，空白 → NULL。 */
  address?: string | null;
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
  /** 活动主地址（N0-E5A）：optional；显式 null / 空白串 → 清空为 NULL。 */
  address?: string | null;
  start_time?: number;
  end_time?: number;
  signup_deadline?: number | null;
  quota?: number;
  max_session_minutes?: number | null;
}

// =========================================================================
// P34-C2：活动发布审核状态机（双维度，严格分离）
//
//   lifecycle status  —— 业务生命周期（既有列，语义不变）
//   audit_status      —— 发布审核维度（0027 新增列）
//
// 两者不得混用；lifecycle 6/7 保留未分配，绝不用于审核态。
// =========================================================================

export const ACTIVITY_STATUS = {
  DRAFT: 0,
  SIGNUP_OPEN: 1,
  IN_PROGRESS: 2,
  ENDED: 3,
  CANCELLED: 4,
  UNPUBLISHED: 5,
} as const;

export const ACTIVITY_AUDIT = {
  DRAFT: 0,
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
} as const;

/** audit_status → 稳定文本标签（写入 content_audit_logs.from_status/to_status）。 */
export const ACTIVITY_AUDIT_LABEL: Readonly<Record<number, string>> = {
  [ACTIVITY_AUDIT.DRAFT]: 'DRAFT',
  [ACTIVITY_AUDIT.PENDING]: 'PENDING',
  [ACTIVITY_AUDIT.APPROVED]: 'APPROVED',
  [ACTIVITY_AUDIT.REJECTED]: 'REJECTED',
};

/**
 * 发布/审核相关字段一律服务端权威，客户端不得提交（P34-C2 §3 / §8）。
 * 出现在 create / update body 中 → 400 INVALID_PARAM（不静默忽略）。
 * 注意：publish_audit_by 为 LEGACY_DORMANT，永不写入、永不删除、永不 rename。
 */
export const ACTIVITY_FORBIDDEN_PUBLICATION_FIELDS = [
  'status',
  'audit_status',
  'published_at',
  'submitted_by',
  'submitted_at',
  'reviewed_by',
  'reviewed_at',
  'reject_reason',
  'publish_audit_by',
] as const;

/** 审核所需最小活动视图（team-scoped；含职责分离判定所需主体）。 */
export interface ActivityApprovalState {
  id: number;
  status: number;
  audit_status: number;
  created_by: number;
  submitted_by: number | null;
  submitted_at: number | null;
  reviewed_by: number | null;
  /**
   * N0-F2：活动名称，供 IN_APP 审核结果通知正文使用（不进入任何 API 响应 DTO）。
   * 与 ActivitySignupTarget.title 同一来源列，非新增列。
   */
  title: string;
}

export class ActivityRepository extends BaseRepository {
  /** team_id 恒服务端派生（TEAM_SCOPED 铁律）；缺失 → 403 team scope required。 */
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    return teamId;
  }

  /** 团队活动分页列表（TEAM_SCOPED：强制 team_id 隔离）。 */
  async listByMyTeam(page: number, pageSize: number, offset: number): Promise<Paginated<ActivityRow>> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();

    const teamId = this.ctx.tenant.teamId;
    const items = await this.all<ActivityRow>(
      `SELECT id, public_id, team_id, title, summary, address, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes,
              audit_status, submitted_at, reviewed_at, reject_reason
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
      `SELECT id, public_id, team_id, title, summary, address, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes,
              audit_status, submitted_at, reviewed_at, reject_reason
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }

  /**
   * 志愿者公开可见活动（P34-C3）：仅返回 audit_status=APPROVED 且 lifecycle status ∈ (1,2,3,4)
   * 的活动。TEAM_SCOPED（team_id 双重限定 → 跨团队 / 不可见状态 → 同一 404）。
   * 投影不含内部 id / team_id（避免 numeric DB id 泄露，A.§14 / D.§12）。
   */
  async listVolunteerVisible(page: number, pageSize: number, offset: number): Promise<Paginated<VolunteerActivityRow>> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();

    const teamId = this.ctx.tenant.teamId;
    const where = `WHERE team_id = ? AND deleted_at IS NULL AND audit_status = 2 AND status IN (1,2,3,4)`;
    const items = await this.all<VolunteerActivityRow>(
      `SELECT public_id, title, summary, address, start_time, end_time,
              signup_deadline, quota, signed_count, status, audit_status, max_session_minutes
         FROM activities ${where}
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );

    const totalRow = await this.first<{ total: number }>(`SELECT COUNT(*) AS total FROM activities ${where}`, [teamId]);
    const total = totalRow?.total ?? 0;
    return {
      items,
      pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async findVolunteerVisibleByPublicId(publicId: string): Promise<VolunteerActivityRow> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<VolunteerActivityRow>(
      `SELECT public_id, title, summary, address, start_time, end_time, signup_deadline,
              quota, signed_count, status, audit_status, max_session_minutes
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL
          AND audit_status = 2 AND status IN (1,2,3,4)`,
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
      `SELECT id, team_id, status, allow_cancel, need_audit, title, address
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }

  /**
   * 报名资格查询（P34-C3 blocker fix）。
   *
   * 仅当活动同时满足【创建新报名】资格时才返回，否则走 404（与"不可见/不存在"一致，不泄露活动存在性）：
   *   audit_status = APPROVED(2) AND status = SIGNUP_OPEN(1) AND deleted_at IS NULL AND team_id 匹配。
   *
   * 与 findSignupTargetByPublicId 的区别：
   * - 本方法额外强制 audit_status = APPROVED，杜绝志愿者对"已开放但未过审"活动（status=1 + audit DRAFT/PENDING/REJECTED）
   *   以及任意非开放态（status 0/2/3/4/5）创建新报名。
   * - 仅用于【创建新报名】路径（createOwn）；cancel / 历史读 / attendance / checkin / checkout 仍使用
   *   findSignupTargetByPublicId（保留历史 participation / service 数据可读性，不被 visibility predicate 误伤）。
   */
  async findSignupEligibleByPublicId(publicId: string): Promise<ActivitySignupTarget> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<ActivitySignupTarget>(
      `SELECT id, team_id, status, allow_cancel, need_audit
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL
          AND status = 1 AND audit_status = 2`,
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
    // P34-C2 §3：create 一律服务端权威 —— status = 0 (DRAFT)、audit_status = 0 (DRAFT)。
    // 客户端提交的 status 一律不接受（路由层对 forbidden 字段返回 400；此处再兜底强制草稿）。
    const status = ACTIVITY_STATUS.DRAFT;

    const statements: { sql: string; params: unknown[] }[] = [
      {
        sql: `INSERT INTO activities
                (public_id, team_id, title, summary, address, start_time, end_time,
                 signup_deadline, quota, status, audit_status, max_session_minutes,
                 created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          activityPublicId,
          teamId,
          cmd.title,
          cmd.summary ?? null,
          cmd.address ?? null,
          cmd.start_time,
          cmd.end_time,
          cmd.signup_deadline ?? null,
          cmd.quota ?? 0,
          status,
          ACTIVITY_AUDIT.DRAFT,
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
    if (patch.address !== undefined) apply('address', patch.address);
    if (patch.start_time !== undefined) apply('start_time', patch.start_time);
    if (patch.end_time !== undefined) apply('end_time', patch.end_time);
    if (patch.signup_deadline !== undefined) apply('signup_deadline', patch.signup_deadline);
    if (patch.quota !== undefined) apply('quota', patch.quota);
    if (patch.max_session_minutes !== undefined) apply('max_session_minutes', patch.max_session_minutes);

    if (sets.length === 0) return;

    // P34-C2 §7：UNIFORM RE-REVIEW —— 任何管理员业务编辑都使活动重新进入 DRAFT 审核起点，
    // 并清空全部发布 / 审核元数据（published_at / submitted_* / reviewed_* / reject_reason）。
    // 不做 major/minor 分类器；已发布活动被编辑后必须重新 submit + 他人审核。
    sets.push('status = ?');
    params.push(ACTIVITY_STATUS.DRAFT);
    sets.push('audit_status = ?');
    params.push(ACTIVITY_AUDIT.DRAFT);
    sets.push('published_at = NULL');
    sets.push('submitted_by = NULL');
    sets.push('submitted_at = NULL');
    sets.push('reviewed_by = NULL');
    sets.push('reviewed_at = NULL');
    sets.push('reject_reason = NULL');

    sets.push('updated_at = ?');
    params.push(now, publicId, this.ctx.tenant.teamId);

    const res = await this.run(
      `UPDATE activities SET ${sets.join(', ')} WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      params,
    );
    // 跨团队 / 不存在 / 已逻辑删除 → 0 行 → 404（与 findByPublicId 一致，不泄露存在性，§7）。
    if ((res.meta?.changes ?? 0) === 0) throw notFound('Activity');
  }

  /** 读取审核所需最小状态（team-scoped；跨团队 / 不存在 / 已删除 → null → 404）。 */
  async getApprovalState(publicId: string): Promise<ActivityApprovalState | null> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');
    return this.first<ActivityApprovalState>(
      `SELECT id, status, audit_status, created_by, submitted_by, submitted_at, reviewed_by, title
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
  }

  /**
   * N0-F2 R1-A：取「当前 PENDING 审核轮次」对应的 submit audit log id（严格当前轮次锁定）。
   *
   * 数据契约（R1-A §1 已证明，非推测）：在 submitForApprovalAtomically 中，submit audit log 的
   * created_at 与 activities.submitted_at 来自【同一个 now】值（submit() 行内单次计算、
   * 同一 db.batch 内写入），类型同为 epoch 秒，故正常流程下两者恒等：
   *     submit_log.created_at == activities.submitted_at
   *
   * 据此在 R1「MAX(created_at, id)」基础上追加【轮次时间窗谓词】
   *     AND created_at = <当前 activity.submitted_at>
   * 把候选严格收敛到当前 PENDING 轮次：
   *   - 同秒多轮（Round1 submit@S → REJECTED → Round2 submit@S）：两轮 submit log 均
   *     created_at=S，但 Round2 的 id 更大；ORDER BY id DESC → 取 Round2，绝不回退到 Round1；
   *   - 历史旧 submit log（created_at ≠ 当前 submitted_at，例如数据不一致 / 异常回填）：
   *     直接被谓词排除，不会误选为当前轮次；
   *   - 缺失 / 时间窗不匹配 → 返回 null → 调用方批前 internalError（数据一致性缺失）。
   *
   * 该谓词依赖 §1 证明的同源契约；若未来提交路径破坏该契约（created_at 与 submitted_at 不再同源），
   * 则本方法须随之修订，不得降级为「仅 MAX(created_at)」的宽松取最新（那会重新引入 R1-A 缺陷）。
   *
   * @param submittedAt 当前 PENDING activity 的 submitted_at（调用方从 state 透传，非重新读取）。
   *                   可能为 null（DRAFT / 异常），此时 created_at = NULL 永不成立 → 返回 null → 批前失败。
   * @returns 当前轮次 submit audit log 的 id；无匹配（缺失 / 仅历史旧 log / 时间窗不符）→ null。
   *          调用方须据此显式失败为「数据一致性缺失」（批前，不写通知 / audit log / UPDATE）。
   *
   * 注意：content_audit_logs 为 AUDIT_ONLY 表，本方法不调用 ensureTableRead（与同文件
   * buildGatedAuditLogStatement 写该表时一致），仅做 team_id 派生校验，避免破坏 team_auditor 审核路径。
   */
  async findCurrentSubmitAuditLogId(
    activityId: number,
    submittedAt: number | null,
  ): Promise<number | null> {
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    // R1-A 轮次时间窗谓词：仅接受 created_at == 当前 activity.submitted_at 的 submit log。
    const row = await this.first<{ id: number }>(
      `SELECT id
         FROM content_audit_logs
        WHERE target_type = 'activity'
          AND target_id = ?
          AND action = 'submit'
          AND team_id = ?
          AND created_at = ?
        ORDER BY id DESC
        LIMIT 1`,
      [activityId, this.ctx.tenant.teamId, submittedAt],
    );
    return row?.id ?? null;
  }

  // =========================================================================
  // N0-F2 —— 发布审核的谓词门控原子批（POST-state 单一真相仍为 guarded UPDATE）
  //
  // 为什么需要：本轮之前 submit/approve/reject 是「guarded UPDATE」+「content_audit_logs
  // INSERT」两次独立 I/O，approve/reject 还要额外写 IN_APP 通知 → 存在
  //   「UPDATE 成功但 audit log 失败」/「UPDATE 成功但通知缺失」/「通知成功但 UPDATE 失败」
  // 三类部分成功窗口。本区块把三者收敛进同一个 db.batch。
  //
  // 结构（复刻 N0-E1 activity-signups.reviewSignupAtomically 的共享谓词范式）：
  //   statements = [ ...notificationStatements, gated auditLog INSERT, guarded UPDATE ]
  //   UPDATE 恒在【最后】。
  //
  // 正确性论证（确定性，非概率性）：
  // 1) notification / content_audit_logs 语句只写各自的表，【不触碰】activities
  //    → 不改变谓词 P 的真值；
  // 2) db.batch 为单写事务、语句顺序执行并持 SQLite 写锁，批内无其它写者穿插；
  // 3) 故 UPDATE 求值 P 时其真值与门控语句求值时的真值【必然相同】。
  // 由 (1)(2)(3)：P 真 → 1 通知 + 1 recipient + 1 audit log + 1 行 UPDATE；
  //              P 假 → 0 / 0 / 0 / 0。
  // 任一语句发生真实 SQL 错误 → 整批回滚，不存在部分成功；本层不做任何补偿写。
  // =========================================================================

  /**
   * 构造「共享 PRE-state 谓词 P」门控片段（供 Notification Core / audit log 组合使用）。
   *
   *   P := activities.id = ? ∧ activities.public_id = ? ∧ activities.team_id = ?
   *        ∧ activities.deleted_at IS NULL ∧ activities.audit_status = 1 (PENDING)
   *
   * teamId 恒服务端派生，绝不接受客户端 override。
   */
  buildReviewGate(p: { activityId: number; activityPublicId: string }): NotificationInsertGate {
    this.ensureTableRead('activities');
    const teamId = this.requireTeamId();
    return {
      existsSql: `EXISTS (
            SELECT 1 FROM activities g
             WHERE g.id = ? AND g.public_id = ? AND g.team_id = ?
               AND g.deleted_at IS NULL AND g.audit_status = ?
          )`,
      params: [p.activityId, p.activityPublicId, teamId, ACTIVITY_AUDIT.PENDING],
    };
  }

  /** submit 的共享谓词：audit_status ∈ {DRAFT, REJECTED}。 */
  buildSubmitGate(p: { activityId: number; activityPublicId: string }): NotificationInsertGate {
    this.ensureTableRead('activities');
    const teamId = this.requireTeamId();
    return {
      existsSql: `EXISTS (
            SELECT 1 FROM activities g
             WHERE g.id = ? AND g.public_id = ? AND g.team_id = ?
               AND g.deleted_at IS NULL AND g.audit_status IN (?, ?)
          )`,
      params: [
        p.activityId,
        p.activityPublicId,
        teamId,
        ACTIVITY_AUDIT.DRAFT,
        ACTIVITY_AUDIT.REJECTED,
      ],
    };
  }

  /** gated content_audit_logs INSERT（复用 BaseRepository 的单条 SQL 事实源语义）。 */
  private buildGatedAuditLogStatement(p: {
    activityId: number;
    action: 'submit' | 'approve' | 'reject';
    fromAudit: number;
    toAudit: number;
    reason: string | null;
    operatorId: number;
    now: number;
    gate: NotificationInsertGate;
  }): D1PreparedStatement {
    const teamId = this.requireTeamId();
    return this.db
      .prepare(
        `INSERT INTO content_audit_logs
           (target_type, target_id, action, from_status, to_status, reason, operator_id, team_id, created_at)
         SELECT 'activity', ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${p.gate.existsSql}`,
      )
      .bind(
        p.activityId,
        p.action,
        ACTIVITY_AUDIT_LABEL[p.fromAudit] ?? String(p.fromAudit),
        ACTIVITY_AUDIT_LABEL[p.toAudit] ?? String(p.toAudit),
        p.reason,
        p.operatorId,
        teamId,
        p.now,
        ...(p.gate.params as never[]),
      );
  }

  /**
   * submit 原子批：gated audit log INSERT + guarded audit_status UPDATE（UPDATE 最后）。
   * @returns UPDATE 实际变更行数（1=跃迁成功；0=谓词落空 → 调用方区分 404 / 409）。
   */
  async submitForApprovalAtomically(p: {
    activityId: number;
    activityPublicId: string;
    operatorId: number;
    now: number;
    fromAudit: number;
    gate: NotificationInsertGate;
  }): Promise<number> {
    this.ensureTableRead('activities');
    const teamId = this.requireTeamId();

    const auditLogStmt = this.buildGatedAuditLogStatement({
      activityId: p.activityId,
      action: 'submit',
      fromAudit: p.fromAudit,
      toAudit: ACTIVITY_AUDIT.PENDING,
      reason: null,
      operatorId: p.operatorId,
      now: p.now,
      gate: p.gate,
    });

    const updateStmt = this.db
      .prepare(
        `UPDATE activities
            SET audit_status = ?, status = ?,
                submitted_by = ?, submitted_at = ?,
                reviewed_by = NULL, reviewed_at = NULL, reject_reason = NULL,
                updated_at = ?
          WHERE id = ? AND public_id = ? AND team_id = ? AND deleted_at IS NULL
            AND audit_status IN (?, ?)`,
      )
      .bind(
        ACTIVITY_AUDIT.PENDING,
        ACTIVITY_STATUS.DRAFT,
        p.operatorId,
        p.now,
        p.now,
        p.activityId,
        p.activityPublicId,
        teamId,
        ACTIVITY_AUDIT.DRAFT,
        ACTIVITY_AUDIT.REJECTED,
      );

    const results = await this.db.batch([auditLogStmt, updateStmt]);
    return Number(results[results.length - 1]?.meta?.changes ?? 0);
  }

  /**
   * approve / reject 原子批：
   *   [ ...notificationStatements, gated audit log INSERT, guarded activities UPDATE ]
   *
   * P34-C2 既有语义逐项保持：
   *   - approve：audit_status→APPROVED、status→SIGNUP_OPEN、published_at=now、reject_reason=NULL；
   *   - reject ：audit_status→REJECTED、status→DRAFT、reject_reason=reason、published_at 不动；
   *   - 两者均写 reviewed_by / reviewed_at / updated_at。
   *
   * @returns UPDATE 实际变更行数（1=跃迁成功；0=谓词落空 → 调用方区分 404 / 409）。
   */
  async reviewActivityAtomically(p: {
    action: 'approve' | 'reject';
    activityId: number;
    activityPublicId: string;
    auditStatus: number;
    status: number;
    reviewBy: number;
    reviewAt: number;
    rejectReason: string | null;
    gate: NotificationInsertGate;
    notificationStatements: D1PreparedStatement[];
  }): Promise<number> {
    this.ensureTableRead('activities');
    const teamId = this.requireTeamId();

    const auditLogStmt = this.buildGatedAuditLogStatement({
      activityId: p.activityId,
      action: p.action,
      fromAudit: ACTIVITY_AUDIT.PENDING,
      toAudit: p.auditStatus,
      reason: p.rejectReason,
      operatorId: p.reviewBy,
      now: p.reviewAt,
      gate: p.gate,
    });

    const updateStmt =
      p.action === 'approve'
        ? this.db
            .prepare(
              `UPDATE activities
                  SET audit_status = ?, status = ?,
                      reviewed_by = ?, reviewed_at = ?, reject_reason = NULL,
                      published_at = ?, updated_at = ?
                WHERE id = ? AND public_id = ? AND team_id = ? AND deleted_at IS NULL
                  AND audit_status = ?`,
            )
            .bind(
              p.auditStatus,
              p.status,
              p.reviewBy,
              p.reviewAt,
              p.reviewAt, // published_at
              p.reviewAt, // updated_at
              p.activityId,
              p.activityPublicId,
              teamId,
              ACTIVITY_AUDIT.PENDING,
            )
        : this.db
            .prepare(
              `UPDATE activities
                  SET audit_status = ?, status = ?,
                      reviewed_by = ?, reviewed_at = ?, reject_reason = ?,
                      updated_at = ?
                WHERE id = ? AND public_id = ? AND team_id = ? AND deleted_at IS NULL
                  AND audit_status = ?`,
            )
            .bind(
              p.auditStatus,
              p.status,
              p.reviewBy,
              p.reviewAt,
              p.rejectReason,
              p.reviewAt, // updated_at
              p.activityId,
              p.activityPublicId,
              teamId,
              ACTIVITY_AUDIT.PENDING,
            );

    const results = await this.db.batch([...p.notificationStatements, auditLogStmt, updateStmt]);
    return Number(results[results.length - 1]?.meta?.changes ?? 0);
  }

  // -------------------------------------------------------------------------
  // N0-F2 移除说明（无替代 stub，直接不存在这些方法）：
  //
  //   旧 submitForApproval / approveForPublication / rejectForRevision 为
  //   「guarded UPDATE」单次 I/O；旧 insertActivityAuditLog 为「独立 audit log INSERT」。
  //   二者组合即产生 §3 明令禁止的部分成功窗口：
  //     * UPDATE 成功但 audit log 失败；
  //     * UPDATE 成功但 IN_APP 通知缺失。
  //   本轮以 submitForApprovalAtomically / reviewActivityAtomically（同一 db.batch，
  //   共享 PRE-state 谓词，UPDATE 恒在最后）完全取代，故这四个方法已从 runtime 移除。
  //
  //   P34-C2 语义（audit_status/status/reviewed_by/reviewed_at/reject_reason/published_at
  //   的取值与守卫条件）逐项保留于上述原子方法内，不改变业务状态机。
  // -------------------------------------------------------------------------
}
