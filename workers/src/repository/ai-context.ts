/**
 * 嘉禾 AI V1 —— volunteer_assist 业务上下文【只读】仓库（P36-C2）。
 *
 * 纪律（冻结 P36-B §3 / 任务 §2/§3/§4）：
 * - **AI 不查库、不生成 SQL、不决定 scope**：所有查询在此以**服务端确定性**执行，
 *   没有一处由调用方（更不是模型）拼接或选择。
 * - **作用域确定**：每条查询都以 `auth.userId`（本人）+ `tenant.teamId`（当前团队）为界；
 *   跨团队 / 他人 / 未公开 / 草稿数据一律不得返回。
 * - **只读**：本文件只有 SELECT，绝无写语句（测试以源码扫描证明）。
 * - **最小投影**（§4）：绝不选择 internal numeric 主键 / `*_id` 外键 / 隐私密文
 *   （real_name_enc / id_card_* / phone_* / emergency_contact_enc / identity_hash）/
 *   审计数据（AUDIT_ONLY）。只允许 public_id + 业务标题/名称 + 状态 + 时间 + 数值 + 摘要。
 * - **代码级 guard**：注入 provider 前的最终行级 `assertNoForbiddenKeys` 由**组装层**
 *   （`services/ai/data-block.ts`）施加——本仓库只负责「最小投影」，不反向依赖 services 层
 *   （保持 repository → services 零依赖的既有分层）。
 * - 表级 scope guard 复用 `BaseRepository.ensureTableRead`（单一事实来源）。
 */

import { BaseRepository } from './base';
import { ARTICLE_STATUS, ARTICLE_AUDIT } from './content';

/** 各来源的默认读取上限（服务端固定；防止 context 无界膨胀）。 */
export interface AIContextLimits {
  activities: number;
  participations: number;
  serviceRecords: number;
  growth: number;
  training: number;
  exams: number;
  certificates: number;
  content: number;
}

export const AI_CONTEXT_DEFAULT_LIMITS: AIContextLimits = {
  activities: 20,
  participations: 20,
  serviceRecords: 20,
  growth: 20,
  training: 20,
  exams: 10,
  certificates: 20,
  content: 10,
};

/** 活动「志愿者可见」判定（与 activities.ts#listVolunteerVisible 完全一致）。 */
const ACTIVITY_AUDIT_APPROVED = 2;
const ACTIVITY_VISIBLE_STATUSES = [1, 2, 3, 4];

export interface AITeamInfo {
  public_id: string;
  name: string;
  short_name: string | null;
  intro: string | null;
}

export interface AIActivityItem {
  public_id: string;
  title: string;
  summary: string | null;
  start_time: number;
  end_time: number;
  status: number;
}

export interface AIParticipationItem {
  public_id: string;
  activity_public_id: string;
  activity_title: string;
  status: number;
  created_at: number;
}

export interface AIServiceRecordItem {
  public_id: string;
  minutes: number;
  points_awarded_units: number;
  settlement_status: number;
  business_service_date: string | null;
}

export interface AIPointsAccount {
  balance: number;
  total_earned: number;
  total_spent: number;
}

export interface AIGrowthItem {
  action_type: string;
  value: number;
  balance_after: number;
  created_at: number;
}

export interface AITrainingItem {
  course_public_id: string;
  title: string;
  progress: number;
  learned_minutes: number;
  status: number;
}

export interface AIExamItem {
  paper_public_id: string | null;
  title: string;
  score: number | null;
  passed: number | null;
  submitted_at: number | null;
}

export interface AICertificateItem {
  public_id: string;
  cert_type: string;
  issuer_name: string | null;
  issued_at: number;
  status: number;
}

export interface AIContentItem {
  public_id: string;
  content_type: string;
  title: string;
  summary: string | null;
}

export class AIContextRepository extends BaseRepository {
  private readonly limits: AIContextLimits;

  constructor(deps: ConstructorParameters<typeof BaseRepository>[0], limits?: Partial<AIContextLimits>) {
    super(deps);
    this.limits = { ...AI_CONTEXT_DEFAULT_LIMITS, ...(limits ?? {}) };
  }

  /** 当前团队（active team）id；无团队上下文时为 null。 */
  get teamId(): number | null {
    return this.ctx.tenant.teamId;
  }

  /** 当前用户 id；未认证时为 null。 */
  get userId(): number | null {
    return this.ctx.auth.userId;
  }

