/**
 * 志愿者身份核验路由（P0-A）。
 *
 * 仅承载「真实姓名 + 身份证」二要素核验主链：
 *   POST /api/v2/volunteer/identity/verify
 *   GET  /api/v2/volunteer/identity/status
 *
 * 范围边界（严格遵守）：
 * - 不处理手机号绑定 / 培训 / 考试 / qualification / team join / 保险。
 * - 不创建 qualification gate（那属于 P0-C 阶段）。
 * - 响应绝不返回：身份证明文 / Provider 原始响应 / Secret。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { IdentityRepository } from '../repository/identity';
import { IdentityVerificationService } from '../services/identity-verification';
import { getIdentityProvider } from '../providers/identity/registry';
import { ok } from '../utils/response';
import { authRequired, invalidParam, AppError, ErrorCode } from '../utils/errors';
import { isValidIdCard } from '../utils/pii';

const volunteer = new Hono<{ Bindings: Env; Variables: AppVars }>();

volunteer.post('/identity/verify', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(ErrorCode.INVALID_INPUT, 400, 'Invalid JSON body');
  }

  const realName = typeof (body as Record<string, unknown>)?.real_name === 'string'
    ? ((body as Record<string, unknown>).real_name as string).trim()
    : '';
  const idCard = typeof (body as Record<string, unknown>)?.id_card === 'string'
    ? ((body as Record<string, unknown>).id_card as string).trim()
    : '';

  if (realName.length === 0 || realName.length > 64) {
    throw new AppError(ErrorCode.INVALID_INPUT, 400, 'Invalid real_name');
  }
  if (!isValidIdCard(idCard)) {
    throw invalidParam('id_card', 'invalid_format');
  }

  const repo = new IdentityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const provider = getIdentityProvider(c.env);
  const svc = new IdentityVerificationService(repo, provider, c.env);
  const result = await svc.verify(auth.userId, realName, idCard);
  return ok(c, result);
});

volunteer.get('/identity/status', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const repo = new IdentityRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const provider = getIdentityProvider(c.env);
  const svc = new IdentityVerificationService(repo, provider, c.env);
  const status = await svc.getStatus(auth.userId);
  return ok(c, status);
});

export default volunteer;
