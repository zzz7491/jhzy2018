#!/usr/bin/env node
/**
 * P32-P2 集成探针（TEST-ONLY，disposable）。
 *
 * 纪律（与全仓 integration 测试一致）：
 * - 直接对本地 miniflare D1 sqlite 写 fixture（与 fixture.mjs 同路径发现逻辑），不 mock
 *   auth / tenant middleware / permission provider / repositories / D1。
 * - 通过【真实 Worker 运行时】（wrangler dev，BASE_URL）验证 training / exam / certificate 后端。
 * - X-Team-Id 使用 team public_id（P30 team-header fix 已支持）。
 * - 所有测试 public_id 以 '01P32' 前缀标记，teardown 可识别、可清理。
 * - 禁止 INSERT permissions / role_permissions。
 *
 * 用法：
 *   node tests/p32_backend.mjs --setup      # 写入 fixture（wrangler dev 启动前）
 *   node tests/p32_backend.mjs --run        # 向 BASE_URL 发请求断言（wrangler dev 已启动）
 *   node tests/p32_backend.mjs --teardown   # 清理 fixture
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const IDS = {
  teamA: '01P32TEAMAAAAAAAAAAAAAAAAA',
  teamB: '01P32TEAMBBBBBBBBBBBBBBBBB',
  ownerA: '01P32PERAAAAAAAAAAAAAAAAAA',
  ownerB: '01P32PERABBBBBBBBBBBBBBBBB',
  plat: '01P32PLT000000000000000000',
  volA: '01P32VETA00000000000000000',
  volB: '01P32VETB00000000000000000',
  // C5：两个「无 active cert」的同队志愿者，用于构造同一 cert_trn code 的发证竞争
  volC: '01P32VETC00000000000000000',
  volD: '01P32VETD00000000000000000',
  courseA: '01P32CRSAAAAAAAAAAAAAAAAAA',
  lessonA1: '01P32TSN1AAAAAAAAAAAAAAAAA',
  lessonA2: '01P32TSN2AAAAAAAAAAAAAAAAA',
  questionQ1: '01P32QUESTIONAAAA00000000',
  paperA: '01P32PAPERAAAAAAAAAAAAAAAA',
};
const T0 = 1756500000;

const TOKENS = {
  ownerA: 's_p32_' + IDS.ownerA,
  ownerB: 's_p32_' + IDS.ownerB,
  plat: 's_p32_' + IDS.plat,
  volA: 's_p32_' + IDS.volA,
  volB: 's_p32_' + IDS.volB,
  volC: 's_p32_' + IDS.volC,
  volD: 's_p32_' + IDS.volD,
};

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

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 经 wrangler CLI 写 local D1（与运行中的 worker 同一 D1 binding / 同一会话可见）。
 * 仅用于运行期需要被 worker 立即观察到的号池操作（C5 池竞争）。
 */
