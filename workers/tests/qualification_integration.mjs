#!/usr/bin/env node
/**
 * P0-C 志愿者资格派生 + 门禁 集成测试（确定性场景：Part A 资格投影 / B signup 门 / C AI 门 /
 * D 非门控保留 / E 不变量 / F 20 题不变量 / G pass_score 不变量 + 历史会话安全）。
 *
 * 设计（自包含，不导入 fixture.mjs —— fixture.mjs 的 CLI 分发会在被 import 时 process.exit(2)）：
 *   - 本文件自备最小 D1 fixture（users / teams / user_roles / activities / user_identities），
 *     以 '01P0CTEST' 前缀标记，结束（teardown）仅清理本文件写入的行，不影响其它测试。
 *   - 资格三事实（IDENTITY_VERIFIED / PHONE_BOUND / INITIAL_TRAINING_EXAM_PASSED）由本测试
 *     直接 INSERT/DELETE 于本地 D1，逐场景切换，验证 getVolunteerQualification 投影与门禁。
 *   - 不变量：本地 D1 已应用迁移 0031/0032/0033（含 identity_verifications / phone_verifications /
 *     courses.purpose / exam_papers.purpose）；`wrangler dev --local` 已启动（默认 8787）。
 *
 * 纪律（与全仓一致）：
 *   - 资格为 DERIVED FACT（无持久化 qualification_status），不引用 volunteer_profiles.cert_status /
 *     users.status / team membership / legacy admin approval。
 *   - reasons 稳定 token：IDENTITY_REQUIRED / PHONE_REQUIRED / TRAINING_EXAM_REQUIRED（字典序）。
 *   - 门失败 → 403 QUALIFICATION_REQUIRED + error.details.reasons（逗号连接的缺失 token）。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const T0 = 1756500000; // 固定时间戳，保证幂等
const IDKEY = 'local-test-only-identity-key'; // 与 wechat-auth-service.ts local 测试密钥一致
const idHash = (id) => createHmac('sha256', IDKEY).update(id).digest('hex');

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    fails.push(name);
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

// ===== DB helpers =====
function findDbPath() {
  const files = readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`expected exactly 1 sqlite file in ${D1_DIR}, got: ${files.join(',')}`);
  return join(D1_DIR, files[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(findDbPath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const q1 = (sql, ...b) => withDb((db) => db.prepare(sql).get(...b));
const qn = (sql, ...b) => withDb((db) => db.prepare(sql).all(...b));
const qc = (sql, ...b) => withDb((db) => db.prepare(sql).get(...b)?.n ?? 0);

// ===== HTTP helpers =====
const ALL_TEXT = [];
async function req(method, path, { headers = {}, body } = {}) {
  let res, json;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    return { res: { status: 0 }, body: null, text: String(e), connError: true };
  }
  const text = JSON.stringify(json);
  ALL_TEXT.push(text);
  return { res, body: json, text };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const teamHdr = (teamId) => ({ 'x-team-id': String(teamId) });

// ===== 本测试专有 D1 fixture =====
// 26 位 Crockford ULID（避开 I/L/O/U），以 '01P0CTEST' 前缀便于 teardown 清理。
function a26(seed) {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '01P0CTEST';
  while (s.length < 26) s += chars[(seed * 31 + s.length * 7) % chars.length];
  return s.slice(0, 26);
}
const PUB = {
  volA: a26(1),
  volB: a26(2),
  ownerA: a26(3),
  teamA: a26(4),
  teamB: a26(5),
  actS1: a26(6), // teamA / status=1 / allow_cancel=1 / need_audit=0
};
let SEQ = 0;
const uid = () => `01P0C${String(SEQ++).padStart(18, '0')}`; // 唯一 public_id 片段

let VOL_A_ID = null;
let VOL_B_ID = null;
let OWNER_A_ID = null;
let TEAM_A_ID = null;
let TEAM_B_ID = null;
let ACT_S1_ID = null;

function setupFixture() {
  withDb((db) => {
    db.exec('PRAGMA foreign_keys = OFF;');
    // 清理本测试可能残留的 '01P0CTEST' 行（幂等）
    for (const r of db.prepare(`SELECT id FROM users WHERE public_id LIKE '01P0CTEST%'`).all()) {
      const id = r.id;
      db.prepare('DELETE FROM exam_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM course_enrollments WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM identity_verifications WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM phone_verifications WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_identities WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM activity_signups WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM team_members WHERE user_id = ?').run(id);
    }
    for (const r of db.prepare(`SELECT id FROM teams WHERE public_id LIKE '01P0CTEST%'`).all()) {
      const tid = r.id;
      db.prepare('DELETE FROM exam_papers WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM courses WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM activities WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM user_roles WHERE scope_team_id = ?').run(tid);
    }
    db.prepare(`DELETE FROM teams WHERE public_id LIKE '01P0CTEST%'`).run();
    db.prepare(`DELETE FROM users WHERE public_id LIKE '01P0CTEST%'`).run();
    // 清理本测试的题库 fixture（先删 pinned answers，再删 questions）
    db.prepare(`DELETE FROM exam_answers WHERE question_id IN (SELECT id FROM exam_questions WHERE public_id LIKE '01P0CTEST%')`).run();
    db.prepare(`DELETE FROM exam_questions WHERE public_id LIKE '01P0CTEST%'`).run();
    db.exec('PRAGMA foreign_keys = ON;');

    const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, 1)`);
    insUser.run(PUB.volA, 'P0C-VolA');
    insUser.run(PUB.volB, 'P0C-VolB');
    insUser.run(PUB.ownerA, 'P0C-OwnerA');
    VOL_A_ID = db.prepare('SELECT id FROM users WHERE public_id = ?').get(PUB.volA).id;
    VOL_B_ID = db.prepare('SELECT id FROM users WHERE public_id = ?').get(PUB.volB).id;
    OWNER_A_ID = db.prepare('SELECT id FROM users WHERE public_id = ?').get(PUB.ownerA).id;

    const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
    insTeam.run(PUB.teamA, 'P0C Team A', OWNER_A_ID);
    insTeam.run(PUB.teamB, 'P0C Team B', VOL_B_ID);
    TEAM_A_ID = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(PUB.teamA).id;
    TEAM_B_ID = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(PUB.teamB).id;

    const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;
    const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
    insUR.run(VOL_A_ID, rid('volunteer'), TEAM_A_ID); // volunteer@teamA → 持有 signup.signup.create + ai.assist.use
    insUR.run(OWNER_A_ID, rid('team_owner'), TEAM_A_ID);
    insUR.run(VOL_B_ID, rid('volunteer'), TEAM_B_ID);

    const insTM = db.prepare(`INSERT INTO team_members (team_id, user_id, team_role_code, join_status) VALUES (?, ?, 'member', 1)`);
    insTM.run(TEAM_A_ID, VOL_A_ID); // volA 是 teamA 的 team member（A10 依赖）
    insTM.run(TEAM_A_ID, OWNER_A_ID);
    insTM.run(TEAM_B_ID, VOL_B_ID);

    const insId = db.prepare(`INSERT INTO user_identities (user_id, identity_type, identity_hash, active_marker, status) VALUES (?, ?, ?, 1, 1)`);
    insId.run(VOL_A_ID, 'wechat_openid', idHash('P0C_OPENID_A'));
    insId.run(VOL_A_ID, 'wechat_unionid', idHash('P0C_UNIONID_A'));
    insId.run(VOL_B_ID, 'wechat_openid', idHash('P0C_OPENID_B'));
    // ownerA（team_owner）持有 exam.paper.manage：供 Part G 通过 admin API 验证 pass_score 不变量。
    insId.run(OWNER_A_ID, 'wechat_openid', idHash('P0C_OPENID_OWNER'));
    insId.run(OWNER_A_ID, 'wechat_unionid', idHash('P0C_UNIONID_OWNER'));

    const insAct = db.prepare(
      `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, allow_cancel, need_audit, audit_status, created_by)
       VALUES (?, ?, ?, ?, ?, 30, 1, 1, 0, 2, ?)`,
    );
    insAct.run(PUB.actS1, TEAM_A_ID, 'P0C Signup A1', T0 + 86400, T0 + 90000, OWNER_A_ID);
    ACT_S1_ID = db.prepare('SELECT id FROM activities WHERE public_id = ?').get(PUB.actS1).id;

    // 权限目录基线快照（不自盘硬编码数值；实际基线由 E1 不变量动态校验不变性）。
    const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
    const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
    process.stderr.write(`  [fixture] setup OK: permissions=${p} role_permissions=${rp}\n`);
  });
}

function teardownFixture() {
  withDb((db) => {
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const r of db.prepare(`SELECT id FROM users WHERE public_id LIKE '01P0CTEST%'`).all()) {
      const id = r.id;
      db.prepare('DELETE FROM exam_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM course_enrollments WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM identity_verifications WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM phone_verifications WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_identities WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM activity_signups WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM team_members WHERE user_id = ?').run(id);
    }
    for (const r of db.prepare(`SELECT id FROM teams WHERE public_id LIKE '01P0CTEST%'`).all()) {
      const tid = r.id;
      db.prepare('DELETE FROM exam_papers WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM courses WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM activities WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(tid);
      db.prepare('DELETE FROM user_roles WHERE scope_team_id = ?').run(tid);
    }
    db.prepare(`DELETE FROM teams WHERE public_id LIKE '01P0CTEST%'`).run();
    db.prepare(`DELETE FROM users WHERE public_id LIKE '01P0CTEST%'`).run();
    // 清理本测试的题库 fixture（先删 pinned answers，再删 questions）
    db.prepare(`DELETE FROM exam_answers WHERE question_id IN (SELECT id FROM exam_questions WHERE public_id LIKE '01P0CTEST%')`).run();
    db.prepare(`DELETE FROM exam_questions WHERE public_id LIKE '01P0CTEST%'`).run();
    db.exec('PRAGMA foreign_keys = ON;');
  });
}

// ===== 资格三事实 INSERT / 清理 =====
function clearFacts() {
  withDb((db) => {
    db.exec('PRAGMA foreign_keys = OFF;');
    // 先清 exam_answers（外键 CASCADE 在 PRAGMA OFF 下不触发，须显式删；否则 session id 复用会
    // 把旧答案错挂到新会话，破坏「题量=20」不变量的确定性）。
    db.prepare('DELETE FROM exam_answers WHERE team_id = ?').run(TEAM_A_ID);
    db.prepare('DELETE FROM exam_sessions WHERE team_id = ?').run(TEAM_A_ID);
    db.prepare('DELETE FROM course_enrollments WHERE user_id = ?').run(VOL_A_ID);
    db.prepare('DELETE FROM identity_verifications WHERE user_id = ?').run(VOL_A_ID);
    db.prepare('DELETE FROM phone_verifications WHERE user_id = ?').run(VOL_A_ID);
    db.prepare('DELETE FROM exam_papers WHERE team_id = ?').run(TEAM_A_ID);
    db.prepare('DELETE FROM courses WHERE team_id = ?').run(TEAM_A_ID);
    db.prepare('DELETE FROM volunteer_profiles WHERE user_id = ?').run(VOL_A_ID);
    db.exec('PRAGMA foreign_keys = ON;');
  });
}

function grantIdentityVerified() {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO identity_verifications (public_id, user_id, provider, status, identity_fingerprint, attempt_key, created_at, updated_at, verified_at)
         VALUES (?, ?, 'FAKE', 'VERIFIED', ?, ?, ?, ?, ?)`,
      )
      .run(uid(), VOL_A_ID, 'fp' + VOL_A_ID + SEQ, 'atk' + VOL_A_ID + SEQ, T0, T0, T0),
  );
}
function grantIdentityPending() {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO identity_verifications (public_id, user_id, provider, status, identity_fingerprint, attempt_key, created_at, updated_at)
         VALUES (?, ?, 'FAKE', 'PENDING', ?, ?, ?, ?)`,
      )
      .run(uid(), VOL_A_ID, 'fp' + VOL_A_ID + SEQ, 'atk' + VOL_A_ID + SEQ, T0, T0),
  );
}
function grantPhone(status = 'BOUND') {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO phone_verifications (public_id, user_id, provider, phone_enc, phone_hash, phone_mask, status, bound_at, created_at)
         VALUES (?, ?, 'WECHAT', 'ENC', 'HASH', '138****0000', ?, ?, ?)`,
      )
      .run(uid(), VOL_A_ID, status, status === 'BOUND' ? T0 : null, T0),
  );
}

/** 创建 n 道真实题目（status=1），返回 numeric question id 列表（供钉入 exam_answers）。 */
let GRANT_Q_SEQ = 0;
function makeQuestions(n) {
  return withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO exam_questions
         (public_id, question_type, stem, options, answer, analysis, difficulty, tags, status, created_by, created_at, updated_at)
       VALUES (?, 'single', ?, '[{"key":"A","text":"a"},{"key":"B","text":"b"}]', 'A', NULL, 2, NULL, 1, ?, ?, ?)`,
    );
    const ids = [];
    for (let i = 0; i < n; i++) {
      const pid = `01P0CTESTG${String(GRANT_Q_SEQ++).padStart(9, '0')}`;
      const r = ins.run(pid, `P0C GQ${GRANT_Q_SEQ}`, VOL_A_ID, T0, T0);
      ids.push(Number(r.lastInsertRowid));
    }
    return ids;
  });
}

/**
 * 插入 INITIAL_VOLUNTEER（或自定义 purpose）课程 + 报名 + 试卷 + 考试会话，
 * 并【真实钉入 questionCount 道题目】（exam_answers），使该 attempt 具备可验证的真实题量。
 *
 * 参数：
 *   examScore      —— 会话真实分数（INITIAL 资格线为 >=90）
 *   questionCount  —— 该 attempt 实际参与题目数（INITIAL 资格要求恰为 20）
 *   promoteFromNormal —— 「历史会话」场景：先以普通试卷（purpose='', pass_score=60）落库并产生
 *                        旧会话，随后把该试卷提升为 INITIAL_VOLUNTEER（pass_score=90）。
 */
function grantTrainingExam(opts = {}) {
  const {
    enrollmentStatus = 3,
    completedAt = T0,
    examPassed = 1,
    examStatus = 3,
    examScore = 95,
    questionCount = 20,
    coursePurpose = 'INITIAL_VOLUNTEER',
    paperPurpose = 'INITIAL_VOLUNTEER',
    passScore = 90,
    courseDeletedAt = null,
    paperDeletedAt = null,
    sessionUserId = VOL_A_ID,
    withEnrollment = true,
    promoteFromNormal = false,
  } = opts;

  const qids = makeQuestions(questionCount);
  const initPaperPurpose = promoteFromNormal ? '' : paperPurpose;
  const initPassScore = promoteFromNormal ? 60 : passScore;

  withDb((db) => {
    const cPid = uid();
    db.prepare(
      `INSERT INTO courses (public_id, team_id, title, required, status, created_by, deleted_at, purpose)
       VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
    ).run(cPid, TEAM_A_ID, 'Initial Training', VOL_A_ID, courseDeletedAt, coursePurpose);
    const courseId = db.prepare('SELECT id FROM courses WHERE public_id = ?').get(cPid).id;
    const pPid = uid();
    db.prepare(
      `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, deleted_at, purpose)
       VALUES (?, ?, ?, ?, '{}', 100, ?, 60, 3, 1, ?, ?)`,
    ).run(pPid, TEAM_A_ID, 'Initial Exam', courseId, initPassScore, paperDeletedAt, initPaperPurpose);
    const paperId = db.prepare('SELECT id FROM exam_papers WHERE public_id = ?').get(pPid).id;
    if (withEnrollment) {
      db.prepare(
        `INSERT INTO course_enrollments (user_id, course_id, team_id, progress, status, completed_at)
         VALUES (?, ?, ?, 100, ?, ?)`,
      ).run(VOL_A_ID, courseId, TEAM_A_ID, enrollmentStatus, completedAt);
    }
    const sres = db.prepare(
      `INSERT INTO exam_sessions (paper_id, user_id, team_id, attempt_no, started_at, submitted_at, score, passed, status)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(paperId, sessionUserId, TEAM_A_ID, T0, T0, examScore, examPassed, examStatus);
    const sessionId = Number(sres.lastInsertRowid);
    const insAns = db.prepare(
      `INSERT INTO exam_answers (team_id, session_id, question_id, user_answer, is_correct, score, answered_at)
       VALUES (?, ?, ?, 'A', 1, 1, ?)`,
    );
    for (const qid of qids) insAns.run(TEAM_A_ID, sessionId, qid, T0);
    // 历史场景：旧会话已存在后，把普通试卷提升为 INITIAL_VOLUNTEER（pass_score 必须同步为 90）。
    if (promoteFromNormal) {
      db.prepare(`UPDATE exam_papers SET purpose = 'INITIAL_VOLUNTEER', pass_score = 90 WHERE id = ?`).run(paperId);
    }
  });
}

// ===== P0-C 20-question invariant fixture（真实题库 + 显式 INITIAL_VOLUNTEER 试卷）=====
const QB_PREFIX = '01P0CTESTQ';
/** 创建 n 道真实 active 题库题目（PLATFORM_GLOBAL），供真实考试 runtime 抽题。 */
function setupExamBank(n) {
  withDb((db) => {
    const ins = db.prepare(
      `INSERT INTO exam_questions
         (public_id, question_type, stem, options, answer, analysis, difficulty, tags, status, created_by, created_at, updated_at)
       VALUES (?, 'single', ?, '[{"key":"A","text":"a"},{"key":"B","text":"b"}]', 'A', NULL, 2, NULL, 1, ?, ?, ?)`,
    );
    for (let i = 0; i < n; i++) {
      ins.run(`${QB_PREFIX}${String(i).padStart(4, '0')}`, `P0C Q${i}`, VOL_A_ID, T0, T0);
    }
  });
}
/** 创建 1 个显式 INITIAL_VOLUNTEER course + 1 张显式 INITIAL_VOLUNTEER 试卷（teamA, status=1）。 */
function setupInitialPaper(pickCount, passScore = 90) {
  return withDb((db) => {
    const cpid = a26(40);
    db.prepare(
      `INSERT INTO courses (public_id, team_id, title, required, status, created_by, deleted_at, purpose)
       VALUES (?, ?, 'P0C Initial Course', 0, 1, ?, NULL, 'INITIAL_VOLUNTEER')`,
    ).run(cpid, TEAM_A_ID, VOL_A_ID);
    const courseId = db.prepare('SELECT id FROM courses WHERE public_id = ?').get(cpid).id;
    const ppid = a26(41);
    db.prepare(
      `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, deleted_at, purpose)
       VALUES (?, ?, 'P0C Initial Exam', ?, ?, 100, ?, 60, 3, 1, NULL, 'INITIAL_VOLUNTEER')`,
    ).run(ppid, TEAM_A_ID, courseId, JSON.stringify({ count: pickCount }), passScore);
    const paperId = db.prepare('SELECT id FROM exam_papers WHERE public_id = ?').get(ppid).id;
    return { coursePublicId: cpid, paperPublicId: ppid, courseId, paperId };
  });
}
/** 设置 INITIAL 试卷的 pick_rule.count（用于 19/20/21 场景切换，不新建试卷=不破坏唯一性）。 */
function setPaperPickCount(paperPublicId, count) {
  withDb((db) =>
    db.prepare('UPDATE exam_papers SET pick_rule = ? WHERE public_id = ?').run(JSON.stringify({ count }), paperPublicId),
  );
}

function grantLegacyCertStatus(status = 3) {
  withDb((db) =>
    db
      .prepare(`INSERT INTO volunteer_profiles (user_id, cert_status) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET cert_status=?`)
      .run(VOL_A_ID, status, status),
  );
}

// ===== login =====
async function login(openid, unionid = '-') {
  return req('POST', '/api/v2/auth/wechat/login', { body: { code: `MOCK_WECHAT_CODE.${openid}.${unionid}` } });
}

// ===== main =====
async function main() {
  const health = await req('GET', '/');
  if (health.connError || health.res.status === 0) {
    process.stderr.write(
      `\nLIVE_ASSERTION = NOT_EXECUTED_TO_ASSERTION_COMPLETION (server unreachable at ${BASE}; ` +
        `需先 wrangler dev --local 且本地 D1 已应用 0031/0032/0033)\n`,
    );
    process.exitCode = 0;
    return;
  }

  setupFixture();
  const r = await login('P0C_OPENID_A', 'P0C_UNIONID_A');
  const token = r.body?.data?.token ?? null;
  check('T0 登录取得 volA token', token != null, `token=${!!token}`);
  if (token == null) {
    process.stderr.write('\nFATAL: 无法取得 token，终止\n');
    teardownFixture();
    process.exitCode = 1;
    return;
  }

  const qGet = () => req('GET', '/api/v2/users/me/qualification', { headers: bearer(token) });

  // 不变量快照（regression）
  const before = {
    users: qc("SELECT COUNT(*) n FROM users WHERE public_id NOT LIKE '01P0CTEST%'"),
    teamMembers: qc('SELECT COUNT(*) n FROM team_members'),
    userRoles: qc('SELECT COUNT(*) n FROM user_roles'),
    permissions: qc('SELECT COUNT(*) n FROM permissions'),
    rolePermissions: qc('SELECT COUNT(*) n FROM role_permissions'),
    certificates: qc('SELECT COUNT(*) n FROM certificates'),
    attendanceSessions: qc('SELECT COUNT(*) n FROM attendance_sessions'),
  };

  const reasonsOf = (body) => body?.data?.reasons ?? [];
  const hasAll = (arr, ...xs) => xs.every((x) => arr.includes(x));

  // ===================== Part A：资格投影（22 场景）=====================
  // A1 三事实全真
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam();
    const s = await qGet();
    check(
      'A1 三事实全真 → qualified=true + reasons=[]',
      s.res.status === 200 && s.body?.data?.qualified === true && Array.isArray(s.body?.data?.reasons) && s.body?.data?.reasons.length === 0 &&
        s.body?.data?.identity_verified === true && s.body?.data?.phone_bound === true && s.body?.data?.initial_training_exam_passed === true,
      s.text.slice(0, 160),
    );
  }
  // A2 三事实全缺
  {
    clearFacts();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A2 三事实全缺 → qualified=false + reasons=[IDENTITY_REQUIRED,PHONE_REQUIRED,TRAINING_EXAM_REQUIRED]',
      s.res.status === 200 && s.body?.data?.qualified === false &&
        hasAll(rs, 'IDENTITY_REQUIRED', 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED') && rs.length === 3,
      JSON.stringify(rs),
    );
  }
  // A3 仅 identity
  {
    clearFacts();
    grantIdentityVerified();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A3 仅 identity → reasons=[PHONE_REQUIRED,TRAINING_EXAM_REQUIRED]',
      s.body?.data?.identity_verified === true && !s.body?.data?.phone_bound && !s.body?.data?.initial_training_exam_passed &&
        hasAll(rs, 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED') && rs.length === 2,
      JSON.stringify(rs),
    );
  }
  // A4 仅 phone
  {
    clearFacts();
    grantPhone();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A4 仅 phone → reasons=[IDENTITY_REQUIRED,TRAINING_EXAM_REQUIRED]',
      !s.body?.data?.identity_verified && s.body?.data?.phone_bound === true && !s.body?.data?.initial_training_exam_passed &&
        hasAll(rs, 'IDENTITY_REQUIRED', 'TRAINING_EXAM_REQUIRED') && rs.length === 2,
      JSON.stringify(rs),
    );
  }
  // A5 仅 exam
  {
    clearFacts();
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A5 仅 exam → reasons=[IDENTITY_REQUIRED,PHONE_REQUIRED]',
      !s.body?.data?.identity_verified && !s.body?.data?.phone_bound && s.body?.data?.initial_training_exam_passed === true &&
        hasAll(rs, 'IDENTITY_REQUIRED', 'PHONE_REQUIRED') && rs.length === 2,
      JSON.stringify(rs),
    );
  }
  // A6 identity + phone
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A6 identity+phone → reasons=[TRAINING_EXAM_REQUIRED]',
      s.body?.data?.identity_verified && s.body?.data?.phone_bound && !s.body?.data?.initial_training_exam_passed &&
        rs.length === 1 && rs[0] === 'TRAINING_EXAM_REQUIRED',
      JSON.stringify(rs),
    );
  }
  // A7 identity + exam
  {
    clearFacts();
    grantIdentityVerified();
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A7 identity+exam → reasons=[PHONE_REQUIRED]',
      s.body?.data?.identity_verified && !s.body?.data?.phone_bound && s.body?.data?.initial_training_exam_passed &&
        rs.length === 1 && rs[0] === 'PHONE_REQUIRED',
      JSON.stringify(rs),
    );
  }
  // A8 phone + exam
  {
    clearFacts();
    grantPhone();
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A8 phone+exam → reasons=[IDENTITY_REQUIRED]',
      !s.body?.data?.identity_verified && s.body?.data?.phone_bound && s.body?.data?.initial_training_exam_passed &&
        rs.length === 1 && rs[0] === 'IDENTITY_REQUIRED',
      JSON.stringify(rs),
    );
  }
  // A9 legacy cert_status=3 但无三事实 → 不替代
  {
    clearFacts();
    grantLegacyCertStatus(3);
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A9 legacy cert_status=3 不替代 → qualified=false + 三 reasons 全在',
      s.body?.data?.qualified === false && hasAll(rs, 'IDENTITY_REQUIRED', 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A10 team member 但无三事实 → 不替代
  {
    clearFacts();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    const isMember = qc('SELECT COUNT(*) n FROM team_members WHERE user_id = ? AND team_id = ?', VOL_A_ID, TEAM_A_ID) === 1;
    check(
      'A10 team member 不替代（volA 是 teamA member 但无事实）→ qualified=false',
      isMember && s.body?.data?.qualified === false && hasAll(rs, 'IDENTITY_REQUIRED', 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED'),
      `isMember=${isMember} ${JSON.stringify(rs)}`,
    );
  }
  // A11 EXAM_PASS_IMPLIES_TRAINING_COMPLETION = NO：报名未完成 + 考试通过
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ enrollmentStatus: 1, completedAt: null, examPassed: 1, examStatus: 3 });
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A11 报名未完成(仅考试通过) → training-exam=false + reasons=[TRAINING_EXAM_REQUIRED]',
      s.body?.data?.initial_training_exam_passed === false && rs.includes('TRAINING_EXAM_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A12 报名完成 + 考试未通过
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ enrollmentStatus: 3, completedAt: T0, examPassed: 0, examStatus: 3 });
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A12 报名完成但考试未通过 → training-exam=false',
      s.body?.data?.initial_training_exam_passed === false && rs.includes('TRAINING_EXAM_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A13 课程 deleted_at 置位
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ courseDeletedAt: T0 });
    const s = await qGet();
    check(
      'A13 课程 deleted_at 置位 → training-exam=false',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }
  // A14 试卷 deleted_at 置位
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ paperDeletedAt: T0 });
    const s = await qGet();
    check(
      'A14 试卷 deleted_at 置位 → training-exam=false',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }
  // A15 考试会话 status != 3
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ examPassed: 1, examStatus: 2 });
    const s = await qGet();
    check(
      'A15 考试会话 status=2(非3) → training-exam=false',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }
  // A16 考试会话 passed != 1
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ examPassed: 0, examStatus: 3 });
    const s = await qGet();
    check(
      'A16 考试会话 passed=0 → training-exam=false',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }
  // A17 identity 状态非 VERIFIED（PENDING）
  {
    clearFacts();
    grantIdentityPending();
    grantPhone();
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A17 identity 状态=PENDING（非 VERIFIED）→ identity=false',
      s.body?.data?.identity_verified === false && rs.includes('IDENTITY_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A18 identity 多行：一行 VERIFIED 即算（存在 VERIFIED 语义）
  {
    clearFacts();
    grantIdentityPending();
    grantIdentityVerified(); // 追加一行 VERIFIED
    grantPhone();
    grantTrainingExam();
    const s = await qGet();
    check(
      'A18 存在 VERIFIED 行（即使另有 PENDING）→ identity=true',
      s.body?.data?.identity_verified === true && s.body?.data?.qualified === true,
      s.text.slice(0, 120),
    );
  }
  // A19 phone 状态 PROVIDER_ERROR
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone('PROVIDER_ERROR');
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A19 phone 状态=PROVIDER_ERROR → phone=false',
      s.body?.data?.phone_bound === false && rs.includes('PHONE_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A20 phone 状态 INVALID_CODE
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone('INVALID_CODE');
    grantTrainingExam();
    const s = await qGet();
    const rs = reasonsOf(s.body);
    check(
      'A20 phone 状态=INVALID_CODE → phone=false',
      s.body?.data?.phone_bound === false && rs.includes('PHONE_REQUIRED'),
      JSON.stringify(rs),
    );
  }
  // A21 purpose 门控：非 INITIAL_VOLUNTEER 课程+考试通过不计入
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ coursePurpose: '', paperPurpose: '' }); // 普通（非初始）培训
    const s = await qGet();
    check(
      'A21 非 INITIAL_VOLUNTEER purpose 培训通过 → training-exam=false（purpose 门控）',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }
  // A22 用户隔离：INITIAL 课程报名属于 volA，但考试会话属于 volB
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ sessionUserId: VOL_B_ID }); // 考试会话写在 volB 名下
    const s = await qGet();
    check(
      'A22 考试会话属他人(volB) → volA training-exam=false（用户隔离）',
      s.body?.data?.initial_training_exam_passed === false,
      s.text.slice(0, 120),
    );
  }

  // ===================== Part B：signup 门禁（4 场景）=====================
  const signupUrl = `/api/v2/activities/${PUB.actS1}/signups`;
  const clearSignups = () =>
    withDb((db) => db.prepare('DELETE FROM activity_signups WHERE user_id = ?').run(VOL_A_ID));
  const signupReq = () => req('POST', signupUrl, { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) }, body: {} });

  // B1 全资格 → 成功
  {
    clearFacts();
    clearSignups();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam();
    const s = await signupReq();
    const created = qc('SELECT COUNT(*) n FROM activity_signups WHERE user_id = ? AND activity_id = ?', VOL_A_ID, ACT_S1_ID);
    check(
      'B1 全资格 → POST signup 201 + 行已建',
      (s.res.status === 200 || s.res.status === 201) && created === 1,
      `status=${s.res.status} created=${created} ${s.text.slice(0, 120)}`,
    );
    clearSignups();
  }
  // B2 全缺 → 403 QUALIFICATION_REQUIRED
  {
    clearFacts();
    clearSignups();
    const s = await signupReq();
    const code = s.body?.error?.code;
    const reasons = (s.body?.error?.details?.reasons ?? '').split(',').filter(Boolean);
    check(
      'B2 全缺 → 403 QUALIFICATION_REQUIRED + details.reasons 含三 token',
      s.res.status === 403 && code === 'QUALIFICATION_REQUIRED' && hasAll(reasons, 'IDENTITY_REQUIRED', 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED'),
      `status=${s.res.status} code=${code} reasons=${s.body?.error?.details?.reasons}`,
    );
  }
  // B3 identity+phone，无 exam → 403 仅 TRAINING_EXAM_REQUIRED
  {
    clearFacts();
    clearSignups();
    grantIdentityVerified();
    grantPhone();
    const s = await signupReq();
    const code = s.body?.error?.code;
    const reasons = (s.body?.error?.details?.reasons ?? '').split(',').filter(Boolean);
    check(
      'B3 identity+phone 无 exam → 403 + reasons=[TRAINING_EXAM_REQUIRED]',
      s.res.status === 403 && code === 'QUALIFICATION_REQUIRED' && reasons.length === 1 && reasons[0] === 'TRAINING_EXAM_REQUIRED',
      `code=${code} reasons=${s.body?.error?.details?.reasons}`,
    );
  }
  // B4 仅 identity → 403 含 PHONE_REQUIRED + TRAINING_EXAM_REQUIRED
  {
    clearFacts();
    clearSignups();
    grantIdentityVerified();
    const s = await signupReq();
    const code = s.body?.error?.code;
    const reasons = (s.body?.error?.details?.reasons ?? '').split(',').filter(Boolean);
    check(
      'B4 仅 identity → 403 + reasons=[PHONE_REQUIRED,TRAINING_EXAM_REQUIRED]',
      s.res.status === 403 && code === 'QUALIFICATION_REQUIRED' && hasAll(reasons, 'PHONE_REQUIRED', 'TRAINING_EXAM_REQUIRED') && reasons.length === 2,
      `code=${code} reasons=${s.body?.error?.details?.reasons}`,
    );
    clearSignups();
  }

  // ===================== Part C：AI 门禁（2 场景）=====================
  // C1 全资格 → 200
  {
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam();
    const s = await req('GET', '/api/v2/ai/conversations', { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) } });
    check(
      'C1 全资格 → GET /ai/conversations 200（门放行）',
      s.res.status === 200,
      `status=${s.res.status} ${s.text.slice(0, 120)}`,
    );
  }
  // C2 全缺 → 403 QUALIFICATION_REQUIRED
  {
    clearFacts();
    const s = await req('GET', '/api/v2/ai/conversations', { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) } });
    check(
      'C2 全缺 → GET /ai/conversations 403 QUALIFICATION_REQUIRED',
      s.res.status === 403 && s.body?.error?.code === 'QUALIFICATION_REQUIRED',
      `status=${s.res.status} code=${s.body?.error?.code}`,
    );
  }

  // ===================== Part D：非门控端点对未资格用户仍可用（9 场景）=====================
  {
    clearFacts(); // volA 未资格
    const notQual = (s) => !(s.res.status === 403 && s.body?.error?.code === 'QUALIFICATION_REQUIRED');
    const d1 = await login('P0C_OPENID_A', 'P0C_UNIONID_A'); // 登录始终允许
    check('D1 登录对未资格用户允许（200）', d1.res.status === 200, `status=${d1.res.status}`);
    const d2 = await req('GET', '/api/v2/users/me', { headers: bearer(token) });
    check('D2 GET /users/me 未资格仍可用', notQual(d2) && d2.res.status === 200, `status=${d2.res.status}`);
    const d3 = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: '测试', id_card: '11010119900307001X' } });
    check('D3 POST 身份核验未资格仍可用（非 QUALIFICATION 门）', notQual(d3), `status=${d3.res.status} code=${d3.body?.error?.code}`);
    const d4 = await req('GET', '/api/v2/volunteer/identity/status', { headers: bearer(token) });
    check('D4 GET 身份状态未资格仍可用', notQual(d4) && d4.res.status === 200, `status=${d4.res.status}`);
    const d5 = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token), body: { code: 'MOCK_PHONE_CODE.13800000000' } });
    check('D5 POST 手机号绑定未资格仍可用', notQual(d5), `status=${d5.res.status} code=${d5.body?.error?.code}`);
    const d6 = await req('GET', '/api/v2/training/courses', { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) } });
    check('D6 GET 培训课程未资格仍可用', notQual(d6) && d6.res.status === 200, `status=${d6.res.status}`);
    const d7 = await req('GET', '/api/v2/activities', { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) } });
    check('D7 GET 活动公开浏览未资格仍可用', notQual(d7) && d7.res.status === 200, `status=${d7.res.status}`);
    const d8 = await req('POST', `/api/v2/teams/${TEAM_B_ID}/join`, { headers: bearer(token) });
    check('D8 POST 加入团队（团队申请）未资格仍可用', notQual(d8), `status=${d8.res.status} code=${d8.body?.error?.code}`);
    const d9 = await req('POST', '/api/v2/exams/nonexistent-paper/start', { headers: bearer(token) });
    check('D9 POST 考试开始端点未资格仍可用（不受资格门约束）', notQual(d9), `status=${d9.res.status} code=${d9.body?.error?.code}`);
  }

  // ===================== Part E：不变量快照（regression）=====================
  {
    const after = {
      users: qc("SELECT COUNT(*) n FROM users WHERE public_id NOT LIKE '01P0CTEST%'"),
      teamMembers: qc('SELECT COUNT(*) n FROM team_members'),
      userRoles: qc('SELECT COUNT(*) n FROM user_roles'),
      permissions: qc('SELECT COUNT(*) n FROM permissions'),
      rolePermissions: qc('SELECT COUNT(*) n FROM role_permissions'),
      certificates: qc('SELECT COUNT(*) n FROM certificates'),
      attendanceSessions: qc('SELECT COUNT(*) n FROM attendance_sessions'),
    };
    const unchanged =
      before.users === after.users &&
      before.teamMembers === after.teamMembers &&
      before.userRoles === after.userRoles &&
      before.permissions === after.permissions &&
      before.rolePermissions === after.rolePermissions &&
      before.certificates === after.certificates &&
      before.attendanceSessions === after.attendanceSessions;
    check(
      'E1 无关业务计数不变（users/team_members/user_roles/permissions/certificates/attendance_sessions）',
      unchanged,
      JSON.stringify({ before, after }),
    );
  }

  // ===================== Part F：20-question production invariant（真实考试 runtime）=====================
  {
    clearFacts();
    setupExamBank(30); // 真实题库 30 题（>=21，足以覆盖 19/20/21）
    const p = setupInitialPaper(20);

    // F0：INITIAL_VOLUNTEER 试卷显式 pass_score=90 且 purpose 正确（schema-only 迁移不 backfill）
    const ps = q1('SELECT pass_score, purpose FROM exam_papers WHERE public_id = ?', p.paperPublicId);
    check(
      'F0 INITIAL_VOLUNTEER paper purpose 正确且显式 pass_score=90',
      ps.purpose === 'INITIAL_VOLUNTEER' && ps.pass_score === 90,
      JSON.stringify(ps),
    );

    const startReq = () =>
      req('POST', `/api/v2/exams/${p.paperPublicId}/start`, { headers: { ...bearer(token), ...teamHdr(TEAM_A_ID) } });
    const sessionCount = () => qc('SELECT COUNT(*) n FROM exam_sessions WHERE user_id = ?', VOL_A_ID);

    // F1：19 题 → start 拒绝（INITIAL 必须恰 20），且不落任何会话
    setPaperPickCount(p.paperPublicId, 19);
    const f1 = await startReq();
    check(
      'F1 INITIAL 19 题 → start 拒绝(400) 且未建会话（不得成为有效资格通过）',
      f1.res.status === 400 && sessionCount() === 0,
      `status=${f1.res.status} code=${f1.body?.error?.code} sessions=${sessionCount()} ${f1.text.slice(0, 100)}`,
    );

    // F2：21 题 → start 拒绝
    setPaperPickCount(p.paperPublicId, 21);
    const f2 = await startReq();
    check(
      'F2 INITIAL 21 题 → start 拒绝(400) 且未建会话',
      f2.res.status === 400 && sessionCount() === 0,
      `status=${f2.res.status} code=${f2.body?.error?.code} sessions=${sessionCount()} ${f2.text.slice(0, 100)}`,
    );

    // F3：20 题 → start 允许，实际参与题目（bindings）恰为 20
    setPaperPickCount(p.paperPublicId, 20);
    const f3 = await startReq();
    const qlen = f3.body?.data?.attempt?.questions?.length ?? -1;
    const pinnedN = qc(
      'SELECT COUNT(*) n FROM exam_answers ea JOIN exam_sessions es ON es.id = ea.session_id WHERE es.user_id = ?',
      VOL_A_ID,
    );
    check(
      'F3 INITIAL 20 题 → start 允许(200) 且 attempt/pinned 实际题目=20',
      f3.res.status === 200 && qlen === 20 && pinnedN === 20,
      `status=${f3.res.status} qlen=${qlen} pinned=${pinnedN} ${f3.text.slice(0, 100)}`,
    );

    // F4：唯一性 —— 第二个 INITIAL_VOLUNTEER course / paper 被 DB 唯一约束拒绝
    let courseDup = false;
    try {
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO courses (public_id, team_id, title, required, status, created_by, deleted_at, purpose)
             VALUES (?, ?, 'dup', 0, 1, ?, NULL, 'INITIAL_VOLUNTEER')`,
          )
          .run(a26(42), TEAM_A_ID, VOL_A_ID),
      );
    } catch {
      courseDup = true;
    }
    check('F4a 第二个 INITIAL_VOLUNTEER course 被唯一约束拒绝', courseDup, `courseDup=${courseDup}`);

    let paperDup = false;
    try {
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, deleted_at, purpose)
             VALUES (?, ?, 'dup', NULL, '{}', 100, 90, 60, 3, 1, NULL, 'INITIAL_VOLUNTEER')`,
          )
          .run(a26(43), TEAM_A_ID),
      );
    } catch {
      paperDup = true;
    }
    check('F4b 第二个 INITIAL_VOLUNTEER paper 被唯一约束拒绝', paperDup, `paperDup=${paperDup}`);

    // F5：非 INITIAL_VOLUNTEER 试卷 pass_score 不被改成 90（迁移无 batch UPDATE）
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, deleted_at, purpose)
           VALUES (?, ?, 'normal', NULL, '{}', 100, 60, 60, 3, 1, NULL, '')`,
        )
        .run(a26(44), TEAM_A_ID),
    );
    const np = q1('SELECT pass_score FROM exam_papers WHERE public_id = ?', a26(44));
    check('F5 非 INITIAL_VOLUNTEER 试卷 pass_score 保持 60（未被改成 90）', np?.pass_score === 60, `pass_score=${np?.pass_score}`);
  }

  // ===================== Part G：pass_score 不变量 + 历史会话安全（FINAL SEMANTIC FIX）=====================
  {
    // --- G0..G3：pass_score=90 成为真实持久化事实（backend authority 强制 + DB 触发器终裁）---
    clearFacts();
    const ownerLogin = await login('P0C_OPENID_OWNER', 'P0C_UNIONID_OWNER');
    const ownerToken = ownerLogin.body?.data?.token ?? null;
    check(
      'G0 ownerA(team_owner, exam.paper.manage) 登录取得 token',
      ownerToken != null,
      `status=${ownerLogin.res.status} token=${!!ownerToken}`,
    );
    const adminHdr = { ...bearer(ownerToken), ...teamHdr(TEAM_A_ID) };
    const createPaper = (body) => req('POST', '/api/v2/exams/admin/papers', { headers: adminHdr, body });

    // G1：创建 INITIAL_VOLUNTEER 且入参 pass_score=60 → 持久化 90（backend authority 强制）
    const g1 = await createPaper({ title: 'P0C-G1', pick_rule: { count: 20 }, total_score: 100, pass_score: 60, purpose: 'INITIAL_VOLUNTEER' });
    const g1pid = g1.body?.data?.public_id ?? null;
    const g1row = g1pid ? q1('SELECT purpose, pass_score FROM exam_papers WHERE public_id = ?', g1pid) : null;
    check(
      'G1 创建 INITIAL_VOLUNTEER 试卷（入参 pass_score=60）→ 持久化 pass_score=90',
      g1.res.status === 201 && g1row?.purpose === 'INITIAL_VOLUNTEER' && g1row?.pass_score === 90,
      `status=${g1.res.status} row=${JSON.stringify(g1row)} ${g1.text.slice(0, 100)}`,
    );

    // G1b：DB 触发器拒绝把 INITIAL 试卷 pass_score 直接改成 60（数据层终裁，覆盖直连 DB 路径）
    let g1bRejected = false;
    try {
      withDb((db) => db.prepare('UPDATE exam_papers SET pass_score = 60 WHERE public_id = ?').run(g1pid));
    } catch {
      g1bRejected = true;
    }
    check(
      'G1b DB 触发器拒绝把 INITIAL 试卷 pass_score 改为 60（数据不变量）',
      g1bRejected && q1('SELECT pass_score FROM exam_papers WHERE public_id = ?', g1pid)?.pass_score === 90,
      `rejected=${g1bRejected}`,
    );

    // G2：普通试卷保持自身 pass_score（缺省 purpose=''）
    const g2 = await createPaper({ title: 'P0C-G2', pick_rule: { count: 20 }, total_score: 100, pass_score: 60 });
    const g2pid = g2.body?.data?.public_id ?? null;
    const g2row = g2pid ? q1('SELECT purpose, pass_score FROM exam_papers WHERE public_id = ?', g2pid) : null;
    check(
      'G2 普通考试试卷 pass_score 保持自身值 60（未被改成 90）',
      g2.res.status === 201 && g2row?.purpose === '' && g2row?.pass_score === 60,
      `status=${g2.res.status} row=${JSON.stringify(g2row)}`,
    );

    // G3：PUT 试图把 INITIAL 试卷 pass_score 改成 30 → 仍持久化为 90（阻止修改）
    const g3 = await req('PUT', `/api/v2/exams/admin/papers/${g1pid}`, {
      headers: adminHdr,
      body: { title: 'P0C-G1', pick_rule: { count: 20 }, total_score: 100, pass_score: 30 },
    });
    const g3row = q1('SELECT pass_score FROM exam_papers WHERE public_id = ?', g1pid);
    check(
      'G3 PUT 试图把 INITIAL 试卷 pass_score 改为 30 → 仍为 90（阻止修改）',
      g3.res.status === 200 && g3row?.pass_score === 90,
      `status=${g3.res.status} pass_score=${g3row?.pass_score} ${g3.text.slice(0, 100)}`,
    );

    // --- G4..G8：历史会话安全（qualification 必须基于真实 attempt 事实）---
    const examFact = async () => (await qGet()).body?.data?.initial_training_exam_passed === true;

    // G4：合法 INITIAL 会话（20 题 + 95 分 + passed + completed）→ true
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam();
    check('G4 合法 INITIAL 会话（20 题 + 95 分, passed, completed）→ training-exam=true', (await examFact()) === true);

    // G5：20 题但 score=89（<90）→ false（INITIAL 资格线 90）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ examScore: 89 });
    check('G5 20 题但 score=89(<90) → training-exam=false（90 分线）', (await examFact()) === false);

    // G6：19 题 + 95 分 → false（题量必须恰 20）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ questionCount: 19 });
    check('G6 19 题 + 95 分 → training-exam=false（题量门）', (await examFact()) === false);

    // G7：21 题 + 95 分 → false（题量必须恰 20）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ questionCount: 21 });
    check('G7 21 题 + 95 分 → training-exam=false（题量门）', (await examFact()) === false);

    // G8a：历史普通试卷会话（80 分 / 10 题）在其试卷被提升为 INITIAL 后 → false（score 门）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ promoteFromNormal: true, examScore: 80, questionCount: 10 });
    const g8aPaper = q1("SELECT purpose, pass_score FROM exam_papers WHERE team_id = ? AND purpose = 'INITIAL_VOLUNTEER'", TEAM_A_ID);
    check(
      'G8a 旧普通会话(80 分/10 题) 提升为 INITIAL 后 → training-exam=false（score 门）',
      g8aPaper?.purpose === 'INITIAL_VOLUNTEER' && g8aPaper?.pass_score === 90 && (await examFact()) === false,
      `paper=${JSON.stringify(g8aPaper)}`,
    );

    // G8b：历史普通试卷会话（95 分 / 10 题）提升为 INITIAL 后 → false（题量门）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ promoteFromNormal: true, examScore: 95, questionCount: 10 });
    check('G8b 旧普通会话(95 分/10 题) 提升为 INITIAL 后 → training-exam=false（题量门）', (await examFact()) === false);

    // G8c：历史会话事实本就满足 INITIAL rule（95 分 / 20 题）→ true（以事实为准，非时间戳/迁移版本）
    clearFacts();
    grantIdentityVerified();
    grantPhone();
    grantTrainingExam({ promoteFromNormal: true, examScore: 95, questionCount: 20 });
    check('G8c 旧会话事实满足 INITIAL rule（95 分/20 题, 提升后）→ training-exam=true（以事实为准）', (await examFact()) === true);
  }

  teardownFixture();
  process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
  if (fail > 0) process.stderr.write(`FAILED: ${fails.join(', ')}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`FATAL ${String(e)}\n`);
  try { teardownFixture(); } catch {}
  process.exitCode = 1;
});
