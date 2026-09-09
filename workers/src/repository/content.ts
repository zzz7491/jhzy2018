/**
 * ContentRepository（P33-P3B-2B）—— 社区内容（文章/评论/附件/点赞/举报/审计）SQL 收口。
 *
 * scope 事实（S2-3 矩阵 / tenant-scope.ts）：
 * - content_articles / content_comments / content_attachments / content_likes /
 *   content_reports 均为 TEAM_SCOPED —— 所有查询【必须】带 team_id = ctx.tenant.teamId，
 *   跨团队一律按 not found 处理（不泄露存在性）。
 * - content_audit_logs 为 AUDIT_ONLY：仅写入审计行（不调用 ensureTableRead，避免普通
 *   团队角色被 audit_read 守卫拦截）；读取审计日志由下一阶段 gate。
 *
 * 纪律（与全仓一致）：
 * - 所有外部 resource resolution 以 public_id 输入；numeric id 只在 repository/service 内部使用。
 * - 不依赖 route middleware 代替 SQL/team 边界；team 隔离在 SQL 层二次收口。
 * - 状态枚举严格遵循 0024/0025 冻结定义（status 1/2/3/4，audit_status 0/1/2/3/4），
 *   不得自行重新定义数值含义。
 * - 计数器（like_count / comment_count / report_count）与真实 create/delete 操作一致；
 *   用 db.batch 保持原子（D1 单事务顺序执行）。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired } from '../utils/errors';
import { isUlid } from '../utils/validation';
import { generateUlid } from '../utils/crypto';
import type { Paginated } from '../types/api';

// ===== 冻结状态枚举（与 migration 0024/0025 一致）=====
export const ARTICLE_STATUS = {
  DRAFT: 1,
  PUBLISHED: 2,
  UNPUBLISHED: 3,
  DELETED: 4,
} as const;

export const ARTICLE_AUDIT = {
  NOT_SUBMITTED: 0,
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
  EXEMPT: 4,
} as const;

// 评论 / 文章通用可见状态
export const VISIBLE_STATUS = 1; // status
export const VISIBLE_AUDIT = 1; // audit_status

// 举报原因（与 content_reports.reason_type CHECK 一致）
export const REPORT_REASONS = [
  'illegal',
  'ad',
  'infringe',
  'fake',
  'abuse',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// 附件允许的 mime 类型（§7）
export const ATTACHMENT_MIME_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const ATTACHMENT_MAX = 9;

// ===== 行类型 =====
export interface ContentArticleRow {
  id: number;
  public_id: string;
  team_id: number;
  author_id: number;
  content_type: string;
  title: string;
  content: string | null;
  status: number;
  audit_status: number;
  published_at: number | null;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
  like_count: number;
  comment_count: number;
  report_count: number;
}

export interface ContentCommentRow {
  id: number;
  public_id: string;
  target_type: string;
  target_id: number;
  user_id: number;
  team_id: number;
  content: string;
  status: number;
  audit_status: number;
  created_at: number;
}

// ===== 对外 safe DTO（不暴露任何 numeric id / object_key / checksum）=====
export interface FeedAttachmentItem {
  file_public_id: string;
  mime_type: string;
  size_bytes: number;
}

export interface FeedArticleItem {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  author_public_id: string | null;
  author_nickname: string | null;
  attachments: FeedAttachmentItem[];
  comment_count: number;
  like_count: number;
  liked_by_me: boolean;
  published_at: number | null;
  created_at: number;
}

export interface AdminArticleItem {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  author_public_id: string | null;
  author_nickname: string | null;
  status: number;
  audit_status: number;
  comment_count: number;
  like_count: number;
  report_count: number;
  created_at: number;
  published_at: number | null;
}

/** 管理端文章详情 DTO（供编辑/审核台回填）：含 status/audit_status/作者信息/附件；不含任何 numeric id。 */
export interface AdminArticleDetail {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  status: number;
  audit_status: number;
  author_public_id: string | null;
  author_nickname: string | null;
  attachments: FeedAttachmentItem[];
  created_at: number;
  published_at: number | null;
}