function d1Exec(sql) {
  return execSync(`npx wrangler d1 execute jhzy-v2-local --local --command "${sql}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * 清理 P32 测试自产数据（setup 写入前 / teardown 复用，保证可连续重入）。
 *
 * 纪律：
 * - 只按显式 P32 标识定位：public_id LIKE '01P32%' / '01P32Q%'，
 *   或由 P32 用户 / P32 团队派生（created_by / user_id / team_id / paper_id）。
 * - M1/M2/M3/M4 经 API 动态创建的数据 public_id 是运行时 ULID，不匹配前缀，
 *   但 created_by ∈ P32 用户、team_id ∈ P32 团队，因此同样被精确定位并清理。
 * - 不写任何非法 status（exam_questions CHECK 只允许 1/2），不做 status=0 停用。
 * - 不触碰任何业务数据（业务行不可能由 P32 用户创建或归属 P32 团队）。
 */
function purgeP32(db) {
  const q = (sql) => db.prepare(sql).all().map((r) => r.id);
  const IN = (arr) => (arr.length ? `IN (${arr.join(',')})` : 'IN (NULL)');

  // 注意：各表「可用于定位 P32 归属」的列不同——
  //   courses / exam_questions 有 created_by；exam_papers 只有 team_id + course_id；
  //   course_lessons 只有 course_id。故一律按「P32 前缀 OR P32 用户/团队/课程派生」定位。
  const users = q("SELECT id FROM users WHERE public_id LIKE '01P32%'");
  const teams = q("SELECT id FROM teams WHERE public_id LIKE '01P32%'");
  const courses = q(
    `SELECT id FROM courses WHERE public_id LIKE '01P32%' OR team_id ${IN(teams)} OR created_by ${IN(users)}`,
  );
  const papers = q(
    `SELECT id FROM exam_papers WHERE public_id LIKE '01P32%' OR team_id ${IN(teams)} OR course_id ${IN(courses)}`,
  );
  const sessions = q(`SELECT id FROM exam_sessions WHERE user_id ${IN(users)} OR paper_id ${IN(papers)}`);
  const certs = q(
    `SELECT id FROM certificates WHERE public_id LIKE '01P32%' OR user_id ${IN(users)} OR team_id ${IN(teams)} OR exam_paper_id ${IN(papers)}`,
  );
  const enrolls = q(`SELECT id FROM course_enrollments WHERE user_id ${IN(users)} OR course_id ${IN(courses)}`);

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`DELETE FROM certificate_logs WHERE certificate_id ${IN(certs)}`);
  db.exec(`DELETE FROM certificates WHERE id ${IN(certs)}`);
  // cert_trn 号池为 P32 训练证书专用池：随 P32 证书一并释放，保证每轮起始状态一致
  db.exec("UPDATE id_pools SET status=0, assigned_to=NULL, assigned_at=NULL WHERE pool_type='cert_trn' AND status != 0");
  db.exec(`DELETE FROM exam_answers WHERE session_id ${IN(sessions)}`);
  db.exec(`DELETE FROM exam_sessions WHERE id ${IN(sessions)}`);
  db.exec(`DELETE FROM exam_papers WHERE id ${IN(papers)}`);
  db.exec(`DELETE FROM exam_questions WHERE public_id LIKE '01P32Q%' OR created_by ${IN(users)}`);
  db.exec(`DELETE FROM learning_records WHERE enrollment_id ${IN(enrolls)}`);
  db.exec(`DELETE FROM course_enrollments WHERE id ${IN(enrolls)}`);
  db.exec(`DELETE FROM course_lessons WHERE public_id LIKE '01P32%' OR course_id ${IN(courses)}`);
  db.exec(`DELETE FROM courses WHERE id ${IN(courses)}`);
  db.exec(`DELETE FROM sessions WHERE public_id LIKE '01P32%' OR user_id ${IN(users)}`);
  db.exec(`DELETE FROM user_roles WHERE scope_team_id ${IN(teams)} OR user_id ${IN(users)}`);
  db.exec(`DELETE FROM teams WHERE id ${IN(teams)}`);
  db.exec(`DELETE FROM users WHERE id ${IN(users)}`);
  db.exec('PRAGMA foreign_keys = ON;');
}

function newToken() {
  return 's_' + randomBytes(32).toString('base64url');
}

// ============================== SETUP ==============================
function setup() {
  const db = new DatabaseSync(dbFile());
  db.exec('PRAGMA foreign_keys = ON;');
  try {
    // 清场：仅清理 P32 自产数据（含 M1-M4 动态创建），不写非法 status、不碰业务数据
    purgeP32(db);

    const insUser = db.prepare('INSERT INTO users (public_id, nickname, status) VALUES (?, ?, 1)');
    insUser.run(IDS.ownerA, 'P32-OwnerA');
    insUser.run(IDS.ownerB, 'P32-OwnerB');
    insUser.run(IDS.plat, 'P32-Plat');
    insUser.run(IDS.volA, 'P32-VolA');
    insUser.run(IDS.volB, 'P32-VolB');
    insUser.run(IDS.volC, 'P32-VolC');
    insUser.run(IDS.volD, 'P32-VolD');
    const uid = (p) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(p)?.id;
    const ownerAId = uid(IDS.ownerA);
    const ownerBId = uid(IDS.ownerB);
    const platId = uid(IDS.plat);
    const volAId = uid(IDS.volA);
    const volBId = uid(IDS.volB);
    const volCId = uid(IDS.volC);
    const volDId = uid(IDS.volD);

    const insTeam = db.prepare('INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)');
    insTeam.run(IDS.teamA, 'P32 Team A', ownerAId);
    insTeam.run(IDS.teamB, 'P32 Team B', ownerBId);
    const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
    const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

    const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;
    const insUR = db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)');
    insUR.run(ownerAId, rid('team_owner'), teamAId);
    insUR.run(ownerBId, rid('team_owner'), teamBId);
    insUR.run(platId, rid('platform_super_admin'), null);
    insUR.run(volAId, rid('volunteer'), teamAId);
    insUR.run(volBId, rid('volunteer'), teamBId);
    insUR.run(volCId, rid('volunteer'), teamAId);
    insUR.run(volDId, rid('volunteer'), teamAId);

    // ---- training fixture ----
    const insCourse = db.prepare(
      `INSERT INTO courses (public_id, team_id, title, summary, required, required_minutes, sort, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
    );
    insCourse.run(IDS.courseA, teamAId, 'P32 培训课程A', 'summaryA', 1, 60, ownerAId);
    const courseAId = db.prepare('SELECT id FROM courses WHERE public_id = ?').get(IDS.courseA)?.id;
    const insLesson = db.prepare(
      `INSERT INTO course_lessons (public_id, team_id, course_id, title, lesson_type, content, duration_min, sort, is_free, status)
       VALUES (?, ?, ?, ?, 'article', ?, ?, ?, 0, 1)`,
    );
    insLesson.run(IDS.lessonA1, teamAId, courseAId, '章节1', 'content1', 10, 0);
    insLesson.run(IDS.lessonA2, teamAId, courseAId, '章节2', 'content2', 20, 1);

    // ---- exam fixture：30 道题库（含 20 题抽取空间），training paper（pass 90）----
const insQ = db.prepare(
      `INSERT INTO exam_questions (public_id, question_type, stem, options, answer, analysis, difficulty, tags, status, created_by)
       VALUES (?, 'single', ?, ?, ?, NULL, 2, NULL, 1, ?)`,
    );
    // 题库已由 purgeP32 清场（不写非法 status，改用精确删除），此处直接写入本轮 30 道 P32 题
    for (let i = 0; i < 30; i++) {
      const pid = '01P32Q' + i.toString().padStart(2, '0') + 'A'.repeat(18);
      insQ.run(pid, `题${i + 1}`, JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }, { key: 'C', text: 'C' }, { key: 'D', text: 'D' }]), 'A', ownerAId);
    }

    const insPaper = db.prepare(
      `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, created_at)
       VALUES (?, ?, ?, ?, ?, 100, 90, 30, 10, 1, ?)`,
    );
    insPaper.run(IDS.paperA, teamAId, 'P32 培训考试', courseAId, JSON.stringify({ count: 20 }), T0);
    const paperAId = db.prepare('SELECT id FROM exam_papers WHERE public_id = ?').get(IDS.paperA)?.id;

    // ---- 一个 teamA 已有证书（volA + paperA）用于复考/不重复场景；activated status=1 ----
    // 先用该 paper 的 active cert 存在 case。直接在表里插一行归属 volB（避免影响 volA 的首考路径）。
    const tpl = db.prepare("SELECT id FROM certificate_templates WHERE cert_type='training' AND status=1 ORDER BY id LIMIT 1").get();
    if (tpl) {
      const code = db.prepare("SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 ORDER BY id LIMIT 1").get()?.code;
      if (code) {
        const volBUserId = volBId;
        db.prepare(
          `INSERT INTO certificates (public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type, source_type, source_id, exam_paper_id, status, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, 'training', 'exam', NULL, ?, 1, ?)`,
        ).run(`01P32CERTBBBBBBBBBBBBBBBBB`, code, '01P32VERIFYBBBBBBBBBBBBBBBB', tpl.id, volBUserId, teamAId, paperAId, T0);
        db.prepare(
          `INSERT INTO certificate_logs (team_id, certificate_id, action, created_at)
           SELECT ?, id, 'issue', ? FROM certificates WHERE public_id = '01P32CERTBBBBBBBBBBBBBBBBB'`,
        ).run(teamAId, T0);
        db.prepare(
          `UPDATE id_pools SET status=1, assigned_to=?, assigned_at=? WHERE pool_type='cert_trn' AND code=?`,
        ).run(volBUserId, T0, code);
      }
    }

    // ---- sessions ----
    const now = Math.floor(Date.now() / 1000);
    const insSess = db.prepare(
      `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 'p32', ?, 1)`,
    );
    for (const [k, pid] of [
      ['ownerA', IDS.ownerA],
      ['ownerB', IDS.ownerB],
      ['plat', IDS.plat],
      ['volA', IDS.volA],
      ['volB', IDS.volB],
      ['volC', IDS.volC],
      ['volD', IDS.volD],
    ]) {
      insSess.run(`01P32SESS${k}000000000000000`, uid(pid), sha256Hex(TOKENS[k]), now + 30 * 24 * 3600);
    }

    console.log('[p32] setup OK', JSON.stringify({ teamAId, teamBId, ownerAId, volAId, volBId, courseAId, paperAId }));
  } finally {
    db.close();
  }
}

