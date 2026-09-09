/**
 * 社区管理端路由（P33-P3B-2C）—— /api/v2/admin/content
 *
 * 纪律（§8/§10/§13）：
 * - 仅实现：list / approve / reject / unpublish / delete 五个管理端点；
 *   不新增任何 permission code（沿用 0003 目录：
 *     list/approve/reject → content.article.audit
 *     unpublish           → content.article.publish
 *     delete              → content.article.delete）。
 * - 所有端点经 requirePermission（DB-backed）gate；service 再强制 actor + team 二次边界。
 * - 每个写动作由 service 在 batch 内写 content_audit_logs（action/from_status/to_status 真实前/后值）。
 * - 响应安全：仅回显 article_public_id；不回显 numeric id / 内部 status 含义 / operator 内部 id。
 *   管理台列表 DTO 含 status/audit_status 枚举数值（业务状态，非标识符），属安全字段。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVars } from '../env';
import { ContentAdminService } from '../services/content-admin-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { requireUlidParam, parsePagination } from '../utils/validation';

const adminContent = new Hono<{ Bindings: Env; Variables: AppVars }>();

function svc(c: Context) {
  return new ContentAdminService({
    db: c.env.DB,
    ctx: { auth: c.get('auth'), tenant: c.get('tenant') },
  });
}

// ---- GET /articles（审核台列表：同 team 全部未删除）----
adminContent.get('/articles', requirePermission('content.article.audit'), async (c) => {
  const { page, pageSize } = parsePagination(c.req.query());
  const data = await svc(c).list(page, pageSize);
  return ok(c, data);
});

// ---- POST /articles/:articlePublicId/approve ----
adminContent.post('/articles/:articlePublicId/approve', requirePermission('content.article.audit'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).approve(publicId);
  return ok(c, data);
});

// ---- POST /articles/:articlePublicId/reject ----
adminContent.post('/articles/:articlePublicId/reject', requirePermission('content.article.audit'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).reject(publicId);
  return ok(c, data);
});

// ---- POST /articles/:articlePublicId/unpublish（需 publish 权限）----
adminContent.post('/articles/:articlePublicId/unpublish', requirePermission('content.article.publish'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).unpublish(publicId);
  return ok(c, data);
});

// ---- DELETE /articles/:articlePublicId（需 delete 权限）----
adminContent.delete('/articles/:articlePublicId', requirePermission('content.article.delete'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).delete(publicId);
  return ok(c, data);
});

export default adminContent;
