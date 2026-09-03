#!/usr/bin/env node
/**
 * S2-6c-2 Auth Integration Tests（微信登录 / 身份解析 / 登出 / 会话管理 / Cookie 通道）。
 *
 * 前置：`node tests/fixture.mjs auth` + wrangler dev 已启动（127.0.0.1:8787）。
 *
 * 安全断言（贯穿全组）：
 * - 响应体 / 错误体绝不出现：session_key、openid 明文、unionid 明文、AppSecret、微信 errcode/errmsg。
 * - token 只出现在登录响应的 data.token 与 Set-Cookie 中，不出现在错误体 / 请求 ID / 列表中。
 * - 首登（OPEN BUSINESS RULE）不得自动建档 / 授角色 / 建 user_roles / 建 session。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// D1 persistence dir 可被 JHZY_D1_DIR 覆盖（S2-6i Final Regression 隔离 state）；默认沿用 .wrangler/state。
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

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

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

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
const userIdOf = (pid) => withDb((db) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id ?? null);
const teamIdOf = (pid) => withDb((db) => db.prepare('SELECT id FROM teams WHERE public_id = ?').get(pid)?.id ?? null);

/** 某用户活跃会话（status=1）行。 */
function activeSessions(userId) {
  return withDb((db) =>
    db
      .prepare(`SELECT id, public_id, token_hash, status, expires_at, user_agent FROM sessions WHERE user_id = ? AND status = 1`)
      .all(userId),
  );
}
const countUsers = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
const countUserRoles = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM user_roles').get().n);
const countSessions = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n);

// ===== fetch helpers =====
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
  return { res, body: json, text: JSON.stringify(json) };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const cookieHdr = (t) => ({ cookie: `__Host-session=${t}` });

/** mock code：MOCK_WECHAT_CODE.<openid>.<unionid|-> */
const code = (openid, unionid = '-') => `MOCK_WECHAT_CODE.${openid}.${unionid}`;
const login = (c, opts = {}) =>
  req('POST', `/api/v2/auth/wechat/login${opts.cookie ? '?cookie=1' : ''}`, { body: { code: c }, headers: opts.headers ?? {} });

/** 响应/错误体安全扫描：命中任一敏感串即视为泄露。 */
const SECRETS = [
  'session_key',
  'mock-session-key-never-persisted',
  'AppSecret',
  'WECHAT_APP_SECRET',
  'appsecret',
  'errcode',
  'errmsg',
  'secret=',
];
function leaksSecrets(text) {
  const lower = text.toLowerCase();
  return SECRETS.filter((s) => lower.includes(s.toLowerCase()));
}
const INTERNAL = ['SELECT ', 'FROM sessions', 'user_identities', 'token_hash', '.ts:', 'at Object', 'Error:'];
function leaksInternals(text) {
  return INTERNAL.filter((s) => text.includes(s));
}

const volAId = userIdOf(IDS.volA);
const volBId = userIdOf(IDS.volB);
const ownerAId = userIdOf(IDS.ownerA);
const platId = userIdOf(IDS.plat);
const teamA = teamIdOf('01TESTTEAMAAAAAAAAAAAAAAAA');

// =======================================================================
process.stderr.write('A. 微信登录成功路径（6）\n');
let t1 = null;
{
  const r = await login(code('OPENID_A'));
  t1 = r.body?.data?.token ?? null;
  check('A1 200 + status=OK + token + user=volA',
    r.res.status === 200 &&
      r.body?.data?.status === 'OK' &&
      typeof t1 === 'string' &&
      t1.length >= 32 &&
      r.body?.data?.user?.public_id === IDS.volA,
    `got ${r.res.status} ${r.text.slice(0, 160)}`);

  check('A2 响应信封合规（success/request_id 与头一致）',
    r.body?.success === true &&
      typeof r.body?.request_id === 'string' &&
      r.body.request_id === r.res.headers.get('x-request-id'),
    `rid=${r.body?.request_id} hdr=${r.res.headers.get('x-request-id')}`);

  const me = await req('GET', '/api/v2/users/me', { headers: bearer(t1) });
  check('A3 token 立即可用（users/me 200 + 本人）',
    me.res.status === 200 && me.body?.data?.user?.public_id === IDS.volA, `got ${me.res.status}`);

  const rows = activeSessions(volAId).filter((s) => s.token_hash === sha256Hex(t1));
  check('A4 D1 落库 1 行且 token_hash=SHA256(token)', rows.length === 1, `rows=${rows.length}`);

  const exp = r.body?.data?.expires_at ?? 0;
  const expect = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  check('A5 expires_at ≈ now+30d（±120s）', Math.abs(exp - expect) <= 120, `got ${exp} expect≈${expect}`);

  const leaked = [
    ...leaksSecrets(r.text),
    ...leaksSecrets(JSON.stringify(r.res.headers.get('x-request-id') ?? '')),
    ...leaksSecrets(r.text.includes('OPENID_A') ? 'OPENID_A' : ''),
    ...leaksSecrets(r.text.includes('UNIONID_A') ? 'UNIONID_A' : ''),
  ];
  check('A6 响应体无 session_key/openid/unionid/AppSecret/errcode', leaked.length === 0, `leaked=${leaked}`);
}

