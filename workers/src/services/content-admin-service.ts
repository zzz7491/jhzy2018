/**
 * ContentAdminService（P33-P3B-2B）—— 社区管理端业务逻辑层（审核/下架/删除）。
 *
 * 纪律：
 * - 本轮 service 不做 RBAC middleware；权限由下一阶段 routes gate。
 *   但 service 必须 require actor（auth.userId）+ require team（tenant.teamId），
 *   且所有资源解析走 team-scoped（WHERE team_id = ?）二次收口。
 * - 每个 admin 动作都写入 content_audit_logs（action/from_status/to_status），
 *   由 ContentRepository 在批写内完成（原子）。
 * - 状态转换严格遵循冻结枚举（§3）：approve 2/2、reject 1/3、unpublish 3/2、delete 4/*。
 * - 不返回 numeric id / 内部状态；DTO 仅含 public_id 与安全字段。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { ContentRepository, ATTACHMENT_MAX, ATTACHMENT_MIME_ALLOWED, type UpdatePostPatch } from '../repository/content';
import type { AdminArticleItem, AdminArticleDetail } from '../repository/content';
import { FileRepository } from '../repository/files';
import { authRequired, teamScopeRequired, invalidParam, notFound } from '../utils/errors';
import type { RepositoryContext } from '../types/tenant';
import type { Paginated } from '../types/api';

export interface ContentAdminServiceDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

export interface AdminCreateArticleBody {
  title: string;
  body: string;
  attachment_file_public_ids?: string[];
}

export interface AdminUpdateArticleBody {
  title?: string;
  body?: string;
  attachment_file_public_ids?: string[];
}

export class ContentAdminService {
  private readonly repo: ContentRepository;
  private readonly fileRepo: FileRepository;
  private readonly ctx: RepositoryContext;

  constructor(deps: ContentAdminServiceDeps) {
    this.repo = new ContentRepository(deps);
    this.fileRepo = new FileRepository(deps);
    this.ctx = deps.ctx;
  }

  /** 校验 actor + team（管理端必须处于团队上下文）。 */
  private requireActor(): { teamId: number; operatorId: number } {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    const operatorId = this.ctx.auth.userId;
    if (operatorId == null) throw authRequired();
    return { teamId, operatorId };
  }

  /** 审核台列表：同 team 全部未删除文章（含 status/audit_status 供审核判定）。 */
  async list(page: number, pageSize: number): Promise<Paginated<AdminArticleItem>> {
    this.requireActor();
    const offset = Math.max(0, (page - 1) * pageSize);
    return this.repo.listAdminArticles(page, pageSize, offset);
  }

  /** 管理端文章详情（供编辑/审核回填）：同 team 任意未删除状态，含 status/audit_status/作者信息。 */
  async getArticleDetail(publicId: string): Promise<AdminArticleDetail> {
    this.requireActor();
    const detail = await this.repo.getAdminArticleDetail(publicId);
    if (!detail) throw notFound('Article');
    return detail;
  }

  async approve(publicId: string): Promise<{ article_public_id: string }> {
    const { operatorId } = this.requireActor();
    await this.repo.approveArticle(publicId, operatorId);
    return { article_public_id: publicId };
  }

  async reject(publicId: string): Promise<{ article_public_id: string }> {
    const { operatorId } = this.requireActor();
    await this.repo.rejectArticle(publicId, operatorId);
    return { article_public_id: publicId };
  }

  async unpublish(publicId: string): Promise<{ article_public_id: string }> {
    const { operatorId } = this.requireActor();
    await this.repo.unpublishArticle(publicId, operatorId);
    return { article_public_id: publicId };
  }

  async delete(publicId: string): Promise<{ article_public_id: string }> {
    const { operatorId } = this.requireActor();
    await this.repo.deleteArticle(publicId, operatorId);
    return { article_public_id: publicId };
  }

  // ===================================================================
  // 管理端：创建文章（content.article.create）
  // ===================================================================
  // author 强制为操作者（operatorId）；content_type/status/audit_status/published_at
  // 一律服务端派生。附件复用 FileRepository.resolveForAttachment，但【不要求本人上传】
  // （管理员可使用团队内任意成员上传的文件）。

  async createArticle(body: AdminCreateArticleBody): Promise<{ article_public_id: string }> {
    const { teamId, operatorId } = this.requireActor();
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw invalidParam('title', 'required non-empty string');
    }
    if (typeof body.body !== 'string') {
      throw invalidParam('body', 'required string');
    }
    const created = await this.repo.insertAdminArticle({
      title: body.title.trim(),
      content: body.body,
      authorId: operatorId,
      teamId,
    });
    const fileIds = await this.resolveAttachmentFileIds(body.attachment_file_public_ids, teamId);
    if (fileIds.length > 0) {
      await this.repo.replaceArticleAttachments(created.id, fileIds);
    }
    return { article_public_id: created.public_id };
  }

  // ===================================================================
  // 管理端：编辑团队内任意文章（content.article.update）
  // ===================================================================
  // 不绑定 author_id（管理员可编辑团队内任意未删除文章）；仓储层仅按 team_id 二次收口，
  // 跨 team → 404。任何编辑后统一重置为 DRAFT/PENDING（由 repo 强制），等待再次审核。

  async updateArticle(publicId: string, body: AdminUpdateArticleBody): Promise<{ article_public_id: string }> {
    const { teamId } = this.requireActor();
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
    await this.repo.updateAdminArticle(publicId, patch);
    if (body.attachment_file_public_ids !== undefined) {
      const fileIds = await this.resolveAttachmentFileIds(body.attachment_file_public_ids, teamId);
      const art = await this.repo.findArticleRow(publicId);
      if (art) await this.repo.replaceArticleAttachments(art.id, fileIds);
    }
    return { article_public_id: publicId };
  }

  // ===================================================================
  // 附件解析（管理端）：复用 FileRepository.resolveForAttachment，仅做校验。
  // 与志愿者端区别：不校验 uploader_id（管理员可使用团队内任意文件）。
  // ===================================================================

  private async resolveAttachmentFileIds(
    publicIds: string[] | undefined,
    teamId: number,
  ): Promise<number[]> {
    if (!Array.isArray(publicIds) || publicIds.length === 0) return [];
    if (publicIds.length > ATTACHMENT_MAX) {
      throw invalidParam('attachment_file_public_ids', `at most ${ATTACHMENT_MAX} attachments`);
    }
    // 去重（保持顺序）；重复 public id → 拒绝。
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of publicIds) {
      if (typeof p !== 'string') throw invalidParam('attachment_file_public_ids', 'must be string[]');
      if (seen.has(p)) throw invalidParam('attachment_file_public_ids', 'duplicate public id not allowed');
      seen.add(p);
      unique.push(p);
    }
    // resolver 强制 team_id + deleted_at IS NULL；缺失/cross-team 的文件不会返回 → 数量不符 → 404。
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
      fileIds.push(r.id);
    }
    return fileIds;
  }
}
