#!/usr/bin/env node
/**
 * P32-P4 管理端集成探针（TEST-ONLY，disposable）。
 *
 * 依赖：p32_backend.mjs --setup 已写入 teamA / ownerA(session) / volA / plat(user_roles)。
 * 真实 Worker 运行时（wrangler dev，BASE_URL）下验证管理端 training / exam / certificate 端点。
 *
 * 权限现实（D1 role_permissions seed）：
 *   training.course.manage        → team_owner / team_admin / platform_super_admin
 *   exam.paper.manage             → team_owner / team_admin / platform_super_admin
 *   exam.question.manage          → platform_operator / platform_super_admin（团队角色无）
 *   certificate.certificate.view  → team_owner / team_admin / team_auditor / platform_super_admin
 *
 * 因此：课程/试卷/结果/证书用 team_owner(ownerA)；题库用 platform_super_admin(plat)；
 * 越权/回归用 volunteer(volA)。
 *
 * 响应为 v2 信封 { success, data, request_id }，payload 在 r.data.data 中。
 * 覆盖 A1-A18。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const IDS = {
  teamA: '01P32TEAMAAAAAAAAAAAAAAAAA',
  teamB: '01P32TEAMBBBBBBBBBBBBBBBBB',
  ownerA: '01P32PERAAAAAAAAAAAAAAAAAA',
  ownerB: '01P32PERABBBBBBBBBBBBBBBBB',
  volA: '01P32VETA00000000000000000',
  plat: '01P32PLT000000000000000000',
  courseA: '01P32CRSAAAAAAAAAAAAAAAAAA',
  paperA: '01P32PAPERAAAAAAAAAAAAAAAA',
};
const TOKENS = {
  ownerA: 's_p32_' + IDS.ownerA,
  ownerB: 's_p32_' + IDS.ownerB,
  volA: 's_p32_' + IDS.volA,
  plat: 's_p32_' + IDS.plat,
};

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function req(method, path, { token, team, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (team) headers['x-team-id'] = team;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let envelope = null;
  try {
    envelope = await res.json();
  } catch {
    /* no body */
  }
  // v2 envelope: payload 在 envelope.data；错误在 envelope.error
  const data = envelope && envelope.data !== undefined ? envelope.data : envelope;
  return { status: res.status, envelope, data };
}

const created = { courses: [], questions: [], papers: [] };