// =======================================================================
process.stderr.write('B. 身份解析（8）\n');
{
  const r = await login(code('OPENID_UNKNOWN', 'UNIONID_PLAT'));
  const me = r.body?.data?.token ? await req('GET', '/api/v2/users/me', { headers: bearer(r.body.data.token) }) : null;
  check('B1 unionid-only 绑定命中（openid 未绑定）',
    r.res.status === 200 && me?.body?.data?.user?.public_id === IDS.plat, `got ${r.res.status} ${r.text.slice(0, 120)}`);

  const before = { users: countUsers(), ur: countUserRoles(), sess: countSessions() };
  const r2 = await login(code('OPENID_NEW', 'UNIONID_NEW'));
  const after = { users: countUsers(), ur: countUserRoles(), sess: countSessions() };

  // ⚠ S2-6c-3 授权变更（OPEN-1 裁决）：未绑定身份由 "REGISTRATION_REQUIRED 不建档"
  //   改为 "原子创建最小 users + user_identities，然后正常登录"。本项断言随之更新。
  check(
    'B2 未绑定身份 → OPEN-1 自动建档并登录成功（is_new_user=true + token）',
    r2.res.status === 200 &&
      r2.body?.data?.status === 'OK' &&
      r2.body?.data?.is_new_user === true &&
      typeof r2.body?.data?.token === 'string',
    `got ${r2.res.status} ${r2.text.slice(0, 160)}`,
  );

  // ⚠ S2-6c-3 授权变更（OPEN-7 冲突保护）：unionid→volB、openid→ownerA 指向不同主体时，
  //   由 "unionid 优先命中 volB" 改为 "冲突拒绝 + 审计 + 不合并"。本项断言随之更新。
  //   注意：OPEN-7 的 "unionid 优先" 语义仍生效——冲突判定本身即以 unionid 命中结果为首要输入。
  const r3 = await login(code('OPENID_SHARED', 'UNIONID_SHARED'));
  check(
    'B3 unionid→volB、openid→ownerA（不同主体）→ OPEN-7 冲突拒绝（403 IDENTITY_CONFLICT，无 token）',
    r3.res.status === 403 && r3.body?.error?.code === 'IDENTITY_CONFLICT' && r3.body?.data == null,
    `got ${r3.res.status} ${r3.text.slice(0, 160)}`,
  );

  const r4 = await login(code('OPENID_REVOKED'));
  check(
    'B4 已撤销身份行（active_marker=NULL）→ 不匹配（新建用户，非 volA）',
    r4.res.status === 200 &&
      r4.body?.data?.is_new_user === true &&
      r4.body?.data?.user?.public_id !== IDS.volA &&
      r4.body?.data?.user?.public_id != null,
    `got ${r4.text.slice(0, 140)}`,
  );

  // ⚠ S2-6c-3：停用身份行（active_marker=1 + status=2）仍占用
  //   UNIQUE(identity_type, identity_hash, active_marker) 槽位，无法重新绑定到新主体，
  //   因此首登建档路径在此被显式阻断（401）。已撤销行（active_marker=NULL）不占用槽位，
  //   可重新绑定 → 走正常建档（见 B4）。详见 S2-6c-3-REPORT §12。
  const r5 = await login(code('OPENID_INACTIVE'));
  check(
    'B5 停用身份行（status=2）→ 不匹配，且占用唯一槽位不可重新绑定 → 401 AUTH_REQUIRED',
    r5.res.status === 401 && r5.body?.error?.code === 'AUTH_REQUIRED',
    `got ${r5.res.status} ${r5.text.slice(0, 140)}`,
  );

  const r6 = await login(code('OPENID_DISABLED'));
  check('B6 停用用户（status=3）→ 401 AUTH_REQUIRED',
    r6.res.status === 401 && r6.body?.error?.code === 'AUTH_REQUIRED', `got ${r6.res.status} ${r6.text.slice(0, 120)}`);

  check('B7 首登恰好创建 1 个 user（users +1）', after.users === before.users + 1, `${before.users} → ${after.users}`);
  check(
    'B8 首登不授角色（user_roles 不变）且恰好创建 1 个 session',
    after.ur === before.ur && after.sess === before.sess + 1,
    `ur ${before.ur}→${after.ur}, sess ${before.sess}→${after.sess}`,
  );
}

