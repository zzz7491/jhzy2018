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
import serviceRecords from './routes/service-records'; // S2-NEW-ARCH-P22：服务时长记录（read + 修正申请）；直接 adjust 已于 P35-C2 移除
import serviceRecordAdjustments from './routes/service-record-adjustments'; // P35-C2：服务时长修正「申请 → 双人审批」审批/拒绝端点
import points from './routes/points'; // P23-P4B：个人积分账户 / 流水 SELF 只读
import mall from './routes/mall'; // P24-P3B：积分商城（商品 / 兑换 / 本人订单）SELF+TEAM 只读 + 兑换
import training from './routes/training'; // P32-P2：学习培训（课程 / 章节 / 报名 / 进度 / admin CRUD）
import exams from './routes/exams'; // P32-P2：考试（start / resume / submit / grade / 自动发证 / admin CRUD）
import certificates from './routes/certificates'; // P32-P2：证书（mine / detail / verify / template admin）
import files from './routes/files'; // P33-P3A-2：文件基础设施（POST /files、GET /files/:filePublicId）
import content from './routes/content'; // P33-P3B-2C：社区志愿者/团队路由（/api/v2/content/*）
import ai from './routes/ai'; // P36-C3-2：嘉禾 AI V1（/api/v2/ai/*；4 个端点，ACTIVE_TEAM_REQUIRED）
import adminContent from './routes/admin-content'; // P33-P3B-2C：社区管理端路由（/api/v2/admin/content/*）
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
  v2.route('/service-records', serviceRecords); // S2-NEW-ARCH-P22：ServiceRecord 读 + 人工修正（public_id 资源键；/mine 字面量优先）
  v2.route('/service-record-adjustments', serviceRecordAdjustments); // P35-C2：服务时长修正「申请 → 双人审批」审批/拒绝端点
  v2.route('/points', points); // P23-P4B：个人积分账户 / 流水 SELF 只读（/account、/transactions）
  v2.route('/mall', mall); // P24-P3B：积分商城（/products、/orders）SELF+TEAM 只读 + 兑换
  v2.route('/forms', forms); // S2-NEW-ARCH-P20：动态表单引擎（/api/v2/forms/*）
  v2.route('/training', training); // P32-P2：/api/v2/training/*
  v2.route('/exams', exams); // P32-P2：/api/v2/exams/*
  v2.route('/certificates', certificates); // P32-P2：/api/v2/certificates/*
  v2.route('/files', files); // P33-P3A-2：/api/v2/files/*（Community V1 图片上传 / TEAM-scoped 读取）
  v2.route('/content', content); // P33-P3B-2C：/api/v2/content/*（社区文章/评论/点赞/举报 SELF+TEAM）
  v2.route('/ai', ai); // P36-C3-2：/api/v2/ai/*（conversation 4 端点；AI_CAN_MUTATE_BUSINESS_STATE = NO）
  v2.route('/admin/content', adminContent); // P33-P3B-2C：/api/v2/admin/content/*（社区审核/下架/删除）
  v2.route('/auth', authRoutes); // S2-6c-2：登录/登出/会话管理
  v2.route('/__test', testRoutes); // TEST-ONLY：处理器内部 local 门禁
  app.route('/api/v2', v2);

  app.get('/', (c) => ok(c, { name: 'jhzy-v2-worker', api: '/api/v2', health: '/health' }));

  return app;
}
