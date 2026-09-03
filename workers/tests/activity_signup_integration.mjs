#!/usr/bin/env node
/**
 * S2-6g Activity Signup Vertical Slice 集成测试（A–F 组，≥36 项）。
 *
 * 前置：`node tests/fixture.mjs signup` + wrangler dev 已启动（BASE_URL 见下）。
 * 通过【真实 Worker 运行时】验证首个真实业务授权闭环：
 *
 *   Session → Role → Permission(D1) → Tenant Scope → Ownership → Repository Write
 *
 * 冻结权限码（唯一事实 = workers/scripts/permission-catalog.json，本套件不新增/不改码）：
 *   signup.signup.create —— 报名活动（scopeType USER / risk LOW）      持有人：platform_super_admin, volunteer
 *   signup.signup.cancel —— 取消自己的报名（scopeType USER / risk LOW） 持有人：platform_super_admin, volunteer
 *   signup.signup.review —— 审核活动报名（scopeType TEAM / risk HIGH）  本阶段不使用（审核 ≠ 取消他人）
 *
 * 纪律（用户 §八/§九/§十/§十二/§十四/§十五/§十六/§十九/§二十/§二十一）：
 * - 权限完全来自 D1（83/238），无 mock、无角色名短路。
 * - 跨团队一律 404（不泄露存在性）；无权限 403；未认证 401；业务状态冲突 409。
 * - 套件内不写 permissions / role_permissions；E 组临时改 user_roles 后必须恢复。
 * - 不创建 migration、不改 Schema、不改 Catalog。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// D1 persistence dir 可被 JHZY_D1_DIR 覆盖（S2-6i Final Regression 隔离 state）；默认沿用 .wrangler/state。
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => 's_' + randomBytes(32).toString('base64url');

const IDS = {
  volA: '01TESTUSERAAAAAAAAAAAAAAAA',
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD',
  teamAdminA: '01TESTUSERCFADMIN000000000A',
  plat: '01TESTUSERCPPPPPPPPPPPPPPP',
  platSuper: '01TESTUSERSUPER0000000000A',
  teamA: '01TESTTEAMAAAAAAAAAAAAAAAA',
  teamB: '01TESTTEAMBBBBBBBBBBBBBBBB',
  actS1: '01TESTACTS1AAAAAAAAAAAAAAA',
  actS2: '01TESTACTS2AAAAAAAAAAAAAAA',
  actS3: '01TESTACTS3AAAAAAAAAAAAAAA',
  actS4: '01TESTACTS4AAAAAAAAAAAAAAA',
  actS5: '01TESTACTS5AAAAAAAAAAAAAAA',
  actS6: '01TESTACTS6AAAAAAAAAAAAAAA',
  // 合法 ULID 但库中不存在（用于 404 与"不泄露存在性"对照）。
  actMissing: '01TESTACTZZZZZZZZZZZZZZZZZ',
  // SQL 注入载荷（必须被 ULID 校验拦截在 DB 之前 → 400）。
  actInjection: "01TESTACTS1AAAAAAAAAAAAAAA' OR '1'='1",
};

function dbFile() {
  return join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
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
const userIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pub)?.id);
const teamIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM teams WHERE public_id = ?').get(pub)?.id);
const actIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM activities WHERE public_id = ?').get(pub)?.id);
const roleIdOf = (code) => withDb((db) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id);

/** 读取某活动下某用户的报名行（任意 status）。 */
function signupRow(activityId, userId) {
  return withDb((db) =>
    db
      .prepare('SELECT * FROM activity_signups WHERE activity_id = ? AND user_id = ?')
      .get(activityId, userId),
  );
}
const signupCount = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM activity_signups').get().n);

// ===== 会话：直接向本地 D1 插入 sessions 行（token/hash 测试侧生成）=====
const TOKENS = {};
function insertSessions() {
  withDb((db) => {
    db.prepare(`DELETE FROM sessions WHERE public_id LIKE '01TESTSESS%'`).run();
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare(
      `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 'signup-test', ?, 1)`,
    );
    const mk = (pub, userPid) => {
      const t = newToken();
      ins.run(`01TESTSESS${pub}`, userIdOf(userPid), sha256Hex(t), now + 30 * 24 * 3600);
      return t;
    };
    TOKENS.volA = mk('SUPSVOLAAAAAAAA', IDS.volA);
    TOKENS.volB = mk('SUPSVOLBBBBBBBB', IDS.volB);
    TOKENS.ownerA = mk('SUPSOWNERCCCCCC', IDS.ownerA);
    TOKENS.teamAdminA = mk('SUPSADMINDDDDDD', IDS.teamAdminA);
    TOKENS.plat = mk('SUPSPLATEEEEEEE', IDS.plat);
    TOKENS.platSuper = mk('SUPSSUPERFFFFFF', IDS.platSuper);
  });
}

