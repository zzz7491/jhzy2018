/**
 * 嘉禾 AI V1 HTTP API（P36-C3-2）—— /api/v2/ai
 *
 * 端点（精确 4 个，不新增其它 AI endpoint）：
 *   POST /api/v2/ai/conversations                    → 201  （创建 + 首轮问答）
 *   GET  /api/v2/ai/conversations                    → 200  （本人 + 本团队列表）
 *   GET  /api/v2/ai/conversations/:publicId          → 200  （详情；跨用户/跨团队 404）
 *   POST /api/v2/ai/conversations/:publicId/messages → 200  （下一轮问答；CAS stale 409）
 *
 * gate（§5）：ACTIVE_TEAM_REQUIRED + requirePermission('ai.assist.use')。
 * - 顺序：authentication → active team → permission → strict body → ownership → rate limit
 *   → provider → usage → persistence。
 * - 即使 platform role 拥有 ai.assist.use，无 active team 仍 403 TEAM_SCOPE_REQUIRED。
 * - permission 由 RBAC middleware 判定，**不硬编码角色**。
 *
 * 编排全部在 AIConversationService：本文件只做 ULID / body 解析 / 状态映射，
 * 不自行串联 provider / repository / 限流。
 *
 * 响应安全（§16）：不返回 provider / model / tokens / numeric id / user_id / team_id /
 * raw context / system prompt / 上游响应。投影由 repository + service 保证。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import { AIConversationService, AI_ASSIST_PERMISSION } from '../services/ai/conversation-service';
import { authorizePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired, invalidParam } from '../utils/errors';
import { requireUlidParam, parsePagination } from '../utils/validation';

const ai = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * 全部 4 个端点统一 gate（§5）：ACTIVE_TEAM_REQUIRED + ai.assist.use。
 * - 顺序：authentication → active team → permission（DB-backed，不硬编码角色）。
 * - platform role 即使拥有 ai.assist.use，无 active team 也会被 team gate 拦下。
 */
function requireAiAssist() {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();
    const tenant = c.get('tenant');
    if (tenant.teamId == null) throw teamScopeRequired();
    await authorizePermission(c.env, auth, AI_ASSIST_PERMISSION);
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
  return new AIConversationService({
    db: c.env.DB,
    auth: c.get('auth'),
    tenant: c.get('tenant'),
    env: c.env,
  });
}

// ---- GET /conversations（§10：list；投影不含 provider/model/messages/tokens/id）----
ai.get('/conversations', requireAiAssist(), async (c) => {
  const { page, pageSize, offset } = parsePagination(c.req.query());
  const data = await svc(c).listConversations(page, pageSize, offset);
  return ok(c, data);
});

// ---- POST /conversations（§8：create + first exchange → 201）----
ai.post('/conversations', requireAiAssist(), async (c) => {
  const body = await readJsonBody(c);
  const data = await svc(c).createConversation(body);
  return ok(c, data, 201);
});

// ---- GET /conversations/:publicId（§11：detail；跨用户/跨团队 → 404）----
ai.get('/conversations/:publicId', requireAiAssist(), async (c) => {
  const publicId = requireUlidParam(c.req.param('publicId'), 'publicId');
  const data = await svc(c).getConversation(publicId);
  return ok(c, data);
});

// ---- POST /conversations/:publicId/messages（§9：next exchange；CAS stale → 409）----
ai.post('/conversations/:publicId/messages', requireAiAssist(), async (c) => {
  const publicId = requireUlidParam(c.req.param('publicId'), 'publicId');
  const body = await readJsonBody(c);
  const data = await svc(c).appendMessage(publicId, body);
  return ok(c, data);
});

export default ai;
