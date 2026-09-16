#!/usr/bin/env node
/**
 * G1-CROSS-TEAM-CHECKOUT-CLOSEOUT —— 跨团队 active-session 签退确定性合同测试。
 *
 * 冻结语义：
 * - ONE_VOLUNTEER_ONE_ACTIVE_SESSION = YES / ACTIVE_SESSION_SCOPE = GLOBAL_PER_USER。
 * - `GET /api/v2/attendance-sessions/me` 返回 active=true 后，同一用户【必须】能签退自己这条
 *   active session，无论当前 X-Team-Id 是否等于该会话所属 team。
 * - 签退所需 team 归属（tenant 过滤 / attendance_events.team_id / settlement / service_records）
 *   一律取自【会话自身 team_id】，绝不用请求头的当前团队（§3 / §7）。
 * - 这是 SELF 签退：identity 恒来自 server auth，客户端既不能指定 user 也不能指定 team。
 *
 * 两部分：
 *   A 组（静态合同）：service / repository / route 源码断言（权威 team 来源、分支、归属、G1 响应不变）。
 *   B 组（SQL 行为）：node:sqlite 真实 schema + fixture，执行源码里【实际发布的那几条 SQL】，
 *                     验证 Case A/B/C/D/E + downstream team attribution。
 *
 * 运行：node workers/tests/g1_cross_team_checkout.mjs   （无需 wrangler / D1 / node_modules）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS = join(HERE, '..');
const REPO_ROOT = join(WORKERS, '..');

const svcSrc = readFileSync(join(WORKERS, 'src/services/attendance-service.ts'), 'utf8');
const repoSrc = readFileSync(join(WORKERS, 'src/repository/attendance-sessions.ts'), 'utf8');
const signupSrc = readFileSync(join(WORKERS, 'src/repository/activity-signups.ts'), 'utf8');
const srSrc = readFileSync(join(WORKERS, 'src/repository/service-records.ts'), 'utf8');
const ptsSrc = readFileSync(join(WORKERS, 'src/repository/points-ledger.ts'), 'utf8');
const routeSrc = readFileSync(join(WORKERS, 'src/routes/activities.ts'), 'utf8');
const meRouteSrc = readFileSync(join(WORKERS, 'src/routes/attendance-sessions.ts'), 'utf8');
const migration0001 = readFileSync(join(WORKERS, 'migrations/0001_initial_schema.sql'), 'utf8');
const migration0004 = readFileSync(join(WORKERS, 'migrations/0004_attendance_multi_participation.sql'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

// ── 源码切片工具 ────────────────────────────────────────────────────────
function methodBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end === -1 ? src.length : end + 4);
}
function firstTemplate(body) {
  const a = body.indexOf('`');
  if (a < 0) return '';
  const b = body.indexOf('`', a + 1);
  return b === -1 ? '' : body.slice(a + 1, b);
}
/** 按 SQL 关键字锚定取模板（避免误取方法内其它模板串，如 nonce）。 */
function templateAround(body, marker) {
  const m = body.indexOf(marker);
  if (m < 0) return '';
  const a = body.lastIndexOf('`', m);
  if (a < 0) return '';
  const b = body.indexOf('`', m);
  return b === -1 ? '' : body.slice(a + 1, b);
}

// ══════════════════════════════════════════════════════════════════════
console.log('=== A 组：静态合同（service / repository / route） ===');
// ══════════════════════════════════════════════════════════════════════

const checkoutMethod = methodBody(svcSrc, 'async checkOutOwn(');
check(checkoutMethod.length > 0, 'service defines checkOutOwn');

