#!/usr/bin/env node
/**
 * S2-5 Local Integration + Security Tests（A–L）。
 *
 * 前置：fixture setup 完成 + wrangler dev 已在 BASE 启动（默认 http://127.0.0.1:8787）。
 * 通过【真实 Worker 运行时】验证 Worker → Middleware → Repository → D1 完整链路。
 * 结果逐行写 stderr，退出码 0/1。
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// D1 persistence dir 可被 JHZY_D1_DIR 覆盖（S2-6i Final Regression 隔离 state）；默认沿用 .wrangler/state。
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

// ===== 测试结果收集 =====
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

function h(role, user, team) {
  const headers = {};
  if (role) headers['x-test-role'] = role;
  if (user != null) headers['x-test-user'] = String(user);
  if (team != null) headers['x-test-team'] = String(team);
  return headers;
}

async function get(path, headers = {}, extra = {}) {
  const res = await fetch(`${BASE}${path}`, { headers, ...extra });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

// ===== 从本地 D1 读取 fixture id 映射（只读）=====
function loadIds() {
  if (!existsSync(D1_DIR)) throw new Error('D1 state dir not found — run fixture setup first');
  const file = join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
  const db = new DatabaseSync(file, { readOnly: true });
  const map = {};
  const rows = db.prepare(`SELECT public_id, id FROM users WHERE public_id LIKE '01TEST%'`).all();
  for (const r of rows) map[r.public_id] = r.id;
  const out = {
    volA: map['01TESTUSERAAAAAAAAAAAAAAAA'],
    volB: map['01TESTUSERBBBBBBBBBBBBBBBB'],
    ownerA: map['01TESTUSERCDDDDDDDDDDDDDDD'],
    plat: map['01TESTUSERCPPPPPPPPPPPPPPP'],
    teamA: db.prepare(`SELECT id FROM teams WHERE public_id = '01TESTTEAMAAAAAAAAAAAAAAAA'`).get()?.id,
    teamB: db.prepare(`SELECT id FROM teams WHERE public_id = '01TESTTEAMBBBBBBBBBBBBBBBB'`).get()?.id,
    actA1: '01TESTACTAAAAAAAAAAAAAAAAA',
    actA2: '01TESTACTBBBBBBBBBBBBBBBBB',
    actB1: '01TESTACTCCCCCCCCCCCCCCCCC',
  };
  db.close();
  if (out.volA == null || out.teamA == null) throw new Error('fixture rows missing — run fixture setup');
  return out;
}

// ===== 测试组 =====
async function testA_response() {
  process.stderr.write('A. API response 格式\n');
  const { res, body } = await get('/api/v2/system/status');
  check('A1 status=200', res.status === 200, `got ${res.status}`);
  check('A2 success=true', body?.success === true);
  check('A3 data 是对象', body?.data != null && typeof body.data === 'object');
  check('A4 request_id 存在', typeof body?.request_id === 'string' && body.request_id.length > 0);
  check('A5 X-Request-ID 头一致', res.headers.get('x-request-id') === body?.request_id);
}

async function testB_errorFormat(ids) {
  process.stderr.write('B. 统一错误 response（404）\n');
  // 26 位合法 ULID 格式但不存在 → 404（非法格式才会 400）。
  const { res, body } = await get('/api/v2/teams/01TESTTEAMZZZZZZZZZZZZZZZZ', h('volunteer', ids.volA, ids.teamA));
  check('B1 status=404', res.status === 404, `got ${res.status}`);
  check('B2 success=false', body?.success === false);
  check('B3 error.code=NOT_FOUND', body?.error?.code === 'NOT_FOUND');
  check('B4 request_id 存在', typeof body?.request_id === 'string');
}

async function testC_requestId(ids) {
  process.stderr.write('C. Request ID 生成/传播\n');
  const fixed = 'itest-fixed-req-0001';
  const r1 = await get('/api/v2/system/status', { 'x-request-id': fixed });
  check('C1 合法客户端 ID 透传', r1.res.headers.get('x-request-id') === fixed);
  check('C2 body request_id 与头一致', r1.body?.request_id === fixed);

  const r2 = await get('/api/v2/system/status');
  const r3 = await get('/api/v2/system/status');
  check('C3 自动生成 req- 前缀', (r2.res.headers.get('x-request-id') ?? '').startsWith('req-'));
  check('C4 每请求唯一', r2.res.headers.get('x-request-id') !== r3.res.headers.get('x-request-id'));

  const evil = 'x'.repeat(100); // 超长（>64）→ 不匹配白名单，服务端应安全替换
  const r4 = await get('/api/v2/system/status', { 'x-request-id': evil });
  check('C5 非法客户端 ID 被安全替换', (r4.res.headers.get('x-request-id') ?? '').startsWith('req-'));
}

async function testD_auth(ids) {
  process.stderr.write('D. 未认证拒绝\n');
  const r1 = await get('/api/v2/users/me');
  check('D1 users/me 未认证 401', r1.res.status === 401 && r1.body?.error?.code === 'AUTH_REQUIRED', `got ${r1.res.status}`);
  const r2 = await get('/api/v2/activities');
  check('D2 activities 未认证 401', r2.res.status === 401);
  const r3 = await get('/api/v2/activities/' + ids.actA1);
  check('D3 activity 详情未认证 401', r3.res.status === 401);
}

async function testE_roles(ids) {
  process.stderr.write('E. 6 冻结角色解析\n');
  const roles = ['platform_super_admin', 'platform_operator', 'team_owner', 'team_admin', 'team_auditor', 'volunteer'];
  for (const role of roles) {
    const { res, body } = await get('/api/v2/users/me', h(role, ids.volA, ids.teamA));
    check(`E role=${role} → users/me 200`, res.status === 200 && body?.success === true, `got ${res.status}`);
  }
  // 未知角色不得流入（S2-5 加固）。
  const bad = await get('/api/v2/users/me', { 'x-test-role': 'super_hacker', 'x-test-user': String(ids.volA) });
  check('E+ 未知角色视为未认证 401', bad.res.status === 401, `got ${bad.res.status}`);
}

async function testF_volunteerTeam(ids) {
  process.stderr.write('F. volunteer = TEAM scope（S2-2G）\n');
  const { res, body } = await get('/api/v2/activities', h('volunteer', ids.volA, ids.teamA));
  check('F1 volunteer 可列本团队活动', res.status === 200 && body?.success === true, `got ${res.status}`);
  const items = body?.data?.items ?? [];
  check('F2 全部条目属于本团队', items.length === 2 && items.every((i) => i.team_id === ids.teamA));
  check('F3 分页 meta 存在', body?.data?.pagination?.page === 1 && body?.data?.pagination?.page_size === 20);
}

async function testG_tenantIsolation(ids) {
  process.stderr.write('G. 租户隔离（Team A vs Team B）\n');
  // B 团队志愿者读 A 团队活动 → 404（隔离不暴露存在性）。
  const cross = await get('/api/v2/activities/' + ids.actA1, h('volunteer', ids.volB, ids.teamB));
  check('G1 B 团队读 A 团队活动 404', cross.res.status === 404 && cross.body?.error?.code === 'NOT_FOUND', `got ${cross.res.status}`);
  // A 团队志愿者读 A 团队活动 → 200。
  const own = await get('/api/v2/activities/' + ids.actA1, h('volunteer', ids.volA, ids.teamA));
  check('G2 本团队读活动 200', own.res.status === 200 && own.body?.data?.activity?.public_id === ids.actA1);
  // B 团队列表只含 B1。
  const listB = await get('/api/v2/activities', h('volunteer', ids.volB, ids.teamB));
  const items = listB.body?.data?.items ?? [];
  check('G3 B 团队列表只含 B1', items.length === 1 && items[0]?.public_id === ids.actB1);
}

async function testH_userScope(ids) {
  process.stderr.write('H. USER_SCOPED 隔离\n');
  // 有角色无用户上下文 → 403。
  const noUser = await get('/api/v2/users/me', h('volunteer', null, ids.teamA));
  check('H1 无用户上下文 403 USER_SCOPE_REQUIRED', noUser.res.status === 403 && noUser.body?.error?.code === 'USER_SCOPE_REQUIRED', `got ${noUser.res.status}`);
  // 只能读到自己的数据。
  const meA = await get('/api/v2/users/me', h('volunteer', ids.volA, ids.teamA));
  check('H2 A 只见 A 自己', meA.body?.data?.user?.public_id === '01TESTUSERAAAAAAAAAAAAAAAA');
  const meB = await get('/api/v2/users/me', h('volunteer', ids.volB, ids.teamB));
  check('H3 B 只见 B 自己', meB.body?.data?.user?.public_id === '01TESTUSERBBBBBBBBBBBBBBBB');
}

async function testI_platformScope(ids) {
  process.stderr.write('I. PLATFORM_GLOBAL 不强制 team_id\n');
  // 平台角色无 team 头：系统状态与自身信息可用（平台资源不要求 team）。
  const st = await get('/api/v2/system/status', h('platform_operator', ids.plat, null));
  check('I1 平台角色访问系统状态 200（无 team 头）', st.res.status === 200, `got ${st.res.status}`);
  const me = await get('/api/v2/users/me', h('platform_operator', ids.plat, null));
  check('I2 平台角色 users/me 200', me.res.status === 200);
  // 团队资源仍要求团队上下文（不因平台角色放行，也不假装平台角色有 team）。
  const acts = await get('/api/v2/activities', h('platform_operator', ids.plat, null));
  check('I3 平台角色无 team 上下文 → 403 TEAM_SCOPE_REQUIRED', acts.res.status === 403 && acts.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `got ${acts.res.status}`);
}

async function testJ_permissionSafety() {
  process.stderr.write('J. 权限目录安全（permissions=83 / role_permissions=238，S2-6e seed 基线）\n');
  const { body } = await get('/probe');
  check('J1 permissions=83 (S2-6e seed)', body?.data?.permissions === 83, `got ${body?.data?.permissions}`);
  check('J2 role_permissions=238 (S2-6e seed)', body?.data?.role_permissions === 238, `got ${body?.data?.role_permissions}`);
  check('J3 user_roles=0', body?.data?.user_roles === 0);
  const roles = await get('/probe/roles');
  check('J4 6 角色且 volunteer=team', roles.body?.roles?.length === 6 && roles.body?.volunteerScope === 'team');
}

async function testK_permissionMock(ids) {
  process.stderr.write('K. DB-backed Permission 判定（S2-6f：真实 seed 权限，无 DB 写）\n');
  // K1：真实存在但 volunteer 未持有的 code → 403 FORBIDDEN（不再 PERMISSION_CATALOG_FROZEN）。
  const denied = await get('/api/v2/__test/permission?code=team.member.role.update', h('volunteer', ids.volA, ids.teamA));
  check('K1 volunteer 请求无授权 code → 403 FORBIDDEN', denied.res.status === 403 && denied.body?.error?.code === 'FORBIDDEN', `got ${denied.res.status}/${denied.body?.error?.code}`);
  // K2：volunteer 自有的真实 code → 200 authorized。
  const allowed = await get('/api/v2/__test/permission?code=attendance.record.checkin', h('volunteer', ids.volA, ids.teamA));
  check('K2 volunteer 请求已授权 code → 200', allowed.res.status === 200 && allowed.body?.data?.authorized === true, `got ${allowed.res.status}`);
  const unauth = await get('/api/v2/__test/permission?code=attendance.record.checkin');
  check('K3 未认证 401', unauth.res.status === 401);
}

async function testL_injection() {
  process.stderr.write('L. SQL 注入防护\n');
  const inj = encodeURIComponent("' OR 1=1 --");
  const r1 = await get(`/api/v2/activities/${inj}`, h('volunteer', 1, 1));
  check('L1 path 注入 → 400 INVALID_PARAM（非 500/非全量数据）', r1.res.status === 400 && r1.body?.error?.code === 'INVALID_PARAM', `got ${r1.res.status}`);
  const r2 = await get('/api/v2/teams/' + inj, h('volunteer', 1, 1));
  check('L2 teams path 注入 → 400', r2.res.status === 400);
  const r3 = await get('/api/v2/activities?page=1%20OR%201=1', h('volunteer', 1, 1));
  check('L3 page 参数注入 → 400', r3.res.status === 400);
  const r4 = await get('/api/v2/activities?page_size=999999999', h('volunteer', 1, 1));
  check('L4 page_size 滥用被 clamp 到 ≤100', r4.res.status === 200 && (r4.body?.data?.pagination?.page_size ?? 999) <= 100, `got ${r4.body?.data?.pagination?.page_size}`);
}

async function testM_errorLeakage(ids) {
  process.stderr.write('M. 错误信息不泄露内部细节\n');
  const { res, body } = await get('/api/v2/__test/boom', h('volunteer', ids.volA, ids.teamA));
  check('M1 boom → 500 INTERNAL_ERROR', res.status === 500 && body?.error?.code === 'INTERNAL_ERROR', `got ${res.status}`);
  const raw = JSON.stringify(body) + (res.headers.get('x-request-id') ?? '');
  const leaks = ['SELECT', 'secret_table', 'password', '/home', '.env', 'StackTrace', 'sqlite', 'at frame'];
  for (const needle of leaks) {
    check(`M2 不泄露 "${needle}"`, !raw.includes(needle));
  }
  check('M3 错误响应仍带 X-Request-ID', typeof res.headers.get('x-request-id') === 'string');
  // 统一错误格式校验。
  check('M4 错误体仅含 code/message/request_id', body?.success === false && typeof body?.error?.message === 'string');
}

// ===== 主流程 =====
const ids = loadIds();
process.stderr.write(`S2-5 Integration Tests → ${BASE}\n`);
await testA_response();
await testB_errorFormat(ids);
await testC_requestId(ids);
await testD_auth(ids);
await testE_roles(ids);
await testF_volunteerTeam(ids);
await testG_tenantIsolation(ids);
await testH_userScope(ids);
await testI_platformScope(ids);
await testJ_permissionSafety();
await testK_permissionMock(ids);
await testL_injection();
await testM_errorLeakage(ids);
process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
