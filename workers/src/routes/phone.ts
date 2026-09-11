/**
 * 微信可信手机号绑定路由（P0-B）。
 *
 * 仅承载「微信可信手机号」绑定主链：
 *   POST /api/v2/users/me/phone/wechat/bind
 *   GET  /api/v2/users/me/phone/status
 *
 * 范围边界（严格遵守）：
 * - 不处理 qualification / 培训 / 考试 / team join / 保险 / 通知。
 * - 响应绝不返回：完整手机号明文 / 动态 code / Provider 原始响应 / Secret / access_token。
 * - 绑定事实只能来自微信可信手机号授权（前端 getPhoneNumber → code → 后端 getuserphonenumber）。
 *   绝不信任客户端传入的任意 phone 字段。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { PhoneRepository } from '../repository/phone';
import { PhoneBindingService } from '../services/phone-binding';
import { getWeChatPhoneProvider } from '../providers/wechat/phone-client';
import { ok } from '../utils/response';
import { authRequired, AppError, ErrorCode } from '../utils/errors';

const phone = new Hono<{ Bindings: Env; Variables: AppVars }>();

phone.post('/wechat/bind', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(ErrorCode.INVALID_INPUT, 400, 'Invalid JSON body');
  }

  // 仅接受 { code }；绝不接受客户端自填手机号。
  const code = typeof (body as Record<string, unknown>)?.code === 'string'
    ? ((body as Record<string, unknown>).code as string).trim()
    : '';
  if (code.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, 400, 'Missing code');
  }

  const repo = new PhoneRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const provider = getWeChatPhoneProvider(c.env);
  const svc = new PhoneBindingService(repo, provider, c.env);
  const result = await svc.bind(auth.userId, code);
  return ok(c, result);
});

phone.get('/status', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const repo = new PhoneRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const provider = getWeChatPhoneProvider(c.env);
  const svc = new PhoneBindingService(repo, provider, c.env);
  const status = await svc.getStatus(auth.userId);
  return ok(c, status);
});

export default phone;