// 1) 权威定位：全局唯一 active session（GLOBAL_PER_USER）
check(
  /findOwnActiveSessionForCheckout\(userId\)/.test(checkoutMethod),
  'checkOutOwn resolves the authoritative session via findOwnActiveSessionForCheckout(userId)',
);
check(
  !/findOwnActiveSessionAny\(/.test(checkoutMethod),
  'checkOutOwn does NOT use the team-filtered findOwnActiveSessionAny',
);

// 2) 分支：只有「请求活动 == active session 活动」才走会话 team 权威路径
check(
  /activeSession == null \|\| activeSession\.activity_public_id !== activityPublicId/.test(checkoutMethod),
  'falls back to the legacy in-team path when no active session OR requested activity != session activity',
);
check(
  /return this\.checkOutOwnInTeam\(activityPublicId, userId, teamId\)/.test(checkoutMethod),
  'fallback delegates to checkOutOwnInTeam (preserves original 404/409 semantics)',
);

// 3) 权威 team 来源 = 会话自身（§3）
check(
  /const sessionTeamId = activeSession\.team_id;/.test(checkoutMethod),
  'authoritative team comes from the SESSION (activeSession.team_id), not from the request header',
);
check(
  /const sessionTenant: TenantContext = \{ scope: 'TEAM_SCOPED', teamId: sessionTeamId, userId \};/.test(checkoutMethod),
  'a session-scoped TenantContext is derived from the session team',
);
check(
  /this\.repos\(sessionTenant\)\.signups\.findOwnActiveSignup\(/.test(checkoutMethod),
  'signup is resolved inside the SESSION team (not the current header team)',
);

// 4) 客户端不得指定身份/团队
check(
  /async checkOutOwn\(activityPublicId: string\)/.test(checkoutMethod),
  'checkOutOwn takes only activityPublicId (no client team_id / user_id / session id)',
);
check(!/c\.req\.query|c\.req\.json/.test(checkoutMethod), 'checkOutOwn never reads query or body (no client identity)');

// 5) 原子签退 / settlement 一律使用会话 team（§7 downstream integrity）
const finalizeBody = methodBody(svcSrc, 'private async finalizeCheckout(');
check(finalizeBody.length > 0, 'service defines finalizeCheckout (shared checkout tail)');
check(
  /new ServiceRecordService\(\{ db: this\.db, auth: this\.auth, tenant \}\)/.test(finalizeBody),
  'settlement service is constructed with the SESSION tenant (not this.tenant)',
);
check(
  /buildSettleStatementWithPoints\(\s*\n\s*session\.id,\s*\n\s*teamId,/.test(finalizeBody),
  'buildSettleStatementWithPoints receives the session team (teamId), not the header team',
);
check(
  /checkOutAtomically\(\s*\n\s*p\.signupId,\s*\n\s*userId,\s*\n\s*teamId,/.test(finalizeBody),
  'checkOutAtomically receives the session team (teamId), not the header team',
);
check(
  /if \(!ownershipPolicy\.canAct\(session, this\.auth\)\) throw notFound\('Attendance session'\)/.test(finalizeBody),
  'SELF ownership policy is still enforced (404 on failure)',
);
check(
  /if \(session\.status === ATTENDANCE_STATUS\.CHECKED_OUT\)/.test(finalizeBody),
  'already-checked-out still short-circuits to 409 (not masked by a 0-row UPDATE)',
);

// 6) 既有（当前团队）路径逐行保留，未放宽
const legacyBody = methodBody(svcSrc, 'private async checkOutOwnInTeam(');
check(legacyBody.length > 0, 'legacy in-team path is preserved as checkOutOwnInTeam');
check(/findSignupTargetByPublicId\(activityPublicId\)/.test(legacyBody), 'legacy path still resolves activity inside the team (404)');
check(/findOwnActiveSignup\(activity\.id, userId\)/.test(legacyBody), 'legacy path still validates own active signup (409 NOT_SIGNED_UP)');
check(/findOwnActiveSession\(signup\.id, userId\)/.test(legacyBody), 'legacy path still looks up the team-scoped active session (409 CHECKIN_REQUIRED)');
check(/this\.repos\(\)/.test(legacyBody) && !/this\.repos\(sessionTenant\)/.test(legacyBody), 'legacy path uses the request tenant only (no scope widening)');

// 7) 权限未变 / 未新增 permission
check(
  /requirePermission\('attendance\.record\.checkout'\)/.test(routeSrc),
  'route still requires attendance.record.checkout (no new permission)',
);
check(
  !/attendance\.record\.read/.test(routeSrc) && !/attendance\.record\.read/.test(svcSrc),
  'no attendance.record.read permission was introduced in this closeout',
);

// 8) G1 public response 未变（§4：不得因本轮扩展 /me）
check(
  /active: true,\s*\n\s*session: \{\s*\n\s*activity_public_id: row\.activity_public_id,\s*\n\s*checkin_at: row\.checkin_at,\s*\n\s*\}/.test(meRouteSrc),
  'G1 /me public response is unchanged: { active:true, session:{ activity_public_id, checkin_at } }',
);
check(
  !/participation_id|checkout_at:|team_id:/.test(
    meRouteSrc.slice(meRouteSrc.indexOf("sessions.get('/me'"), meRouteSrc.indexOf('\nsessions.', meRouteSrc.indexOf("sessions.get('/me'") + 10)),
  ),
  'G1 /me response was NOT widened with internal/team/PII fields',
);

// 9) 仓储新方法：GLOBAL_PER_USER + 参数化 + 内部字段仅内部使用
const lookupBody = methodBody(repoSrc, 'async findOwnActiveSessionForCheckout(');
check(lookupBody.length > 0, 'repository defines findOwnActiveSessionForCheckout');
check(/ensureTableRead\('attendance_sessions'\)/.test(lookupBody), 'new lookup still enforces the table read guard (no auth/tenant bypass)');
check(/WHERE s\.user_id = \?/.test(lookupBody), 'lookup filters by user_id (SELF)');
check(/AND s\.status = \?/.test(lookupBody), 'lookup filters status = ? (CHECKED_IN)');
check(/AND s\.checkout_at IS NULL/.test(lookupBody), 'lookup filters checkout_at IS NULL (one business predicate)');
check(/LIMIT 1/.test(lookupBody), 'lookup has LIMIT 1');
check(/JOIN activities a ON a\.id = s\.activity_id/.test(lookupBody), 'lookup JOINs activities to obtain the public identifier');
check(/a\.public_id AS activity_public_id/.test(lookupBody), 'lookup projects activities.public_id AS activity_public_id');
check(!/team_id\s*=\s*\?/.test(lookupBody), 'lookup does NOT filter by team_id (GLOBAL_PER_USER)');

const lookupSql = templateAround(lookupBody, 'SELECT s.id, s.signup_id');
check(lookupSql.trim().length > 0, 'extracted the shipped lookup SQL for behavioral test');
check(!/\$\{/.test(lookupSql), 'lookup SQL is fully parameterized (no template interpolation)');

// 10) 未建 migration / 未新增列
const migFiles = readdirSync(join(WORKERS, 'migrations'));
const addedPublicId = migFiles.some((f) =>
  /ALTER TABLE attendance_sessions[\s\S]{0,300}public_id/i.test(readFileSync(join(WORKERS, 'migrations', f), 'utf8')),
);
check(!addedPublicId, 'no migration adds attendance_sessions.public_id (none created this round)');
check(
  /CREATE UNIQUE INDEX IF NOT EXISTS uq_active_attendance\s*\n\s*ON attendance_sessions\(user_id\) WHERE status = 1 AND checkout_at IS NULL/.test(migration0004),
  'one-active-session DB invariant UNIQUE(user_id) is still intact',
);

// 11) 积分归属：points 域无 team 维度（不可能被 TEAM_B 污染）
check(
  !/teamId/.test(ptsSrc.slice(ptsSrc.indexOf('export interface ServicePointsInput'), ptsSrc.indexOf('export interface ServicePointsStatements'))),
  'points statement input has no teamId (team attribution cannot be forged there)',
);
check(
  /CREATE TABLE IF NOT EXISTS points_accounts \([\s\S]*?\)/.test(migration0001) &&
    !/team_id/.test(migration0001.slice(migration0001.indexOf('CREATE TABLE IF NOT EXISTS points_accounts'), migration0001.indexOf('CREATE TABLE IF NOT EXISTS growth_rules'))),
  'points_accounts has NO team_id column (0001): points are per-user, team pollution impossible',
);

// ══════════════════════════════════════════════════════════════════════
console.log('=== B 组：SQL 行为（node:sqlite 真实 schema + fixture） ===');
// ══════════════════════════════════════════════════════════════════════

// ── 其余待执行 SQL 的抽取 ──────────────────────────────────────────────
const signupSql = templateAround(methodBody(signupSrc, 'async findOwnActiveSignup('), 'SELECT s.id, s.activity_id');
check(signupSql.trim().length > 0, 'extracted findOwnActiveSignup SQL');

const coBody = methodBody(repoSrc, 'async checkOutAtomically(');
const CO_INSERT_SQL = templateAround(coBody, 'INSERT INTO attendance_events');
const CO_UPDATE_SQL = templateAround(coBody, 'UPDATE attendance_sessions');
check(/INSERT INTO attendance_events/.test(CO_INSERT_SQL), 'extracted checkout event INSERT...SELECT SQL');
check(/UPDATE attendance_sessions/.test(CO_UPDATE_SQL), 'extracted checkout conditional UPDATE SQL');

const legacySessionSql = templateAround(methodBody(repoSrc, 'async findOwnActiveSession('), 'SELECT id, signup_id');
check(legacySessionSql.trim().length > 0, 'extracted legacy (team-scoped) findOwnActiveSession SQL');

// settlement SQL（含服务器内部常量插值，此处按源码常量逐个替换；残留 ${ 立即判 FAIL）
let SETTLE_SQL = templateAround(methodBody(srSrc, 'buildSettleStatement(p: SettlementInput)'), 'WITH settled AS');
check(SETTLE_SQL.trim().length > 0, 'extracted settlement SQL');
SETTLE_SQL = SETTLE_SQL.replace(/\$\{MULTIPLIER_BASE\}/g, '100')
  .replace(/\$\{POINTS_MIN_MINUTES\}/g, '30')
  .replace(/\$\{POINTS_BASE_UNITS_PER_HOUR\}/g, '100')
  .replace(/\$\{SETTLEMENT_STATUS\.EFFECTIVE\}/g, '1')
  .replace(/\$\{anomalyBlock\}/g, 'x.status IN (1,2)')
  .replace(/\$\{\s*\/\*[\s\S]*?\*\/\s*(\d+)\s*\}/g, '$1')
  .replace(/\$\{(\d+)\}/g, '$1');
check(!/\$\{/.test(SETTLE_SQL), 'settlement SQL constants fully resolved for the behavioral run');

// ── schema ────────────────────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE activities (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, team_id INTEGER NOT NULL,
  title TEXT, deleted_at INTEGER, points_multiplier_pct INTEGER, max_session_minutes INTEGER
);
CREATE TABLE activity_signups (
  id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  review_status INTEGER NOT NULL DEFAULT 1, status INTEGER NOT NULL DEFAULT 1,
  cancel_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE activity_participations (
  id INTEGER PRIMARY KEY, signup_id INTEGER NOT NULL, occurrence_id INTEGER,
  slot_id INTEGER, occurrence_position_id INTEGER, status INTEGER, cancelled_at INTEGER
);
CREATE TABLE attendance_sessions (
  id INTEGER PRIMARY KEY, signup_id INTEGER NOT NULL, activity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, team_id INTEGER NOT NULL, participation_id INTEGER,
  service_date INTEGER NOT NULL DEFAULT 0, slot TEXT, checkin_at INTEGER, checkout_at INTEGER,
  status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2,3,4)),
  review_status INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER,
  business_service_date TEXT
);
CREATE UNIQUE INDEX uq_active_attendance
  ON attendance_sessions(user_id) WHERE status = 1 AND checkout_at IS NULL;
CREATE TABLE attendance_events (
  id INTEGER PRIMARY KEY, session_id INTEGER, activity_id INTEGER, user_id INTEGER, team_id INTEGER,
  event_type TEXT, nonce TEXT, operator_id INTEGER, reason TEXT, raw TEXT,
  occurred_at INTEGER, created_at INTEGER, latitude REAL, longitude REAL, accuracy REAL
);
CREATE UNIQUE INDEX uq_event_nonce ON attendance_events(nonce);
CREATE TABLE attendance_anomalies (id INTEGER PRIMARY KEY, session_id INTEGER, status INTEGER);
CREATE TABLE service_records (
  id INTEGER PRIMARY KEY, session_id INTEGER UNIQUE, user_id INTEGER, team_id INTEGER,
  activity_id INTEGER, minutes INTEGER, source TEXT, service_date INTEGER,
  business_service_date TEXT, points_min_minutes INTEGER, points_base_units_per_hour INTEGER,
  points_multiplier_pct INTEGER, points_awarded_units INTEGER, settlement_status INTEGER,
  public_id TEXT, status INTEGER, review_status INTEGER, points_revision INTEGER,
  created_at INTEGER, updated_at INTEGER
);
`);

const PUB_A = '01ACT' + 'A'.repeat(21);
const PUB_B = '01ACT' + 'B'.repeat(21);
const ACT_A = 11;
const ACT_B = 22;
const TEAM_A = 201;
const TEAM_B = 202;

const U_SAME = 101;   // Case A：当前团队 == 会话团队
const U_CROSS = 102;  // Case B：当前团队 != 会话团队
const U_MISMATCH = 103; // Case E：active 在 A 活动，请求 checkout B 活动
const U_NONE = 104;   // Case D：无 active session
const U_OTHER = 105;  // 其他用户（不得签退他人会话）

db.prepare('INSERT INTO activities (id, public_id, team_id, title, deleted_at) VALUES (?,?,?,?,NULL)').run(ACT_A, PUB_A, TEAM_A, 'A队活动');
db.prepare('INSERT INTO activities (id, public_id, team_id, title, deleted_at) VALUES (?,?,?,?,NULL)').run(ACT_B, PUB_B, TEAM_B, 'B队活动');

const insSignup = db.prepare('INSERT INTO activity_signups (id, activity_id, user_id, review_status, status) VALUES (?,?,?,1,1)');
const insPart = db.prepare('INSERT INTO activity_participations (id, signup_id) VALUES (?,?)');
const insSession = db.prepare(`INSERT INTO attendance_sessions
  (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot,
   checkin_at, checkout_at, status, review_status, created_at, updated_at, business_service_date)
  VALUES (?,?,?,?,?,?,0,NULL,?,?,?,0,0,NULL,'2026-09-16')`);

// 每个用户在 TEAM_A/ACT_A 下有自己的 signup + participation + 活跃会话
let sidSeq = 0;
function seedUserInTeamA(userId, { active = true } = {}) {
  sidSeq += 1;
  const signupId = sidSeq;
  const partId = signupId;
  insSignup.run(signupId, ACT_A, userId);
  insPart.run(partId, signupId);
  const sessionId = 1000 + sidSeq;
  insSession.run(sessionId, signupId, ACT_A, userId, TEAM_A, partId, 1000, null, active ? 1 : 2);
  return { signupId, sessionId, partId };
}

const A_SAME = seedUserInTeamA(U_SAME);
const A_CROSS = seedUserInTeamA(U_CROSS);
const A_MISMATCH = seedUserInTeamA(U_MISMATCH);
seedUserInTeamA(U_NONE, { active: false }); // 已签退，不算 active
const A_OTHER = seedUserInTeamA(U_OTHER);

const qLookup = db.prepare(lookupSql);
const lookup = (userId) => qLookup.get(userId, 1); // bind [userId, ATTENDANCE_STATUS.CHECKED_IN]

const qSignup = db.prepare(signupSql);
const findSignup = (activityId, userId, teamId) => qSignup.get(activityId, userId, 1, teamId);

const qLegacy = db.prepare(legacySessionSql);
const legacyActive = (signupId, userId, teamId) => qLegacy.get(signupId, userId, teamId, 1);

const qEvent = db.prepare(CO_INSERT_SQL);
const qUpdate = db.prepare(CO_UPDATE_SQL);
const qSettle = db.prepare(SETTLE_SQL);

function atomicCheckout({ signupId, userId, teamId, activityId, sessionId, now, nonce }) {
  const ev = qEvent.run(activityId, userId, teamId, nonce, userId, now, now, signupId, userId, teamId);
  const up = qUpdate.run(2, now, now, signupId, userId, teamId);
  const settle = qSettle.run(sessionId, teamId, nonce, nonce, '01SR' + String(sessionId).padStart(22, '0'), now, now);
  return { events: Number(ev?.changes ?? 0), changes: Number(up?.changes ?? 0), sr: Number(settle?.changes ?? 0) };
}

// ── B1. 权威定位：GLOBAL_PER_USER，不带 team 过滤 ──────────────────────
const sSame = lookup(U_SAME);
check(sSame != null, 'B1 user with an active session is found by the authoritative lookup');
check(sSame?.team_id === TEAM_A, 'B1 authoritative session exposes its REAL team (TEAM_A)');
check(sSame?.activity_public_id === PUB_A, 'B1 authoritative session exposes activities.public_id (not the internal activity_id)');
check(sSame?.id === A_SAME.sessionId, 'B1 authoritative session is the user\'s own unique active session');

// ── B2. Case A：当前团队 == 会话团队 → 签退 PASS ───────────────────────
const signupSame = findSignup(ACT_A, U_SAME, TEAM_A);
check(signupSame != null, 'Case A own active signup resolved inside the session team');
const nowA = 1000 + 3600;
const nonceA = 'checkout:A:' + nowA;
const rA = atomicCheckout({ ...A_SAME, userId: U_SAME, teamId: TEAM_A, activityId: ACT_A, now: nowA, nonce: nonceA });
check(rA.events === 1, 'Case A checkout event written exactly once');
check(rA.changes === 1, 'Case A atomic UPDATE changed 1 row (checkout succeeded)');
const rowA = db.prepare('SELECT status, checkout_at, team_id FROM attendance_sessions WHERE id=?').get(A_SAME.sessionId);
check(rowA.status === 2 && rowA.checkout_at === nowA, 'Case A session closed (status=2 + checkout_at)');
check(rowA.team_id === TEAM_A, 'Case A session team attribution unchanged (still TEAM_A)');
check(lookup(U_SAME) == null, 'Case A after checkout the authoritative lookup returns null (active=false)');
const evA = db.prepare('SELECT team_id, event_type FROM attendance_events WHERE session_id=?').get(A_SAME.sessionId);
check(evA?.team_id === TEAM_A, 'Case A checkout event team attribution = TEAM_A (not the header team)');
const srA = db.prepare('SELECT team_id, user_id, minutes, settlement_status FROM service_records WHERE session_id=?').get(A_SAME.sessionId);
check(srA?.team_id === TEAM_A, 'Case A ServiceRecord team attribution = TEAM_A (downstream integrity)');
check(srA?.user_id === U_SAME && srA?.minutes === 60, 'Case A ServiceRecord carries the real user and 60 minutes');
check(srA?.settlement_status === 1, 'Case A ServiceRecord is EFFECTIVE (transition-gate hit)');

// ── B3. Case B：当前团队 = TEAM_B，会话在 TEAM_A → 签退也必须 PASS ──────
//   先证明【旧】行为确实会失败（这就是本轮要关闭的缺陷）
check(findSignup(ACT_A, U_CROSS, TEAM_B) == null, 'OLD behaviour reproduced: signup lookup with header team TEAM_B finds nothing (409 NOT_SIGNED_UP)');
const rOld = atomicCheckout({ ...A_CROSS, userId: U_CROSS, teamId: TEAM_B, activityId: ACT_A, now: 5000, nonce: 'old:B' });
check(rOld.changes === 0, 'OLD behaviour reproduced: atomic checkout with header team TEAM_B changes 0 rows (409)');
check(
  db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE session_id=?').get(A_CROSS.sessionId).n === 0,
  'OLD behaviour wrote no event (no side effect on the failed guard)',
);

//   新行为：team 取自会话自身 → PASS
const sCross = lookup(U_CROSS);
check(sCross?.activity_public_id === PUB_A, 'Case B requested activity public id matches the session activity (routing condition holds)');
const signupCross = findSignup(ACT_A, U_CROSS, sCross.team_id);
check(signupCross != null, 'Case B own active signup resolved inside the SESSION team (TEAM_A)');
const nowB = 1000 + 7200;
const nonceB = 'checkout:B:' + nowB;
const rB = atomicCheckout({ ...A_CROSS, userId: U_CROSS, teamId: sCross.team_id, activityId: ACT_A, now: nowB, nonce: nonceB });
check(rB.events === 1, 'Case B cross-team checkout event written exactly once');
check(rB.changes === 1, 'Case B cross-team checkout SUCCEEDS (this is the closeout)');
const rowB = db.prepare('SELECT status, checkout_at, team_id FROM attendance_sessions WHERE id=?').get(A_CROSS.sessionId);
check(rowB.status === 2 && rowB.checkout_at === nowB, 'Case B session correctly closed');
check(rowB.team_id === TEAM_A, 'Case B session team is STILL TEAM_A (not overwritten by TEAM_B)');
check(lookup(U_CROSS) == null, 'Case B after cross-team checkout the authoritative lookup returns null (active=false)');
const evB = db.prepare('SELECT team_id FROM attendance_events WHERE session_id=?').get(A_CROSS.sessionId);
check(evB?.team_id === TEAM_A, 'Case B audit/event team attribution = TEAM_A (never TEAM_B)');
const srB = db.prepare('SELECT team_id, user_id FROM service_records WHERE session_id=?').get(A_CROSS.sessionId);
check(srB?.team_id === TEAM_A, 'Case B ServiceRecord team = TEAM_A (no TEAM_B pollution)');
check(srB?.team_id !== TEAM_B, 'Case B ServiceRecord is NOT attributed to the header team TEAM_B');
check(srB?.user_id === U_CROSS, 'Case B ServiceRecord belongs to the authenticated user');

// ── B4. Case E：active 在活动 A，请求 checkout 活动 B → 拒绝 ────────────
const sMis = lookup(U_MISMATCH);
check(sMis?.activity_public_id === PUB_A, 'Case E authoritative session belongs to activity A');
check(sMis?.activity_public_id !== PUB_B, 'Case E requested activity B does NOT match the active session → legacy/deny branch');
// 旧路径下：即使当前团队换成 TEAM_B 且用户在 B 活动有报名，也拿不到 active session → 409
const signupB = findSignup(ACT_B, U_MISMATCH, TEAM_B);
check(signupB == null, 'Case E no active signup for activity B (denied by the legacy branch)');
check(
  legacyActive(A_MISMATCH.signupId, U_MISMATCH, TEAM_B) == null,
  'Case E team-scoped active session lookup finds nothing for activity B → 409 CHECKIN_REQUIRED (rejected)',
);
check(
  db.prepare('SELECT status FROM attendance_sessions WHERE id=?').get(A_MISMATCH.sessionId).status === 1,
  'Case E the real active session was NOT touched (stay CHECKED_IN)',
);

// ── B5. Case D：无 active session → 保持既有错误语义 ────────────────────
check(lookup(U_NONE) == null, 'Case D user with no active session → authoritative lookup null (409 path)');
check(legacyActive(A_OTHER.signupId, U_NONE, TEAM_A) == null, 'Case D legacy lookup also null (unchanged CHECKIN_REQUIRED contract)');

// ── B6. 其他用户不得签退该会话（SELF） ─────────────────────────────────
check(lookup(U_OTHER) != null, 'B6 other user has their own active session');
const rOther = atomicCheckout({ ...A_SAME, userId: U_OTHER, teamId: TEAM_A, activityId: ACT_A, now: 9000, nonce: 'other' });
check(rOther.changes === 0, 'B6 another user CANNOT checkout someone else\'s session (0 rows)');
const rOtherUserTarget = atomicCheckout({ ...A_OTHER, userId: U_SAME, teamId: TEAM_A, activityId: ACT_A, now: 9100, nonce: 'other2' });
check(rOtherUserTarget.changes === 0, 'B6 user cannot checkout a session whose signup is not theirs (0 rows)');

// ── B7. 幂等：重复签退不产生第二次副作用 ──────────────────────────────
const rDup = atomicCheckout({ ...A_SAME, userId: U_SAME, teamId: TEAM_A, activityId: ACT_A, now: nowA + 10, nonce: 'dup:1' });
check(rDup.changes === 0, 'duplicate checkout changes 0 rows (idempotent)');
check(
  db.prepare('SELECT COUNT(*) AS n FROM service_records WHERE session_id=?').get(A_SAME.sessionId).n === 1,
  'duplicate checkout creates no second ServiceRecord (transition-gate holds)',
);

// ── B8. one-active-session DB 不变式仍然成立 ───────────────────────────
let uniqueBlocked = false;
try {
  insSession.run(9999, A_OTHER.signupId, ACT_A, U_OTHER, TEAM_A, A_OTHER.partId, 7000, null, 1);
} catch (e) {
  uniqueBlocked = /UNIQUE/i.test(String(e.message));
}
check(uniqueBlocked, 'second active session for the same user is still rejected by the DB UNIQUE invariant');

// ── B9. 读取不产生写 ──────────────────────────────────────────────────
const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM attendance_sessions').get().c;
const beforeEvents = db.prepare('SELECT COUNT(*) AS c FROM attendance_events').get().c;
lookup(U_SAME);
lookup(U_CROSS);
lookup(U_NONE);
lookup(U_OTHER);
const afterCount = db.prepare('SELECT COUNT(*) AS c FROM attendance_sessions').get().c;
const afterEvents = db.prepare('SELECT COUNT(*) AS c FROM attendance_events').get().c;
check(beforeCount === afterCount && beforeEvents === afterEvents, 'authoritative lookup performs no mutation (pure read)');

db.close();

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