export interface CommentView {
  comment_public_id: string;
  content: string;
  user_public_id: string | null;
  user_nickname: string | null;
  created_at: number;
}

// ===== 输入类型 =====
export interface CreatePostInput {
  title: string;
  content: string;
  authorId: number;
  teamId: number;
}

export interface UpdatePostPatch {
  title?: string;
  content?: string;
}

export interface CreateCommentInput {
  articleId: number;
  userId: number;
  teamId: number;
  content: string;
}

export interface CreateReportInput {
  targetType: 'article' | 'comment';
  targetId: number;
  teamId: number;
  reporterId: number;
  reasonType: ReportReason;
  description: string | null;
}

export class ContentRepository extends BaseRepository {
  // ===================================================================
  // 读：文章
  // ===================================================================

  /** team-scoped 文章行（不含敏感字段）；跨团队/不存在返回 null（不泄露存在性）。 */
  async findArticleRow(publicId: string): Promise<ContentArticleRow | null> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) return null;
    return this.first<ContentArticleRow>(
      `SELECT id, public_id, team_id, author_id, content_type, title, content,
              status, audit_status, published_at, created_at, updated_at, deleted_at,
              like_count, comment_count, report_count
         FROM content_articles
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
  }

  /** 与 findArticleRow 相同，但 null → 404（供写操作前置校验）。 */
  async requireArticleRow(publicId: string): Promise<ContentArticleRow> {
    const row = await this.findArticleRow(publicId);
    if (!row) throw notFound('Article');
    return row;
  }

  // ===================================================================
  // 写：志愿者创建文章（content_type='post'，DRAFT/PENDING）
  // ===================================================================

  async insertVolunteerPost(input: CreatePostInput): Promise<{ public_id: string; id: number }> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const now = Math.floor(Date.now() / 1000);
    const publicId = generateUlid();
    const res = await this.run(
      `INSERT INTO content_articles
        (public_id, team_id, author_id, content_type, title, content,
         anonymous, status, audit_status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, 'post', ?, ?, 0, ?, ?, NULL, ?, ?)`,
      [
        publicId,
        input.teamId,
        input.authorId,
        input.title,
        input.content,
        ARTICLE_STATUS.DRAFT,
        ARTICLE_AUDIT.PENDING,
        now,
        now,
      ],
    );
    const id = Number((res as { meta?: { last_row_id?: number | string } }).meta?.last_row_id ?? 0);
    return { public_id: publicId, id };
  }

  // ===================================================================
  // 写：志愿者更新自己的文章（仅 DRAFT 重置：status=1/audit=1/published=NULL）
  // ===================================================================

  async updateOwnArticle(
    publicId: string,
    authorId: number,
    patch: UpdatePostPatch,
  ): Promise<void> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Article');
    const now = Math.floor(Date.now() / 1000);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.content !== undefined) {
      sets.push('content = ?');
      params.push(patch.content);
    }
    // 任何 SELF update 后统一重置为草稿/待审（含原本已发布）。
    sets.push('status = ?');
    params.push(ARTICLE_STATUS.DRAFT);
    sets.push('audit_status = ?');
    params.push(ARTICLE_AUDIT.PENDING);
    sets.push('published_at = NULL');
    sets.push('updated_at = ?');
    params.push(now);
    // 仅本人同团队未删除文章；他人同 team / 跨 team → 0 行 → 404（不泄露存在性）。
    params.push(publicId, this.ctx.tenant.teamId, authorId);
    const res = await this.run(
      `UPDATE content_articles
          SET ${sets.join(', ')}
        WHERE public_id = ? AND team_id = ? AND author_id = ? AND deleted_at IS NULL`,
      params,
    );
    if ((res.meta?.changes ?? 0) === 0) throw notFound('Article');
  }

  // ===================================================================
  // 写：管理员创建文章（content_type='post'，DRAFT/PENDING）
  // ===================================================================
  // 与 insertVolunteerPost 形态一致，但 author_id = operator（管理端操作者），
  // 不强制"本人上传"。后续审核通过 approveArticle 后进入 feed 可见。

  async insertAdminArticle(input: CreatePostInput): Promise<{ public_id: string; id: number }> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const now = Math.floor(Date.now() / 1000);
    const publicId = generateUlid();
    const res = await this.run(
      `INSERT INTO content_articles
        (public_id, team_id, author_id, content_type, title, content,
         anonymous, status, audit_status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, 'post', ?, ?, 0, ?, ?, NULL, ?, ?)`,
      [
        publicId,
        input.teamId,
        input.authorId,
        input.title,
        input.content,
        ARTICLE_STATUS.DRAFT,
        ARTICLE_AUDIT.PENDING,
        now,
        now,
      ],
    );
    const id = Number((res as { meta?: { last_row_id?: number | string } }).meta?.last_row_id ?? 0);
    return { public_id: publicId, id };
  }

  // ===================================================================
  // 写：管理员编辑团队内任意文章（仅 DRAFT 重置：status=1/audit=1/published=NULL）
  // ===================================================================
  // 与 updateOwnArticle 不同：此处【不绑定 author_id】——管理员可编辑团队内任意未删除文章；
  // 他人同 team / 跨 team → 0 行 → 404（不泄露存在性）。任何编辑后统一重置为草稿/待审，
  // 等待再次审核发布（杜绝"绕过审核直接改已发布内容"）。

  async updateAdminArticle(publicId: string, patch: UpdatePostPatch): Promise<void> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Article');
    const now = Math.floor(Date.now() / 1000);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.content !== undefined) {
      sets.push('content = ?');
      params.push(patch.content);
    }
    // 任何管理端 update 后统一重置为草稿/待审（含原本已发布）。
    sets.push('status = ?');
    params.push(ARTICLE_STATUS.DRAFT);
    sets.push('audit_status = ?');
    params.push(ARTICLE_AUDIT.PENDING);
    sets.push('published_at = NULL');
    sets.push('updated_at = ?');
    params.push(now);
    // 团队内任意未删除文章；跨 team → 0 行 → 404（不泄露存在性）。
    params.push(publicId, this.ctx.tenant.teamId);
    const res = await this.run(
      `UPDATE content_articles
          SET ${sets.join(', ')}
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      params,
    );
    if ((res.meta?.changes ?? 0) === 0) throw notFound('Article');
  }

  // ===================================================================
  // 读：feed（仅已发布且已通过审核的 post）
  // ===================================================================

  async listFeed(page: number, pageSize: number, offset: number): Promise<Paginated<FeedArticleItem>> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId ?? 0;
    const rows = await this.all<{
      article_public_id: string;
      content_type: string;
      title: string;
      body: string | null;
      author_public_id: string | null;
      author_nickname: string | null;
      comment_count: number;
      like_count: number;
      liked_flag: number | null;
      published_at: number | null;
      created_at: number;
    }>(
      `SELECT a.public_id AS article_public_id, a.content_type, a.title, a.content AS body,
              u.public_id AS author_public_id, u.nickname AS author_nickname,
              a.comment_count, a.like_count,
              (SELECT 1 FROM content_likes l
                WHERE l.target_type = 'article' AND l.target_id = a.id AND l.user_id = ?) AS liked_flag,
              a.published_at, a.created_at
         FROM content_articles a
         LEFT JOIN users u ON u.id = a.author_id
        WHERE a.team_id = ? AND a.content_type = 'post'
          AND a.status = ? AND a.audit_status = ? AND a.deleted_at IS NULL
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
      [userId, teamId, ARTICLE_STATUS.PUBLISHED, ARTICLE_AUDIT.APPROVED, pageSize, offset],
    );
    const totalRow = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM content_articles
        WHERE team_id = ? AND content_type = 'post'
          AND status = ? AND audit_status = ? AND deleted_at IS NULL`,
      [teamId, ARTICLE_STATUS.PUBLISHED, ARTICLE_AUDIT.APPROVED],
    );
    const total = totalRow?.total ?? 0;
    const items: FeedArticleItem[] = [];
    for (const r of rows) {
      const attachments = await this.listArticleAttachmentsById(r.article_public_id);
      items.push({
        article_public_id: r.article_public_id,
        content_type: r.content_type,
        title: r.title,
        body: r.body,
        author_public_id: r.author_public_id,
        author_nickname: r.author_nickname,
        attachments,
        comment_count: r.comment_count,
        like_count: r.like_count,
        liked_by_me: r.liked_flag != null,
        published_at: r.published_at,
        created_at: r.created_at,
      });
    }
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

  // ===================================================================
  // 读：admin 文章列表（同 team 全部未删除，供审核台）
  // ===================================================================

  async listAdminArticles(
    page: number,
    pageSize: number,
    offset: number,
  ): Promise<Paginated<AdminArticleItem>> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const teamId = this.ctx.tenant.teamId;
    const rows = await this.all<{
      article_public_id: string;
      content_type: string;
      title: string;
      body: string | null;
      author_public_id: string | null;
      author_nickname: string | null;
      status: number;
      audit_status: number;
      comment_count: number;
      like_count: number;
      report_count: number;
      created_at: number;
      published_at: number | null;
    }>(
      `SELECT a.public_id AS article_public_id, a.content_type, a.title, a.content AS body,
              u.public_id AS author_public_id, u.nickname AS author_nickname,
              a.status, a.audit_status, a.comment_count, a.like_count, a.report_count,
              a.created_at, a.published_at
         FROM content_articles a
         LEFT JOIN users u ON u.id = a.author_id
        WHERE a.team_id = ? AND a.deleted_at IS NULL
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );
    const totalRow = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM content_articles WHERE team_id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    const total = totalRow?.total ?? 0;
    const items: AdminArticleItem[] = rows.map((r) => ({
      article_public_id: r.article_public_id,
      content_type: r.content_type,
      title: r.title,
      body: r.body,
      author_public_id: r.author_public_id,
      author_nickname: r.author_nickname,
      status: r.status,
      audit_status: r.audit_status,
      comment_count: r.comment_count,
      like_count: r.like_count,
      report_count: r.report_count,
      created_at: r.created_at,
      published_at: r.published_at,
    }));
    return {
      items,
      pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  // ===================================================================
  // 读：admin 文章详情（同 team 任意未删除状态，供编辑/审核台回填）
  // ===================================================================

  /**
   * 管理端文章详情：team-scoped（public_id + team_id + deleted_at IS NULL），
   * 无发布态过滤 —— 草稿 / 驳回 / 下架 / 已发布 均可见（编辑/审核需要）。
   * cross-team / 不存在 / 已删除 → null（不泄露存在性）。
   * 返回安全 DTO（含 status/audit_status/作者信息/附件），不含 numeric id。
   */
  async getAdminArticleDetail(publicId: string): Promise<AdminArticleDetail | null> {
    this.ensureTableRead('content_articles');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) return null;
    const row = await this.first<{
      article_public_id: string;
      content_type: string;
      title: string;
      body: string | null;
      status: number;
      audit_status: number;
      author_public_id: string | null;
      author_nickname: string | null;
      created_at: number;
      published_at: number | null;
    }>(
      `SELECT a.public_id AS article_public_id, a.content_type, a.title, a.content AS body,
              a.status, a.audit_status,
              u.public_id AS author_public_id, u.nickname AS author_nickname,
              a.created_at, a.published_at
         FROM content_articles a
         LEFT JOIN users u ON u.id = a.author_id
        WHERE a.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) return null;
    const attachments = await this.listArticleAttachmentsById(publicId);
    return {
      article_public_id: row.article_public_id,
      content_type: row.content_type,
      title: row.title,
      body: row.body,
      status: row.status,
      audit_status: row.audit_status,
      author_public_id: row.author_public_id,
      author_nickname: row.author_nickname,
      attachments,
      created_at: row.created_at,
      published_at: row.published_at,
    };
  }

  // ===================================================================
  // 写：管理端状态转换（approve / reject / unpublish / delete）+ 审计日志
  // ===================================================================

  async approveArticle(publicId: string, operatorId: number): Promise<void> {
    const art = await this.requireArticleRow(publicId);
    const now = Math.floor(Date.now() / 1000);
    await this.batch([
      {
        sql: `UPDATE content_articles
                 SET status = ?, audit_status = ?, published_at = ?, audit_by = ?, audit_at = ?, updated_at = ?
               WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
        params: [
          ARTICLE_STATUS.PUBLISHED,
          ARTICLE_AUDIT.APPROVED,
          now,
          operatorId,
          now,
          now,
          publicId,
          this.ctx.tenant.teamId,
        ],
      },
      this.auditLogStmt(art.id, 'approve', art.status, ARTICLE_STATUS.PUBLISHED, operatorId, now),
    ]);
  }

  async rejectArticle(publicId: string, operatorId: number): Promise<void> {
    const art = await this.requireArticleRow(publicId);
    const now = Math.floor(Date.now() / 1000);
    await this.batch([
      {
        sql: `UPDATE content_articles
                 SET status = ?, audit_status = ?, updated_at = ?
               WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
        params: [ARTICLE_STATUS.DRAFT, ARTICLE_AUDIT.REJECTED, now, publicId, this.ctx.tenant.teamId],
      },
      this.auditLogStmt(art.id, 'reject', art.status, ARTICLE_STATUS.DRAFT, operatorId, now),
    ]);
  }

  async unpublishArticle(publicId: string, operatorId: number): Promise<void> {
    const art = await this.requireArticleRow(publicId);
    const now = Math.floor(Date.now() / 1000);
    await this.batch([
      {
        sql: `UPDATE content_articles
                 SET status = ?, audit_status = ?, published_at = NULL, updated_at = ?
               WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
        params: [ARTICLE_STATUS.UNPUBLISHED, ARTICLE_AUDIT.APPROVED, now, publicId, this.ctx.tenant.teamId],
      },
      this.auditLogStmt(art.id, 'unpublish', art.status, ARTICLE_STATUS.UNPUBLISHED, operatorId, now),
    ]);
  }

  async deleteArticle(publicId: string, operatorId: number): Promise<void> {
    const art = await this.requireArticleRow(publicId);
    const now = Math.floor(Date.now() / 1000);
    await this.batch([
      {
        sql: `UPDATE content_articles
                 SET status = ?, deleted_at = ?, updated_at = ?
               WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
        params: [ARTICLE_STATUS.DELETED, now, now, publicId, this.ctx.tenant.teamId],
      },
      this.auditLogStmt(art.id, 'delete', art.status, ARTICLE_STATUS.DELETED, operatorId, now),
    ]);
  }

  /** 审计日志语句（content_audit_logs 为 AUDIT_ONLY，直接 run/batch，不触发 read 守卫）。 */
  private auditLogStmt(
    targetId: number,
    action: 'approve' | 'reject' | 'unpublish' | 'delete',
    fromStatus: number,
    toStatus: number,
    operatorId: number,
    now: number,
  ): { sql: string; params: unknown[] } {
    return {
      sql: `INSERT INTO content_audit_logs
              (target_type, target_id, action, from_status, to_status, operator_id, team_id, created_at)
            VALUES ('article', ?, ?, ?, ?, ?, ?, ?)`,
      params: [targetId, action, String(fromStatus), String(toStatus), operatorId, this.ctx.tenant.teamId, now],
    };
  }

  // ===================================================================
  // 附件：替换（update 语义）
  // ===================================================================

  async replaceArticleAttachments(articleId: number, fileIds: number[]): Promise<void> {
    this.ensureTableRead('content_attachments');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const now = Math.floor(Date.now() / 1000);
    const stmts: { sql: string; params: unknown[] }[] = [
      {
        sql: `DELETE FROM content_attachments WHERE target_type = 'article' AND target_id = ?`,
        params: [articleId],
      },
    ];
    fileIds.forEach((fid, i) => {
      stmts.push({
        sql: `INSERT INTO content_attachments (team_id, target_type, target_id, file_id, sort, created_at)
              VALUES (?, 'article', ?, ?, ?, ?)`,
        params: [this.ctx.tenant.teamId, articleId, fid, i, now],
      });
    });
    await this.batch(stmts);
  }

  async listArticleAttachmentsById(articlePublicId: string): Promise<FeedAttachmentItem[]> {
    this.ensureTableRead('content_attachments');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const idRow = await this.first<{ id: number }>(
      `SELECT id FROM content_articles WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [articlePublicId, this.ctx.tenant.teamId],
    );
    if (!idRow) return [];
    return this.listArticleAttachmentsByIdRaw(idRow.id);
  }

  async listArticleAttachmentsByIdRaw(articleId: number): Promise<FeedAttachmentItem[]> {
    return this.all<FeedAttachmentItem>(
      `SELECT f.public_id AS file_public_id, f.mime_type, f.size_bytes
         FROM content_attachments ca
         JOIN files f ON f.id = ca.file_id
        WHERE ca.target_type = 'article' AND ca.target_id = ?
        ORDER BY ca.sort ASC`,
      [articleId],
    );
  }

  // ===================================================================
  // 评论
  // ===================================================================

  async createComment(input: CreateCommentInput): Promise<{ public_id: string; id: number }> {
    this.ensureTableRead('content_comments');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const now = Math.floor(Date.now() / 1000);
    const publicId = generateUlid();
    await this.batch([
      {
        sql: `INSERT INTO content_comments
                (target_type, target_id, user_id, team_id, public_id, content, status, audit_status, created_at)
              VALUES ('article', ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.articleId,
          input.userId,
          input.teamId,
          publicId,
          input.content,
          VISIBLE_STATUS,
          VISIBLE_AUDIT,
          now,
        ],
      },
      {
        // comment_count 计数器与真实写入一致（只在 content_articles 上存在）。
        sql: `UPDATE content_articles SET comment_count = comment_count + 1 WHERE id = ? AND deleted_at IS NULL`,
        params: [input.articleId],
      },
    ]);
    const idRow = await this.first<{ id: number }>(
      `SELECT id FROM content_comments WHERE public_id = ? AND team_id = ?`,
      [publicId, this.ctx.tenant.teamId],
    );
    return { public_id: publicId, id: idRow?.id ?? 0 };
  }

  async findCommentRow(publicId: string): Promise<ContentCommentRow | null> {
    this.ensureTableRead('content_comments');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) return null;
    return this.first<ContentCommentRow>(
      `SELECT id, public_id, target_type, target_id, user_id, team_id, content, status, audit_status, created_at
         FROM content_comments
        WHERE public_id = ? AND team_id = ?`,
      [publicId, this.ctx.tenant.teamId],
    );
  }

  async listVisibleComments(articleId: number): Promise<CommentView[]> {
    this.ensureTableRead('content_comments');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const rows = await this.all<{
      comment_public_id: string;
      content: string;
      user_public_id: string | null;
      user_nickname: string | null;
      created_at: number;
    }>(
      `SELECT c.public_id AS comment_public_id, c.content,
              u.public_id AS user_public_id, u.nickname AS user_nickname, c.created_at
         FROM content_comments c
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.target_type = 'article' AND c.target_id = ? AND c.team_id = ?
          AND c.status = ? AND c.audit_status = ?
        ORDER BY c.created_at ASC`,
      [articleId, this.ctx.tenant.teamId, VISIBLE_STATUS, VISIBLE_AUDIT],
    );
    return rows.map((r) => ({
      comment_public_id: r.comment_public_id,
      content: r.content,
      user_public_id: r.user_public_id,
      user_nickname: r.user_nickname,
      created_at: r.created_at,
    }));
  }

  // ===================================================================
  // 点赞（仅 target_type='article'）
  // ===================================================================

  async addLike(articleId: number, userId: number, teamId: number): Promise<{ liked: boolean; like_count: number }> {
    this.ensureTableRead('content_likes');
    const res = await this.run(
      `INSERT OR IGNORE INTO content_likes (team_id, target_type, target_id, user_id, created_at)
       VALUES (?, 'article', ?, ?, ?)`,
      [teamId, articleId, userId, Math.floor(Date.now() / 1000)],
    );
    // INSERT OR IGNORE：已点赞时 changes=0（幂等，不重复计行 / 不双倍计数）。
    // POST-like 的语义终态为"已点赞"，故 liked 恒为 true；仅在真实新增时 +1 计数器。
    const inserted = (res.meta?.changes ?? 0) > 0;
    if (inserted) {
      await this.run(`UPDATE content_articles SET like_count = like_count + 1 WHERE id = ?`, [articleId]);
    }
    const count = await this.countLikes(articleId);
    return { liked: true, like_count: count };
  }

  async removeLike(
    articleId: number,
    userId: number,
    teamId: number,
  ): Promise<{ liked: boolean; like_count: number }> {
    this.ensureTableRead('content_likes');
    const res = await this.run(
      `DELETE FROM content_likes WHERE target_type = 'article' AND target_id = ? AND user_id = ?`,
      [articleId, userId],
    );
    const removed = (res.meta?.changes ?? 0) > 0;
    if (removed) {
      await this.run(
        `UPDATE content_articles SET like_count = MAX(0, like_count - 1) WHERE id = ?`,
        [articleId],
      );
    }
    const count = await this.countLikes(articleId);
    return { liked: false, like_count: count };
  }

  async countLikes(articleId: number): Promise<number> {
    this.ensureTableRead('content_likes');
    const row = await this.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM content_likes WHERE target_type = 'article' AND target_id = ?`,
      [articleId],
    );
    return row?.c ?? 0;
  }

  async hasLiked(articleId: number, userId: number): Promise<boolean> {
    this.ensureTableRead('content_likes');
    const row = await this.first<{ one: number }>(
      `SELECT 1 AS one FROM content_likes WHERE target_type = 'article' AND target_id = ? AND user_id = ?`,
      [articleId, userId],
    );
    return row != null;
  }

  // ===================================================================
  // 举报
  // ===================================================================

  async createReport(input: CreateReportInput): Promise<void> {
    this.ensureTableRead('content_reports');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    const now = Math.floor(Date.now() / 1000);
    const stmts: { sql: string; params: unknown[] }[] = [
      {
        sql: `INSERT INTO content_reports
                (target_type, target_id, team_id, reporter_id, reason_type, description, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        params: [
          input.targetType,
          input.targetId,
          input.teamId,
          input.reporterId,
          input.reasonType,
          input.description,
          now,
        ],
      },
    ];
    // report_count 计数器仅在 content_articles 上存在（content_comments 无该列）。
    if (input.targetType === 'article') {
      stmts.push({
        sql: `UPDATE content_articles SET report_count = report_count + 1 WHERE id = ? AND deleted_at IS NULL`,
        params: [input.targetId],
      });
    }
    await this.batch(stmts);
  }
}
