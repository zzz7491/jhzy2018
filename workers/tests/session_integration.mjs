#!/usr/bin/env node
/**
 * S2-6c-1 Session Core Tests（指令 E 组 10 项）。
 *
 * 前置：`node tests/fixture.mjs session`（含 user_roles + 停用用户）+ wrangler dev 已启动。
 * token / hash 在测试侧生成，sessions 行直接插入本地 D1（服务端 Session 核心为被测对象，
 * 登录端点属 S2-6c-2 范围）。原始 token 绝不允许出现在响应体/错误体/服务端日志中。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
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

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function newToken() {
  return 's_' + randomBytes(32).toString('base64url');
}

const IDS = {
  volA: '01TESTUSERAAAAAAAAAAAAAAAA',
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD',
  plat: '01TESTUSERCPPPPPPPPPPPPPPP',
  disabled: '01TESTUSERDDDDDDDDDDDDDDDD',
  teamA: '01TESTTEAMAAAAAAAAAAAAAAAA',
  teamB: '01TESTTEAMBBBBBBBBBBBBBBBB',
};

// ===== 直接向本地 D1 插入 sessions 行（token/hash 测试侧生成）=====
function insertSessions() {
  const file = join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare(`DELETE FROM sessions WHERE public_id LIKE '01TESTSESS%'`).run();

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 'session-test', ?, ?)`,
  );

  const out = {};
  const mk = (key, pub, userId, status, expiresAt) => {
    const token = newToken();
    ins.run(`01TESTSESS${pub}`, userId, sha256Hex(token), expiresAt, status);
    out[key] = token;
  };

  mk('valid', 'AAAAAAAAAAAAA', uid(IDS.volA), 1, now + 30 * 24 * 3600);
  mk('expired', 'BBBBBBBBBBBBB', uid(IDS.volA), 1, now - 100);
  mk('revoked', 'CCCCCCCCCCCCC', uid(IDS.volA), 2, now + 30 * 24 * 3600);
  mk('disabled', 'DDDDDDDDDDDDD', uid(IDS.disabled), 1, now + 30 * 24 * 3600);
  mk('multi', 'EEEEEEEEEEEEE', uid(IDS.ownerA), 1, now + 30 * 24 * 3600);

  // 记录 volB 的有效 token（隔离对照用）
  const volBToken = newToken();
  ins.run('01TESTSESSFFFFFFFFFFF', uid(IDS.volB), sha256Hex(volBToken), now + 30 * 24 * 3600, 1);
  out.volB = volBToken;

  db.close();
  return out;
}

function teamIdOf(pub) {
  const file = join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
  const d = new DatabaseSync(file, { readOnly: true });
  const id = d.prepare('SELECT id FROM teams WHERE public_id = ?').get(pub)?.id;
  d.close();
  return id;
}

// ===== fetch helpers =====
async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

// ===== 主流程 =====
const tokens = insertSessions();
const rawTokens = Object.values(tokens);
const teamA = teamIdOf(IDS.teamA);
const teamB = teamIdOf(IDS.teamB);

process.stderr.write('S1. 有效 Session → 认证成功\n');
{
  const r = await get('/api/v2/users/me', bearer(tokens.valid));
  check('S1a 200 + 本人数据', r.res.status === 200 && r.body?.data?.user?.public_id === IDS.volA, `got ${r.res.status}`);
  const w = await get('/api/v2/__test/whoami', bearer(tokens.valid));
  check('S1b 无团队头 → USER_SCOPED + 无角色', w.body?.data?.role === null && w.body?.data?.tenant?.scope === 'USER_SCOPED');
}

process.stderr.write('S2. 团队上下文选择（X-Team-Id）→ TEAM scope\n');
{
  const w = await get('/api/v2/__test/whoami', { ...bearer(tokens.valid), 'x-team-id': String(teamA) });
  check('S2a role=volunteer + teamId=teamA', w.body?.data?.role === 'volunteer' && w.body?.data?.teamId === teamA);
  check('S2b tenant=TEAM_SCOPED', w.body?.data?.tenant?.scope === 'TEAM_SCOPED');
  const acts = await get('/api/v2/activities', { ...bearer(tokens.valid), 'x-team-id': String(teamA) });
  check('S2c Session 用户可列本团队活动', acts.res.status === 200 && (acts.body?.data?.items ?? []).length === 2);
}

process.stderr.write('S3. 不存在 token → 401\n');
{
  const r = await get('/api/v2/users/me'); // 完全无凭证
  check('S3a 401', r.res.status === 401 && r.body?.error?.code === 'AUTH_REQUIRED', `got ${r.res.status}`);
}

process.stderr.write('S4. token hash 不匹配 → 401\n');
{
  const r = await get('/api/v2/users/me', bearer('s_' + randomBytes(32).toString('base64url')));
  check('S4a 随机 token 401', r.res.status === 401);
}

process.stderr.write('S5. 过期 Session → 401\n');
{
  const r = await get('/api/v2/users/me', bearer(tokens.expired));
  check('S5a 401', r.res.status === 401);
}

process.stderr.write('S6. 撤销 Session（status=2）→ 401\n');
{
  const r = await get('/api/v2/users/me', bearer(tokens.revoked));
  check('S6a 401', r.res.status === 401);
}

process.stderr.write('S7. 停用用户（status=3）→ 401\n');
{
  const r = await get('/api/v2/users/me', bearer(tokens.disabled));
  check('S7a 401', r.res.status === 401);
}

process.stderr.write('S8. 多角色/多团队解析\n');
{
  const wa = await get('/api/v2/__test/whoami', { ...bearer(tokens.multi), 'x-team-id': String(teamA) });
  check('S8a 同团队多角色取最高 team_owner', wa.body?.data?.role === 'team_owner');
  const wb = await get('/api/v2/__test/whoami', { ...bearer(tokens.multi), 'x-team-id': String(teamB) });
  check('S8b 跨团队切换角色行 volunteer@teamB', wb.body?.data?.role === 'volunteer' && wb.body?.data?.teamId === teamB);
}

process.stderr.write('S9. Session 不可绕过 Tenant Scope\n');
{
  const w = await get('/api/v2/__test/whoami', { ...bearer(tokens.valid), 'x-team-id': String(teamB) });
  check('S9a 请求越权团队 → 上下文归空（role/teamId=null）', w.body?.data?.role === null && w.body?.data?.teamId === null);
  const acts = await get('/api/v2/activities', { ...bearer(tokens.valid), 'x-team-id': String(teamB) });
  check('S9b 越权团队访问活动 → 403 TEAM_SCOPE_REQUIRED', acts.res.status === 403 && acts.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `got ${acts.res.status}`);
  // volB 只能看 B 团数据，看不到 A 团（真实 session 的租户隔离）
  const cross = await get('/api/v2/activities/01TESTACTAAAAAAAAAAAAAAAAA', { ...bearer(tokens.volB), 'x-team-id': String(teamB) });
  check('S9c B 团 session 读 A 团活动 → 404', cross.res.status === 404);
}

process.stderr.write('S10. 平台角色经 Session 解析\n');
{
  const w = await get('/api/v2/__test/whoami', bearer(tokens.plat ?? tokens.multi)); // plat token 未生成时跳过
  // plat 会话在上面 insertSessions 未生成，改用 ownerA 无团队头（team 角色≠平台角色）
  check('S10a 非平台用户无团队头 → role=null', w.body?.data?.role === null);
}

process.stderr.write('S11. 平台角色会话（plat 用户）\n');
{
  // 补插 plat 会话（S10 修正：平台角色解析独立验证）
  const file = join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
  const db = new DatabaseSync(file);
  const uid = db.prepare('SELECT id FROM users WHERE public_id = ?').get(IDS.plat)?.id;
  const platToken = newToken();
  db.prepare(`INSERT INTO sessions (public_id, user_id, token_hash, expires_at, status) VALUES ('01TESTSESSGGGGGGGGGGGGG', ?, ?, ?, 1)`)
    .run(uid, sha256Hex(platToken), Math.floor(Date.now() / 1000) + 3600);
  db.close();
  rawTokens.push(platToken);

  const w = await get('/api/v2/__test/whoami', bearer(platToken));
  check('S11a role=platform_operator（scope NULL）', w.body?.data?.role === 'platform_operator');
  const me = await get('/api/v2/users/me', bearer(platToken));
  check('S11b 平台用户 users/me 200', me.res.status === 200);
}

process.stderr.write('S12. 原始 token 不出现在响应/错误中\n');
{
  let leaked = false;
  for (const t of rawTokens) {
    const r1 = await get('/api/v2/users/me', bearer(t));
    const r2 = await get('/api/v2/activities/01TESTACTZZZZZZZZZZZZZZZZZ', bearer(t));
    const text = JSON.stringify(r1.body) + JSON.stringify(r2.body) + (r1.res.headers.get('x-request-id') ?? '');
    if (text.includes(t)) leaked = true;
  }
  check('S12a 全部响应/错误体无原始 token', !leaked);
}

process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
