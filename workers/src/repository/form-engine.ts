/**
 * FormEngineRepository（S2-NEW-ARCH-P20）—— 通用动态表单引擎唯一写入口。
 *
 * scope 事实（repository/tenant-scope.ts）：
 * - form_definitions / form_bindings：TEAM_SCOPED，持有真实 team_id，过滤用 team_id=?。
 * - form_definition_versions / form_submissions：TEAM_SCOPED 且入 DERIVED_TEAM_TABLES，
 *   无 team_id 列，team 一律经 form_definitions JOIN 派生过滤（禁止简单 WHERE team_id=?）。
 *
 * SQL 纪律（用户 §十）：全部 prepare().bind()；参数化构建器 P(v) 保证多参顺序零错位。
 *
 * 并发安全（用户 §十二 / P20 REV2）：
 * - 唯一真相 = public_id UNIQUE / UNIQUE(definition_id, version_no) /
 *   partial UNIQUE（uq_def_draft / uq_def_published / uq_binding_* / uq_sub_draft）。
 * - 重复提交（allow_repeat=false）的守卫 = 原子 INSERT...SELECT...WHERE NOT EXISTS(active submitted)，
 *   不改建 grain UNIQUE（SQLite partial index 无法引用 definitions.allow_repeat）。
 * - 插入是否发生一律以 meta.changes 判定（绝不使用 last_row_id —— INSERT...SELECT 无命中时
 *   last_row_id 会残留上一条已插入 id，造成伪成功）。
 */

import { BaseRepository } from './base';
import { teamScopeRequired, authRequired, notFoundReason, conflict } from '../utils/errors';

// ===== 行类型 =====

export interface FormDefinitionRow {
  id: number;
  public_id: string;
  team_id: number;
  name: string;
  description: string | null;
  status: number; // 1 draft / 2 published / 3 archived
  published_version_id: number | null;
  allow_repeat: number;
  created_by: number;
  created_at: number;
  updated_at: number | null;
}

export interface FormBindingRow {
  id: number;
  public_id: string;
  team_id: number;
  definition_id: number;
  consumer_type: string;
  consumer_public_id: string | null;
  is_default: number;
  status: number; // 1 active / 2 archived
  consume_policy: number; // 0 none / 1 optional / 2 required（P21，0016）
  created_at: number;
  updated_at: number | null;
}

export const FORM_CONSUME_POLICY = {
  NONE: 0,
  OPTIONAL: 1,
  REQUIRED: 2,
} as const;

export interface FormVersionRow {
  id: number;
  public_id: string;
  definition_id: number;
  version_no: number;
  status: number; // 1 draft / 2 published / 3 archived
  schema_json: string;
  created_by: number;
  created_at: number;
  published_at: number | null;
}

export interface FormSubmissionRow {
  id: number;
  public_id: string;
  definition_id: number;
  version_id: number;
  submitter_user_id: number;
  consumer_type: string;
  consumer_public_id: string | null;
  consumer_key: string;
  answers_json: string;
  status: number; // 1 draft / 2 submitted / 3 withdrawn / 4 invalidated
  created_at: number;
  updated_at: number | null;
  submitted_at: number | null;
}

export const FORM_DEF_STATUS = { DRAFT: 1, PUBLISHED: 2, ARCHIVED: 3 } as const;
export const FORM_VERSION_STATUS = { DRAFT: 1, PUBLISHED: 2, ARCHIVED: 3 } as const;
export const FORM_SUBMISSION_STATUS = { DRAFT: 1, SUBMITTED: 2, WITHDRAWN: 3, INVALIDATED: 4 } as const;