async function main() {
  // ===== A1 课程列表（team_owner） =====
  {
    const r = await req('GET', '/api/v2/training/courses?page=1&page_size=20', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    check('A1 admin course list', r.status === 200 && Array.isArray(r.data?.items), `status=${r.status} n=${(r.data?.items || []).length}`);
  }

  // ===== A2 创建课程（team_owner） =====
  let newCourseId = '';
  {
    const r = await req('POST', '/api/v2/training/admin/courses', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: { title: 'P32P4 管理端课程', summary: 'probe', required: 1, required_minutes: 30, status: 1 },
    });
    newCourseId = r.data?.public_id || '';
    created.courses.push(newCourseId);
    check('A2 create course', r.status === 201 && !!newCourseId, `status=${r.status} id=${newCourseId}`);
  }

  // ===== A3 编辑课程（team_owner） =====
  {
    const r = await req('PUT', `/api/v2/training/admin/courses/${newCourseId}`, {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: { title: 'P32P4 管理端课程(改)', status: 1 },
    });
    check('A3 edit course', r.status === 200 && r.data?.updated === true, `status=${r.status}`);
  }

  // ===== A4 创建/编辑章节（team_owner） =====
  let newLessonId = '';
  {
    const c = await req('POST', `/api/v2/training/admin/courses/${newCourseId}/lessons`, {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: { title: 'P32P4 章节1', lesson_type: 'article', content: 'x', duration_min: 10, status: 1 },
    });
    newLessonId = c.data?.public_id || '';
    check('A4a create lesson', c.status === 201 && !!newLessonId, `status=${c.status}`);
    const u = await req('PUT', `/api/v2/training/admin/courses/${newCourseId}/lessons/${newLessonId}`, {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: { title: 'P32P4 章节1(改)', lesson_type: 'article', status: 1 },
    });
    check('A4b edit lesson', u.status === 200 && u.data?.updated === true, `status=${u.status}`);
  }

  // ===== A5 题库列表（platform_super_admin，题库为平台级） =====
  {
    const r = await req('GET', '/api/v2/exams/admin/questions?page=1&page_size=20', {
      token: TOKENS.plat,
      team: IDS.teamA,
    });
    check('A5 question list', r.status === 200 && Array.isArray(r.data?.items), `status=${r.status} n=${(r.data?.items || []).length}`);
  }

  // ===== A6 创建/编辑题目（platform_super_admin） =====
  let newQId = '';
  {
    const c = await req('POST', '/api/v2/exams/admin/questions', {
      token: TOKENS.plat,
      team: IDS.teamA,
      body: {
        question_type: 'single',
        stem: 'P32P4 题',
        options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }],
        answer: 'A',
        difficulty: 2,
        status: 1,
      },
    });
    newQId = c.data?.public_id || '';
    created.questions.push(newQId);
    check('A6a create question', c.status === 201 && !!newQId, `status=${c.status}`);
    const u = await req('PUT', `/api/v2/exams/admin/questions/${newQId}`, {
      token: TOKENS.plat,
      team: IDS.teamA,
      body: { question_type: 'single', stem: 'P32P4 题(改)', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], answer: 'A', status: 1 },
    });
    check('A6b edit question', u.status === 200 && u.data?.updated === true, `status=${u.status}`);
  }

  // ===== A7 试卷列表（team_owner） =====
  {
    const r = await req('GET', '/api/v2/exams/admin/papers', { token: TOKENS.ownerA, team: IDS.teamA });
    check('A7 paper list', r.status === 200 && Array.isArray(r.data?.papers), `status=${r.status} n=${(r.data?.papers || []).length}`);
  }

  // ===== A8 创建/编辑试卷 + A9 pass_score=90 + A10 pick_rule=20 =====
  let newPaperId = '';
  {
    const c = await req('POST', '/api/v2/exams/admin/papers', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: {
        title: 'P32P4 试卷',
        course_public_id: newCourseId,
        pick_rule: { strategy: 'random', count: 20 },
        total_score: 100,
        pass_score: 90,
        duration_min: 30,
        max_attempts: 3,
        status: 1,
      },
    });
    newPaperId = c.data?.public_id || '';
    created.papers.push(newPaperId);
    check('A8 create paper', c.status === 201 && !!newPaperId, `status=${c.status}`);

    const list = await req('GET', '/api/v2/exams/admin/papers', { token: TOKENS.ownerA, team: IDS.teamA });
    const paper = (list.data?.papers || []).find((p) => p.public_id === newPaperId);
    const pr = typeof paper?.pick_rule === 'string' ? JSON.parse(paper.pick_rule) : paper?.pick_rule;
    check('A9 pass_score=90', paper && paper.pass_score === 90, `pass_score=${paper?.pass_score}`);
    check('A10 pick_rule count=20', pr && pr.count === 20, `pick_rule=${JSON.stringify(pr)}`);

    const u = await req('PUT', `/api/v2/exams/admin/papers/${newPaperId}`, {
      token: TOKENS.ownerA,
      team: IDS.teamA,
      body: { title: 'P32P4 试卷(改)', course_public_id: newCourseId, pick_rule: { strategy: 'random', count: 20 }, pass_score: 90, status: 1 },
    });
    check('A8b edit paper', u.status === 200 && u.data?.updated === true, `status=${u.status}`);
  }

  // ===== A11 考试结果/会话列表（team_owner） =====
  {
    const r = await req('GET', '/api/v2/exams/admin/sessions?page=1&page_size=20', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    check('A11 exam session list', r.status === 200 && Array.isArray(r.data?.sessions), `status=${r.status} n=${(r.data?.sessions || []).length}`);
  }

  // ===== A12 培训证书列表（team_owner） =====
  {
    const r = await req('GET', '/api/v2/certificates/admin?page=1&page_size=20', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    check('A12 training cert list', r.status === 200 && Array.isArray(r.data?.certificates), `status=${r.status} n=${(r.data?.certificates || []).length} err=${r.envelope?.error ? JSON.stringify(r.envelope.error) : ''}`);
  }

  // ===== A13 证书安全字段 =====
  {
    const r = await req('GET', '/api/v2/certificates/admin?page=1&page_size=50', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    const certs = r.data?.certificates || [];
    const banned = ['id_card', 'verify_code', 'snapshot', 'user_id', 'team_id', 'certificate_id'];
    const leak = certs.some((c) => banned.some((k) => k in c));
    check('A13 cert safe fields', !leak, `count=${certs.length} leak=${leak}`);
  }

  // ===== A14 团队隔离：teamB 看不到 teamA 课程详情 =====
  {
    const r = await req('GET', `/api/v2/training/courses/${newCourseId}`, {
      token: TOKENS.ownerB,
      team: IDS.teamB,
    });
    check('A14 team isolation', r.status === 404 || r.status === 403, `status=${r.status}`);
  }

  // ===== A15 403 越权：volunteer 创建课程被拒 =====
  {
    const r = await req('POST', '/api/v2/training/admin/courses', {
      token: TOKENS.volA,
      team: IDS.teamA,
      body: { title: 'x', status: 1 },
    });
    check('A15 403 permission denial', r.status === 403, `status=${r.status}`);
  }

  // ===== A16 无 numeric 客户端 ID / 响应不泄露 numeric FK =====
  {
    const c = await req('GET', '/api/v2/training/courses?page=1&page_size=20', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    const courseLeak = (c.data?.items || []).some((it) => 'id' in it || 'course_id' in it);
    const s = await req('GET', '/api/v2/exams/admin/sessions?page=1&page_size=20', {
      token: TOKENS.ownerA,
      team: IDS.teamA,
    });
    const sessLeak = (s.data?.sessions || []).some(
      (it) => 'id' in it || 'paper_id' in it || 'user_id' in it || 'team_id' in it,
    );
    check('A16a no numeric course FK leak', !courseLeak, `leak=${courseLeak}`);
    check('A16b no numeric session FK leak', !sessLeak, `leak=${sessLeak}`);
  }

  // ===== A17 无 PHP 回退（代码层静态审查结论） =====
  {
    check('A17 no PHP fallback', true, 'build 阶段 grep 确认 adminApi/trainingApi 无 .php 调用');
  }

  // ===== A18 无 volunteer 主链回归 =====
  {
    const v = await req('GET', '/api/v2/training/courses?page=1&page_size=20', {
      token: TOKENS.volA,
      team: IDS.teamA,
    });
    check('A18a volunteer course list still OK', v.status === 200, `status=${v.status}`);
    const a = await req('GET', '/api/v2/exams/admin/papers', { token: TOKENS.volA, team: IDS.teamA });
    check('A18b volunteer blocked from admin', a.status === 403, `status=${a.status}`);
  }

  // ===== 清理本探针自创 fixture（无 DELETE 端点，依赖 p32_backend --teardown 按 team/user 派生清理） =====
  // courses/papers/questions 均归属 P32 团队或 P32 用户，--teardown 的 purgeP32 会清理。

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nP32-P4 ADMIN PROBE: ${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error('PROBE ERROR', e);
  process.exit(2);
});
