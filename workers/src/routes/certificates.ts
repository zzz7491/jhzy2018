/**
 * /api/v2/certificates —�?证书端点（P32-P2）。
 *
 * Volunteer：
 *   GET /certificates/mine              — 我的证书（USER 归属）
 *   GET /certificates/:certificatePublicId — 证书详情（持证者本人 / 团队管理员）
 *
 * Public：
 *   GET /certificates/verify?cert_no=&code= — 公开验真（仅安全字段）
 *
 * Admin（certificate.template.manage）：
 *   GET  /certificates/admin/templates
 *   POST /certificates/admin/templates
 *   PUT  /certificates/admin/templates/:templatePublicId
 *
 * 不暴露 id_card / numeric DB id / private user metadata。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { CertificateService } from '../services/certificate-service';
import { CertificateRepository, type CertificateInput } from '../repository/certificate';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired } from '../utils/errors';
import { requireUlidParam, parsePagination } from '../utils/validation';

const certificates = new Hono<{ Bindings: Env; Variables: AppVars }>();

const buildService = (c: any) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new CertificateService({ db: c.env.DB, auth, tenant: c.get('tenant'), env: c.env });
};

/** GET /certificates/mine — 我的证书（SELF 归属；不要求 TEAM cert.view） */
certificates.get('/mine', async (c) => {
  const svc = buildService(c);
  const result = await svc.mine();
  return ok(c, result);
});

/** GET /certificates/verify — 公开验真（仅安全字段；凭 cert_no / code） */
certificates.get('/verify', async (c) => {
  const svc = buildService(c);
  const result = await svc.verify(c.req.query('cert_no'), c.req.query('code'));
  return ok(c, result);
});

// ===== Admin templates =====

certificates.get('/admin/templates', requirePermission('certificate.template.manage'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const repo = new CertificateRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const templates = await repo.listTemplates();
  return ok(c, { templates });
});

certificates.post('/admin/templates', requirePermission('certificate.template.manage'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const repo = new CertificateRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const createdBy = auth.userId;
  const body = await c.req.json().catch(() => ({}));
  const result = await repo.adminCreateTemplate(body as CertificateInput, createdBy ?? 0, Math.floor(Date.now() / 1000));
  return ok(c, result, 201);
});

certificates.put('/admin/templates/:templatePublicId', requirePermission('certificate.template.manage'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const repo = new CertificateRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const templatePublicId = requireUlidParam(c.req.param('templatePublicId'), 'templatePublicId');
  const body = await c.req.json().catch(() => ({}));
  const updated = await repo.adminUpdateTemplate(templatePublicId, body as CertificateInput, Math.floor(Date.now() / 1000));
  return ok(c, { updated });
});

/** GET /certificates/admin — 本团队培训证书列表（certificate.certificate.view）。仅安全字段。 */
certificates.get('/admin', requirePermission('certificate.certificate.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const tenant = c.get('tenant');
  const teamId = tenant?.teamId ?? null;
  if (teamId == null) throw teamScopeRequired();
  const repo = new CertificateRepository({ db: c.env.DB, ctx: { auth, tenant } });
  const pagination = parsePagination(c.req.query());
  const [rows, total] = await Promise.all([
    repo.listCertsByTeam(teamId, pagination.page, pagination.pageSize),
    repo.countCertsByTeam(teamId),
  ]);
  return ok(c, {
    certificates: rows,
    pagination: { page: pagination.page, page_size: pagination.pageSize, total },
  });
});

/** GET /certificates/:certificatePublicId — 详情（持证者本人 SELF；团队管理员需 cert.view）。注册在 /admin 之后以避免被参数路由遮蔽。 */
certificates.get('/:certificatePublicId', async (c) => {
  const svc = buildService(c);
  const certificatePublicId = requireUlidParam(c.req.param('certificatePublicId'), 'certificatePublicId');
  const result = await svc.detail(certificatePublicId);
  return ok(c, result);
});

export default certificates;