  /** A. 当前团队基本信息（teams = PLATFORM_GLOBAL；以 active teamId 限定）。 */
  async readTeam(): Promise<AITeamInfo | null> {
    this.ensureTableRead('teams');
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) return null;
    const row = await this.first<AITeamInfo>(
      `SELECT public_id, name, short_name, intro
         FROM teams
        WHERE id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    return row ?? null;
  }

  /** B. 当前团队「志愿者可见」活动（与 listVolunteerVisible 同一可见性判定）。 */
  async listVisibleActivities(): Promise<AIActivityItem[]> {
    this.ensureTableRead('activities');
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) return [];
    const rows = await this.all<AIActivityItem>(
      `SELECT public_id, title, summary, start_time, end_time, status
         FROM activities
        WHERE team_id = ? AND deleted_at IS NULL
          AND audit_status = ? AND status IN (?, ?, ?, ?)
        ORDER BY start_time DESC
        LIMIT ?`,
      [teamId, ACTIVITY_AUDIT_APPROVED, ...ACTIVITY_VISIBLE_STATUSES, this.limits.activities],
    );
    return rows;
  }

  /** C. 当前用户【本人】参与记录（user_id 由服务端 auth 提供；跨团队/他人不可得）。 */
  async listMyParticipations(): Promise<AIParticipationItem[]> {
    this.ensureTableRead('activity_participations');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null || userId == null) return [];
    const rows = await this.all<AIParticipationItem>(
      `SELECT p.public_id AS public_id,
              a.public_id AS activity_public_id,
              a.title     AS activity_title,
              p.status    AS status,
              p.created_at AS created_at
         FROM activity_participations p
         JOIN activity_signups s ON s.id = p.signup_id
         JOIN activities a       ON a.id = s.activity_id
        WHERE s.user_id = ? AND a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY p.created_at DESC
        LIMIT ?`,
      [userId, teamId, this.limits.participations],
    );
    return rows;
  }

  /** D. 当前用户【本人】服务时长记录（TEAM_SCOPED：user_id + team_id 双限定）。 */
  async listMyServiceRecords(): Promise<AIServiceRecordItem[]> {
    this.ensureTableRead('service_records');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null || userId == null) return [];
    const rows = await this.all<AIServiceRecordItem>(
      `SELECT public_id, minutes, points_awarded_units, settlement_status, business_service_date
         FROM service_records
        WHERE user_id = ? AND team_id = ?
        ORDER BY service_date DESC
        LIMIT ?`,
      [userId, teamId, this.limits.serviceRecords],
    );
    return rows;
  }

  /** E. 当前用户【本人】积分账户（USER_SCOPED）。 */
  async readMyPoints(): Promise<AIPointsAccount | null> {
    this.ensureTableRead('points_accounts');
    const userId = this.ctx.auth.userId;
    if (userId == null) return null;
    const row = await this.first<AIPointsAccount>(
      `SELECT balance, total_earned, total_spent FROM points_accounts WHERE user_id = ?`,
      [userId],
    );
    return row ?? null;
  }

  /** F. 当前用户【本人】成长记录（USER_SCOPED）。 */
  async listMyGrowth(): Promise<AIGrowthItem[]> {
    this.ensureTableRead('growth_records');
    const userId = this.ctx.auth.userId;
    if (userId == null) return [];
    const rows = await this.all<AIGrowthItem>(
      `SELECT action_type, value, balance_after, created_at
         FROM growth_records
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [userId, this.limits.growth],
    );
    return rows;
  }

  /** G. 当前用户【本人】培训报名/进度（TEAM_SCOPED：ce.user_id + ce.team_id 双限定）。 */
  async listMyTraining(): Promise<AITrainingItem[]> {
    this.ensureTableRead('course_enrollments');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null || userId == null) return [];
    const rows = await this.all<AITrainingItem>(
      `SELECT c.public_id AS course_public_id,
              c.title     AS title,
              ce.progress AS progress,
              ce.learned_minutes AS learned_minutes,
              ce.status   AS status
         FROM course_enrollments ce
         JOIN courses c ON c.id = ce.course_id
        WHERE ce.user_id = ? AND ce.team_id = ? AND c.deleted_at IS NULL
        ORDER BY ce.created_at DESC
        LIMIT ?`,
      [userId, teamId, this.limits.training],
    );
    return rows;
  }

  /** H1. 当前用户【本人】考试记录（TEAM_SCOPED：es.user_id + es.team_id）。 */
  async listMyExams(): Promise<AIExamItem[]> {
    this.ensureTableRead('exam_sessions');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null || userId == null) return [];
    const rows = await this.all<AIExamItem>(
      `SELECT ep.public_id AS paper_public_id,
              ep.title     AS title,
              es.score     AS score,
              es.passed    AS passed,
              es.submitted_at AS submitted_at
         FROM exam_sessions es
         JOIN exam_papers ep ON ep.id = es.paper_id
        WHERE es.user_id = ? AND es.team_id = ?
        ORDER BY es.started_at DESC
        LIMIT ?`,
      [userId, teamId, this.limits.exams],
    );
    return rows;
  }

  /** H2. 当前用户【本人】证书（TEAM_SCOPED）。刻意不含 holder_name / 证书编号（最小化）。 */
  async listMyCertificates(): Promise<AICertificateItem[]> {
    this.ensureTableRead('certificates');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null || userId == null) return [];
    const rows = await this.all<AICertificateItem>(
      `SELECT public_id, cert_type, issuer_name, issued_at, status
         FROM certificates
        WHERE user_id = ? AND team_id = ?
        ORDER BY issued_at DESC
        LIMIT ?`,
      [userId, teamId, this.limits.certificates],
    );
    return rows;
  }

  /** I. 已公开/已批准社区内容摘要（仅已发布 + 已审核通过；不含草稿/未审）。 */
  async listPublishedContent(): Promise<AIContentItem[]> {
    this.ensureTableRead('content_articles');
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) return [];
    const rows = await this.all<AIContentItem>(
      `SELECT public_id, content_type, title, summary
         FROM content_articles
        WHERE team_id = ?
          AND status = ? AND audit_status = ? AND deleted_at IS NULL
        ORDER BY published_at DESC
        LIMIT ?`,
      [teamId, ARTICLE_STATUS.PUBLISHED, ARTICLE_AUDIT.APPROVED, this.limits.content],
    );
    return rows;
  }
}
