#!/usr/bin/env node
/**
 * P32-P3A 导航契约探针（TEST-ONLY，disposable）。
 *
 * 验证志愿者考试入口的「后端发现 paperPublicId」闭环（取代本地 storage key）：
 *   F19  课程详情 / 列表 返回正确的 paperPublicId
 *   F20  无可用 paper 的课程 → exam === null（安全 unavailable，非 500）
 *   F21  合格课程 → 无需任何预置 storage key 即可 start 考试
 *   F22  start 返回 20 道固定题目
 *   F23  resume 复用同一 session
 *   F24  响应中不暴露任何 numeric paper/question/session id；只有 public_id(ULID)
 *
 * 直接对本地 miniflare D1 sqlite 写隔离 fixture（与 harness 同发现逻辑），不 mock 任何层。
 * 用法：先 `node tests/p32_backend.mjs --setup` 再 `node tests/p32_p3a_probe.mjs`。
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const IDS = {
  teamA: '01P32TEAMAAAAAAAAAAAAAAAAA',
  ownerA: '01P32PERAAAAAAAAAAAAAAAAAA',
  volA: '01P32VETA00000000000000000',
  courseA: '01P32CRSAAAAAAAAAAAAAAAAAA',
  lessonA1: '01P32TSN1AAAAAAAAAAAAAAAAA',
  lessonA2: '01P32TSN2AAAAAAAAAAAAAAAAA',
  paperA: '01P32PAPERAAAAAAAAAAAAAAAA',
  nullCourse: '01P32P3AN00000000000000000', // 隔离 fixture：无 paper 的课程（26-char Crockford ULID，排除 I/L/O/U）
};
const TOKEN = (pub) => 's_p32_' + pub;
const T_A = IDS.teamA;
const VOLA = TOKEN(IDS.volA);
const OA = TOKEN(IDS.ownerA);

function dbFile() {
  return join(
    D1_DIR,
    readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0],
  );
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    return fn(db);
  } finally {
    db.close();
  }
}
function ulidRe(s) {
  return typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}  -- ${detail}`);
  }
}

async function req(method, path, { token, team, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (team) headers['X-Team-Id'] = team;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, body: data };
}

function noNumericKeys(obj, forbidden) {
  // 递归检查：任何对象/数组不得出现 forbidden 中的 numeric 外键键名
  if (obj === null || obj === undefined) return true;
  if (Array.isArray(obj)) return obj.every((x) => noNumericKeys(x, forbidden));
  if (typeof obj !== 'object') return true;
  for (const k of Object.keys(obj)) {
    if (forbidden.includes(k)) return false;
    if (!noNumericKeys(obj[k], forbidden)) return false;
  }
  return true;
}

async function main() {
  console.log('=== P32-P3A 导航契约探针 (F19-F24) ===');

  // 隔离 fixture：建一个「无 paper」的课程（01P32 前缀，可被 teardown 清理）
  withDb((db) => {
    const teamId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
    db.prepare(
      `INSERT OR IGNORE INTO courses (public_id, team_id, title, summary, required, required_minutes, status, created_at)
       VALUES (?, ?, 'P3A-无试卷课程', 'fixture', 1, 30, 1, 1756500000)`,
    ).run(IDS.nullCourse, teamId);
  });

  // ---- F19: 课程详情返回正确 paperPublicId ----
  const d = await req('GET', `/api/v2/training/courses/${IDS.courseA}`, { token: VOLA, team: T_A });
  check('F19 course detail 200', d.status === 200, `status=${d.status}`);
  const examDetail = d.body?.data?.course?.exam;
  check('F19 detail returns paper_public_id === paperA', examDetail?.paper_public_id === IDS.paperA, JSON.stringify(examDetail));
  check('F19 detail paper_public_id is ULID', ulidRe(examDetail?.paper_public_id), examDetail?.paper_public_id);

  // ---- F19b: 课程列表也返回 paperPublicId ----
  const l = await req('GET', `/api/v2/training/courses?page=1&page_size=50`, { token: VOLA, team: T_A });
  check('F19b list 200', l.status === 200, `status=${l.status}`);
  const courseAItem = (l.body?.data?.items || []).find((c) => c.public_id === IDS.courseA);
  check('F19b list item has exam.paper_public_id === paperA', courseAItem?.exam?.paper_public_id === IDS.paperA, JSON.stringify(courseAItem?.exam));

  // ---- F20: 无可用 paper 的课程 → exam === null（安全 unavailable）----
  const nd = await req('GET', `/api/v2/training/courses/${IDS.nullCourse}`, { token: VOLA, team: T_A });
  check('F20 paperless course detail 200 (not 500)', nd.status === 200, `status=${nd.status}`);
  check('F20 paperless course exam === null', nd.body?.data?.course?.exam === null || nd.body?.data?.course?.exam === undefined, JSON.stringify(nd.body?.data?.course?.exam));

  // 报名并完成 courseA 两章 → 使 eligible 变为 true
  const enr = await req('POST', `/api/v2/training/courses/${IDS.courseA}/enroll`, { token: VOLA, team: T_A, body: {} });
  check('enroll courseA (201/200)', enr.status === 201 || enr.status === 200, `status=${enr.status}`);
  const p1 = await req('POST', `/api/v2/training/courses/${IDS.courseA}/lessons/${IDS.lessonA1}/progress`, {
    token: VOLA,
    team: T_A,
    body: { learned_seconds: 600, completed: true },
  });
  check('lesson1 progress completed', p1.status === 200 && p1.body?.data?.lesson?.completed === true, `status=${p1.status}`);
  const p2 = await req('POST', `/api/v2/training/courses/${IDS.courseA}/lessons/${IDS.lessonA2}/progress`, {
    token: VOLA,
    team: T_A,
    body: { learned_seconds: 1200, completed: true },
  });
  check('lesson2 progress completed → course 100', p2.status === 200 && p2.body?.data?.course?.completed === true, `status=${p2.status}`);

  // ---- F19c: 完成后 eligible 权威为 true ----
  const d2 = await req('GET', `/api/v2/training/courses/${IDS.courseA}`, { token: VOLA, team: T_A });
  const examEligible = d2.body?.data?.course?.exam;
  check('F19c eligible === true after completion', examEligible?.eligible === true, JSON.stringify(examEligible));

  // ---- F21: 不依赖任何 storage key，直接 start（paper 来自后端）----
  const start = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VOLA, team: T_A, body: {} });
  check('F21 start 200 (no storage key needed)', start.status === 200, `status=${start.status} ${JSON.stringify(start.body)}`);
  const attempt = start.body?.data?.attempt;
  check('F21 attempt present', !!attempt, JSON.stringify(start.body));
  const sessionPublicId = attempt?.session_public_id;
  check('F21 session_public_id is ULID', ulidRe(sessionPublicId), sessionPublicId);

  // ---- F22: 20 道固定题目 ----
  check('F22 start returns 20 questions', Array.isArray(attempt?.questions) && attempt.questions.length === 20, `len=${attempt?.questions?.length}`);

  // ---- F24: 不暴露 numeric id；只有 public_id；无答案泄露 ----
  const forbidden = ['id', 'paper_id', 'question_id', 'session_id', 'course_id', 'user_id', 'team_id', 'answer', 'is_correct', 'correct'];
  check('F24 attempt has no numeric foreign keys', noNumericKeys(attempt, forbidden), JSON.stringify(attempt).slice(0, 200));
  check(
    'F24 every question exposes question_public_id (ULID) and no answer',
    attempt?.questions?.every((q) => ulidRe(q.question_public_id) && !('answer' in q) && !('is_correct' in q)),
    '',
  );
  check('F24 paperPublicId in URL is ULID', ulidRe(IDS.paperA), IDS.paperA);

  // ---- F23: resume 复用同一 session ----
  const resume = await req('GET', `/api/v2/exams/sessions/${sessionPublicId}`, { token: VOLA, team: T_A });
  check('F23 resume 200', resume.status === 200, `status=${resume.status}`);
  const rAttempt = resume.body?.data?.attempt;
  check('F23 same session_public_id', rAttempt?.session_public_id === sessionPublicId, `${rAttempt?.session_public_id} vs ${sessionPublicId}`);
  check('F23 same 20 questions', Array.isArray(rAttempt?.questions) && rAttempt.questions.length === 20, `len=${rAttempt?.questions?.length}`);
  check('F23 no numeric ids in resume', noNumericKeys(rAttempt, forbidden), '');

  // 清理隔离 fixture（含上一轮因非法 ULID 误插入的 orphan 行）
  withDb((db) => {
    db.prepare('DELETE FROM courses WHERE public_id = ?').run(IDS.nullCourse);
    db.prepare("DELETE FROM courses WHERE public_id = '01P32P3ANULLCOURSE00000'").run();
  });

  console.log(`\n=== P32-P3A 探针结果: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('探针崩溃:', e);
  process.exit(1);
});
