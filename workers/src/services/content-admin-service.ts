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
import { ContentRepository } from '../repository/content';
import type { AdminArticleItem } from '../repository/content';
import { authRequired, teamScopeRequired } from '../utils/errors';
import type { RepositoryContext } from '../types/tenant';
import type { Paginated } from '../types/api';

export interface ContentAdminServiceDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

export class ContentAdminService {
  private readonly repo: ContentRepository;
  private readonly ctx: RepositoryContext;

  constructor(deps: ContentAdminServiceDeps) {
    this.repo = new ContentRepository(deps);
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
}
