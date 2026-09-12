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
  form_submission_id: number | null; // P21（0016）
}

/** P21 读投影基础行（signup + form submission + frozen schema；service 层按权限裁剪）。 */
export interface SignupReadRow {
  id: number;
  activity_public_id: string;
  user_public_id: string;
  review_status: number;
  status: number;
  cancel_count: number;
  created_at: number;
  updated_at: number | null;
  form_data: string | null;
  submission_public_id: string | null;
  submission_status: number | null;
  version_public_id: string | null;
  answers_json: string | null;
  version_schema_json: string | null;
  submitter_user_id: number | null;
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
              s.cancel_count, s.created_at, s.updated_at, s.form_submission_id
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [signupId, teamId],
    );
    if (!row) throw notFound('Signup');
    return row;
  }

  /**
   * N0-E0：读取可审核报名行（TEAM_SCOPED 派生隔离 + 活动归属）。
   * 用于审核前的「存在性 / 当前 review_status」判定：
   * - 跨团队 / 不存在 / 不属于该活动 → null（统一 404，不泄露存在性）。
   * - 返回行供 Service 判定当前状态是否为 PENDING。
   */
  async findReviewableByIdForTeam(signupId: number, activityId: number): Promise<ActivitySignupRow | null> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();
    const row = await this.first<ActivitySignupRow>(
      `SELECT s.id, s.activity_id, s.user_id, s.review_status, s.status,
              s.cancel_count, s.created_at, s.updated_at, s.form_submission_id
         FROM activity_signups s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.id = ? AND s.activity_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [signupId, activityId, teamId],
    );
    return row ?? null;
  }

  /**
   * N0-E0：条件 UPDATE 写入审核结果。
   * - 强制 TEAM_SCOPED（EXISTS activities.team_id = ?）。
   * - 强制 review_status = 0 guard（仅 PENDING 允许跃迁）。
   * - activity_id / signup id / review_by / review_at 全部服务端派生，绝不接受客户端 override。
   * - 返回 changes：仅当真实命中 1 行（PENDING → APPROVED/REJECTED）时为 1。
   *   重复请求 / 并发 / 跨团队 / 不存在 → 0（上层按 transition/race/404 处理）。
   */
  async updateReviewStatusWithMeta(
    signupId: number,
    activityId: number,
    targetReviewStatus: number,
    reviewBy: number,
    reviewAt: number,
    reviewReason: string | null,
  ): Promise<number> {
    this.ensureTableRead('activity_signups');
    const teamId = this.requireTeamId();

    const res = await this.run(
      `UPDATE activity_signups
          SET review_status = ?,
              review_by = ?,
              review_at = ?,
              review_reason = ?,
              updated_at = ?
        WHERE id = ? AND activity_id = ? AND review_status = 0
          AND EXISTS (
            SELECT 1 FROM activities a
             WHERE a.id = activity_signups.activity_id
               AND a.team_id = ? AND a.deleted_at IS NULL
          )`,
      [targetReviewStatus, reviewBy, reviewAt, reviewReason, reviewAt, signupId, activityId, teamId],
    );
    return res.meta?.changes ?? 0;
  }

  // =========================================================================
  // P21 —— Signup × Form Submission 绑定 / 重报 / 读投影（唯一写入口保持本文件）
  // =========================================================================

  /** 仅绑定 P20 已 submitted 的 evidence：单条原子 INSERT…SELECT，guard 全含，以 changes 判定。 */
  async insertSignupWithFormAtomically(input: {
    activityPublicId: string;
    userId: number;
    teamId: number;
    submissionPublicId: string;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('activity_signups');
    const { activityPublicId, userId, teamId, submissionPublicId, now } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const res = await this.run(
      `INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at, form_submission_id)
       SELECT a.id, ${P(userId)}, (CASE WHEN a.need_audit = 1 THEN 0 ELSE 1 END), 1, ${P(now)}, s.id
         FROM activities a
         JOIN form_submissions s ON s.public_id = ${P(submissionPublicId)}
         JOIN form_definitions d ON d.id = s.definition_id
        WHERE a.public_id = ${P(activityPublicId)} AND a.team_id = ${P(teamId)}
          AND a.status = 1 AND a.deleted_at IS NULL
          AND s.status = 2 AND s.submitter_user_id = ${P(userId)}
          AND s.consumer_type = 'activity.signup' AND s.consumer_public_id = a.public_id
          AND d.team_id = a.team_id AND d.status = 2
          AND s.version_id = d.published_version_id
          AND EXISTS (SELECT 1 FROM form_bindings b
                       WHERE b.status = 1 AND b.consumer_type = 'activity.signup'
                         AND b.team_id = a.team_id AND b.consume_policy IN (1,2)
                         AND ( (b.consumer_public_id = a.public_id AND b.definition_id = s.definition_id)
                               OR (b.consumer_public_id IS NULL AND b.is_default = 1
                                   AND b.definition_id = s.definition_id) ))
          AND NOT EXISTS (SELECT 1 FROM activity_signups g
                           JOIN activities ga ON ga.id = g.activity_id
                          WHERE g.user_id = ${P(userId)} AND g.activity_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM activity_signups g2 WHERE g2.form_submission_id = s.id)`,
      params,
    );
    return Number(res.meta?.changes ?? 0);
  }

  /** 重新报名（无表单，form_submission_id=NULL）：原 cancelled 行 status=2 → 1。 */
  async reactivateSignupAtomically(input: {
    activityPublicId: string;
    userId: number;
    teamId: number;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('activity_signups');
    const { activityPublicId, userId, teamId, now } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const res = await this.run(
      `UPDATE activity_signups AS g
          SET status = 1,
              review_status = (SELECT CASE WHEN a.need_audit = 1 THEN 0 ELSE 1 END
                                FROM activities a
                               WHERE a.id = g.activity_id AND a.team_id = ${P(teamId)} AND a.deleted_at IS NULL),
              review_by = NULL, review_at = NULL, review_reason = NULL,
              form_submission_id = NULL,
              updated_at = ${P(now)}
        WHERE g.user_id = ${P(userId)} AND g.status = 2
          AND g.activity_id = (SELECT a.id FROM activities a
                                WHERE a.public_id = ${P(activityPublicId)}
                                  AND a.team_id = ${P(teamId)}
                                  AND a.status = 1 AND a.deleted_at IS NULL)`,
      params,
    );
    return Number(res.meta?.changes ?? 0);
  }

  /**
   * 重新报名（绑定已校验的证据 id）：原子 UPDATE…WHERE，关键 1:1 排除当前行内联。
   * 除确保原行 status=2（cancelled）外，对 ensureBindable 已核过的全部证据在 UPDATE 谓词内
   * 再次原子复核，消除 ensureBindable 与本次写之间的 TOCTOU（管理员 publish/archive/改 binding
   * 等中间态不可把旧证据错误绑入）：
   *   - 证据仍 submitted（status=2）
   *   - 证据归属本人（submitter_user_id = g.user_id）
   *   - 证据 consumer 匹配本活动（consumer_type + consumer_public_id = 活动 public_id）
   *   - 定义仍 published（d.status=2 且 team 一致）
   *   - 证据版本仍 = 当前 published_version_id
   *   - 活跃 binding 仍指向该 definition 且 consume_policy ∈ (1,2)
   *   - 该 evidence 未被其它 signup 占用（排除当前行）
   * 任一条件不满足 → changes=0 → 上层 reclassify 安全重分类（不泄露 SQL/内部 id）。
   */
  async reactivateSignupWithGivenSubmissionAtomically(input: {
    activityPublicId: string;
    userId: number;
    teamId: number;
    submissionId: number;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('activity_signups');
    const { activityPublicId, userId, teamId, submissionId, now } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const res = await this.run(
      `UPDATE activity_signups AS g
          SET status = 1,
              review_status = (SELECT CASE WHEN a.need_audit = 1 THEN 0 ELSE 1 END
                                FROM activities a
                               WHERE a.id = g.activity_id AND a.team_id = ${P(teamId)} AND a.deleted_at IS NULL),
              review_by = NULL, review_at = NULL, review_reason = NULL,
              form_submission_id = ${P(submissionId)}, updated_at = ${P(now)}
        WHERE g.user_id = ${P(userId)} AND g.status = 2
          AND g.activity_id = (SELECT a.id FROM activities a
                                WHERE a.public_id = ${P(activityPublicId)} AND a.team_id = ${P(teamId)}
                                  AND a.status = 1 AND a.deleted_at IS NULL)
          -- 证据仍 submitted + 归属本人 + consumer 匹配本活动
          AND EXISTS (SELECT 1 FROM form_submissions s
                       WHERE s.id = ${P(submissionId)}
                         AND s.status = 2
                         AND s.submitter_user_id = g.user_id
                         AND s.consumer_type = 'activity.signup'
                         AND s.consumer_public_id = (SELECT a2.public_id FROM activities a2 WHERE a2.id = g.activity_id))
          -- 定义仍 published 且证据版本仍 = 当前 published_version_id
          AND EXISTS (SELECT 1 FROM form_submissions s2
                       JOIN form_definitions d ON d.id = s2.definition_id
                      WHERE s2.id = ${P(submissionId)}
                        AND d.team_id = ${P(teamId)} AND d.status = 2
                        AND s2.version_id = d.published_version_id)
          -- 活跃 binding 仍指向该 definition 且 consume_policy ∈ (1,2)
          AND EXISTS (SELECT 1 FROM form_bindings b
                       WHERE b.status = 1 AND b.consumer_type = 'activity.signup'
                         AND b.team_id = ${P(teamId)} AND b.consume_policy IN (1,2)
                         AND EXISTS (SELECT 1 FROM form_submissions s3
                                      WHERE s3.id = ${P(submissionId)}
                                        AND ( (b.consumer_public_id = (SELECT a2.public_id FROM activities a2 WHERE a2.id = g.activity_id) AND b.definition_id = s3.definition_id)
                                              OR (b.consumer_public_id IS NULL AND b.is_default = 1 AND b.definition_id = s3.definition_id) )))
          -- 该 evidence 未被其它 signup 占用（排除当前行）
          AND NOT EXISTS (SELECT 1 FROM activity_signups g2 WHERE g2.form_submission_id = ${P(submissionId)} AND g2.id <> g.id)`,
      params,
    );
    return Number(res.meta?.changes ?? 0);
  }

  private readonly SIGNUP_READ_SELECT = `
    SELECT g.id, a.public_id AS activity_public_id, u.public_id AS user_public_id,
           g.review_status, g.status, g.cancel_count, g.created_at, g.updated_at,
           g.form_data, s.public_id AS submission_public_id, s.status AS submission_status,
           v.public_id AS version_public_id, s.answers_json, v.schema_json AS version_schema_json,
           s.submitter_user_id
      FROM activity_signups g
      JOIN activities a ON a.id = g.activity_id
      JOIN users u ON u.id = g.user_id
      LEFT JOIN form_submissions s ON s.id = g.form_submission_id
      LEFT JOIN form_definition_versions v ON v.id = s.version_id`;

  /** form_submission_id 被多少条 signup 使用（排除自身行；P21 1:1 占位判定）。 */
  async countFormSubmissionUsages(submissionId: number, excludeSignupId?: number): Promise<number> {
    this.ensureTableRead('activity_signups');
    this.requireTeamId();
    const row = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM activity_signups
        WHERE form_submission_id = ? AND (? IS NULL OR id <> ?)`,
      [submissionId, excludeSignupId ?? null, excludeSignupId ?? null],
    );
    return Number(row?.n ?? 0);
  }

  /** 本人唯一 signup 详情（含 cancelled；经活动派生租户隔离）。 */
  async findOwnSignupDetail(activityId: number, userId: number, teamId: number): Promise<SignupReadRow | null> {
    this.ensureTableRead('activity_signups');
    return this.first<SignupReadRow>(
      `${this.SIGNUP_READ_SELECT}
        WHERE g.activity_id = ? AND g.user_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityId, userId, teamId],
    );
  }

  /** 按 user_public_id 的指定 signup 详情（TEAM；跨团队/用户不存在 → null）。 */
  async findSignupDetailByUser(activityPublicId: string, userPublicId: string, teamId: number): Promise<SignupReadRow | null> {
    this.ensureTableRead('activity_signups');
    return this.first<SignupReadRow>(
      `${this.SIGNUP_READ_SELECT}
        WHERE a.public_id = ? AND u.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [activityPublicId, userPublicId, teamId],
    );
  }

  /** 团队 signup 列表（分页；含所有 status；不批量携带敏感 answers 由 service 层裁剪）。 */
  async listSignupsForTeam(activityPublicId: string, teamId: number, limit: number, offset: number): Promise<SignupReadRow[]> {
    this.ensureTableRead('activity_signups');
    return this.all<SignupReadRow>(
      `${this.SIGNUP_READ_SELECT}
        WHERE a.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT ? OFFSET ?`,
      [activityPublicId, teamId, limit, offset],
    );
  }
}