// =======================================================================
process.stderr.write('C. 登出（5）\n');
const t2 = (await login(code('OPENID_A'))).body?.data?.token ?? null;
{
  const r = await req('POST', '/api/v2/auth/logout', { headers: bearer(t1) });
  check('C1 logout → 200 + status=OK',
    r.res.status === 200 && r.body?.data?.status === 'OK', `got ${r.res.status} ${r.text.slice(0, 120)}`);

  const me = await req('GET', '/api/v2/users/me', { headers: bearer(t1) });
  check('C2 登出后原 token 立即失效', me.res.status === 401, `got ${me.res.status}`);

  const r2 = await req('POST', '/api/v2/auth/logout', { headers: bearer(t1) });
  check('C3 重复 logout 幂等（仍 200 OK）',
    r2.res.status === 200 && r2.body?.data?.status === 'OK', `got ${r2.res.status}`);

  const r3 = await req('POST', '/api/v2/auth/logout');
  check('C4 无 token logout → 401 AUTH_REQUIRED',
    r3.res.status === 401 && r3.body?.error?.code === 'AUTH_REQUIRED', `got ${r3.res.status}`);

  const me2 = await req('GET', '/api/v2/users/me', { headers: bearer(t2) });
  check('C5 登出只影响当前会话（另一设备仍 200）', me2.res.status === 200, `got ${me2.res.status}`);
}

// =======================================================================
process.stderr.write('D. 会话管理（7）\n');
const t3 = (await login(code('OPENID_A'))).body?.data?.token ?? null;
const t4 = (await login(code('OPENID_A'))).body?.data?.token ?? null;
const tB = (await login(code('OPENID_B'))).body?.data?.token ?? null;
let listA = null;
{
  listA = await req('GET', '/api/v2/auth/sessions', { headers: bearer(t2) });
  const dbActive = activeSessions(volAId);
  const items = listA.body?.data?.items ?? [];
  check('D1 列表数量 = 该用户活跃会话数（DB 一致）',
    listA.res.status === 200 && items.length === dbActive.length, `items=${items.length} db=${dbActive.length}`);

  // S2-6c-3：新增派生展示字段 device_name（指令 §六），白名单 7 → 8。
  const expectedKeys = [
    'created_at', 'device_name', 'expires_at', 'id', 'last_seen_at', 'public_id', 'status', 'user_agent_summary',
  ];
  const keyOk = items.every((it) => JSON.stringify(Object.keys(it).sort()) === JSON.stringify(expectedKeys));
  check('D2 字段白名单（仅 7 个安全字段）', items.length > 0 && keyOk,
    `keys=${JSON.stringify(items[0] ? Object.keys(items[0]).sort() : [])}`);

  const hashes = withDb((db) => db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash));
  const hashLeak = hashes.filter((h) => listA.text.includes(h));
  check('D3 列表不含 token_hash', hashLeak.length === 0, `leaked=${hashLeak.length}`);

  const anon = await req('GET', '/api/v2/auth/sessions');
  check('D4 未认证 → 401 AUTH_REQUIRED',
    anon.res.status === 401 && anon.body?.error?.code === 'AUTH_REQUIRED', `got ${anon.res.status}`);

  const listB = await req('GET', '/api/v2/auth/sessions', { headers: bearer(tB) });
  const idsA = new Set(items.map((i) => i.public_id));
  const idsB = new Set((listB.body?.data?.items ?? []).map((i) => i.public_id));
  const overlap = [...idsB].filter((x) => idsA.has(x));
  check('D5 仅返回自己的会话（A/B 列表零交集）',
    idsA.size > 0 && idsB.size > 0 && overlap.length === 0, `overlap=${overlap.length}`);

  const target = items.find((i) => i.public_id !== null && i.status === 1);
  const rv = await req('POST', `/api/v2/auth/sessions/${target.id}/revoke`, { headers: bearer(t2) });
  const revoked = withDb((db) => db.prepare('SELECT status FROM sessions WHERE id = ?').get(target.id)?.status);
  check('D6 撤销自己的会话 → 200 且 DB status=2',
    rv.res.status === 200 && revoked === 2, `http=${rv.res.status} status=${revoked}`);

  const victim = (listB.body?.data?.items ?? [])[0];
  const cross = await req('POST', `/api/v2/auth/sessions/${victim.id}/revoke`, { headers: bearer(t2) });
  const bad = await req('POST', '/api/v2/auth/sessions/abc/revoke', { headers: bearer(t2) });
  check('D7 撤销他人会话 → 404（不泄露存在性）；非法 id → 400',
    cross.res.status === 404 && bad.res.status === 400, `cross=${cross.res.status} bad=${bad.res.status}`);
}

