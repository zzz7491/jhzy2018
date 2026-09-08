/**
 * /api/v2/exams —�?考试端点（P32-P2）。
 *
 * Volunteer（exam.exam.take）：
 *   POST /exams/:paperPublicId/start                 — 开始考试（服务端抽 20 题、钉入、不可变 snapshot）
 *   GET  /exams/sessions/:sessionPublicId            — 会话详情（resume：同集 20 题）
 *   POST /exams/sessions/:sessionPublicId/submit     — 提交 + 服务端评分 +（条件）自动发证
 *   GET  /exams/sessions/:sessionPublicId/result     — 权威结果
 *
 * Admin（exam.question.manage / exam.paper.manage）：
 *   POST /exams/admin/questions
 *   PUT  /exams/admin/questions/:questionPublicId
 *   POST /exams/admin/papers
 *   PUT  /exams/admin/papers/:paperPublicId
 *   GET  /exams/admin/papers
 *   GET  /exams/admin/questions
 *
 * 全部 public_id（paper / session / question）寻址；submit body 仅 questionPublicId + selected。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ExamService } from '../services/exam-service';
import { ExamRepository, type ExamQuestionInput, type ExamPaperInput } from '../repository/exam';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired } from '../utils/errors';
import { requireUlidParam, parsePagination } from '../utils/validation';

const exams = new Hono<{ Bindings: Env; Variables: AppVars }>();

const buildService = (c: any) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new ExamService({ db: c.env.DB, auth, tenant: c.get('tenant'), env: c.env });
};

const buildRepo = (c: any) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new ExamRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
};

/** POST /exams/:paperPublicId/start */
exams.post('/:paperPublicId/start', requirePermission('exam.exam.take'), async (c) => {
  const svc = buildService(c);
  const paperPublicId = requireUlidParam(c.req.param('paperPublicId'), 'paperPublicId');
  const result = await svc.start(paperPublicId);
  return ok(c, result);
});

/** GET /exams/sessions/:sessionPublicId — 会话详情（resume 同集） */
exams.get('/sessions/:sessionPublicId', requirePermission('exam.exam.take'), async (c) => {
  const svc = buildService(c);
  const sessionPublicId = requireUlidParam(c.req.param('sessionPublicId'), 'sessionPublicId');
  const result = await svc.getSession(sessionPublicId);
  return ok(c, result);
});

/** POST /exams/sessions/:sessionPublicId/submit */
exams.post('/sessions/:sessionPublicId/submit', requirePermission('exam.exam.take'), async (c) => {
  const svc = buildService(c);
  const sessionPublicId = requireUlidParam(c.req.param('sessionPublicId'), 'sessionPublicId');
  let body: { answers?: unknown } = {};
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') body = json as { answers?: unknown };
  } catch {
    body = {};
  }
  const result = await svc.submit(sessionPublicId, body);
  return ok(c, result);
});

/** GET /exams/sessions/:sessionPublicId/result — 权威结果 */
exams.get('/sessions/:sessionPublicId/result', requirePermission('exam.exam.take'), async (c) => {
  const svc = buildService(c);
  const sessionPublicId = requireUlidParam(c.req.param('sessionPublicId'), 'sessionPublicId');
  const result = await svc.submit(sessionPublicId, {});
  return ok(c, result);
});

// ===== Admin =====

/** GET /exams/admin/papers — 本团队试卷列表 */
exams.get('/admin/papers', requirePermission('exam.paper.manage'), async (c) => {
  const repo = buildRepo(c);
  const teamId = repo['ctx'].tenant.teamId;
  if (teamId == null) throw requireTeamScopeError();
  const papers = await repo.listPapersByTeam(teamId);
  return ok(c, { papers });
});

/** POST /exams/admin/papers — 创建试卷 */
exams.post('/admin/papers', requirePermission('exam.paper.manage'), async (c) => {
  const repo = buildRepo(c);
  const teamId = repo['ctx'].tenant.teamId;
  if (teamId == null) throw requireTeamScopeError();
  const body = await c.req.json().catch(() => ({}));
  const result = await repo.adminCreatePaper(teamId, body as ExamPaperInput, Math.floor(Date.now() / 1000));
  return ok(c, result, 201);
});

/** PUT /exams/admin/papers/:paperPublicId — 更新试卷 */
exams.put('/admin/papers/:paperPublicId', requirePermission('exam.paper.manage'), async (c) => {
  const repo = buildRepo(c);
  const teamId = repo['ctx'].tenant.teamId;
  if (teamId == null) throw requireTeamScopeError();
  const paperPublicId = requireUlidParam(c.req.param('paperPublicId'), 'paperPublicId');
  const body = await c.req.json().catch(() => ({}));
  const updated = await repo.adminUpdatePaper(teamId, paperPublicId, body as ExamPaperInput, Math.floor(Date.now() / 1000));
  return ok(c, { updated });
});

/** GET /exams/admin/questions — 题库列表 */
exams.get('/admin/questions', requirePermission('exam.question.manage'), async (c) => {
  const repo = buildRepo(c);
  const pagination = parsePagination(c.req.query());
  const [items, total] = await Promise.all([
    repo.listQuestions(pagination.pageSize, pagination.pageSize),
    repo.countQuestions(),
  ]);
  return ok(c, {
    items,
    pagination: { page: pagination.page, page_size: pagination.pageSize, total },
  });
});

/** POST /exams/admin/questions — 创建题目 */
exams.post('/admin/questions', requirePermission('exam.question.manage'), async (c) => {
  const repo = buildRepo(c);
  const body = await c.req.json().catch(() => ({}));
  const createdBy = repo['ctx'].auth.userId;
  if (createdBy == null) throw authRequired();
  const result = await repo.adminCreateQuestion(body as ExamQuestionInput, createdBy, Math.floor(Date.now() / 1000));
  return ok(c, result, 201);
});

/** PUT /exams/admin/questions/:questionPublicId — 更新题目 */
exams.put('/admin/questions/:questionPublicId', requirePermission('exam.question.manage'), async (c) => {
  const repo = buildRepo(c);
  const questionPublicId = requireUlidParam(c.req.param('questionPublicId'), 'questionPublicId');
  const body = await c.req.json().catch(() => ({}));
  const updated = await repo.adminUpdateQuestion(questionPublicId, body as ExamQuestionInput, Math.floor(Date.now() / 1000));
  return ok(c, { updated });
});

/** GET /exams/admin/sessions —— 本团队考试结果/会话列表（exam.paper.manage）。 */
exams.get('/admin/sessions', requirePermission('exam.paper.manage'), async (c) => {
  const repo = buildRepo(c);
  const teamId = repo['ctx'].tenant.teamId;
  if (teamId == null) throw teamScopeRequired();
  const pagination = parsePagination(c.req.query());
  const [rows, total] = await Promise.all([
    repo.listSessionsByTeam(teamId, pagination.page, pagination.pageSize),
    repo.countSessionsByTeam(teamId),
  ]);
  return ok(c, {
    sessions: rows,
    pagination: { page: pagination.page, page_size: pagination.pageSize, total },
  });
});

function requireTeamScopeError(): Error {
  return teamScopeRequired();
}

export default exams;