// ===== E 组：临时撤销 / 恢复 volA 的 volunteer@teamA（验证权限未固化进 Session）=====
function revokeVolunteerAtTeamA() {
  withDb((db) => {
    db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').run(
      userIdOf(IDS.volA),
      roleIdOf('volunteer'),
      teamIdOf(IDS.teamA),
    );
  });
}
function restoreVolunteerAtTeamA() {
  withDb((db) => {
    const u = userIdOf(IDS.volA);
    const t = teamIdOf(IDS.teamA);
    const r = roleIdOf('volunteer');
    const exists = db
      .prepare('SELECT 1 AS x FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?')
      .get(u, r, t);
    if (!exists) db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?,?,?)').run(u, r, t);
  });
}

// ===== HTTP helpers =====
async function req(method, path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body, text: JSON.stringify(body ?? {}) };
}
const authHeaders = (token, team) => {
  const h = { authorization: `Bearer ${token}` };
  if (team != null) h['x-team-id'] = String(team);
  return h;
};
const signup = (activityId, token, team) =>
  req('POST', `/api/v2/activities/${encodeURIComponent(activityId)}/signups`, authHeaders(token, team));
const cancel = (activityId, token, team) =>
  req('DELETE', `/api/v2/activities/${encodeURIComponent(activityId)}/signups/me`, authHeaders(token, team));

// ===== 泄漏扫描（F 组）=====
const RESPONSE_LOG = [];
/**
 * 报名业务面响应（新增写端点的响应）单独收集：SQL / 表名泄露只针对本阶段新增业务面断言。
 * 说明：/probe 是 S2-4 既有基础设施探针，其契约就是回显各表行数（含 role_permissions / user_roles），
 *      属既有设计且非业务响应，不计入本阶段新增面的泄露判定；/api/v2/__test/* 为 TEST-ONLY 回显。
 */
const SIGNUP_RESPONSE_LOG = [];
const LEAK_SQL_RE = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|UNION\s+ALL|sqlite_master)\b/i;
const LEAK_TABLE_RE = /(activity_signups|role_permissions|user_roles|permissions\s*\.)/i;
const LEAK_ID_RE = /(role_id|permission_id|roleId|permissionId)/i;
const log = (r) => RESPONSE_LOG.push(r.text);
const logSignup = (r) => {
  log(r);
  SIGNUP_RESPONSE_LOG.push(r.text);
};

// ===== 主流程 =====
insertSessions();
const teamA = teamIdOf(IDS.teamA);
const teamB = teamIdOf(IDS.teamB);
const volAId = userIdOf(IDS.volA);
const volBId = userIdOf(IDS.volB);
const ownerAId = userIdOf(IDS.ownerA);
const a1 = actIdOf(IDS.actS1);
const a2 = actIdOf(IDS.actS2);
const a3 = actIdOf(IDS.actS3);
const a4 = actIdOf(IDS.actS4);
const a5 = actIdOf(IDS.actS5);
const a6 = actIdOf(IDS.actS6);

