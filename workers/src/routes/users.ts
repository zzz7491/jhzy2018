/**
 * GET /api/v2/users/me —— 当前用户（S2-5 最小只读）。
 *
 * USER_SCOPED：仅返回测试注入身份对应的本人数据；不提供他人查询端点。
 * 本阶段不实现注册 / 登录。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { UserRepository } from '../repository/users';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';

const users = new Hono<{ Bindings: Env; Variables: AppVars }>();

users.get('/me', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const repo = new UserRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const user = await repo.findMe();
  const profile = await repo.findMyProfile();

  return ok(c, { user, profile: profile ?? null });
});

export default users;
