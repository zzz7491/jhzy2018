/**
 * 志愿者资格状态路由（P0-C）。
 *
 * 端点（精确 1 个；纯投影，无 PII）：
 *   GET /api/v2/users/me/qualification → 200 返回当前用户资格派生结果
 *
 * 范围边界（严格遵守）：
 * - 仅 auth required；不要求团队上下文（资格是每用户派生，不依赖 team）。
 * - 后端为唯一权威；前端仅消费，不自算（用户 P0-C §20）。
 * - 不写任何状态、不触发核验/绑定/考试。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { VolunteerQualificationService } from '../services/volunteer-qualification-service';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';

const qualification = new Hono<{ Bindings: Env; Variables: AppVars }>();

qualification.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const svc = new VolunteerQualificationService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const result = await svc.getVolunteerQualification(auth.userId);
  return ok(c, result);
});

export default qualification;
