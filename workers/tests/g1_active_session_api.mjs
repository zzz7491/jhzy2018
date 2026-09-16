#!/usr/bin/env node
/**
 * G1 —— GET /api/v2/attendance-sessions/me 确定性合同测试。
 *
 * 冻结语义（G1）：
 * - ACTIVE predicate = status = 1 AND checkout_at IS NULL（与 checkin/checkout 同一业务语义）。
 * - SCOPE = GLOBAL_PER_USER：不按当前 X-Team-Id 过滤。
 * - SELF BY CONSTRUCTION：查询对象恒为 server-authenticated user。
 * - 纯读，无任何 DB mutation。
 * - 响应 allowlist：active；active=true 时仅 session.activity_public_id + session.checkin_at。
 *
 * 两部分：
 *   A 组（静态合同）：路由 / 仓储源码断言（授权、字面量优先、strict-input、allowlist、无写）。
 *   B 组（SQL 行为）：用 node:sqlite 建真实 schema + fixture，执行仓储里【实际发布的那条 SQL】，
 *                     验证 predicate / global-per-user / JOIN 映射 / checkout / force-checkout。
 *
 * 运行：node workers/tests/g1_active_session_api.mjs   （无需 wrangler / D1 / node_modules）
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const routeSrc = readFileSync(join(ROOT, 'src/routes/attendance-sessions.ts'), 'utf8');
const repoSrc = readFileSync(join(ROOT, 'src/repository/attendance-sessions.ts'), 'utf8');
const migrationSrc = readFileSync(join(ROOT, 'migrations/0004_attendance_multi_participation.sql'), 'utf8');

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

// ── 源码切片：/me handler ────────────────────────────────────────────────
const ME_START = routeSrc.indexOf("sessions.get('/me'");
const nextRouteAfterMe = routeSrc.indexOf('\nsessions.', ME_START + 10);
const meHandler = ME_START >= 0
  ? routeSrc.slice(ME_START, nextRouteAfterMe === -1 ? routeSrc.length : nextRouteAfterMe)
  : '';

console.log('=== A 组：静态合同（路由 / 仓储） ===');

// 1) 路由存在 + 路径 + 权限 + 认证
check(ME_START >= 0, "route defines sessions.get('/me')");
check(
  /sessions\.get\('\/me',\s*requirePermission\('attendance\.record\.checkin'\)/.test(routeSrc),
  '/me requires attendance.record.checkin (裁决：不新增权限)',
);
check(meHandler.length > 0, '/me handler slice extracted');
check(/if \(!auth\.authenticated\) throw authRequired\(\)/.test(meHandler), '/me rejects unauthenticated (401 authRequired)');
check(/const userId = auth\.userId/.test(meHandler), '/me takes userId from server auth context');
check(/if \(userId == null\) throw authRequired\(\)/.test(meHandler), '/me rejects missing server userId');

// 2) 字面量 /me 必须注册在任何动态段之前
const firstDynamic = routeSrc.search(/sessions\.(get|post)\('\/:/);
check(ME_START >= 0 && ME_START < firstDynamic, '/me registered BEFORE any dynamic /:param route');

// 3) strict-input：拒绝 query，特别是 user_id / team_id
check(/for \(const k of Object\.keys\(c\.req\.query\(\) \?\? \{\}\)\)/.test(meHandler), '/me iterates query keys (strict-input)');
check(/throw invalidParam\(/.test(meHandler), '/me throws invalidParam on any query key');
check(/identity is server-derived/.test(meHandler), '/me explicitly rejects user_id/team_id as identity override');
check(!/c\.req\.json\(\)/.test(meHandler), '/me does NOT read request body (no client identity from body)');

// 4) 不使用受 team_id 限制的旧查询
check(
  /findOwnActiveSessionGlobal\(/.test(meHandler) && !/findOwnActiveSessionAny\(/.test(meHandler),
  '/me uses findOwnActiveSessionGlobal (NOT the team-filtered findOwnActiveSessionAny)',
);

// 5) 响应 allowlist
check(/return ok\(c, \{ active: false \}\)/.test(meHandler), 'no-active response is exactly { active: false }');
check(/active: true,\s*\n\s*session: \{\s*\n\s*activity_public_id: row\.activity_public_id,\s*\n\s*checkin_at: row\.checkin_at,\s*\n\s*\}/.test(meHandler), 'active response is { active:true, session:{ activity_public_id, checkin_at } }');

// 6) 禁止字段（G1 §10）
const FORBIDDEN_IN_RESPONSE = [
  'session.id', 'activity_id:', 'user_id:', 'team_id:', 'participation_id',
  'checkout_at:', 'status:', 'latitude', 'longitude', 'accuracy', 'device', 'ip_hash',
  'risk_score', 'nickname', 'phone', 'birthday', 'id_card', 'openid', 'minutes', 'points',
];
const leaked = FORBIDDEN_IN_RESPONSE.filter((f) => meHandler.includes(f));
check(leaked.length === 0, `/me exposes no forbidden field (leaked: ${leaked.length ? leaked.join(',') : 'none'})`);
// G1 裁决已删除 session.public_id；此处精确排除 session 级 public_id（不误伤 activity_public_id）。
check(
  !/session\.public_id|public_id:\s*row\.public_id|(?<!activity_)public_id:\s*row\./.test(meHandler),
  '/me does NOT return a session-level public_id (removed by G1 ruling)',
);

// 7) 纯读：handler 内无任何写操作
const MUTATION_MARKERS = ['INSERT ', 'UPDATE ', 'DELETE ', '.batch(', 'this.run(', '.run(', 'insertEvent', 'checkOut', 'forceCheckout'];
const mutations = MUTATION_MARKERS.filter((m) => meHandler.includes(m));
check(mutations.length === 0, `/me performs no DB mutation (found: ${mutations.length ? mutations.join(',') : 'none'})`);

// 8) 仓储方法：GLOBAL_PER_USER + 参数化 + JOIN
const methodSlice = repoSrc.slice(repoSrc.indexOf('async findOwnActiveSessionGlobal('));
const methodBody = methodSlice.slice(0, methodSlice.indexOf('\n  }\n') + 4);
check(methodBody.length > 0, 'repository defines findOwnActiveSessionGlobal');
check(/ensureTableRead\('attendance_sessions'\)/.test(methodBody), 'repository still enforces table read guard (no auth bypass)');
check(/WHERE s\.user_id = \?/.test(methodBody), 'SQL filters by user_id (SELF)');
check(/AND s\.status = \?/.test(methodBody), 'SQL filters status = ? (bound to CHECKED_IN)');
check(/AND s\.checkout_at IS NULL/.test(methodBody), 'SQL filters checkout_at IS NULL');
check(/JOIN activities a ON a\.id = s\.activity_id/.test(methodBody), 'SQL JOINs activities to map public identifier');
check(/a\.public_id AS activity_public_id/.test(methodBody), 'SQL projects activities.public_id AS activity_public_id');
check(/LIMIT 1/.test(methodBody), 'SQL has LIMIT 1');
check(!/team_id\s*=\s*\?/.test(methodBody), 'SQL does NOT filter by team_id (GLOBAL_PER_USER)');
check(!/\$\{/.test(methodBody.slice(methodBody.indexOf('`'), methodBody.lastIndexOf('`'))), 'SQL is parameterized (no template interpolation)');
check(/\[userId, ATTENDANCE_STATUS\.CHECKED_IN\]/.test(methodBody), 'bind params are [userId, CHECKED_IN]');

// 9) 冻结不变式：DB 层 UNIQUE(user_id) partial index 仍然存在
check(
  /CREATE UNIQUE INDEX IF NOT EXISTS uq_active_attendance\s*\n\s*ON attendance_sessions\(user_id\) WHERE status = 1 AND checkout_at IS NULL/.test(migrationSrc),
  'migration 0004 keeps UNIQUE(user_id) WHERE status=1 AND checkout_at IS NULL',
);

// ── 提取仓储里实际发布的那条 SQL ─────────────────────────────────────────
const sqlStart = methodBody.indexOf('`');
const sqlEnd = methodBody.indexOf('`', sqlStart + 1);
const ACTIVE_SQL = methodBody.slice(sqlStart + 1, sqlEnd);
check(ACTIVE_SQL.trim().length > 0, 'extracted the shipped SQL for behavioral test');

console.log('=== B 组：SQL 行为（node:sqlite 真实 schema + fixture） ===');

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  title TEXT,
  deleted_at INTEGER
);
CREATE TABLE attendance_sessions (
  id INTEGER PRIMARY KEY,
  signup_id INTEGER NOT NULL,
  activity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  participation_id INTEGER,
  service_date INTEGER NOT NULL DEFAULT 0,
  slot TEXT,
  checkin_at INTEGER,
  checkout_at INTEGER,
  status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2,3,4)),
  review_status INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  business_service_date TEXT
);
CREATE UNIQUE INDEX uq_active_attendance
  ON attendance_sessions(user_id) WHERE status = 1 AND checkout_at IS NULL;
`);

const PUB_A = '01ACT' + 'A'.repeat(21); // 26-char ULID
const PUB_B = '01ACT' + 'B'.repeat(21);
const [ACT_A, ACT_B] = [11, 22];
const [TEAM_A, TEAM_B] = [201, 202];
const [U_ACTIVE_A, U_CHECKED_OUT, U_ACTIVE_B, U_CANCELLED, U_FORCED] = [101, 102, 103, 104, 105];

db.prepare('INSERT INTO activities (id, public_id, title, deleted_at) VALUES (?,?,?,NULL)').run(ACT_A, PUB_A, 'A队活动');
db.prepare('INSERT INTO activities (id, public_id, title, deleted_at) VALUES (?,?,?,NULL)').run(ACT_B, PUB_B, 'B队活动');

const ins = db.prepare(`INSERT INTO attendance_sessions
  (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot,
   checkin_at, checkout_at, status, review_status, created_at, updated_at, business_service_date)
  VALUES (?,?,?,?,?,?,0,NULL,?,?,?,0,0,NULL,NULL)`);
ins.run(1, 1, ACT_A, U_ACTIVE_A, TEAM_A, 1, 1000, null, 1);          // 活跃（A 队）
ins.run(2, 2, ACT_A, U_CHECKED_OUT, TEAM_A, 2, 1100, 2000, 2);       // 正常签退
ins.run(3, 3, ACT_B, U_ACTIVE_B, TEAM_B, 3, 1500, null, 1);          // 活跃（B 队）
ins.run(4, 4, ACT_A, U_CANCELLED, TEAM_A, 4, 1200, null, 4);         // 已取消
ins.run(5, 5, ACT_A, U_FORCED, TEAM_A, 5, 1300, 3000, 2);            // force-checkout

const stmt = db.prepare(ACTIVE_SQL);
const q = (userId) => stmt.get(userId, 1); // bind [userId, ATTENDANCE_STATUS.CHECKED_IN]

// B1. 有 active → 命中
const rActiveA = q(U_ACTIVE_A);
check(rActiveA != null, 'active session in current team → row returned (active=true)');
check(rActiveA?.checkin_at === 1000, 'active row exposes real checkin_at');

// B2. activity identifier 来自 activities.public_id，不是内部 activity_id
check(rActiveA?.activity_public_id === PUB_A, 'activity_public_id comes from activities.public_id');
check(rActiveA?.activity_public_id !== String(ACT_A), 'activity_public_id is NOT the internal activity_id');
check(/^01[0-9A-HJKMNP-TV-Z]{24}$/.test(String(rActiveA?.activity_public_id ?? '')), 'activity_public_id is a 26-char Crockford ULID');

// B3. 响应列严格 = allowlist（不多一列）
const keys = Object.keys(rActiveA ?? {}).sort();
check(keys.length === 2 && keys[0] === 'activity_public_id' && keys[1] === 'checkin_at', `row projection is exactly [activity_public_id, checkin_at] (got ${keys.join(',')})`);

// B4. 无 active → null
check(q(999) == null, 'user with no session → null (active=false)');

// B5. 已签退 → 不算 active
check(q(U_CHECKED_OUT) == null, 'checked-out session (status=2) is NOT active');

// B6. force-checkout → 不算 active
check(q(U_FORCED) == null, 'force-checked-out session (status=2 + checkout_at) is NOT active');

// B7. 已取消 → 不算 active
check(q(U_CANCELLED) == null, 'cancelled session (status=4, checkout_at NULL) is NOT active');

// B8. 关键：active session 在另一个 team，仍必须被发现（GLOBAL_PER_USER）
const rActiveB = q(U_ACTIVE_B);
check(rActiveB != null, 'active session in ANOTHER team is still found (no team_id filter)');
check(rActiveB?.activity_public_id === PUB_B, 'cross-team active session maps to correct activity public_id');

// B9. 不得读到他人 session（SELF）
check(q(U_ACTIVE_A)?.activity_public_id !== undefined && q(U_CHECKED_OUT) == null, 'query is SELF-scoped (other users not reachable via same predicate)');

// B10. DB 不变式：同用户第二条 active 会话被 UNIQUE 拒绝（不靠应用层挑选）
let uniqueBlocked = false;
try {
  ins.run(9, 9, ACT_A, U_ACTIVE_A, TEAM_A, 9, 4000, null, 1);
} catch (e) {
  uniqueBlocked = /UNIQUE/i.test(String(e.message));
}
check(uniqueBlocked, 'second active session for same user is rejected by DB UNIQUE invariant');

// B11. 纯读：执行 SQL 后数据未变
const before = db.prepare('SELECT COUNT(*) AS c FROM attendance_sessions').get().c;
q(U_ACTIVE_A);
q(U_ACTIVE_B);
q(999);
const after = db.prepare('SELECT COUNT(*) AS c FROM attendance_sessions').get().c;
check(before === after && before === 5, 'GET query performs no mutation (row count unchanged)');

db.close();

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
