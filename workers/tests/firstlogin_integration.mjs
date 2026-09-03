#!/usr/bin/env node
/**
 * S2-6c-3 Integration Tests（首登规则 / 身份冲突 / Session TTL / 管理端 CSRF / device_name / 全端下线）。
 *
 * 前置：`node tests/fixture.mjs firstlogin` + wrangler dev 已启动（127.0.0.1:8787）。
 *
 * 覆盖（指令 §九，≥28 项；本文件 31 项）：
 *   A  First Login          (9)  —— OPEN-1 / OPEN-2
 *   B  Identity Conflict    (4)  —— OPEN-7
 *   C  Session TTL          (3)  —— 指令 §四
 *   D  CSRF                 (6)  —— 指令 §五
 *   E  Device Semantics     (3)  —— 指令 §六
 *   F  Logout / Revoke-All  (4)  —— 指令 §七
 *   G  Atomicity / Security (2)
 *
 * 安全断言（贯穿全组）：
 * - 响应体绝不出现：session_key、openid/unionid 明文、AppSecret、微信 errcode、token_hash、SQL/表名。
 * - 冲突响应不泄露任何账户映射（不含 A/B 的 public_id / user id / 身份摘要）。
 * - 首登不授角色、不建团队、不授 permission（permissions / role_permissions 计数不因首登变化；S2-6e 后全局基线为 83 / 238）。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// D1 persistence dir 可被 JHZY_D1_DIR 覆盖（S2-6i Final Regression 隔离 state）；默认沿用 .wrangler/state。
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

/** local CSRF allowlist（与 src/middleware/csrf.ts LOCAL_ALLOWED_ORIGINS 一致）。 */
const ALLOWED_ORIGIN = 'http://127.0.0.1:8787';
const EVIL_ORIGIN = 'http://evil.example';

const IDS = {
  volA: '01TESTUSERAAAAAAAAAAAAAAAA',
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD',
  plat: '01TESTUSERCPPPPPPPPPPPPPPP',
  disabled: '01TESTUSERDDDDDDDDDDDDDDDD',
};

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

const LOCAL_KEY = 'local-test-only-identity-key';
const identityHash = (v) => createHmac('sha256', LOCAL_KEY).update(v).digest('hex');