// ---------------------------------------------------------------- A. Baseline
process.stderr.write('A. Baseline（目录 83/238 + 冻结报名权限 + fixture 就绪）\n');
{
  const probe = await req('GET', '/probe');
  log(probe);
  check('A1 permissions=83', probe.body?.data?.permissions === 83, `got ${probe.body?.data?.permissions}`);
  check('A2 role_permissions=238', probe.body?.data?.role_permissions === 238, `got ${probe.body?.data?.role_permissions}`);

  const codes = withDb((db) =>
    db
      .prepare(
        `SELECT code FROM permissions WHERE code IN ('signup.signup.create','signup.signup.cancel','signup.signup.review')`,
      )
      .all()
      .map((r) => r.code),
  );
  check('A3 冻结报名权限存在（create/cancel/review = 3）', codes.length === 3, `got ${JSON.stringify(codes)}`);

  const owners = withDb((db) =>
    db
      .prepare(
        `SELECT r.code AS role FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'signup.signup.create' ORDER BY r.code`,
      )
      .all()
      .map((r) => r.role)
      .join(','),
  );
  check('A3b signup.signup.create 持有者 = platform_super_admin,volunteer', owners === 'platform_super_admin,volunteer', `got ${owners}`);

  const fx = withDb((db) => ({
    teams: db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
    acts: db.prepare('SELECT COUNT(*) AS n FROM activities').get().n,
    su: db.prepare('SELECT COUNT(*) AS n FROM activity_signups').get().n,
    volA: db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id=ur.role_id
          WHERE ur.user_id=? AND r.code='volunteer' AND ur.scope_team_id=?`,
      )
      .get(volAId, teamA).n,
  }));
  check('A4 fixture 就绪：teams=2 activities=6 activity_signups=0', fx.teams === 2 && fx.acts === 6 && fx.su === 0, JSON.stringify(fx));
  check('A4b volA 持有 volunteer@teamA 绑定', fx.volA === 1, `got ${fx.volA}`);
}

// ---------------------------------------------------------------- B. Create Signup
process.stderr.write('B. 报名创建（Create Signup）\n');
{
  const r = await signup(IDS.actS1, TOKENS.volA, teamA);
  logSignup(r);
  check('B1 volunteer 合法报名成功 → 201', r.res.status === 201, `got ${r.res.status} ${r.text}`);
  check(
    'B2 统一 response（success/request_id + X-Request-ID 一致）',
    r.body?.success === true &&
      typeof r.body?.request_id === 'string' &&
      r.res.headers.get('x-request-id') === r.body.request_id,
    r.text,
  );
  check('B3 signup.user_id = volA', r.body?.data?.signup?.user_id === volAId, `got ${r.body?.data?.signup?.user_id}`);
  check('B4 signup.activity_id = actS1', r.body?.data?.signup?.activity_id === a1, `got ${r.body?.data?.signup?.activity_id}`);
  const row = signupRow(a1, volAId);
  check('B5 落库正确：status=1 且活动归属 teamA', row?.status === 1 && actIdOf(IDS.actS1) === a1, JSON.stringify(row));
  const derived = withDb((db) =>
    db.prepare('SELECT a.team_id AS t FROM activity_signups s JOIN activities a ON a.id=s.activity_id WHERE s.id=?').get(row.id),
  );
  check('B5b 派生团队隔离：signup 所属 activity.team_id = teamA', derived?.t === teamA, `got ${derived?.t}`);
  check('B5c 免审活动 need_audit=0 → review_status=1（审核通过）', row?.review_status === 1, `got ${row?.review_status}`);
}

{
  const r = await signup(IDS.actS1, null, teamA);
  logSignup(r);
  check('B6 未认证（无 Session）→ 401 AUTH_REQUIRED', r.res.status === 401 && r.body?.error?.code === 'AUTH_REQUIRED', `got ${r.res.status}/${r.body?.error?.code}`);
}
{
  const r = await signup(IDS.actS1, TOKENS.teamAdminA, teamA);
  logSignup(r);
  check('B7 无 signup.signup.create 权限（team_admin@teamA）→ 403 FORBIDDEN', r.res.status === 403 && r.body?.error?.code === 'FORBIDDEN', `got ${r.res.status}/${r.body?.error?.code}`);
}
{
  const r = await signup(IDS.actMissing, TOKENS.volA, teamA);
  logSignup(r);
  check('B8 活动不存在（合法 ULID）→ 404 NOT_FOUND', r.res.status === 404 && r.body?.error?.code === 'NOT_FOUND', `got ${r.res.status}/${r.body?.error?.code}`);
}
{
  const r = await signup(IDS.actS4, TOKENS.volA, teamA);
  logSignup(r);
  check('B9 跨团队活动（actS4@teamB，active=teamA）→ 404（不泄露存在）', r.res.status === 404 && r.body?.error?.code === 'NOT_FOUND', `got ${r.res.status}/${r.body?.error?.code}`);
}
{
  const r = await signup(IDS.actInjection, TOKENS.volA, teamA);
  logSignup(r);
  check('B10 SQL 注入 activityId → 400 INVALID_PARAM（先于 DB）', r.res.status === 400 && r.body?.error?.code === 'INVALID_PARAM', `got ${r.res.status}/${r.body?.error?.code}`);
}
{
  const r = await signup(IDS.actS1, TOKENS.volA, teamA);
  logSignup(r);
  check(
    'B11 重复报名 → 409 CONFLICT（reason=signup_already_exists）',
    r.res.status === 409 && r.body?.error?.code === 'CONFLICT' && r.body?.error?.details?.reason === 'signup_already_exists',
    `got ${r.res.status} ${r.text}`,
  );
  const n = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM activity_signups WHERE activity_id=? AND user_id=?').get(a1, volAId).n);
  check('B12 重复报名后数据库仍只有 1 条', n === 1, `got ${n}`);
}
{
  const r = await signup(IDS.actS3, TOKENS.volA, teamA);
  logSignup(r);
  check(
    'B13 草稿活动（status=0）→ 409 activity_signup_closed',
    r.res.status === 409 && r.body?.error?.details?.reason === 'activity_signup_closed',
    `got ${r.res.status} ${r.text}`,
  );
  const n = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM activity_signups WHERE activity_id=?').get(a3).n);
  check('B14 被拒的报名未产生任何落库', n === 0, `got ${n}`);
}

// ---------------------------------------------------------------- C. Cancel Own Signup
process.stderr.write('C. 取消本人报名（Cancel Own Signup）\n');
{
  const r = await cancel(IDS.actS1, TOKENS.volA, teamA);
  logSignup(r);
  check('C1 volunteer 取消自己的报名 → 200', r.res.status === 200 && r.body?.data?.signup?.status === 2, `got ${r.res.status} ${r.text}`);
  const row = signupRow(a1, volAId);
  check('C2 DB 状态正确：status=2 已取消', row?.status === 2, JSON.stringify(row));
  check('C2b cancel_count=1 且 updated_at 已写', row?.cancel_count === 1 && row?.updated_at != null, JSON.stringify(row));

  const again = await cancel(IDS.actS1, TOKENS.volA, teamA);
  logSignup(again);
  check('C3 重复取消 → 404（取消为单向终态）', again.res.status === 404, `got ${again.res.status}`);
  const row2 = signupRow(a1, volAId);
  check('C4 重复取消未产生第二次计数（cancel_count 仍=1）', row2?.cancel_count === 1, JSON.stringify(row2));
}
{
  // 他人报名：ownerA（volunteer@teamA）报名 actS5；volA 不得取消它。
  const created = await signup(IDS.actS5, TOKENS.ownerA, teamA);
  logSignup(created);
  check('C5 ownerA 报名 actS5 成功（多角色含 volunteer）→ 201', created.res.status === 201, `got ${created.res.status} ${created.text}`);
  const attack = await cancel(IDS.actS5, TOKENS.volA, teamA);
  logSignup(attack);
  check('C6 volA 无法取消他人报名（signups/me 不命中他人行）→ 404', attack.res.status === 404, `got ${attack.res.status} ${attack.text}`);
  const ownerRow = signupRow(a5, ownerAId);
  check('C7 他人记录零变更：status 仍=1、cancel_count 仍=0', ownerRow?.status === 1 && ownerRow?.cancel_count === 0, JSON.stringify(ownerRow));
}
{
  // 跨团队：volB 报名 teamB 活动；volA 用已知 activityId 攻击。
  const vb = await signup(IDS.actS4, TOKENS.volB, teamB);
  logSignup(vb);
  check('C8 volB 报名 teamB 活动成功 → 201', vb.res.status === 201, `got ${vb.res.status} ${vb.text}`);
  const crossA = await cancel(IDS.actS4, TOKENS.volA, teamA);
  logSignup(crossA);
  check('C9 volA(active=teamA) 取消 teamB 报名 → 404（跨租户不泄露）', crossA.res.status === 404, `got ${crossA.res.status} ${crossA.text}`);
  const crossB = await cancel(IDS.actS4, TOKENS.volA, teamB);
  logSignup(crossB);
  check('C10 volA(active=teamB) 无 teamB 角色绑定 → 403', crossB.res.status === 403, `got ${crossB.res.status} ${crossB.text}`);
  const volBRow = signupRow(a4, volBId);
  check('C11 volB 报名记录零变更（无 IDOR）', volBRow?.status === 1 && volBRow?.cancel_count === 0, JSON.stringify(volBRow));
}
{
  const r = await cancel(IDS.actS6, TOKENS.volA, teamA);
  logSignup(r);
  check('C12 不存在的报名 → 404', r.res.status === 404, `got ${r.res.status} ${r.text}`);
  const n = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM activity_signups WHERE activity_id=?').get(a6).n);
  check('C13 404 路径不产生任何写（actS6 下 0 条）', n === 0, `got ${n}`);
}
{
  // allow_cancel = 0 的活动（actS2，need_audit=1）。
  const created = await signup(IDS.actS2, TOKENS.volA, teamA);
  logSignup(created);
  check('C14 需审活动报名成功且 review_status=0（待审核）', created.res.status === 201 && created.body?.data?.signup?.review_status === 0, `got ${created.res.status} ${created.text}`);
  const blocked = await cancel(IDS.actS2, TOKENS.volA, teamA);
  logSignup(blocked);
  check(
    'C15 allow_cancel=0 → 409 activity_cancel_not_allowed',
    blocked.res.status === 409 && blocked.body?.error?.details?.reason === 'activity_cancel_not_allowed',
    `got ${blocked.res.status} ${blocked.text}`,
  );
  const row = signupRow(a2, volAId);
  check('C16 被拒取消零副作用：status 仍=1、cancel_count 仍=0', row?.status === 1 && row?.cancel_count === 0, JSON.stringify(row));
}

// ---------------------------------------------------------------- D. Permission + Tenant
process.stderr.write('D. Permission + Tenant Scope（正交性）\n');
{
  const r = await signup(IDS.actS6, TOKENS.volA, teamA);
  logSignup(r);
  check('D1 volA(volunteer@teamA) + active=teamA → 报名成功', r.res.status === 201, `got ${r.res.status} ${r.text}`);
}
{
  const r = await signup(IDS.actS4, TOKENS.teamAdminA, teamB);
  logSignup(r);
  check('D2 teamAdminA(team_admin@teamA) + active=teamB 不继承 A 权限 → 403', r.res.status === 403, `got ${r.res.status} ${r.text}`);
}
{
  const r1 = await signup(IDS.actS4, TOKENS.ownerA, teamB);
  logSignup(r1);
  check('D3 ownerA(volunteer@teamB) + active=teamB → 可报名 teamB 活动', r1.res.status === 201, `got ${r1.res.status} ${r1.text}`);
  const r2 = await signup(IDS.actS4, TOKENS.ownerA, teamA);
  logSignup(r2);
  check('D3b 同一用户切回 active=teamA 请求 teamB 活动 → 404', r2.res.status === 404, `got ${r2.res.status} ${r2.text}`);
}
{
  const r = await signup(IDS.actS1, TOKENS.platSuper, teamA);
  logSignup(r);
  check(
    'D4 platform_super_admin 持 signup.signup.create 但无团队数据上下文 → 403 TEAM_SCOPE_REQUIRED（PLATFORM 权限不绕过 Tenant）',
    r.res.status === 403 && r.body?.error?.code === 'TEAM_SCOPE_REQUIRED',
    `got ${r.res.status} ${r.text}`,
  );
  const before = signupRow(a1, volAId);
  const c = await cancel(IDS.actS1, TOKENS.platSuper, teamA);
  logSignup(c);
  check('D4b platform_super_admin 无法取消他人报名（无团队上下文）→ 403', c.res.status === 403, `got ${c.res.status} ${c.text}`);
  const after = signupRow(a1, volAId);
  check(
    'D4c PLATFORM 权限不自动绕过 Ownership（他人记录零变更）',
    before?.status === after?.status && before?.cancel_count === after?.cancel_count,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  );
}
{
  const r = await signup(IDS.actS1, TOKENS.volA, teamB);
  logSignup(r);
  check('D5 volA + active=teamB（无 teamB 绑定）→ 403（TEAM 权限不跨 Team）', r.res.status === 403, `got ${r.res.status} ${r.text}`);
}

// ---------------------------------------------------------------- E. Live Authorization
process.stderr.write('E. 运行时授权即时生效（Role revoke / restore）\n');
{
  const who1 = await req('GET', '/api/v2/__test/whoami', authHeaders(TOKENS.volA, teamA));
  logSignup(who1);
  const permsBefore = (await req('GET', '/api/v2/__test/permissions', authHeaders(TOKENS.volA, teamA))).body?.data?.permissions ?? [];
  check('E0 revoke 前 volA 持有 signup.signup.create', permsBefore.includes('signup.signup.create'), `count=${permsBefore.length}`);

  revokeVolunteerAtTeamA();
  const denied = await signup(IDS.actS5, TOKENS.volA, teamA);
  logSignup(denied);
  check('E1 撤销 volunteer@teamA 后【下一请求】报名权限消失 → 403', denied.res.status === 403, `got ${denied.res.status} ${denied.text}`);
  const permsAfter = (await req('GET', '/api/v2/__test/permissions', authHeaders(TOKENS.volA, teamA))).body?.data?.permissions ?? [];
  check('E1b 权限集合实时收缩（不再含 signup.signup.create）', !permsAfter.includes('signup.signup.create'), `count=${permsAfter.length}`);

  restoreVolunteerAtTeamA();
  const restored = await signup(IDS.actS5, TOKENS.volA, teamA);
  logSignup(restored);
  check('E2 恢复 volunteer@teamA 后【下一请求】权限恢复 → 201', restored.res.status === 201, `got ${restored.res.status} ${restored.text}`);

  const who2 = await req('GET', '/api/v2/__test/whoami', authHeaders(TOKENS.volA, teamA));
  logSignup(who2);
  check(
    'E3 全程无需重新登录（同一 token 仍有效，身份一致）',
    who1.res.status === 200 && who2.res.status === 200 && who1.body?.data?.userId === who2.body?.data?.userId,
    `${who1.res.status}/${who2.res.status}`,
  );
  const permsFinal = (await req('GET', '/api/v2/__test/permissions', authHeaders(TOKENS.volA, teamA))).body?.data?.permissions ?? [];
  check('E4 Permission 未固化进 Session（随 D1 用户角色实时变化）', permsFinal.includes('signup.signup.create'), `count=${permsFinal.length}`);

  const p = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n);
  const rp = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n);
  check('E5 revoke/restore 后目录仍 83/238（零漂移）', p === 83 && rp === 238, `got ${p}/${rp}`);
}

// ---------------------------------------------------------------- F. Security
process.stderr.write('F. 安全审计（泄露 / IDOR / 残留）\n');
{
  const sqlLeaks = SIGNUP_RESPONSE_LOG.filter((t) => LEAK_SQL_RE.test(t) || LEAK_TABLE_RE.test(t));
  check('F1 报名业务面响应无 SQL / 表名泄露', sqlLeaks.length === 0, `${sqlLeaks.length} 条：${sqlLeaks.slice(0, 2).join(' | ')}`);

  const idLeaks = SIGNUP_RESPONSE_LOG.filter((t) => LEAK_ID_RE.test(t));
  check('F2 报名业务面响应无 role_id / permission_id 泄露', idLeaks.length === 0, `${idLeaks.length} 条：${idLeaks.slice(0, 2).join(' | ')}`);

  const testOnly = await req('GET', '/api/v2/__test/permission?code=TEST_ONLY_PERMISSION', authHeaders(TOKENS.volA, teamA));
  log(testOnly);
  check(
    'F3 TEST_ONLY_PERMISSION 无任何授权效力（不在目录 → 500 INTERNAL_ERROR）',
    testOnly.res.status === 500 && testOnly.body?.error?.code === 'INTERNAL_ERROR',
    `got ${testOnly.res.status} ${testOnly.text}`,
  );

  // 无 signupId 写端点（结构上不存在他人报名操作面）。
  const bogus = await req('DELETE', `/api/v2/activities/${IDS.actS1}/signups/12345`, authHeaders(TOKENS.volA, teamA));
  log(bogus);
  check('F4 不存在 signupId 写端点（构造他人 signupId → 404，无 IDOR 入口）', bogus.res.status === 404, `got ${bogus.res.status}`);

  const dupText = RESPONSE_LOG.find((t) => t.includes('signup_already_exists')) ?? '';
  check('F5 409 响应不泄露 UNIQUE 约束 / 列名', dupText !== '' && !/unique|constraint|activity_signups/i.test(dupText), dupText);

  // 残留自检：本套件创建的全部报名行都必须落在测试活动集合内，清理后必须归零。
  const testActIds = [a1, a2, a3, a4, a5, a6];
  const rows = withDb((db) => db.prepare('SELECT id, activity_id, user_id FROM activity_signups').all());
  const stray = rows.filter((r) => !testActIds.includes(r.activity_id));
  check('F6 无越界/孤儿报名行（全部落在本套件测试活动内）', stray.length === 0, `stray=${JSON.stringify(stray)}`);
  withDb((db) => db.prepare('DELETE FROM activity_signups').run());
  check('F7 套件自检清理后 activity_signups = 0（最终零残留由 fixture teardown 断言）', signupCount() === 0, `got ${signupCount()}`);
}

process.stderr.write(`\n===== S2-6g activity signup: pass=${pass} fail=${fail} =====\n`);
process.exit(fail > 0 ? 1 : 0);