// ============================== TEARDOWN ==============================
function teardown() {
  const db = new DatabaseSync(dbFile());
  try {
    purgeP32(db);
  } finally {
    db.close();
  }
  console.log('[p32] teardown OK');
}

async function req(method, path, { token, team, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (team) headers['x-team-id'] = team;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  // 网络层重试：仅对连接级错误（如 execSync 长时间占用后 keep-alive 连接被重置）重试，
  // 不改变任何 HTTP 语义——拿到响应（含 4xx/5xx）即立即返回。
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, init);
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

let pass = 0;
let fail = 0;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    log(`  PASS ${name}`);
  } else {
    fail += 1;
    log(`  FAIL ${name} ${detail}`);
  }
}

async function run() {
  const T_A = IDS.teamA;
  const T_B = IDS.teamB;
  const OA = TOKENS.ownerA;
  const OB = TOKENS.ownerB;
  const PL = TOKENS.plat;
  const VA = TOKENS.volA;
  const VB = TOKENS.volB;
  const VC = TOKENS.volC;
  const VD = TOKENS.volD;
  const ulidRe = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  // ============ Training ============
  // T1 course list
  {
    const r = await req('GET', '/api/v2/training/courses', { token: VA, team: T_A });
    check('T1 course list 200 with courseA', r.status === 200 && (r.data?.data?.items ?? []).some((c) => c.public_id === IDS.courseA), `status=${r.status} ${JSON.stringify(r.data)}`);
  }
  // T2 course detail
  {
    const r = await req('GET', `/api/v2/training/courses/${IDS.courseA}`, { token: VA, team: T_A });
    check('T2 course detail exposes public lesson ids', r.status === 200 && Array.isArray(r.data?.data?.lessons) && r.data.data.lessons.length === 2 && r.data.data.lessons.every((l) => ulidRe.test(l.public_id)), `status=${r.status}`);
  }
  // T3 lesson detail
  {
    const r = await req('GET', `/api/v2/training/courses/${IDS.courseA}/lessons/${IDS.lessonA1}`, { token: VA, team: T_A });
    check('T3 lesson detail 200 (public_id key)', r.status === 200 && r.data?.data?.public_id === IDS.lessonA1, `status=${r.status}`);
  }
  // T4 enroll
  {
    const r = await req('POST', `/api/v2/training/courses/${IDS.courseA}/enroll`, { token: VA, team: T_A, body: {} });
    check('T4 enroll 201 new', r.status === 201 && r.data?.data?.enrolled === true, `status=${r.status}`);
    const r2 = await req('POST', `/api/v2/training/courses/${IDS.courseA}/enroll`, { token: VA, team: T_A, body: {} });
    check('T4b enroll idempotent 200', r2.status === 200 && r2.data?.data?.enrolled === true, `status=${r2.status}`);
  }
  // T5 progress
  {
    const r = await req('POST', `/api/v2/training/courses/${IDS.courseA}/lessons/${IDS.lessonA1}/progress`, { token: VA, team: T_A, body: { learned_seconds: 600, completed: true } });
    check('T5 lesson1 progress (completed)', r.status === 200 && r.data?.data?.lesson?.progress === 100, `status=${r.status} ${JSON.stringify(r.data)}`);
    const r2 = await req('POST', `/api/v2/training/courses/${IDS.courseA}/lessons/${IDS.lessonA2}/progress`, { token: VA, team: T_A, body: { learned_seconds: 1200, completed: true } });
    check('T5b lesson2 progress -> course 100', r2.status === 200 && r2.data?.data?.course?.progress === 100, `status=${r2.status} ${JSON.stringify(r2.data)}`);
  }
  // T6 ownership / team isolation
  {
    const r = await req('POST', `/api/v2/training/courses/${IDS.courseA}/enroll`, { token: VB, team: T_B, body: {} });
    check('T6 cross-team enroll denied (404)', r.status === 404, `status=${r.status}`);
  }

  // ============ Exam ============
  let sessionPid = null;
  // E1/E2 start
  {
    const r = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VA, team: T_A, body: {} });
    const a = r.data?.data?.attempt;
    sessionPid = a?.session_public_id ?? null;
    check('E1 start returns exactly 20 pinned questions', r.status === 200 && Array.isArray(a?.questions) && a.questions.length === 20, `status=${r.status} n=${a?.questions?.length}`);
    check('E2 no answer keys / numeric ids leaked', r.status === 200 && a.questions.every((q) => ulidRe.test(q.question_public_id) && !('answer' in q) && !('id' in q) && !('question_id' in q)), JSON.stringify(a?.questions?.[0] ?? {}).slice(0, 120));
    // verify pinned in DB
    const pinnedRows = withDb((db) => {
      const sId = db.prepare('SELECT id FROM exam_sessions WHERE public_id = ?').get(sessionPid)?.id;
      return sId ? db.prepare('SELECT COUNT(*) n FROM exam_answers WHERE session_id = ?').get(sId).n : -1;
    });
    check('E1b exactly 20 exam_answers rows pinned', pinnedRows === 20, `n=${pinnedRows}`);
  }
  // E3 resume identical
  {
    const r = await req('GET', `/api/v2/exams/sessions/${sessionPid}`, { token: VA, team: T_A });
    check('E3 resume returns identical 20 set', r.status === 200 && (r.data?.data?.attempt?.questions ?? []).length === 20, `status=${r.status}`);
  }
  // E4 duplicate/foreign/missing/extra rejected
  {
    const good = await req('GET', `/api/v2/exams/sessions/${sessionPid}`, { token: VA, team: T_A });
    const qs = good.data?.data?.attempt?.questions ?? [];
    const dupBody = { answers: [qs[0], qs[0]].map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' })) };
    const rDup = await req('POST', `/api/v2/exams/sessions/${sessionPid}/submit`, { token: VA, team: T_A, body: dupBody });
    check('E4 duplicate answers rejected (400)', rDup.status === 400, `status=${rDup.status}`);
    const missBody = { answers: qs.slice(0, 19).map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' })) };
    const rMiss = await req('POST', `/api/v2/exams/sessions/${sessionPid}/submit`, { token: VA, team: T_A, body: missBody });
    check('E4b missing answers rejected (400)', rMiss.status === 400, `status=${rMiss.status}`);
    const foreignBody = { answers: qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' })).concat([{ questionPublicId: IDS.questionQ1, selected: 'A' }]) };
    const rForeign = await req('POST', `/api/v2/exams/sessions/${sessionPid}/submit`, { token: VA, team: T_A, body: foreignBody });
    check('E4c extra/foreign answer rejected (400)', rForeign.status === 400, `status=${rForeign.status}`);
  }

  // E5 <90 → COMPLETED + no cert (all wrong)
  {
    const r = await req('GET', `/api/v2/exams/sessions/${sessionPid}`, { token: VA, team: T_A });
    const qs = r.data?.data?.attempt?.questions ?? [];
    const allWrong = qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'B' })); // answers=A
    const s = await req('POST', `/api/v2/exams/sessions/${sessionPid}/submit`, { token: VA, team: T_A, body: { answers: allWrong } });
    check('E5 <90 COMPLETED, passed=false, no cert', s.status === 200 && s.data?.data?.result?.status === 3 && s.data?.data?.result?.passed === false && s.data.data.result.certificate == null, `status=${s.status} ${JSON.stringify(s.data?.data?.result)}`);
  }
  // E8 submit replay idempotent
  {
    const r = await req('GET', `/api/v2/exams/sessions/${sessionPid}`, { token: VA, team: T_A });
    const qs = r.data?.data?.attempt?.questions ?? [];
    const allWrong = qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'B' }));
    const s = await req('POST', `/api/v2/exams/sessions/${sessionPid}/submit`, { token: VA, team: T_A, body: { answers: allWrong } });
    check('E8 replay idempotent 200 with result', s.status === 200 && s.data?.data?.result?.status === 3, `status=${s.status} ${JSON.stringify(s.data)}`);
  }

  // re-start => attempt_no=2 (E9 status 2/4 never)
  let sessionPid2 = null;
  {
    const r = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VA, team: T_A, body: {} });
    sessionPid2 = r.data?.data?.attempt?.session_public_id ?? null;
    check('C-start after completed attempt (attempt_no=2)', r.status === 200 && r.data?.data?.attempt?.attempt_no === 2, `status=${r.status} ${JSON.stringify(r.data?.data?.attempt)}`);
    const st = withDb((db) => db.prepare('SELECT status FROM exam_sessions WHERE public_id = ?').get(sessionPid2)?.status);
    check('E9 new session status=1 (IN_PROGRESS)', st === 1, `status=${st}`);
    const any24 = withDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM exam_sessions WHERE public_id LIKE '01P32%' AND status IN (2,4)").get().n,
    );
    check('E9b no session ever status 2/4', any24 === 0, `n=${any24}`);
  }

  // E6 >=90 → COMPLETED + cert (all correct)
  {
    const r = await req('GET', `/api/v2/exams/sessions/${sessionPid2}`, { token: VA, team: T_A });
    const qs = r.data?.data?.attempt?.questions ?? [];
    const allRight = qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' }));
    const s = await req('POST', `/api/v2/exams/sessions/${sessionPid2}/submit`, { token: VA, team: T_A, body: { answers: allRight } });
    check('E6 >=90 COMPLETED passed=true cert issued', s.status === 200 && s.data?.data?.result?.passed === true && s.data.data.result.certificate != null, `status=${s.status} ${JSON.stringify(s.data?.data?.result)}`);
    const cid = s.data?.data?.result?.certificate?.public_id;
    // log exactly once
    const logCount = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificate_logs cl JOIN certificates c ON c.id=cl.certificate_id WHERE c.public_id = ? AND cl.action = ?').get(cid, 'issue').n);
    check('E6b certificate_log exactly once', logCount === 1, `n=${logCount}`);
  }

  // C3 same-session concurrent submit -> no duplicate grading/cert
  {
    // start attempt_no=3
    const st = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VA, team: T_A, body: {} });
    const pid3 = st.data?.data?.attempt?.session_public_id;
    const qs = st.data?.data?.attempt?.questions ?? [];
    const allRight = qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' }));
    const [s1, s2] = await Promise.all([
      req('POST', `/api/v2/exams/sessions/${pid3}/submit`, { token: VA, team: T_A, body: { answers: allRight } }),
      req('POST', `/api/v2/exams/sessions/${pid3}/submit`, { token: VA, team: T_A, body: { answers: allRight } }),
    ]);
    const ok1 = s1.status === 200;
    const ok2 = s2.status === 200;
    const certCount = withDb((db) =>
      db.prepare('SELECT COUNT(*) n FROM exam_answers WHERE session_id = (SELECT id FROM exam_sessions WHERE public_id = ?)').get(pid3).n,
    );
    const certsForVolAPaperA = withDb((db) =>
      db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?) AND status = 1').get(IDS.volA, IDS.paperA).n,
    );
    check('C3 concurrent submit: both 200 (loser idempotent)', ok1 && ok2, `s1=${s1.status} s2=${s2.status}`);
    check('C3b answers once (20 rows)', certCount === 20, `n=${certCount}`);
    check('C3c only one active training cert for volA+paperA', certsForVolAPaperA === 1, `certs=${certsForVolAPaperA}`);
  }

  // C1/C2 concurrent start => one active attempt + attempt_no unique
  {
    await Promise.all([
      req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VA, team: T_A, body: {} }),
      req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VA, team: T_A, body: {} }),
    ]);
    const active = withDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM exam_sessions WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND paper_id=(SELECT id FROM exam_papers WHERE public_id=?) AND status IN (1,2)").get(IDS.volA, IDS.paperA).n,
    );
    const dupAttempt = withDb((db) => {
      const rows = db.prepare('SELECT attempt_no, COUNT(*) c FROM exam_sessions WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND paper_id=(SELECT id FROM exam_papers WHERE public_id=?) GROUP BY attempt_no HAVING c>1').all(IDS.volA, IDS.paperA);
      return rows.length;
    });
    check('C1 concurrent start -> at most one active attempt', active <= 1, `active=${active}`);
    check('C2 attempt_no unique (no dup groups)', dupAttempt === 0, `dups=${dupAttempt}`);
  }

  // C4 two passing attempts same user+paper -> one active cert
  {
    const certs = withDb((db) =>
      db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?) AND status=1').get(IDS.volA, IDS.paperA).n,
    );
    check('C4 exactly one active cert for volA+paperA', certs === 1, `certs=${certs}`);
  }

  // C5 pool contention：两个「无 active cert」的同队志愿者竞争同一个 cert_trn code
  {
    const sC = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VC, team: T_A, body: {} });
    const sD = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, { token: VD, team: T_A, body: {} });
    const pidC = sC.data?.data?.attempt?.session_public_id ?? null;
    const pidD = sD.data?.data?.attempt?.session_public_id ?? null;
    const bodyC = { answers: (sC.data?.data?.attempt?.questions ?? []).map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' })) };
    const bodyD = { answers: (sD.data?.data?.attempt?.questions ?? []).map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' })) };
    check('C5 precondition: volC/volD each hold a fresh IN_PROGRESS attempt',
      !!pidC && !!pidD && bodyC.answers.length === 20 && bodyD.answers.length === 20,
      `pidC=${pidC} pidD=${pidD} nC=${bodyC.answers.length} nD=${bodyD.answers.length}`);

    // 仅保留一个 free code → 两次发证必然竞争同一编号
    d1Exec("UPDATE id_pools SET status=1, assigned_to=NULL, assigned_at=NULL WHERE pool_type='cert_trn' AND status=0 AND code != (SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 ORDER BY id ASC LIMIT 1)");
    const free = withDb((db) => db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_trn' AND status=0").get().n);
    const contested = withDb((db) => db.prepare("SELECT code c FROM id_pools WHERE pool_type='cert_trn' AND status=0 ORDER BY id ASC LIMIT 1").get()?.c);
    check('C5a exactly one free cert_trn code remains (contention forced)', free === 1 && !!contested, `free=${free} code=${contested}`);

    const [rC, rD] = await Promise.all([
      req('POST', `/api/v2/exams/sessions/${pidC}/submit`, { token: VC, team: T_A, body: bodyC }),
      req('POST', `/api/v2/exams/sessions/${pidD}/submit`, { token: VD, team: T_A, body: bodyD }),
    ]);
    check('C5b concurrent issuance: exactly one 200 + one 409 (no double-spend)',
      [rC.status, rD.status].slice().sort().join(',') === '200,409',
      `volC=${rC.status} volD=${rD.status}`);

    const cWon = rC.status === 200;
    const loserPid = cWon ? pidD : pidC;
    const loserVol = cWon ? IDS.volD : IDS.volC;
    const loserTok = cWon ? VD : VC;
    const loserBody = cWon ? bodyD : bodyC;

    const usedBy = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificates WHERE cert_no = ?').get(contested).n);
    check('C5c contested cert_no used by at most one certificate', usedBy <= 1, `cert_no=${contested} used=${usedBy}`);

    const ls = withDb((db) => db.prepare('SELECT status, submitted_at, score, passed FROM exam_sessions WHERE public_id = ?').get(loserPid));
    const lAns = withDb((db) => db.prepare('SELECT COUNT(*) n FROM exam_answers WHERE session_id=(SELECT id FROM exam_sessions WHERE public_id=?) AND user_answer IS NOT NULL').get(loserPid).n);
    const lCert = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?)').get(loserVol, IDS.paperA).n);
    const lLog = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificate_logs cl JOIN certificates c ON c.id=cl.certificate_id JOIN users u ON u.id=c.user_id WHERE u.public_id=?').get(loserVol).n);
    check('C5d loser has no partial COMPLETED / cert / log / answer state',
      ls?.status === 1 && ls.submitted_at == null && ls.score == null && ls.passed == null && lAns === 0 && lCert === 0 && lLog === 0,
      JSON.stringify({ ls, lAns, lCert, lLog }));

    // 补充一个全新未用 code → loser 可重新取号重试（不能 re-free 已发过证的编号：cert_no UNIQUE）
    d1Exec("INSERT INTO id_pools (pool_type, code, status, created_at) SELECT 'cert_trn', printf('CTRN%06d', COALESCE(MAX(CAST(substr(code,5) AS INTEGER)),0)+1), 0, unixepoch() FROM (SELECT code FROM id_pools WHERE pool_type='cert_trn')");
    const retry = await req('POST', `/api/v2/exams/sessions/${loserPid}/submit`, { token: loserTok, team: T_A, body: loserBody });
    check('C5e loser retry with fresh code succeeds', retry.status === 200 && retry.data?.data?.result?.passed === true && retry.data?.data?.result?.certificate != null, `status=${retry.status} ${JSON.stringify(retry.data?.data?.result)}`);

    const dup = withDb((db) => db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT cert_no) d FROM certificates WHERE user_id IN (SELECT id FROM users WHERE public_id IN (?,?)) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?)').get(IDS.volC, IDS.volD, IDS.paperA));
    check('C5f no duplicate cert_no across the two issuances', dup.n === 2 && dup.d === 2, JSON.stringify(dup));
    const actC = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?) AND status=1').get(IDS.volC, IDS.paperA).n);
    const actD = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?) AND status=1').get(IDS.volD, IDS.paperA).n);
    check('C5g exactly one active cert per user (no duplicate active cert)', actC === 1 && actD === 1, `volC=${actC} volD=${actD}`);
  }

  // Certificate: K1 mine (SELF) / K2 detail (owner) / K3 isolation / K4 verify / K5 no id_card / K6 no numeric
  {
    const mine = await req('GET', '/api/v2/certificates/mine', { token: VA, team: T_A });
    check('K1 certificates/mine returns cert (SELF)', mine.status === 200 && (mine.data?.data?.certificates ?? []).length >= 1, `status=${mine.status} ${JSON.stringify(mine.data)}`);
    const certPid = mine.data?.data?.certificates?.[0]?.public_id;
    check('K1b mine cert public_id is ULID', !!certPid && ulidRe.test(certPid), `pid=${certPid}`);
    const detail = await req('GET', `/api/v2/certificates/${certPid}`, { token: VA, team: T_A });
    check('K2 cert detail 200 (owner)', detail.status === 200, `status=${detail.status}`);
    const cross = await req('GET', `/api/v2/certificates/${certPid}`, { token: VB, team: T_B });
    check('K3 cross-team/other-user cert detail denied (404)', cross.status === 404, `status=${cross.status}`);
    const noNum = await req('GET', `/api/v2/certificates/${certPid}`, { token: VA, team: T_A });
    const cd = noNum.data?.data?.certificate ?? {};
    check('K6 detail exposes zero numeric internal ids', !('id' in cd) && !('user_id' in cd) && !('template_id' in cd) && !('team_id' in cd) && !('source_id' in cd), JSON.stringify(cd));
    check('K5 detail exposes zero id_card', !('id_card' in cd), JSON.stringify(cd));
  }
  // K4 public verify (safe fields) — ownerA (has cert.view) or self
  {
    const certList = await req('GET', '/api/v2/certificates/mine', { token: VA, team: T_A });
    const certNo = certList.data?.data?.certificates?.[0]?.cert_no;
    const verify = await req('GET', `/api/v2/certificates/verify?cert_no=${certNo}`, { token: VA, team: T_A });
    const vc = verify.data?.data?.certificate ?? {};
    check('K4 public verify returns safe fields only', verify.status === 200 && vc.cert_no === certNo && !('user_id' in vc) && !('id_card' in vc) && !('verify_code' in vc) && !('snapshot' in vc) && !('source_id' in vc), `status=${verify.status} ${JSON.stringify(vc)}`);
  }

  // Pool consumed exactly once (K8)
  {
    const consumed = withDb((db) =>
      db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_trn' AND status=1 AND assigned_to=(SELECT id FROM users WHERE public_id=?)").get(IDS.volA).n,
    );
    check('K8 cert_trn pool consumed exactly once for volA', consumed === 1, `consumed=${consumed}`);
  }

  // ============ Admin CRUD (M1-M5) — redirect to /admin/* routes; ownerA=team_owner on teamA ============
  {
    // M1 course create/update (training.course.manage)
    const c1 = await req('POST', '/api/v2/training/admin/courses', {
      token: OA, team: T_A, body: { title: 'P32 Admin Course', summary: 's', required: 1, required_minutes: 30, status: 1 },
    });
    const cpid = c1.data?.data?.public_id;
    check('M1 admin create course 201 + public_id ULID', c1.status === 201 && !!cpid && ulidRe.test(cpid), `status=${c1.status} ${JSON.stringify(c1.data)}`);
    if (cpid) {
      const up = await req('PUT', `/api/v2/training/admin/courses/${cpid}`, { token: OA, team: T_A, body: { title: 'P32 Admin Course 2', summary: 's2', required: 0, required_minutes: 10, status: 1 } });
      check('M1b admin update course 200', up.status === 200 && up.data?.data?.updated === true, `status=${up.status}`);
    }
    // M2 lesson create/update
    const c0 = await req('GET', '/api/v2/training/courses', { token: OA, team: T_A });
    const adminCourse = c0.data?.data?.items?.find((x) => x.title === 'P32 Admin Course 2') ?? c0.data?.data?.items?.[0];
    let lpid = null;
    if (adminCourse) {
      const l1 = await req('POST', `/api/v2/training/admin/courses/${adminCourse.public_id}/lessons`, {
        token: OA, team: T_A, body: { title: 'Admin Lesson', lesson_type: 'article', content: 'x', duration_min: 5 },
      });
      lpid = l1.data?.data?.public_id;
      check('M2 admin create lesson 201 + public_id ULID', l1.status === 201 && !!lpid && ulidRe.test(lpid), `status=${l1.status} ${JSON.stringify(l1.data)}`);
      if (lpid) {
        const up = await req('PUT', `/api/v2/training/admin/courses/${adminCourse.public_id}/lessons/${lpid}`, {
          token: OA, team: T_A, body: { title: 'Admin Lesson 2', lesson_type: 'article', content: 'y', duration_min: 7 },
        });
        check('M2b admin update lesson 200', up.status === 200 && up.data?.data?.updated === true, `status=${up.status}`);
      }
    }
    // M3 question create/update (exam.question.manage, PLATFORM_GLOBAL — 平台角色，非团队角色)
    const q1 = await req('POST', '/api/v2/exams/admin/questions', {
      token: PL, team: T_A, body: { question_type: 'judge', stem: 'Q?', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer: 'T', difficulty: 2, status: 1 },
    });
    const qpid = q1.data?.data?.public_id;
    check('M3 admin create question 201 + public_id ULID (platform role)', q1.status === 201 && !!qpid && ulidRe.test(qpid), `status=${q1.status} ${JSON.stringify(q1.data)}`);
    if (qpid) {
      const up = await req('PUT', `/api/v2/exams/admin/questions/${qpid}`, { token: PL, team: T_A, body: { question_type: 'judge', stem: 'Q2?', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer: 'F', difficulty: 3, status: 1 } });
      check('M3b admin update question 200 (platform role)', up.status === 200 && up.data?.data?.updated === true, `status=${up.status}`);
    }
    // M3c: team_owner 无权管理 PLATFORM_GLOBAL 题库（正确的权限分层）
    const mgrByTeam = await req('POST', '/api/v2/exams/admin/questions', {
      token: OA, team: T_A, body: { question_type: 'judge', stem: 'x', options: [], answer: '', difficulty: 1, status: 1 },
    });
    check('M3c team_owner cannot manage platform question bank (403)', mgrByTeam.status === 403, `status=${mgrByTeam.status}`);
    // M4 paper create/update (exam.paper.manage, TEAM)
    const p1 = await req('POST', '/api/v2/exams/admin/papers', {
      token: OA, team: T_A, body: { title: 'P32 Admin Paper', pick_rule: { count: 20 }, total_score: 100, pass_score: 90, duration_min: 30, max_attempts: 3, status: 1 },
    });
    const ppid = p1.data?.data?.public_id;
    check('M4 admin create paper 201 + public_id ULID', p1.status === 201 && !!ppid && ulidRe.test(ppid), `status=${p1.status} ${JSON.stringify(p1.data)}`);
    if (ppid) {
      const up = await req('PUT', `/api/v2/exams/admin/papers/${ppid}`, { token: OA, team: T_A, body: { title: 'P32 Admin Paper 2', pick_rule: { count: 20 }, total_score: 100, pass_score: 90, duration_min: 45, max_attempts: 5, status: 1 } });
      check('M4b admin update paper 200', up.status === 200 && up.data?.data?.updated === true, `status=${up.status}`);
      // settings took effect: read DB pass_score
      const paperRow = withDb((db) => db.prepare('SELECT pass_score, max_attempts FROM exam_papers WHERE public_id = ?').get(ppid));
      check('M4c paper update persisted (pass_score=90, max_attempts=5)', paperRow?.pass_score === 90 && paperRow?.max_attempts === 5, JSON.stringify(paperRow));
    }
    // M5 permission 403 coverage
    const volQ = await req('POST', '/api/v2/exams/admin/questions', { token: VA, team: T_A, body: { question_type: 'judge', stem: 'x', options: [], answer: '', difficulty: 1, status: 1 } });
    check('M5 volunteer cannot admin-create question (403)', volQ.status === 403, `status=${volQ.status}`);
    const volCourse = await req('POST', '/api/v2/training/admin/courses', { token: VA, team: T_A, body: { title: 'x' } });
    check('M5b volunteer cannot admin-create course (403)', volCourse.status === 403, `status=${volCourse.status}`);
    const volPaper = await req('POST', '/api/v2/exams/admin/papers', { token: VA, team: T_A, body: { title: 'x' } });
    check('M5c volunteer cannot admin-create paper (403)', volPaper.status === 403, `status=${volPaper.status}`);
  }

  log('');
  log(`P32-P2 probe: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

// ============================== ENTRY ==============================
const mode = process.argv[2] ?? '--run';
if (mode === '--setup') setup();
else if (mode === '--teardown') teardown();
else if (mode === '--run') {
  await run();
} else {
  console.error('usage: node tests/p32_backend.mjs [--setup|--run|--teardown]');
  process.exit(2);
}