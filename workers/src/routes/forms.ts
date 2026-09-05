/**
 * 通用动态表单引擎路由（S2-NEW-ARCH-P20）。
 *
 * 冻结 API（REV2）：
 *   create definition/publish/archive/draft 管理（form.definition.manage）
 *   read definition（form.definition.read）
 *   binding（form.definition.manage）
 *   consumer form render（form.submission.submit）
 *   submission create/patch/withdraw（form.submission.submit）& mine（form.submission.read）
 *   team list/invalidate（form.submission.manage）
 *
 * 路由纪律：字面量段优先注册（/submissions/mine、/submissions/team 必须在 /submissions/:x 之前）。
 * 响应一律 public_id，绝不输出内部 id。
 */
import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';
import { requireUlidParam } from '../utils/validation';
import { FormService } from '../services/form-service';

const forms = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** 安全解析 JSON body（空 / 非法 → {}，交由后续校验阶段 400）。 */
async function readBody(c: import('hono').Context): Promise<Record<string, unknown>> {
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') return json as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return {};
}

function buildService(c: import('hono').Context): FormService {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new FormService({ db: c.env.DB, auth, tenant: c.get('tenant') });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// =========================================================================
// Definition / version
// =========================================================================

/** POST /forms/definitions —— 建 definition + V1 draft。 */
forms.post('/definitions', requirePermission('form.definition.manage'), async (c) => {
  const b = await readBody(c);
  const name = str(b.name);
  if (!name) throw invalidParam('name', 'required');
  const svc = buildService(c);
  const view = await svc.createDefinition({
    name,
    description: str(b.description) ?? null,
    fields: b.fields,
    allow_repeat: b.allow_repeat === true,
  });
  return ok(c, { definition: view }, 201);
});

/** GET /forms/definitions/:definitionPublicId。 */
forms.get('/definitions/:definitionPublicId', requirePermission('form.definition.read'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const svc = buildService(c);
  const view = await svc.getDefinition(definitionPublicId);
  return ok(c, { definition: view });
});

/** PATCH /forms/definitions/:definitionPublicId —— metadata（name/description/allow_repeat）。 */
forms.patch('/definitions/:definitionPublicId', requirePermission('form.definition.manage'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const b = await readBody(c);
  const svc = buildService(c);
  const view = await svc.updateDefinitionMetadata(definitionPublicId, {
    name: str(b.name),
    description: b.description === undefined ? undefined : str(b.description) ?? null,
    allow_repeat: b.allow_repeat === undefined ? undefined : b.allow_repeat === true,
  });
  return ok(c, { definition: view });
});

/** POST /forms/definitions/:definitionPublicId/draft —— 幂等取/建下一 draft。 */
forms.post('/definitions/:definitionPublicId/draft', requirePermission('form.definition.manage'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const svc = buildService(c);
  const result = await svc.createNextDefinitionDraft(definitionPublicId);
  return ok(c, { version: result.version }, result.created ? 201 : 200);
});

/** PATCH /forms/definitions/:definitionPublicId/draft —— 只改当前 draft 的 schema_json。 */
forms.patch('/definitions/:definitionPublicId/draft', requirePermission('form.definition.manage'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const b = await readBody(c);
  const svc = buildService(c);
  const view = await svc.patchDefinitionDraft(definitionPublicId, b.fields);
  return ok(c, { version: view });
});

/** POST /forms/definitions/:definitionPublicId/publish。 */
forms.post('/definitions/:definitionPublicId/publish', requirePermission('form.definition.manage'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const svc = buildService(c);
  const view = await svc.publishDefinition(definitionPublicId);
  return ok(c, { definition: view });
});

/** POST /forms/definitions/:definitionPublicId/archive。 */
forms.post('/definitions/:definitionPublicId/archive', requirePermission('form.definition.manage'), async (c) => {
  const definitionPublicId = requireUlidParam(c.req.param('definitionPublicId'), 'definitionPublicId');
  const svc = buildService(c);
  const view = await svc.archiveDefinition(definitionPublicId);
  return ok(c, { definition: view });
});

// =========================================================================
// Binding
// =========================================================================

/** POST /forms/bindings —— definition ↔ consumer 绑定（只可绑已发布 definition）。 */
forms.post('/bindings', requirePermission('form.definition.manage'), async (c) => {
  const b = await readBody(c);
  const definitionPublicId = str(b.definition_public_id);
  const consumerType = str(b.consumer_type);
  if (!definitionPublicId) throw invalidParam('definition_public_id', 'required');
  if (!consumerType) throw invalidParam('consumer_type', 'required');
  // P21：consume_policy 从请求体透传（0 none / 1 optional（缺省） / 2 required）；非 0/1/2 → 400。
  // 服务层再做一次规范与缺省（OPTIONAL），此处为 route 层第一道校验。
  let consumePolicy: number | undefined;
  if (b.consume_policy !== undefined) {
    if (
      typeof b.consume_policy !== 'number' ||
      !Number.isInteger(b.consume_policy) ||
      b.consume_policy < 0 ||
      b.consume_policy > 2
    ) {
      throw invalidParam('consume_policy', 'must be 0 (none) / 1 (optional) / 2 (required)');
    }
    consumePolicy = b.consume_policy;
  }
  const svc = buildService(c);
  const result = await svc.createBinding({
    definition_public_id: definitionPublicId,
    consumer_type: consumerType,
    consumer_public_id: str(b.consumer_public_id),
    is_default: b.is_default === true,
    consume_policy: consumePolicy,
  });
  return ok(c, { binding: result.binding }, result.created ? 201 : 200);
});

// =========================================================================
// Consumer render
// =========================================================================

/** GET /forms/consumers/:consumerType/:consumerPublicId/form —— 权威解析 published form（渲染）。 */
forms.get(
  '/consumers/:consumerType/:consumerPublicId/form',
  requirePermission('form.submission.submit'),
  async (c) => {
    const consumerType = str(c.req.param('consumerType'));
    if (!consumerType) throw invalidParam('consumerType', 'required');
    const consumerPublicId = requireUlidParam(c.req.param('consumerPublicId'), 'consumerPublicId');
    const svc = buildService(c);
    const view = await svc.getConsumerForm(consumerType, consumerPublicId);
    return ok(c, view);
  },
);

// =========================================================================
// Submission
// =========================================================================

/** POST /forms/submissions —— 提交（draft|submitted）。 */
forms.post('/submissions', requirePermission('form.submission.submit'), async (c) => {
  const b = await readBody(c);
  const consumerType = str(b.consumer_type);
  const newPublicId = str(b.new_public_id);
  if (!consumerType) throw invalidParam('consumer_type', 'required');
  if (!newPublicId) throw invalidParam('new_public_id', 'required');
  const svc = buildService(c);
  const result = await svc.submit({
    consumer_type: consumerType,
    consumer_public_id: str(b.consumer_public_id),
    version_public_id: str(b.version_public_id),
    new_public_id: newPublicId,
    answers: b.answers,
    status: b.status === 'draft' ? 'draft' : b.status === 'submitted' ? 'submitted' : undefined,
  });
  return ok(c, { submission: result.submission }, result.created ? 201 : 200);
});

/** GET /forms/submissions/mine（SELF；字面量须优先注册）。 */
forms.get('/submissions/mine', requirePermission('form.submission.read'), async (c) => {
  const svc = buildService(c);
  const list = await svc.listOwnSubmissions();
  return ok(c, { submissions: list });
});

/** GET /forms/submissions/team?consumerType=&consumerPublicId=（manage；字面量优先注册）。 */
forms.get('/submissions/team', requirePermission('form.submission.manage'), async (c) => {
  const consumerType = c.req.query('consumerType') ?? '';
  if (!consumerType) throw invalidParam('consumerType', 'required');
  const consumerPublicId = c.req.query('consumerPublicId') ?? undefined;
  const svc = buildService(c);
  const list = await svc.listTeamSubmissions(consumerType, consumerPublicId);
  return ok(c, { submissions: list });
});

/** PATCH /forms/submissions/:submissionPublicId —— owner 更新 draft answers。 */
forms.patch('/submissions/:submissionPublicId', requirePermission('form.submission.submit'), async (c) => {
  const submissionPublicId = requireUlidParam(c.req.param('submissionPublicId'), 'submissionPublicId');
  const b = await readBody(c);
  const svc = buildService(c);
  const view = await svc.patchDraftSubmission(submissionPublicId, b.answers);
  return ok(c, { submission: view });
});

/** POST /forms/submissions/:submissionPublicId/withdraw（SELF）。 */
forms.post('/submissions/:submissionPublicId/withdraw', requirePermission('form.submission.submit'), async (c) => {
  const submissionPublicId = requireUlidParam(c.req.param('submissionPublicId'), 'submissionPublicId');
  const svc = buildService(c);
  const view = await svc.withdrawSubmission(submissionPublicId);
  return ok(c, { submission: view });
});

/** POST /forms/submissions/:submissionPublicId/invalidate（TEAM manage）。 */
forms.post('/submissions/:submissionPublicId/invalidate', requirePermission('form.submission.manage'), async (c) => {
  const submissionPublicId = requireUlidParam(c.req.param('submissionPublicId'), 'submissionPublicId');
  const svc = buildService(c);
  const view = await svc.invalidateSubmission(submissionPublicId);
  return ok(c, { submission: view });
});

export default forms;