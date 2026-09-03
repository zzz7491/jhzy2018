/**
 * ActivitySignupRepository（S2-6g）—— activity_signups 的唯一写入口。
 *
 * scope 事实（S2-3 矩阵 / repository/tenant-scope.ts）：
 * - activity_signups = TEAM_SCOPED，且【无 team_id 列】→ DERIVED_TEAM_TABLES 成员。
 *   team 由 activity_id → activities.team_id 派生；所有查询必须 JOIN / EXISTS activities
 *   并以 a.team_id = ? 限定，禁止简单 WHERE team_id=?（该列根本不存在）。
 * - PermissionProvider 只裁决"当前用户能否报名"，【不】替代租户范围过滤
 *   （用户 §九：PermissionProvider != Tenant filter；中间件放行后 Repository 仍必须收口）。
 *
 * SQL 纪律（用户 §十）：全部 prepare().bind()，禁止字符串插值。
 *   activityId / signupId / userId / teamId / status 全部参数化。
 *
 * 并发安全（用户 §十二）：重复报名的唯一真相 = Schema 既有
 *   UNIQUE (user_id, activity_id)（0001_initial_schema.sql）。
 *   预检 SELECT 只是快路径（给出稳定的 409 reason）；真正的"不可能产生第二条"由数据库约束保证，
 *   INSERT 抛出 UNIQUE 冲突时同样收敛为 409（不泄露 SQL 原文）。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired, conflict, ConflictReason } from '../utils/errors';

export interface ActivitySignupRow {
  id: number;
  activity_id: number;
  user_id: number;
  review_status: number;
  status: number;
  cancel_count: number;
  created_at: number;
  updated_at: number | null;
}

/** activity_signups.status 字典（docs/嘉禾志愿2.0技术架构设计方案V1.0.md §activity_signups）。 */
export const SIGNUP_STATUS = {
  /** 1 已报名（有效报名） */
  REGISTERED: 1,
  /** 2 已取消 */
  CANCELLED: 2,
  /** 3 已签到（本阶段不涉及） */
  CHECKED_IN: 3,
  /** 4 已完成（本阶段不涉及） */
  COMPLETED: 4,
} as const;

/** activity_signups.review_status 字典（docs/嘉禾志愿V2.0 Phase0.4.2 状态字典核查报告，带代码出处）。 */
export const SIGNUP_REVIEW_STATUS = {
  /** 0 待审核 */
  PENDING: 0,
  /** 1 审核通过 */
  APPROVED: 1,
  /** 2 审核拒绝 */
  REJECTED: 2,
} as const;

/** SQLite/D1 UNIQUE 冲突错误特征（仅服务端判定使用，不向客户端回显）。 */
const UNIQUE_VIOLATION_RE = /unique\s+constraint\s+failed/i;

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return UNIQUE_VIOLATION_RE.test(msg);
}

export class ActivitySignupRepository extends BaseRepository {
  /** 当前租户团队 id；缺失即拒绝（TEAM_SCOPED 派生表同样必须落在团队上下文）。 */
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    return teamId;
  }

  /**
   * 查询本人名下该活动的报名行（任意 status），经 activities 派生租户隔离。
   * 用于重复报名预检：UNIQUE(user_id, activity_id) 覆盖全 status，故预检也不能只看 status=1。
   */
  async findOwnSignup(activityId: number, userId: number): Promise<ActivitySignupRow | null> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();

    return this.first<ActivitySignupRow>(
      `SELECT s.id, s.activity_id, s.user_id, s.review_status, s.status,
              s.cancel_count, s.created_at, s.updated_at
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.activity_id = ? AND s.user_id = ?
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityId, userId, teamId],
    );
  }

  /**
   * 查询本人名下该活动的【有效】报名行（status = 1 已报名）。
   * 取消流程只作用于有效报名；已取消行再次取消 → 查不到 → 404（冻结规则，见报告 §10）。
   */
  async findOwnActiveSignup(activityId: number, userId: number): Promise<ActivitySignupRow | null> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();

    return this.first<ActivitySignupRow>(
      `SELECT s.id, s.activity_id, s.user_id, s.review_status, s.status,
              s.cancel_count, s.created_at, s.updated_at
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.activity_id = ? AND s.user_id = ? AND s.status = ?
          AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityId, userId, SIGNUP_STATUS.REGISTERED, teamId],
    );
  }

  /**
   * 创建报名行。
   * - user_id 由调用方（Service）以 AuthContext.userId 传入，绝不来自请求体（§四 Ownership）。
   * - review_status 由调用方依据 activities.need_audit 计算后传入（免审→1 通过 / 需审→0 待审）。
   * - UNIQUE(user_id, activity_id) 冲突 → 抛 409 CONFLICT（race 分支），不泄露 SQL 原文。
   */
  async insertSignup(
    activityId: number,
    userId: number,
    reviewStatus: number,
    now: number,
  ): Promise<number> {
    this.ensureTableRead('activity_signups');
    this.requireTeamId();

    try {
      const res = await this.run(
        `INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [activityId, userId, reviewStatus, SIGNUP_STATUS.REGISTERED, now],
      );
      const id = Number(res.meta?.last_row_id ?? 0);
      if (id <= 0) throw conflict(ConflictReason.SIGNUP_DUPLICATE_RACE);
      return id;
    } catch (err) {
      // 并发重复报名：数据库唯一约束是唯一真相 → 收敛为 409，绝不回显 SQL / 表名。
      if (isUniqueViolation(err)) throw conflict(ConflictReason.SIGNUP_DUPLICATE_RACE);
      throw err;
    }
  }

  /**
   * 取消报名（原子 UPDATE，租户 + 归属 + 状态全部写入 WHERE）。
   *
   * 为什么把 tenant / ownership / status 全部放进 WHERE：
   * - §十四 IDOR：即使调用方拿到了跨团队的 signupId，EXISTS(activities.team_id = ?) 也会使其 0 命中。
   * - §十九：归属/租户不成立时 changes = 0 —— 无 UPDATE、无 status 变化、无任何副作用。
   * - 并发双取消：第二个请求 status 已不是 1 → changes = 0 → 上层 404。
   *
   * @returns true = 实际取消了 1 行；false = 未命中（跨团队 / 非本人 / 已取消 / 活动不存在）
   */
  async cancelOwnSignup(
    signupId: number,
    activityId: number,
    userId: number,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();

    const res = await this.run(
      `UPDATE activity_signups
          SET status = ?, cancel_count = cancel_count + 1, updated_at = ?
        WHERE id = ? AND activity_id = ? AND user_id = ? AND status = ?
          AND EXISTS (
            SELECT 1 FROM activities a
             WHERE a.id = activity_signups.activity_id
               AND a.team_id = ? AND a.deleted_at IS NULL
          )`,
      [SIGNUP_STATUS.CANCELLED, now, signupId, activityId, userId, SIGNUP_STATUS.REGISTERED, teamId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** 按 id 读取（取消后回显用；同样经 activities 派生租户隔离）。 */
  async findByIdForTeam(signupId: number): Promise<ActivitySignupRow> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();

    const row = await this.first<ActivitySignupRow>(
      `SELECT s.id, s.activity_id, s.user_id, s.review_status, s.status,
              s.cancel_count, s.created_at, s.updated_at
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [signupId, teamId],
    );
    if (!row) throw notFound('Signup');
    return row;
  }
}
