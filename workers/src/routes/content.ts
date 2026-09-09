/**
 * 社区志愿者/团队路由（P33-P3B-2C）—— /api/v2/content
 *
 * 纪律（与全仓及 P33-P3B-2B 一致）：
 * - 读（feed / detail / comments list）要求 requireAuth + active TEAM（§5），
 *   不引入新的 content.article.view 权限；service/repository 已有 TEAM 二次边界。
 * - 写动作经 requirePermission（DB-backed）gate：
 *     POST article   → content.article.self.create
 *     PUT  article   → content.article.self.update
 *     POST comment   → content.comment.create
 *     POST/DELETE like → content.like.create
 *     POST report    → content.report.create
 *   不使用 content.article.create / content.article.update（§6/§7）。
 * - ownership 仍由 service 强制（author_id = auth.userId）；路由只做权限 + ULID + 字段白名单。
 * - 响应安全（§10）：只回显 public_id；绝不回显 numeric id / object_key / checksum /
 *   reporter_id / 内部 target_id。service DTO 已满足；路由不透传内部字段。
 * - 请求校验（§9）：body 仅接受 service contract 字段（title/body/attachment_file_public_ids/
 *   content/reason/detail）；客户端传入 team_id/author_id/status 等一律忽略（service 不读取）。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import { ContentService } from '../services/content-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired, invalidParam } from '../utils/errors';
import { requireUlidParam, parsePagination } from '../utils/validation';

const content = new Hono<{ Bindings: Env; Variables: AppVars }>();

// §5：feed / detail / comments list 仅要求「已认证 + active TEAM」，不引入新 view 权限。
function requireActiveTeam() {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();
    const tenant = c.get('tenant');
    if (tenant.teamId == null) throw teamScopeRequired();
    await next();
  });
}

/** 安全解析 JSON body（非对象 → 400，不泄露内部错误）。 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalidParam('body', 'expected JSON object');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidParam('body', 'expected JSON object');
  }
  return raw as Record<string, unknown>;
}

function svc(c: Context) {
  return new ContentService({
    db: c.env.DB,
    ctx: { auth: c.get('auth'), tenant: c.get('tenant') },
  });
}

// ---- GET /feed（已认证 + active TEAM）----
content.get('/feed', requireActiveTeam(), async (c) => {
  const { page, pageSize } = parsePagination(c.req.query());
  const data = await svc(c).getFeed(page, pageSize);
  return ok(c, data);
});

// ---- GET /articles/:articlePublicId（已认证 + active TEAM）----
content.get('/articles/:articlePublicId', requireActiveTeam(), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).getArticle(publicId);
  return ok(c, data);
});

// ---- POST /articles（SELF create）----
content.post('/articles', requirePermission('content.article.self.create'), async (c) => {
  const body = await readJsonBody(c);
  const data = await svc(c).createPost({
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    attachment_file_public_ids: Array.isArray(body.attachment_file_public_ids)
      ? (body.attachment_file_public_ids as string[])
      : undefined,
  });
  return ok(c, data, 201);
});

// ---- PUT /articles/:articlePublicId（SELF update；ownership 由 service 强制）----
content.put('/articles/:articlePublicId', requirePermission('content.article.self.update'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const body = await readJsonBody(c);
  const patch: { title?: string; body?: string; attachment_file_public_ids?: string[] } = {};
  if (body.title !== undefined) patch.title = typeof body.title === 'string' ? body.title : '';
  if (body.body !== undefined) patch.body = typeof body.body === 'string' ? body.body : '';
  if (body.attachment_file_public_ids !== undefined) {
    patch.attachment_file_public_ids = Array.isArray(body.attachment_file_public_ids)
      ? (body.attachment_file_public_ids as string[])
      : undefined;
  }
  const data = await svc(c).updateOwnArticle(publicId, patch);
  return ok(c, data);
});

// ---- GET /articles/:articlePublicId/comments（已认证 + active TEAM）----
content.get('/articles/:articlePublicId/comments', requireActiveTeam(), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).listComments(publicId);
  return ok(c, data);
});

// ---- POST /articles/:articlePublicId/comments ----
content.post('/articles/:articlePublicId/comments', requirePermission('content.comment.create'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const body = await readJsonBody(c);
  const data = await svc(c).createComment(publicId, {
    content: typeof body.content === 'string' ? body.content : '',
  });
  return ok(c, data, 201);
});

// ---- POST /articles/:articlePublicId/like ----
content.post('/articles/:articlePublicId/like', requirePermission('content.like.create'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).likeArticle(publicId);
  return ok(c, data);
});

// ---- DELETE /articles/:articlePublicId/like ----
content.delete('/articles/:articlePublicId/like', requirePermission('content.like.create'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const data = await svc(c).unlikeArticle(publicId);
  return ok(c, data);
});

// ---- POST /articles/:articlePublicId/report ----
content.post('/articles/:articlePublicId/report', requirePermission('content.report.create'), async (c) => {
  const publicId = requireUlidParam(c.req.param('articlePublicId'), 'articlePublicId');
  const body = await readJsonBody(c);
  const data = await svc(c).reportArticle(publicId, {
    reason: typeof body.reason === 'string' ? body.reason : '',
    detail: typeof body.detail === 'string' ? body.detail : undefined,
  });
  return ok(c, data);
});

// ---- POST /comments/:commentPublicId/report ----
content.post('/comments/:commentPublicId/report', requirePermission('content.report.create'), async (c) => {
  const publicId = requireUlidParam(c.req.param('commentPublicId'), 'commentPublicId');
  const body = await readJsonBody(c);
  const data = await svc(c).reportComment(publicId, {
    reason: typeof body.reason === 'string' ? body.reason : '',
    detail: typeof body.detail === 'string' ? body.detail : undefined,
  });
  return ok(c, data);
});

export default content;
