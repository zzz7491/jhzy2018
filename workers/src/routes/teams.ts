/**
 * GET /api/v2/teams/:id —— 团队详情（S2-5 最小只读）。
 *
 * teams 为 PLATFORM_GLOBAL（S2-3 矩阵）：已认证即可读，不强制 team 上下文。
 * :id 为 ULID public_id，先经 validation 层校验再进 Repository。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { TeamRepository } from '../repository/teams';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';
import { requireUlidParam } from '../utils/validation';

const teams = new Hono<{ Bindings: Env; Variables: AppVars }>();

teams.get('/:id', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');
  const repo = new TeamRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const team = await repo.findByPublicId(publicId);

  return ok(c, { team });
});

export default teams;
