/**
 * /api/v2/training —�?学习培训端点（P32-P2）。
 *
 * Volunteer：
 *   GET  /courses                              — 本团队课程列表（分页）
 *   GET  /courses/:coursePublicId              — 课程详情（含 lessons）
 *   GET  /courses/:coursePublicId/lessons/:lessonPublicId — 章节详情
 *   POST /courses/:coursePublicId/enroll       — 报名学习（training.enrollment.enroll）
 *   POST /courses/:coursePublicId/lessons/:lessonPublicId/progress — 进度上报（training.learning.learn）
 *   GET  /my-progress                          — 我的学习进度（USER）
 *
 * Admin（training.course.manage）：
 *   POST   /admin/courses
 *   PUT    /admin/courses/:coursePublicId
 *   POST   /admin/courses/:coursePublicId/lessons
 *   PUT    /admin/courses/:coursePublicId/lessons/:lessonPublicId
 *
 * 全部 public_id 寻址；不暴露 numeric DB id。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { TrainingService } from '../services/training-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';
import { requireUlidParam, parsePagination } from '../utils/validation';

const training = new Hono<{ Bindings: Env; Variables: AppVars }>();

const buildService = (c: any) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new TrainingService({ db: c.env.DB, auth, tenant: c.get('tenant') });
};

/** GET /training/courses — 本团队课程列表 */
training.get('/courses', async (c) => {
  const svc = buildService(c);
  const pagination = parsePagination(c.req.query());
  const result = await svc.listCourses(pagination.page, pagination.pageSize);
  return ok(c, result);
});

/** GET /training/my-progress — 我的学习进度（USER 归属） */
training.get('/my-progress', async (c) => {
  const svc = buildService(c);
  const result = await svc.myProgress();
  return ok(c, result);
});

/** GET /training/courses/:coursePublicId — 课程详情 */
training.get('/courses/:coursePublicId', async (c) => {
  const svc = buildService(c);
  const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
  const result = await svc.getCourse(coursePublicId);
  return ok(c, result);
});

/** GET /training/courses/:coursePublicId/lessons/:lessonPublicId — 章节详情 */
training.get('/courses/:coursePublicId/lessons/:lessonPublicId', async (c) => {
  const svc = buildService(c);
  const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
  const lessonPublicId = requireUlidParam(c.req.param('lessonPublicId'), 'lessonPublicId');
  const result = await svc.getLesson(coursePublicId, lessonPublicId);
  return ok(c, result);
});

/** POST /training/courses/:coursePublicId/enroll — 报名学习 */
training.post('/courses/:coursePublicId/enroll', requirePermission('training.enrollment.enroll'), async (c) => {
  const svc = buildService(c);
  const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
  const result = await svc.enroll(coursePublicId);
  return ok(c, result, result.created ? 201 : 200);
});

/** POST /training/courses/:coursePublicId/lessons/:lessonPublicId/progress — 进度上报 */
training.post(
  '/courses/:coursePublicId/lessons/:lessonPublicId/progress',
  requirePermission('training.learning.learn'),
  async (c) => {
    const svc = buildService(c);
    const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
    const lessonPublicId = requireUlidParam(c.req.param('lessonPublicId'), 'lessonPublicId');
    let body: { learned_seconds?: unknown; completed?: unknown } = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object') body = json as { learned_seconds?: unknown; completed?: unknown };
    } catch {
      body = {};
    }
    const result = await svc.reportProgress(coursePublicId, lessonPublicId, body);
    return ok(c, result);
  },
);

// ===== Admin =====

/** POST /training/admin/courses — 创建课程 */
training.post('/admin/courses', requirePermission('training.course.manage'), async (c) => {
  const svc = buildService(c);
  const body = await c.req.json().catch(() => ({}));
  const result = await svc.adminCreateCourse(body as any);
  return ok(c, result, 201);
});

/** PUT /training/admin/courses/:coursePublicId — 更新课程 */
training.put('/admin/courses/:coursePublicId', requirePermission('training.course.manage'), async (c) => {
  const svc = buildService(c);
  const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
  const body = await c.req.json().catch(() => ({}));
  await svc.adminUpdateCourse(coursePublicId, body as any);
  return ok(c, { updated: true });
});

/** POST /training/admin/courses/:coursePublicId/lessons — 创建章节 */
training.post('/admin/courses/:coursePublicId/lessons', requirePermission('training.course.manage'), async (c) => {
  const svc = buildService(c);
  const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
  const body = await c.req.json().catch(() => ({}));
  const result = await svc.adminCreateLesson(coursePublicId, body as any);
  return ok(c, result, 201);
});

/** PUT /training/admin/courses/:coursePublicId/lessons/:lessonPublicId — 更新章节 */
training.put(
  '/admin/courses/:coursePublicId/lessons/:lessonPublicId',
  requirePermission('training.course.manage'),
  async (c) => {
    const svc = buildService(c);
    const coursePublicId = requireUlidParam(c.req.param('coursePublicId'), 'coursePublicId');
    const lessonPublicId = requireUlidParam(c.req.param('lessonPublicId'), 'lessonPublicId');
    const body = await c.req.json().catch(() => ({}));
    await svc.adminUpdateLesson(coursePublicId, lessonPublicId, body as any);
    return ok(c, { updated: true });
  },
);

export default training;