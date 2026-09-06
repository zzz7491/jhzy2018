/**
 * GET /api/v2/points/account        —— 当前登录用户的积分账户（SELF）
 * GET /api/v2/points/transactions   —— 当前登录用户自己的积分流水（SELF，分页）
 *
 * P23-P4B：仅 SELF 只读端点，权限 points.account.read（已在 0018 创建并绑定
 * volunteer / platform_super_admin）。不提供 userId / teamId / 过滤 query；不写库。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { PointsService } from '../services/points-service';
import { ok } from '../utils/response';
import { requirePermission } from '../middleware/rbac';
import { authRequired } from '../utils/errors';

const points = new Hono<{ Bindings: Env; Variables: AppVars }>();

points.get('/account', requirePermission('points.account.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new PointsService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const account = await svc.getAccount();
  return ok(c, account);
});

points.get('/transactions', requirePermission('points.account.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new PointsService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const page = await svc.listTransactions(c.req.query());
  return ok(c, page);
});

export default points;
