/**
 * Hono 应用装配（S2-5）。
 *
 * 中间件链（顺序固定）：
 *   requestId → authContext → tenantContext → 路由
 * 全局错误经 app.onError（error-handler）统一折叠，不泄露内部信息。
 *
 * 挂载：
 *   /health /probe           —— S2-4 既有（保留，作为基础设施探针）
 *   /api/v2/system|users|teams|activities —— S2-5 最小只读 API
 *   /api/v2/__test           —— TEST-ONLY（处理器内部 local 门禁，非 local 一律 404）
 */

import { Hono } from 'hono';
import type { Env, AppVars } from './env';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { authContextMiddleware } from './middleware/auth';
import { csrfGuardMiddleware } from './middleware/csrf';
import { tenantContextMiddleware } from './middleware/tenant-scope';
import health from './routes/health';
import probe from './routes/probe';
import system from './routes/system';
import users from './routes/users';
import teams from './routes/teams';
import activities from './routes/activities';
import participations from './routes/participations'; // S2-NEW-ARCH-P11：参与/排班分配
import forms from './routes/forms'; // S2-NEW-ARCH-P20：通用动态表单引擎
import attendanceSessions from './routes/attendance-sessions';
import attendanceAnomalies from './routes/attendance-anomalies';
import authRoutes from './routes/auth';
import testRoutes from './routes/__test';
import { ok } from './utils/response';

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

  // 全局错误兜底（必须在最前注册）。
  app.onError(errorHandler);

  // 中间件链。
  app.use('*', requestIdMiddleware);
  app.use('*', authContextMiddleware);
  app.use('*', tenantContextMiddleware);

  // S2-4 基础设施探针（保留契约）。
  app.route('/health', health);
  app.route('/probe', probe);

  // S2-6c-3：CSRF 守卫（Origin + 自定义头）。仅对 Cookie 认证的状态改变请求生效，
  // 安全方法与 Bearer 小程序请求零成本透传；生产未配置 allowlist 时 fail-closed。
  app.use('/api/v2/*', csrfGuardMiddleware);

  // /api/v2 —— 统一 API 版本前缀（用户 §六）。
  const v2 = new Hono<{ Bindings: Env; Variables: AppVars }>();
  v2.route('/system', system);
  v2.route('/users', users);
  v2.route('/teams', teams);
  v2.route('/activities', activities);
  v2.route('/activities', participations); // S2-NEW-ARCH-P11：参与/排班分配（/activities/:id/participations/*）
  v2.route('/attendance-sessions', attendanceSessions); // S2-6i：Review + Force Checkout（sessionId 资源键）
  v2.route('/attendance-anomalies', attendanceAnomalies); // S2-6j V1：Anomaly Handling（anomalyId 资源键，handling ONLY）
  v2.route('/forms', forms); // S2-NEW-ARCH-P20：动态表单引擎（/api/v2/forms/*）
  v2.route('/auth', authRoutes); // S2-6c-2：登录/登出/会话管理
  v2.route('/__test', testRoutes); // TEST-ONLY：处理器内部 local 门禁
  app.route('/api/v2', v2);

  app.get('/', (c) => ok(c, { name: 'jhzy-v2-worker', api: '/api/v2', health: '/health' }));

  return app;
}
