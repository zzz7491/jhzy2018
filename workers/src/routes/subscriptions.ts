/**
 * 订阅授权路由（N0-C 微信订阅授权基础 —— WECHAT_SUBSCRIBE 渠道）。
 *
 * 端点（全部 SELF / USER_SCOPED；仅 auth required）：
 *   GET  /api/v2/subscriptions/status  → 当前用户订阅状态 + delivery identity readiness
 *   POST /api/v2/subscriptions/consent → 记录一次授权结果（ACCEPT / REJECT / BAN，幂等）
 *
 * 边界（严格遵守）：
 *   - 【无发送端点】：不发任何微信消息；subscribeMessage.send 属 N0-D。
 *   - 【无 openid 出入口】：请求体只接受 template_key / template_id / state；
 *     响应绝不包含 openid / 密文 / hash / 内部 id。
 *   - readiness 表达（§11-C）：已并入 GET /status 的 delivery_identity_ready 字段，
 *     不再单独建 endpoint（优先最少 API）。
 *   - 模板合法性由服务端权威判定（不信任前端 template id）。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { SubscriptionConsentService } from '../services/subscription-consent-service';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';

const subscriptions = new Hono<{ Bindings: Env; Variables: AppVars }>();

subscriptions.get('/status', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const result = await new SubscriptionConsentService({
    env: c.env,
    auth,
    tenant: c.get('tenant'),
  }).getStatus(auth.userId);
  return ok(c, result);
});

subscriptions.post('/consent', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  let body: { template_key?: unknown; template_id?: unknown; state?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw invalidParam('body', 'invalid json');
  }

  const item = await new SubscriptionConsentService({
    env: c.env,
    auth,
    tenant: c.get('tenant'),
  }).recordConsent(auth.userId, {
    templateKey: typeof body?.template_key === 'string' ? body.template_key : '',
    templateId: typeof body?.template_id === 'string' ? body.template_id : '',
    state: body?.state,
  });
  return ok(c, { status: 'OK', item });
});

export default subscriptions;
