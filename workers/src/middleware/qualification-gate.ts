/**
 * 志愿者资格门 middleware 工厂（P0-C；与 RBAC requirePermission 同构）。
 *
 * 语义：
 *   - 校验当前已认证用户（actor）是否具备志愿者资格（IDENTITY + PHONE + INITIAL_TRAINING_EXAM）。
 *   - 未认证 → 401（authContext 已拦截，此处为保险）；资格不满足 → 403 QUALIFICATION_REQUIRED。
 *   - 失败响应 details.reasons 携带稳定缺失 token（IDENTITY_REQUIRED / PHONE_REQUIRED / TRAINING_EXAM_REQUIRED）。
 *
 * 使用：在 requirePermission / teamScope 之后追加，例如 AI 助手端点（routes/ai.ts requireAiAssist）。
 * 服务层门（signup / participation / attendance / settlement）直接调用
 *   assertVolunteerQualified(db, auth, tenant, userId)（见 services/volunteer-qualification-service.ts）。
 */

import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import { VolunteerQualificationService } from '../services/volunteer-qualification-service';
import { authRequired } from '../utils/errors';

export function requireVolunteerQualification() {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth.authenticated || auth.userId == null) throw authRequired();

    const svc = new VolunteerQualificationService({ db: c.env.DB, auth, tenant: c.get('tenant') });
    await svc.assertVolunteerQualified(auth.userId);
    await next();
  });
}