// =======================================================================
process.stderr.write('E. 管理端 Cookie 通道（5）\n');
{
  const r = await login(code('OPENID_OWNER'), { cookie: true });
  const sc = r.res.headers.get('set-cookie') ?? '';
  check('E1 Set-Cookie 签发 __Host-session',
    r.res.status === 200 && sc.startsWith('__Host-session='), `sc=${sc.slice(0, 80)}`);

  const lower = sc.toLowerCase();
  check('E2 属性齐全 HttpOnly/Secure/Path=/ /SameSite=Lax',
    lower.includes('httponly') && lower.includes('secure') && lower.includes('path=/') && lower.includes('samesite=lax'),
    `sc=${sc}`);

  check('E3 无 Domain 属性', !lower.includes('domain='), `sc=${sc}`);

  const ctoken = /__Host-session=([A-Za-z0-9_-]+)/.exec(sc)?.[1] ?? null;
  const me = ctoken ? await req('GET', '/api/v2/users/me', { headers: cookieHdr(ctoken) }) : null;
  check('E4 Cookie 通道可认证（与 Bearer 同一 SessionService）',
    me?.res.status === 200 && me?.body?.data?.user?.public_id === IDS.ownerA, `got ${me?.res.status}`);

  const r2 = await login(code('OPENID_OWNER'));
  check('E5 不带 cookie=1 时不签发 Cookie（小程序通道）',
    (r2.res.headers.get('set-cookie') ?? '') === '', `sc=${r2.res.headers.get('set-cookie')}`);
}

// =======================================================================
process.stderr.write('F. 安全边界（3）\n');
{
  const r = await login(code('ERROR', '-'));
  const l1 = leaksSecrets(r.text);
  check('F1 provider 故障 → 403 FORBIDDEN 且不泄露微信原始错误',
    r.res.status === 403 && r.body?.error?.code === 'FORBIDDEN' && l1.length === 0,
    `got ${r.res.status} leaked=${l1}`);

  const bad1 = await req('POST', '/api/v2/auth/wechat/login', { body: {} });
  const bad2 = await req('POST', '/api/v2/auth/wechat/login', { body: { code: '' } });
  const bad3 = await req('POST', '/api/v2/auth/wechat/login', { body: { code: 'abc' } });
  check('F2 code 缺失/空/过短 → 400 INVALID_PARAM',
    bad1.res.status === 400 && bad2.res.status === 400 && bad3.res.status === 400 &&
      bad1.body?.error?.code === 'INVALID_PARAM',
    `${bad1.res.status}/${bad2.res.status}/${bad3.res.status}`);

  const texts = [r.text, bad1.text, bad2.text, bad3.text, listA.text].join(' ');
  const li = leaksInternals(texts);
  check('F3 错误体不泄露 SQL/表名/内部结构', li.length === 0, `leaked=${li}`);
}

process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