function dbFile() {
  return join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const q1 = (sql, ...binds) => withDb((db) => db.prepare(sql).get(...binds));
const qn = (sql, ...binds) => withDb((db) => db.prepare(sql).all(...binds));

const userIdOf = (pid) => q1('SELECT id FROM users WHERE public_id = ?', pid)?.id ?? null;

function counts() {
  return withDb((db) => ({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    identities: db.prepare('SELECT COUNT(*) AS n FROM user_identities').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    userRoles: db.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n,
    teamMembers: db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n,
    permissions: db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n,
    rolePermissions: db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n,
    conflictEvents: db
      .prepare(`SELECT COUNT(*) AS n FROM security_events WHERE event_type = 'multi_account'`)
      .get().n,
  }));
}

// ===== fetch helpers =====
const ALL_TEXT = [];
async function req(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const text = JSON.stringify(json);
  ALL_TEXT.push(text);
  return { res, body: json, text };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const cookieHdr = (t) => ({ cookie: `__Host-session=${t}` });
const csrfOk = { origin: ALLOWED_ORIGIN, 'x-jhzy-csrf': '1' };

/** mock code：MOCK_WECHAT_CODE.<openid>.<unionid|-> */
const code = (openid, unionid = '-') => `MOCK_WECHAT_CODE.${openid}.${unionid}`;
const login = (c, opts = {}) =>
  req('POST', `/api/v2/auth/wechat/login${opts.cookie ? '?cookie=1' : ''}`, {
    body: { code: c },
    headers: opts.headers ?? {},
  });

/** 敏感串扫描：命中任一即视为泄露。 */
const SECRETS = ['session_key', 'mock-session-key', 'AppSecret', 'WECHAT_APP_SECRET', 'errcode', 'errmsg', 'token_hash'];
function leaksSecrets(text) {
  const lower = text.toLowerCase();
  return SECRETS.filter((s) => lower.includes(s.toLowerCase()));
}
const INTERNAL = ['SELECT ', 'FROM sessions', 'user_identities', '.ts:', 'at Object', 'Error:'];
function leaksInternals(text) {
  return INTERNAL.filter((s) => text.includes(s));
}

const nowSec = () => Math.floor(Date.now() / 1000);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const volAId = userIdOf(IDS.volA);
const volBId = userIdOf(IDS.volB);

// =======================================================================
process.stderr.write('A. First Login / OPEN-1 + OPEN-2（9）\n');
const A_before = counts();
let newUserId = null;
let newPublicId = null;
let newToken = null;
{
  const r = await login(code('FL_OPENID_1', 'FL_UNIONID_1'));
  newToken = r.body?.data?.token ?? null;
  newPublicId = r.body?.data?.user?.public_id ?? null;
  newUserId = newPublicId ? userIdOf(newPublicId) : null;
  const A_after = counts();

  check(
    'A1 新 unionid+openid → 自动创建 user（users +1，is_new_user=true）',
    r.res.status === 200 &&
      r.body?.data?.status === 'OK' &&
      r.body?.data?.is_new_user === true &&
      typeof newToken === 'string' &&
      newUserId != null &&
      A_after.users === A_before.users + 1,
    `http=${r.res.status} isNew=${r.body?.data?.is_new_user} users ${A_before.users}→${A_after.users} ${r.text.slice(0, 140)}`,
  );

  const idRows = newUserId
    ? qn('SELECT identity_type, active_marker, status FROM user_identities WHERE user_id = ?', newUserId)
    : [];
  const types = idRows.map((x) => x.identity_type).sort();
  check(
    'A2 自动创建 user_identities（unionid + openid 各 1 行，active_marker=1/status=1）',
    idRows.length === 2 &&
      JSON.stringify(types) === JSON.stringify(['wechat_openid', 'wechat_unionid']) &&
      idRows.every((x) => x.active_marker === 1 && x.status === 1),
    `rows=${JSON.stringify(idRows)}`,
  );

  const sessRows = newUserId ? qn('SELECT id FROM sessions WHERE user_id = ? AND status = 1', newUserId) : [];
  const me = newToken ? await req('GET', '/api/v2/users/me', { headers: bearer(newToken) }) : null;
  check(
    'A3 创建 Session（sessions +1 且 token 立即可用）',
    sessRows.length === 1 && me?.res.status === 200 && me?.body?.data?.user?.public_id === newPublicId,
    `sessions=${sessRows.length} me=${me?.res.status}`,
  );

  const urRows = newUserId ? qn('SELECT id FROM user_roles WHERE user_id = ?', newUserId) : [];
  check(
    'A4 不创建 user_roles（该用户角色行 = 0，全局 user_roles 计数不变）',
    urRows.length === 0 && A_after.userRoles === A_before.userRoles,
    `rows=${urRows.length} ur ${A_before.userRoles}→${A_after.userRoles}`,
  );

  const tmRows = newUserId ? qn('SELECT id FROM team_members WHERE user_id = ?', newUserId) : [];
  check(
    'A5 不创建 team_members（该用户团队行 = 0，全局计数不变）',
    tmRows.length === 0 && A_after.teamMembers === A_before.teamMembers,
    `rows=${tmRows.length} tm ${A_before.teamMembers}→${A_after.teamMembers}`,
  );

  check(
    'A6 permissions 计数不因首登变化',
    A_after.permissions === A_before.permissions,
    `${A_before.permissions}→${A_after.permissions}`,
  );
  check(
    'A7 role_permissions 计数不因首登变化',
    A_after.rolePermissions === A_before.rolePermissions,
    `${A_before.rolePermissions}→${A_after.rolePermissions}`,
  );

  const u = newUserId ? q1('SELECT cert_level, status FROM users WHERE id = ?', newUserId) : null;
  const who = newToken ? await req('GET', '/api/v2/__test/whoami', { headers: bearer(newToken) }) : null;
  check(
    'A8 注册状态正确（cert_level=1/L1、status=1）+ 无任何角色（whoami role=null, teamId=null）',
    u?.cert_level === 1 &&
      u?.status === 1 &&
      who?.body?.data?.role === null &&
      who?.body?.data?.teamId === null &&
      who?.body?.data?.userId === newUserId,
    `user=${JSON.stringify(u)} whoami=${who?.text?.slice(0, 140)}`,
  );

  const r2 = await login(code('FL_OPENID_1', 'FL_UNIONID_1'));
  const A_after2 = counts();
  check(
    'A9 重复登录不重复创建 user（is_new_user=false，users 计数不变）',
    r2.res.status === 200 &&
      r2.body?.data?.is_new_user === false &&
      r2.body?.data?.user?.public_id === newPublicId &&
      A_after2.users === A_after.users,
    `isNew=${r2.body?.data?.is_new_user} users ${A_after.users}→${A_after2.users}`,
  );
}

// =======================================================================
process.stderr.write('B. Identity Conflict / OPEN-7（4）\n');
{
  const b = counts();
  const r = await login(code('CONFLICT_OPENID', 'CONFLICT_UNIONID'));
  const a = counts();

  check(
    'B10 unionid→A、openid→B（A≠B）→ 登录拒绝（403 IDENTITY_CONFLICT，无 token）',
    r.res.status === 403 &&
      r.body?.error?.code === 'IDENTITY_CONFLICT' &&
      r.body?.data == null &&
      r.body?.success === false,
    `http=${r.res.status} ${r.text.slice(0, 160)}`,
  );

  const volAUnionid = q1(
    `SELECT id FROM user_identities WHERE user_id = ? AND identity_type = 'wechat_unionid' AND identity_hash = ?`,
    volAId,
    identityHash('CONFLICT_UNIONID'),
  );
  const volBOpenid = q1(
    `SELECT id FROM user_identities WHERE user_id = ? AND identity_type = 'wechat_openid' AND identity_hash = ?`,
    volBId,
    identityHash('CONFLICT_OPENID'),
  );
  const crossMerge =
    qn(`SELECT id FROM user_identities WHERE user_id = ? AND identity_hash = ?`, volAId, identityHash('CONFLICT_OPENID'))
      .length +
    qn(`SELECT id FROM user_identities WHERE user_id = ? AND identity_hash = ?`, volBId, identityHash('CONFLICT_UNIONID'))
      .length;
  check(
    'B11 不自动合并（users/identities/sessions 计数不变，A/B 身份行仍各自独立）',
    a.users === b.users &&
      a.identities === b.identities &&
      a.sessions === b.sessions &&
      volAUnionid != null &&
      volBOpenid != null &&
      crossMerge === 0,
    `counts ${JSON.stringify(b)}→${JSON.stringify(a)} crossMerge=${crossMerge}`,
  );

  // 结构化取值比对（不能用 substring：user id 是一位数，request_id 里的数字会造成误判）。
  function collectValues(node, out = []) {
    if (node == null) return out;
    if (typeof node === 'object') {
      for (const v of Object.values(node)) collectValues(v, out);
      return out;
    }
    out.push(String(node));
    return out;
  }
  const respValues = collectValues(r.body);
  const hashLeak = [identityHash('CONFLICT_OPENID'), identityHash('CONFLICT_UNIONID')].filter((h) =>
    r.text.includes(h),
  );
  const idLeak = [IDS.volA, IDS.volB].filter((p) => r.text.includes(p));
  const uidLeak = [String(volAId), String(volBId)].filter((v) => respValues.includes(v));
  check(
    'B12 不泄露 A/B 身份映射（无 public_id / 无身份摘要 / 无 openid、unionid 明文 / 无内部 user id）',
    hashLeak.length === 0 &&
      idLeak.length === 0 &&
      uidLeak.length === 0 &&
      !r.text.includes('CONFLICT_OPENID') &&
      !r.text.includes('CONFLICT_UNIONID'),
    `hashLeak=${hashLeak.length} idLeak=${idLeak} uidLeak=${uidLeak} text=${r.text.slice(0, 160)}`,
  );

  const ev = qn(
    `SELECT severity, detail, user_id, target_type, handled FROM security_events
      WHERE event_type = 'multi_account' ORDER BY id DESC LIMIT 1`,
  )[0];
  const detailStr = ev?.detail ?? '';
  const detailHasSecret =
    detailStr.includes('CONFLICT_OPENID') ||
    detailStr.includes('CONFLICT_UNIONID') ||
    detailStr.includes(identityHash('CONFLICT_OPENID')) ||
    detailStr.includes(identityHash('CONFLICT_UNIONID'));
  check(
    'B13 已记录 security event（multi_account / severity=3 / reason=identity_conflict / 审计不含明文身份）',
    a.conflictEvents === b.conflictEvents + 1 &&
      ev?.severity === 3 &&
      detailStr.includes('identity_conflict') &&
      ev?.target_type === 'user_identity' &&
      !detailHasSecret,
    `events ${b.conflictEvents}→${a.conflictEvents} ev=${JSON.stringify(ev)}`,
  );
}

// =======================================================================
process.stderr.write('C. Session TTL / 指令 §四（3）\n');
let adminExpiry = 0;
let adminMaxAge = null;
{
  const mini = await login(code('FL_OPENID_UA'));
  const exp = mini.body?.data?.expires_at ?? 0;
  check(
    'C14 小程序 TTL = 30d IMPLEMENTATION DEFAULT（±120s）',
    mini.res.status === 200 && near(exp, nowSec() + 30 * 24 * 3600, 120) && mini.body?.data?.channel === 'miniprogram',
    `exp=${exp} expect≈${nowSec() + 30 * 24 * 3600}`,
  );

  const admin = await login(code('FL_OPENID_UA'), { cookie: true });
  adminExpiry = admin.body?.data?.expires_at ?? 0;
  check(
    'C15 管理端 TTL = 12h IMPLEMENTATION DEFAULT（±120s）',
    admin.res.status === 200 && near(adminExpiry, nowSec() + 12 * 3600, 120) &&
      admin.body?.data?.channel === 'admin',
    `exp=${adminExpiry} expect≈${nowSec() + 12 * 3600}`,
  );

  const sc = admin.res.headers.get('set-cookie') ?? '';
  const m = /Max-Age=(\d+)/.exec(sc);
  adminMaxAge = m ? Number(m[1]) : null;
  const serverTtl = adminExpiry - nowSec();
  check(
    'C16 Cookie Max-Age 与服务端 expires_at 同源（±2s）',
    adminMaxAge != null && Math.abs(adminMaxAge - serverTtl) <= 2,
    `maxAge=${adminMaxAge} serverTtl=${serverTtl} sc=${sc.slice(0, 120)}`,
  );
}

// =======================================================================
process.stderr.write('D. 管理端 CSRF / 指令 §五（6）\n');
{
  const cl = await login(code('OPENID_OWNER'), { cookie: true });
  const ct = /__Host-session=([A-Za-z0-9_-]+)/.exec(cl.res.headers.get('set-cookie') ?? '')?.[1] ?? null;

  const noOrigin = await req('POST', '/api/v2/auth/logout', {
    headers: { ...cookieHdr(ct), 'x-jhzy-csrf': '1' },
  });
  check(
    'D17 Cookie POST 无 Origin → 403 CSRF_FAILED',
    noOrigin.res.status === 403 && noOrigin.body?.error?.code === 'CSRF_FAILED',
    `http=${noOrigin.res.status} ${noOrigin.text.slice(0, 120)}`,
  );

  const evil = await req('POST', '/api/v2/auth/logout', {
    headers: { ...cookieHdr(ct), origin: EVIL_ORIGIN, 'x-jhzy-csrf': '1' },
  });
  check(
    'D18 非允许 Origin → 403 CSRF_FAILED',
    evil.res.status === 403 && evil.body?.error?.code === 'CSRF_FAILED',
    `http=${evil.res.status}`,
  );

  const noHeader = await req('POST', '/api/v2/auth/logout', {
    headers: { ...cookieHdr(ct), origin: ALLOWED_ORIGIN },
  });
  check(
    'D19 无自定义 Header → 403 CSRF_FAILED',
    noHeader.res.status === 403 && noHeader.body?.error?.code === 'CSRF_FAILED',
    `http=${noHeader.res.status}`,
  );

  const stillAlive = await req('GET', '/api/v2/users/me', { headers: cookieHdr(ct) });
  check(
    'D20 被拒绝的请求未产生副作用（会话仍有效 200）',
    stillAlive.res.status === 200 && stillAlive.body?.data?.user?.public_id === IDS.ownerA,
    `http=${stillAlive.res.status}`,
  );

  const okReq = await req('POST', '/api/v2/auth/logout', { headers: { ...cookieHdr(ct), ...csrfOk } });
  check(
    'D21 正确 Origin + 自定义 Header → 200（无 CSRF 误伤）',
    okReq.res.status === 200 && okReq.body?.data?.status === 'OK',
    `http=${okReq.res.status} ${okReq.text.slice(0, 120)}`,
  );

  const bToken = (await login(code('OPENID_OWNER'))).body?.data?.token ?? null;
  const bearerLogout = await req('POST', '/api/v2/auth/logout', { headers: bearer(bToken) });
  check(
    'D22 Bearer 小程序请求不被 Cookie CSRF 规则误伤（无 Origin/无 Header 仍 200）',
    bearerLogout.res.status === 200 && bearerLogout.body?.data?.status === 'OK',
    `http=${bearerLogout.res.status} ${bearerLogout.text.slice(0, 120)}`,
  );
}

// =======================================================================
process.stderr.write('E. Device Semantics / 指令 §六（3）\n');
{
  const UA_CHROME_WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const UA_SAFARI_IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const UA_MINI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49 miniProgram';
  const UA_BOGUS = 'ZZZ-BOGUS-UA/9.9';

  await login(code('FL_OPENID_UA'), { headers: { 'user-agent': UA_CHROME_WIN } });
  await login(code('FL_OPENID_UA'), { headers: { 'user-agent': UA_SAFARI_IPHONE } });
  await login(code('FL_OPENID_UA'), { headers: { 'user-agent': UA_MINI } });
  await login(code('FL_OPENID_UA'), { headers: { 'user-agent': UA_BOGUS } });

  const t = (await login(code('FL_OPENID_UA'))).body?.data?.token ?? null;
  const list = await req('GET', '/api/v2/auth/sessions', { headers: bearer(t) });
  const items = list.body?.data?.items ?? [];
  const names = new Set(items.map((i) => i.device_name));
  check(
    'E23 Session 列表返回派生 device_name（含 Chrome on Windows / Safari on iPhone / WeChat Mini Program）',
    list.res.status === 200 &&
      items.length > 0 &&
      items.every((i) => typeof i.device_name === 'string' && i.device_name.length > 0) &&
      names.has('Chrome on Windows') &&
      names.has('Safari on iPhone') &&
      names.has('WeChat Mini Program'),
    `names=${JSON.stringify([...names])}`,
  );

  const hashes = withDb((db) => db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash));
  const hashLeak = hashes.filter((h) => list.text.includes(h));
  check(
    'E24 Session 列表不返回 token_hash',
    hashLeak.length === 0 && !list.text.toLowerCase().includes('token_hash'),
    `leaked=${hashLeak.length}`,
  );

  check(
    'E25 异常 / 无法识别 UA → Unknown Device',
    items.some((i) => i.device_name === 'Unknown Device'),
    `names=${JSON.stringify([...names])}`,
  );
}

// =======================================================================
process.stderr.write('F. Logout / Revoke-All / 指令 §七（4）\n');
{
  const cl = await login(code('OPENID_B'), { cookie: true });
  const ct = /__Host-session=([A-Za-z0-9_-]+)/.exec(cl.res.headers.get('set-cookie') ?? '')?.[1] ?? null;
  const out = await req('POST', '/api/v2/auth/logout', { headers: { ...cookieHdr(ct), ...csrfOk } });
  const sc = (out.res.headers.get('set-cookie') ?? '').toLowerCase();
  check(
    'F26 Cookie logout 清除 __Host-session（Max-Age=0，属性齐全、无 Domain）',
    out.res.status === 200 &&
      sc.includes('__host-session=;') &&
      sc.includes('max-age=0') &&
      sc.includes('httponly') &&
      sc.includes('secure') &&
      sc.includes('samesite=lax') &&
      sc.includes('path=/') &&
      !sc.includes('domain='),
    `sc=${out.res.headers.get('set-cookie')}`,
  );

  const after = await req('GET', '/api/v2/users/me', { headers: cookieHdr(ct) });
  check(
    'F27 logout 后原 Cookie 401（D1 为权威，Cookie 不是权威状态）',
    after.res.status === 401 && after.body?.error?.code === 'AUTH_REQUIRED',
    `http=${after.res.status}`,
  );

  const t1 = (await login(code('OPENID_A'))).body?.data?.token ?? null;
  const t2 = (await login(code('OPENID_A'))).body?.data?.token ?? null;
  const beforeAll = counts();
  const ra = await req('POST', '/api/v2/auth/logout-all', { headers: bearer(t1) });
  const m1 = await req('GET', '/api/v2/users/me', { headers: bearer(t1) });
  const m2 = await req('GET', '/api/v2/users/me', { headers: bearer(t2) });
  check(
    'F28 全端下线后该用户所有 Session 全部 401',
    ra.res.status === 200 &&
      (ra.body?.data?.revoked ?? 0) >= 2 &&
      m1.res.status === 401 &&
      m2.res.status === 401,
    `http=${ra.res.status} revoked=${ra.body?.data?.revoked} m1=${m1.res.status} m2=${m2.res.status}`,
  );

  const afterAll = counts();
  check(
    'F29 全端下线不影响 user / user_identity（users、user_identities 计数不变）',
    afterAll.users === beforeAll.users && afterAll.identities === beforeAll.identities,
    `users ${beforeAll.users}→${afterAll.users}, identities ${beforeAll.identities}→${afterAll.identities}`,
  );
}

// =======================================================================
process.stderr.write('G. Atomicity / Security（2）\n');
{
  // 原子性：所有【首登自动建档】用户都必须同时具备身份行与会话行，不存在半成品。
  const orphanUsers = withDb((db) =>
    db
      .prepare(
        `SELECT u.id FROM users u
          WHERE u.public_id NOT LIKE '01TEST%'
            AND (SELECT COUNT(*) FROM user_identities ui WHERE ui.user_id = u.id) = 0`,
      )
      .all(),
  );
  const orphanSessions = withDb((db) =>
    db
      .prepare(
        `SELECT u.id FROM users u
          WHERE u.public_id NOT LIKE '01TEST%'
            AND (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) = 0`,
      )
      .all(),
  );
  check(
    'G30 首登原子性：无半成品用户（每个自动建档用户都有 identity 行与 session 行）',
    orphanUsers.length === 0 && orphanSessions.length === 0,
    `orphanUsers=${JSON.stringify(orphanUsers)} orphanSessions=${JSON.stringify(orphanSessions)}`,
  );

  const all = ALL_TEXT.join(' ');
  const ls = leaksSecrets(all);
  const li = leaksInternals(all);
  const plain = ['FL_OPENID_1', 'FL_UNIONID_1', 'CONFLICT_OPENID', 'CONFLICT_UNIONID', 'OPENID_A', 'UNIONID_A'].filter(
    (s) => all.includes(s),
  );
  check(
    'G31 全组响应零泄露（无 session_key/AppSecret/errcode/token_hash/SQL/表名/openid、unionid 明文）',
    ls.length === 0 && li.length === 0 && plain.length === 0,
    `secrets=${ls} internals=${li} plain=${plain}`,
  );
}

process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
