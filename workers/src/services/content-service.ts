/**
 * ContentService（P33-P3B-2B）—— 社区志愿者端业务逻辑层（文章/评论/点赞/举报）。
 *
 * 纪律（与全仓一致）：
 * - team_id / author_id / content_type / status / audit_status / published_at / 内部 numeric id
 *   一律由服务端派生（R1 铁律），绝不接受客户端提交（§5）。
 * - 租户隔离由 Repository 层（WHERE team_id = ?）二次收口；PermissionProvider 只裁决"能否执行动作"
 *   （本轮回路由下一阶段 gate，service 不内置 RBAC）。
 * - 附件复用 FileRepository.resolveForAttachment（§7）：服务层只做校验，不读内部 object_key / scan_status。
 * - 输出 DTO 不含任何 numeric id / object_key / checksum（§8/§9/§18）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { ContentRepository, ATTACHMENT_MAX, ATTACHMENT_MIME_ALLOWED, REPORT_REASONS } from '../repository/content';
import type { CreatePostInput, UpdatePostPatch, FeedArticleItem, CommentView, ReportReason } from '../repository/content';
import { FileRepository } from '../repository/files';
import { invalidParam, authRequired, teamScopeRequired, notFound } from '../utils/errors';
import type { RepositoryContext } from '../types/tenant';
import type { Paginated } from '../types/api';

export interface ContentServiceDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

export interface CreatePostBody {
  title: string;
  body: string;
  attachment_file_public_ids?: string[];
}

export interface UpdatePostBody {
  title?: string;
  body?: string;
  attachment_file_public_ids?: string[];
}

export interface ReportBody {
  reason: string;
  detail?: string;
}

export class ContentService {
  private readonly repo: ContentRepository;
  private readonly fileRepo: FileRepository;
  private readonly ctx: RepositoryContext;

  constructor(deps: ContentServiceDeps) {
    this.repo = new ContentRepository(deps);
    this.fileRepo = new FileRepository(deps);
    this.ctx = deps.ctx;
  }

  // ===================================================================
  // 志愿者创建文章
  // ===================================================================

  async createPost(body: CreatePostBody): Promise<{ article_public_id: string }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const authorId = this.ctx.auth.userId;
    if (authorId == null) throw authRequired();

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw invalidParam('title', 'required non-empty string');
    }
    if (typeof body.body !== 'string') {
      throw invalidParam('body', 'required string');
    }

    // 服务端强制：content_type='post', status=1, audit_status=1, published_at=NULL, author/team 派生。
    const created = await this.repo.insertVolunteerPost({
      title: body.title.trim(),
      content: body.body,
      authorId,
      teamId,
    } as CreatePostInput);

    const fileIds = await this.resolveAttachmentFileIds(body.attachment_file_public_ids, teamId, authorId, true);
    if (fileIds.length > 0) {
      await this.repo.replaceArticleAttachments(created.id, fileIds);
    }
    return { article_public_id: created.public_id };
  }

  // ===================================================================
  // 志愿者更新自己的文章（他人同 team / 跨 team → 404）
  // ===================================================================

  async updateOwnArticle(publicId: string, body: UpdatePostBody): Promise<{ article_public_id: string }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const authorId = this.ctx.auth.userId;
    if (authorId == null) throw authRequired();

    const patch: UpdatePostPatch = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        throw invalidParam('title', 'required non-empty string when provided');
      }
      patch.title = body.title.trim();
    }
    if (body.body !== undefined) {
      if (typeof body.body !== 'string') throw invalidParam('body', 'required string when provided');
      patch.content = body.body;
    }

    // 任何 SELF update 后统一重置为 DRAFT/PENDING（含原本已发布），由 repo 强制。
    await this.repo.updateOwnArticle(publicId, authorId, patch);

    if (body.attachment_file_public_ids !== undefined) {
      const fileIds = await this.resolveAttachmentFileIds(body.attachment_file_public_ids, teamId, authorId, true);
      const art = await this.repo.findArticleRow(publicId);
      if (art) await this.repo.replaceArticleAttachments(art.id, fileIds);
    }
    return { article_public_id: publicId };
  }

  // ===================================================================
  // 文章详情（team-scoped；跨 team → 404）
  // ===================================================================

  async getArticle(publicId: string): Promise<FeedArticleItem> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const art = await this.repo.findArticleRow(publicId);
    if (!art) throw notFound('Article');
    const attachments = await this.repo.listArticleAttachmentsById(publicId);
    const likedByMe = this.ctx.auth.userId != null ? await this.repo.hasLiked(art.id, this.ctx.auth.userId) : false;
    return {
      article_public_id: art.public_id,
      content_type: art.content_type,
      title: art.title,
      body: art.content,
      author_public_id: null, // 由 service 单独解析；此处保持与 feed 一致的最小安全视图
      author_nickname: null,
      attachments,
      comment_count: art.comment_count,
      like_count: art.like_count,
      liked_by_me: likedByMe,
      published_at: art.published_at,
      created_at: art.created_at,
    };
  }

  // ===================================================================
  // Feed（仅已发布 + 已通过审核）
  // ===================================================================

  async getFeed(page: number, pageSize: number): Promise<Paginated<FeedArticleItem>> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const offset = Math.max(0, (page - 1) * pageSize);
    return this.repo.listFeed(page, pageSize, offset);
  }

  // ===================================================================
  // 评论（user_id = auth.userId；仅可评已发布且已通过审核的文章）
  // ===================================================================

  async createComment(articlePublicId: string, body: { content: string }): Promise<{ comment_public_id: string }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const userId = this.ctx.auth.userId;
    if (userId == null) throw authRequired();

    if (typeof body.content !== 'string' || body.content.trim() === '') {
      throw invalidParam('content', 'required non-empty string');
    }

    const art = await this.repo.findArticleRow(articlePublicId);
    // 跨 team / 不存在 → 404（不泄露存在性）
    if (!art || art.team_id !== teamId) throw notFound('Article');
    // 仅允许评论已发布且已通过审核的文章
    if (art.status !== 2 || art.audit_status !== 2) {
      throw invalidParam('article', 'article is not open for comments');
    }

    const created = await this.repo.createComment({
      articleId: art.id,
      userId,
      teamId,
      content: body.content.trim(),
    });
    return { comment_public_id: created.public_id };
  }

  async listComments(articlePublicId: string): Promise<CommentView[]> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const art = await this.repo.findArticleRow(articlePublicId);
    if (!art || art.team_id !== teamId) throw notFound('Article');
    return this.repo.listVisibleComments(art.id);
  }

  // ===================================================================
  // 点赞（仅 target_type='article'）
  // ===================================================================

  async likeArticle(articlePublicId: string): Promise<{ liked: boolean; like_count: number }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const userId = this.ctx.auth.userId;
    if (userId == null) throw authRequired();
    const art = await this.repo.findArticleRow(articlePublicId);
    if (!art || art.team_id !== teamId) throw notFound('Article');
    return this.repo.addLike(art.id, userId, teamId);
  }

  async unlikeArticle(articlePublicId: string): Promise<{ liked: boolean; like_count: number }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const userId = this.ctx.auth.userId;
    if (userId == null) throw authRequired();
    const art = await this.repo.findArticleRow(articlePublicId);
    if (!art || art.team_id !== teamId) throw notFound('Article');
    return this.repo.removeLike(art.id, userId, teamId);
  }

  // ===================================================================
  // 举报（article / comment）
  // ===================================================================

  async reportArticle(articlePublicId: string, body: ReportBody): Promise<{ ok: true }> {
    return this.report('article', articlePublicId, body);
  }

  async reportComment(commentPublicId: string, body: ReportBody): Promise<{ ok: true }> {
    return this.report('comment', commentPublicId, body);
  }

  private async report(
    targetType: 'article' | 'comment',
    targetPublicId: string,
    body: ReportBody,
  ): Promise<{ ok: true }> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const reporterId = this.ctx.auth.userId;
    if (reporterId == null) throw authRequired();

    if (!REPORT_REASONS.includes(body.reason as ReportReason)) {
      throw invalidParam('reason', `must be one of: ${REPORT_REASONS.join(', ')}`);
    }
    const description = typeof body.detail === 'string' ? body.detail : null;

    let targetId: number;
    if (targetType === 'article') {
      const art = await this.repo.findArticleRow(targetPublicId);
      if (!art || art.team_id !== teamId) throw notFound('Article');
      targetId = art.id;
    } else {
      const cm = await this.repo.findCommentRow(targetPublicId);
      if (!cm || cm.team_id !== teamId) throw notFound('Comment');
      targetId = cm.id;
    }

    await this.repo.createReport({
      targetType,
      targetId,
      teamId,
      reporterId,
      reasonType: body.reason as ReportReason,
      description,
    });
    // 不返回 report id / numeric target id / reporter_id / 内部 status（§11）。
    return { ok: true };
  }

  // ===================================================================
  // 附件解析（§7）：复用 FileRepository.resolveForAttachment，仅做校验
  // ===================================================================

  private async resolveAttachmentFileIds(
    publicIds: string[] | undefined,
    teamId: number,
    authorId: number,
    requireOwnUpload: boolean,
  ): Promise<number[]> {
    if (!Array.isArray(publicIds) || publicIds.length === 0) return [];
    if (publicIds.length > ATTACHMENT_MAX) {
      throw invalidParam('attachment_file_public_ids', `at most ${ATTACHMENT_MAX} attachments`);
    }
    // 去重（保持顺序）；重复 public id → 拒绝（C21）
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of publicIds) {
      if (typeof p !== 'string') throw invalidParam('attachment_file_public_ids', 'must be string[]');
      if (seen.has(p)) throw invalidParam('attachment_file_public_ids', 'duplicate public id not allowed');
      seen.add(p);
      unique.push(p);
    }
    // resolver 强制 team_id + deleted_at IS NULL；缺失/cross-team 的文件不会返回 → 数量不符 → 404（C4）
    const resolved = await this.fileRepo.resolveForAttachment(unique, teamId);
    if (resolved.length !== unique.length) {
      throw notFound('File');
    }
    const fileIds: number[] = [];
    for (const r of resolved) {
      if (r.visibility !== 'team') {
        throw invalidParam('attachment_file_public_ids', 'file is not team-visible');
      }
      if (!ATTACHMENT_MIME_ALLOWED.has(r.mime_type)) {
        throw invalidParam('attachment_file_public_ids', `unsupported mime_type: ${r.mime_type}`);
      }
      // SELF create/update：他人同 team 文件拒绝（C3）；scan_status 不校验（允许 0，§7）
      if (requireOwnUpload && r.uploader_id !== authorId) {
        throw invalidParam('attachment_file_public_ids', 'file belongs to another user');
      }
      fileIds.push(r.id);
    }
    return fileIds;
  }
}