export class FormEngineRepository extends BaseRepository {
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    return teamId;
  }

  private requireUserId(): number {
    const userId = this.ctx.auth.userId;
    if (userId == null) throw authRequired();
    return userId;
  }

  // ================= 只读解析 =================

  /** definition（任意状态；TEAM_SCOPED）。 */
  async resolveDefinitionByPublicId(publicId: string, teamId: number): Promise<FormDefinitionRow | null> {
    this.ensureTableRead('form_definitions');
    return this.first<FormDefinitionRow>(
      `SELECT * FROM form_definitions WHERE public_id = ? AND team_id = ?`,
      [publicId, teamId],
    );
  }

  /** 版本（DERIVED_TEAM → definitions）。 */
  async resolveVersionByPublicId(publicId: string, teamId: number): Promise<FormVersionRow | null> {
    this.ensureTableRead('form_definition_versions');
    return this.first<FormVersionRow>(
      `SELECT v.id, v.public_id, v.definition_id, v.version_no, v.status, v.schema_json,
              v.created_by, v.created_at, v.published_at
         FROM form_definition_versions v
         JOIN form_definitions d ON d.id = v.definition_id
        WHERE v.public_id = ? AND d.team_id = ?`,
      [publicId, teamId],
    );
  }

  /** 当前已发布版本（必须 = definition.published_version_id 且 status=2）。 */
  async resolvePublishedVersion(definitionId: number, teamId: number): Promise<FormVersionRow | null> {
    this.ensureTableRead('form_definition_versions');
    return this.first<FormVersionRow>(
      `SELECT v.id, v.public_id, v.definition_id, v.version_no, v.status, v.schema_json,
              v.created_by, v.created_at, v.published_at
         FROM form_definition_versions v
         JOIN form_definitions d ON d.id = v.definition_id
        WHERE v.definition_id = ? AND v.status = 2 AND v.published_at IS NOT NULL
          AND d.team_id = ? AND d.status = 2 AND d.published_version_id = v.id`,
      [definitionId, teamId],
    );
  }

  /** 当前 draft 版本（status=1；至多一个）。 */
  async findDraftVersion(definitionId: number, teamId: number): Promise<FormVersionRow | null> {
    this.ensureTableRead('form_definition_versions');
    return this.first<FormVersionRow>(
      `SELECT v.id, v.public_id, v.definition_id, v.version_no, v.status, v.schema_json,
              v.created_by, v.created_at, v.published_at
         FROM form_definition_versions v
         JOIN form_definitions d ON d.id = v.definition_id
        WHERE v.definition_id = ? AND v.status = 1 AND d.team_id = ?`,
      [definitionId, teamId],
    );
  }

  /** consumer 绑定解析：entity 优先 → team default → null。 */
  async resolveBindingForConsumer(
    teamId: number,
    consumerType: string,
    consumerPublicId: string | null,
  ): Promise<FormBindingRow | null> {
    this.ensureTableRead('form_bindings');
    if (consumerPublicId != null) {
      const entity = await this.first<FormBindingRow>(
        `SELECT * FROM form_bindings
          WHERE team_id = ? AND consumer_type = ? AND consumer_public_id = ? AND status = 1
          ORDER BY is_default ASC LIMIT 1`,
        [teamId, consumerType, consumerPublicId],
      );
      if (entity) return entity;
    }
    return this.first<FormBindingRow>(
      `SELECT * FROM form_bindings
        WHERE team_id = ? AND consumer_type = ? AND consumer_public_id IS NULL AND is_default = 1 AND status = 1
        LIMIT 1`,
      [teamId, consumerType],
    );
  }

  /** definition 按内部 id（team-scoped）。 */
  async resolveDefinitionById(definitionId: number, teamId: number): Promise<FormDefinitionRow | null> {
    this.ensureTableRead('form_definitions');
    return this.first<FormDefinitionRow>(
      `SELECT * FROM form_definitions WHERE id = ? AND team_id = ?`,
      [definitionId, teamId],
    );
  }

  /** 版本按内部 id（DERIVED_TEAM → definitions）。 */
  async resolveVersionByInternalId(versionId: number, teamId: number): Promise<FormVersionRow | null> {
    this.ensureTableRead('form_definition_versions');
    return this.first<FormVersionRow>(
      `SELECT v.* FROM form_definition_versions v
         JOIN form_definitions d ON d.id = v.definition_id
        WHERE v.id = ? AND d.team_id = ?`,
      [versionId, teamId],
    );
  }

  /** 提交行（DERIVED_TEAM → definitions）。 */
  async findSubmissionByPublicIdTeamScope(
    publicId: string,
    teamId: number,
  ): Promise<FormSubmissionRow | null> {
    this.ensureTableRead('form_submissions');
    return this.first<FormSubmissionRow>(
      `SELECT f.id, f.public_id, f.definition_id, f.version_id, f.submitter_user_id,
              f.consumer_type, f.consumer_public_id, f.consumer_key, f.answers_json,
              f.status, f.created_at, f.updated_at, f.submitted_at
         FROM form_submissions f
         JOIN form_definitions d ON d.id = f.definition_id
        WHERE f.public_id = ? AND d.team_id = ?`,
      [publicId, teamId],
    );
  }

  /** 本人提交（SELF ownership 由 service 判定）。 */
  async findOwnSubmissionByPublicId(publicId: string, submitterUserId: number, teamId: number): Promise<FormSubmissionRow | null> {
    this.ensureTableRead('form_submissions');
    return this.first<FormSubmissionRow>(
      `SELECT f.* FROM form_submissions f
         JOIN form_definitions d ON d.id = f.definition_id
        WHERE f.public_id = ? AND f.submitter_user_id = ? AND d.team_id = ?`,
      [publicId, submitterUserId, teamId],
    );
  }

  /** 同 grain 活跃 submitted 行（reclassify 用）。 */
  async findActiveSubmitted(
    definitionId: number,
    submitterUserId: number,
    consumerKey: string,
  ): Promise<FormSubmissionRow | null> {
    this.ensureTableRead('form_submissions');
    return this.first<FormSubmissionRow>(
      `SELECT * FROM form_submissions
        WHERE status = 2 AND definition_id = ? AND submitter_user_id = ? AND consumer_key = ?`,
      [definitionId, submitterUserId, consumerKey],
    );
  }

  /** 本人全部提交（倒序）。 */
  async listOwnSubmissions(submitterUserId: number, teamId: number): Promise<FormSubmissionRow[]> {
    this.ensureTableRead('form_submissions');
    return this.all<FormSubmissionRow>(
      `SELECT f.* FROM form_submissions f
         JOIN form_definitions d ON d.id = f.definition_id
        WHERE f.submitter_user_id = ? AND d.team_id = ?
        ORDER BY f.created_at DESC`,
      [submitterUserId, teamId],
    );
  }

  /** 团队提交列表（manage；可限定 consumer，非 draft 状态）。 */
  async listTeamSubmissions(
    teamId: number,
    consumerType: string,
    consumerPublicId: string | null,
  ): Promise<FormSubmissionRow[]> {
    this.ensureTableRead('form_submissions');
    return this.all<FormSubmissionRow>(
      `SELECT f.* FROM form_submissions f
         JOIN form_definitions d ON d.id = f.definition_id
        WHERE d.team_id = ? AND f.consumer_type = ?
          AND (? IS NULL OR f.consumer_public_id = ?)
          AND f.status IN (2,3,4)
        ORDER BY f.created_at DESC
        LIMIT 200`,
      [teamId, consumerType, consumerPublicId, consumerPublicId],
    );
  }

  /** consumer 资源解析（P20 仅 activity.signup）：consumer_public_id 必须属于同 team。 */
  async consumerActivityOwned(consumerType: string, consumerPublicId: string, teamId: number): Promise<boolean> {
    if (consumerType !== 'activity.signup') return false;
    this.ensureTableRead('activities');
    const row = await this.first<{ x: number }>(
      `SELECT 1 AS x FROM activities WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [consumerPublicId, teamId],
    );
    return row != null;
  }

  // ================= 原子写 =================

  /** 建 definition + V1 draft（db.batch 原子）。 */
  async createDefinitionWithV1DraftAtomically(input: {
    publicId: string;
    versionPublicId: string;
    teamId: number;
    actorUserId: number;
    name: string;
    description: string | null;
    fieldsSchema: string;
    allowRepeat: number;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('form_definitions');
    this.ensureTableRead('form_definition_versions');
    const { publicId, versionPublicId, teamId, actorUserId, name, description, fieldsSchema, allowRepeat, now } = input;

    const stmt0 = this.db
      .prepare(
        `INSERT INTO form_definitions
           (public_id, team_id, name, description, status, allow_repeat, created_by, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?,?,?)`,
      )
      .bind(publicId, teamId, name, description, allowRepeat, actorUserId, now, now);
    const stmt1 = this.db
      .prepare(
        `INSERT INTO form_definition_versions
           (public_id, definition_id, version_no, status, schema_json, created_by, created_at)
         VALUES (?, (SELECT id FROM form_definitions WHERE public_id = ?), 1, 1, ?, ?, ?)`,
      )
      .bind(versionPublicId, publicId, fieldsSchema, actorUserId, now);

    const results = await this.db.batch([stmt0, stmt1]);
    const defCreated = Number(results[0]?.meta?.changes ?? 0);
    const verCreated = Number(results[1]?.meta?.changes ?? 0);
    if (defCreated === 1 && verCreated === 1) {
      const row = await this.first<{ id: number }>(
        `SELECT id FROM form_definitions WHERE public_id = ?`, [publicId],
      );
      return row?.id ?? 0;
    }
    return 0;
  }

  /** definition metadata 更新（name/description/allow_repeat）。archived 禁改。 */
  async updateDefinitionMetadata(
    definitionId: number,
    teamId: number,
    metadata: { name?: string; description?: string | null; allowRepeat?: number },
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('form_definitions');
    const { name, description, allowRepeat } = metadata;
    const parts: string[] = [];
    const params: unknown[] = [];
    if (name !== undefined) { parts.push('name = ?'); params.push(name); }
    if (description !== undefined) { parts.push('description = ?'); params.push(description); }
    if (allowRepeat !== undefined) { parts.push('allow_repeat = ?'); params.push(allowRepeat); }
    if (parts.length === 0) return true;
    parts.push('updated_at = ?');
    params.push(now, definitionId, teamId);
    const res = await this.run(
      `UPDATE form_definitions SET ${parts.join(', ')}
        WHERE id = ? AND team_id = ? AND status != 3`,
      params,
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** 创建下一 draft（published/initial → version_no=MAX+1；原子 INSERT…SELECT）。 */
  async createNextDraftAtomically(input: {
    publicId: string;
    definitionId: number;
    teamId: number;
    actorUserId: number;
    schemaJson: string;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('form_definition_versions');
    const { publicId, definitionId, teamId, actorUserId, schemaJson, now } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const id = await this.run(
      `INSERT INTO form_definition_versions
         (public_id, definition_id, version_no, status, schema_json, created_by, created_at)
       SELECT ${P(publicId)}, ${P(definitionId)},
              (SELECT COALESCE(MAX(v2.version_no), 0) + 1
                 FROM form_definition_versions v2
                 JOIN form_definitions d2 ON d2.id = v2.definition_id
                WHERE v2.definition_id = ${P(definitionId)} AND d2.team_id = ${P(teamId)}),
              1, ${P(schemaJson)}, ${P(actorUserId)}, ${P(now)}
       WHERE
         (SELECT 1 FROM form_definitions d WHERE d.id = ${P(definitionId)} AND d.team_id = ${P(teamId)}
            AND d.status != 3) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM form_definition_versions v3
             JOIN form_definitions d3 ON d3.id = v3.definition_id
            WHERE v3.definition_id = ${P(definitionId)} AND v3.status = 1 AND d3.team_id = ${P(teamId)})
         AND NOT EXISTS (SELECT 1 FROM form_definition_versions v4 WHERE v4.public_id = ${P(publicId)})`,
      params,
    );
    return Number(id.meta?.changes ?? 0);
  }

  /** 覆盖当前 draft 的 schema_json（已发布行永不可改）。 */
  async updateDraftSchema(
    definitionId: number,
    teamId: number,
    schemaJson: string,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('form_definition_versions');
    const res = await this.run(
      `UPDATE form_definition_versions AS v
          SET schema_json = ?
        WHERE v.definition_id = ? AND v.status = 1
          AND EXISTS (SELECT 1 FROM form_definitions d
                       WHERE d.id = v.definition_id AND d.team_id = ? AND d.status != 3)`,
      [schemaJson, definitionId, teamId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** 原子发布（db.batch）：old published→archived；draft→published(published_at)；definition→published + published_version_id。 */
  async publishAtomically(
    definitionId: number,
    draftVersionId: number,
    teamId: number,
    now: number,
  ): Promise<{ definitionOk: boolean }> {
    this.ensureTableRead('form_definitions');
    this.ensureTableRead('form_definition_versions');
const stmt0 = this.db
      .prepare(
        `UPDATE form_definition_versions AS v SET status = 3, published_at = published_at
          WHERE v.definition_id = ? AND v.status = 2
            AND EXISTS (SELECT 1 FROM form_definitions d WHERE d.id = v.definition_id AND d.team_id = ?)`,
      )
      .bind(definitionId, teamId);
    const stmt1 = this.db
      .prepare(
        `UPDATE form_definition_versions AS v SET status = 2, published_at = ?
          WHERE v.id = ? AND v.status = 1
            AND EXISTS (SELECT 1 FROM form_definitions d WHERE d.id = v.definition_id AND d.team_id = ?)`,
      )
      .bind(now, draftVersionId, teamId);
    const stmt2 = this.db
      .prepare(
        `UPDATE form_definitions SET status = 2, published_version_id = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND status != 3`,
      )
      .bind(draftVersionId, now, definitionId, teamId);

    const results = await this.db.batch([stmt0, stmt1, stmt2]);
    const verPublished = Number(results[1]?.meta?.changes ?? 0);
    const defUpdated = Number(results[2]?.meta?.changes ?? 0);
    return { definitionOk: verPublished === 1 && defUpdated === 1 };
  }

  /** 原子归档：published+draft version→archived；active bindings→archived；definition→archived + published_version_id=NULL。 */
  async archiveAtomically(
    definitionId: number,
    teamId: number,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('form_definitions');
    this.ensureTableRead('form_definition_versions');
    this.ensureTableRead('form_bindings');
    const stmt0 = this.db
      .prepare(
        `UPDATE form_definition_versions SET status = 3
          WHERE definition_id = ?
            AND EXISTS (SELECT 1 FROM form_definitions d WHERE d.id = definition_id AND d.team_id = ?)
            AND status IN (1,2)`,
      )
      .bind(definitionId, teamId);
    const stmt1 = this.db
      .prepare(
        `UPDATE form_bindings SET status = 2, updated_at = ?
          WHERE definition_id = ? AND status = 1`,
      )
      .bind(now, definitionId);
    const stmt2 = this.db
      .prepare(
        `UPDATE form_definitions SET status = 3, published_version_id = NULL, updated_at = ?
          WHERE id = ? AND team_id = ? AND status != 3`,
      )
      .bind(now, definitionId, teamId);

    const results = await this.db.batch([stmt0, stmt1, stmt2]);
    return (Number(results[2]?.meta?.changes ?? 0)) === 1;
  }

  /** 绑定创建（原子；仅可绑已发布 definition；entity/default 唯一兜底）。 */
  async createBindingAtomically(input: {
    publicId: string;
    teamId: number;
    definitionId: number;
    consumerType: string;
    consumerPublicId: string | null;
    isDefault: number;
    consumePolicy: number;
    now: number;
  }): Promise<number> {
    this.ensureTableRead('form_bindings');
    const { publicId, teamId, definitionId, consumerType, consumerPublicId, isDefault, consumePolicy, now } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const res = await this.run(
      `INSERT INTO form_bindings
         (public_id, team_id, definition_id, consumer_type, consumer_public_id, is_default, consume_policy, status, created_at, updated_at)
       SELECT ${P(publicId)}, ${P(teamId)}, ${P(definitionId)}, ${P(consumerType)}, ${P(consumerPublicId)}, ${P(isDefault)}, ${P(consumePolicy)}, 1, ${P(now)}, NULL
       WHERE
         (SELECT 1 FROM form_definitions d
           WHERE d.id = ${P(definitionId)} AND d.team_id = ${P(teamId)} AND d.status = 2) IS NOT NULL
         AND NOT (${P(isDefault)} = 1 AND ${P(consumerPublicId)} IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM form_bindings b
            WHERE b.status = 1 AND b.consumer_type = ${P(consumerType)}
              AND b.team_id = ${P(teamId)}
              AND ( (${P(isDefault)} = 1 AND b.is_default = 1)
                    OR (${P(isDefault)} = 0 AND b.consumer_public_id = ${P(consumerPublicId)}) ))`,
      params,
    );
    return Number(res.meta?.changes ?? 0);
  }

  /** 提交创建（draft 或 final；原子 INSERT…SELECT 谓词含权威链 + allow_repeat + 单 draft + public_id 唯一）。 */
  async createSubmissionAtomically(input: {
    publicId: string;
    definitionId: number;
    versionId: number;
    submitterUserId: number;
    teamId: number;
    consumerType: string;
    consumerPublicId: string | null;
    consumerKey: string;
    answersJson: string;
    status: number; // 1 draft / 2 submitted
    now: number;
    submittedAt: number | null;
  }): Promise<number> {
    this.ensureTableRead('form_submissions');
    const {
      publicId, definitionId, versionId, submitterUserId, teamId,
      consumerType, consumerPublicId, consumerKey, answersJson, status, now, submittedAt,
    } = input;
    const params: unknown[] = [];
    const P = (v: unknown) => { params.push(v == null ? null : v); return '?'; };

    const res = await this.run(
      `INSERT INTO form_submissions
         (public_id, definition_id, version_id, submitter_user_id, consumer_type, consumer_public_id,
          consumer_key, answers_json, status, created_at, updated_at, submitted_at)
       SELECT ${P(publicId)}, ${P(definitionId)}, ${P(versionId)}, ${P(submitterUserId)}, ${P(consumerType)}, ${P(consumerPublicId)},
              ${P(consumerKey)}, ${P(answersJson)}, ${P(status)}, ${P(now)}, NULL, ${P(submittedAt)}
       WHERE
         -- 定义/版本同链同 team、definition=published、version=当前 published（权威解析的 SQL 复核）
         (SELECT 1 FROM form_definitions d
           WHERE d.id = ${P(definitionId)} AND d.team_id = ${P(teamId)} AND d.status = 2
             AND d.published_version_id = ${P(versionId)}) IS NOT NULL
         AND (SELECT 1 FROM form_definition_versions v
               WHERE v.id = ${P(versionId)} AND v.definition_id = ${P(definitionId)}
                 AND v.status = 2 AND v.published_at IS NOT NULL) IS NOT NULL
         -- binding 仍 active 且指向该 definition（entity 或 default 二选一，跨查防御）
         AND (
           EXISTS (SELECT 1 FROM form_bindings b
                    WHERE b.status = 1 AND b.consumer_type = ${P(consumerType)}
                      AND b.consumer_public_id = ${P(consumerPublicId)}
                      AND b.definition_id = ${P(definitionId)} AND b.team_id = ${P(teamId)})
           OR EXISTS (SELECT 1 FROM form_bindings b
                       WHERE b.status = 1 AND b.consumer_type = ${P(consumerType)}
                         AND b.consumer_public_id IS NULL AND b.is_default = 1
                         AND b.definition_id = ${P(definitionId)} AND b.team_id = ${P(teamId)})
         )
         -- allow_repeat 当前策略（definition 级；false 时同 grain 不允许第二条 submitted）
         AND ( (SELECT allow_repeat FROM form_definitions WHERE id = ${P(definitionId)}) = 1
               OR NOT EXISTS (
                 SELECT 1 FROM form_submissions s2
                  WHERE s2.status = 2 AND s2.definition_id = ${P(definitionId)}
                    AND s2.submitter_user_id = ${P(submitterUserId)} AND s2.consumer_key = ${P(consumerKey)}) )
         -- final 提交须非 draft；draft 至多一个
         AND ( ${P(status)} = 2
               OR NOT EXISTS (
                 SELECT 1 FROM form_submissions s3
                  WHERE s3.status = 1 AND s3.definition_id = ${P(definitionId)}
                    AND s3.submitter_user_id = ${P(submitterUserId)} AND s3.consumer_key = ${P(consumerKey)}) )
         -- 客户端 new_public_id 唯一
         AND NOT EXISTS (SELECT 1 FROM form_submissions s4 WHERE s4.public_id = ${P(publicId)})`,
      params,
    );
    return Number(res.meta?.changes ?? 0);
  }

  /** draft answers 更新（owner + status=1 + version 仍为当前 published；谓词拒绝旧 version 与越权）。 */
  async updateDraftAnswersAtomically(
    publicId: string,
    submitterUserId: number,
    teamId: number,
    expectedVersionId: number,
    answersJson: string,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('form_submissions');
    const res = await this.run(
      `UPDATE form_submissions AS f
          SET answers_json = ?, updated_at = ?
        WHERE f.public_id = ? AND f.submitter_user_id = ? AND f.status = 1 AND f.version_id = ?
          AND EXISTS (SELECT 1 FROM form_definitions d
                       WHERE d.id = f.definition_id AND d.team_id = ?)`,
      [answersJson, now, publicId, submitterUserId, expectedVersionId, teamId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** SELF 撤回（submitted→withdrawn）。 */
  async withdrawAtomically(publicId: string, submitterUserId: number, teamId: number, now: number): Promise<number> {
    this.ensureTableRead('form_submissions');
    const res = await this.run(
      `UPDATE form_submissions AS f
          SET status = 3, updated_at = ?
        WHERE f.public_id = ? AND f.submitter_user_id = ?
          AND f.status IN (1,2)
          AND EXISTS (SELECT 1 FROM form_definitions d WHERE d.id = f.definition_id AND d.team_id = ?)`,
      [now, publicId, submitterUserId, teamId],
    );
    return Number(res.meta?.changes ?? 0);
  }

  /** TEAM 无效化（submitted→invalidated）。 */
  async invalidateAtomically(publicId: string, teamId: number, now: number): Promise<number> {
    this.ensureTableRead('form_submissions');
    const res = await this.run(
      `UPDATE form_submissions AS f
          SET status = 4, updated_at = ?
        WHERE f.public_id = ? AND f.status = 2
          AND EXISTS (SELECT 1 FROM form_definitions d WHERE d.id = f.definition_id AND d.team_id = ?)`,
      [now, publicId, teamId],
    );
    return Number(res.meta?.changes ?? 0);
  }
}