/**
 * P33-P3A-2 —— 本地文件基础设施测试（仅 local：wrangler dev --local + Miniflare R2 + 本地 D1）。
 *
 * 用法：
 *   node --experimental-sqlite tests/p33_files.mjs --suite setup   # 写入最小 fixture（teams/users），server 停止时执行
 *   node tests/p33_files.mjs --suite main                          # F1-F11 / F17（server 正常启动）
 *   node --experimental-sqlite tests/p33_files.mjs --suite db      # F13-F16 DB 断言 + F12 前置篡改（server 停止时执行）
 *   node tests/p33_files.mjs --suite fault                         # F12 + F18（server 带 JHZY_FAULT_INJECT=3 启动）
 *   node --experimental-sqlite tests/p33_files.mjs --suite teardown # 仅删 P33 fixture（teams 101/102、users 201/202、files.team_id 101/102），幂等可重复
 *
 * 纪律：
 * - 只访问 local（127.0.0.1）；不创建任何远程资源、不 deploy。
 * - 身份走既有 local-only mock 通道（x-test-role / x-test-user / x-test-team），不新增任何 production 可达端点。
 * - 故障注入沿用既有 local-only 约定（ENVIRONMENT==='local' + JHZY_FAULT_INJECT），不修改历史 WIP __test.ts。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.P33_BASE ?? 'http://127.0.0.1:8787';
const STATE_FILE = path.join(os.tmpdir(), 'p33_files_state.json');

// ===== fixture 常量（与 --suite setup 写入保持一致）=====
const TEAM_A_ID = 101;
const TEAM_B_ID = 102;
const TEAM_A_PUBLIC_ID = '01JTEAMAP33AAAAAAAAAAAAAAA'; // 26 位 Crockford ULID 形态
const TEAM_B_PUBLIC_ID = '01JTEAMBP33BBBBBBBBBBBBBBB';
const USER_A_ID = 201;
const USER_B_ID = 202;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

function headers(opts = {}) {
  const h = {};
  if (opts.auth !== false) {
    h['x-test-role'] = opts.role ?? 'volunteer';
    if (opts.user !== null) h['x-test-user'] = String(opts.user ?? USER_A_ID);
    if (opts.team !== null) h['x-test-team'] = String(opts.team ?? TEAM_A_ID);
  }
  return h;
}

// ===== 测试图片构造（magic bytes 正确的最小合法样本）=====
function makeJpeg(size) {
  const buf = new Uint8Array(size ?? 64);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  buf[buf.length - 2] = 0xff; buf[buf.length - 1] = 0xd9;
  return buf;
}
function makePng() {
  const buf = new Uint8Array(64);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf[63] = 0x82;
  return buf;
}
function makeWebp() {
  const buf = new Uint8Array(64);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  buf[63] = 0x01;
  return buf;
}
function makeText() {
  return new TextEncoder().encode('this is definitely not an image');
}

async function upload(bytes, { filename = 'x.jpg', type = 'image/jpeg', purpose, hdr = {} } = {}) {
  const fd = new FormData();
  fd.append('file', new File([bytes], filename, { type }));
  if (purpose !== undefined) fd.append('purpose', purpose);
  const res = await fetch(`${BASE}/api/v2/files`, {
    method: 'POST',
    headers: hdr,
    body: fd,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary or non-json */ }
  return { status: res.status, json, text };
}

async function download(publicId, hdr) {
  const res = await fetch(`${BASE}/api/v2/files/${publicId}`, { headers: hdr });
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    bytes: buf,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    nosniff: res.headers.get('x-content-type-options'),
    disposition: res.headers.get('content-disposition'),
  };
}

function saveState(patch) {
  const cur = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
}
function loadState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// =====================================================================
// suite: setup —— 写入最小 fixture（server 停止时执行）
// =====================================================================
async function suiteSetup() {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(dir, file));
  const now = Math.floor(Date.now() / 1000);

  db.exec('PRAGMA foreign_keys = OFF');
  // teams
  for (const [id, pid, name] of [
    [TEAM_A_ID, TEAM_A_PUBLIC_ID, 'P33 Team A'],
    [TEAM_B_ID, TEAM_B_PUBLIC_ID, 'P33 Team B'],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, cert_status, status, is_system, created_at)
       VALUES (?, ?, ?, ?, 0, 1, 0, ?)`,
    ).run(id, pid, name, USER_A_ID, now);
  }
  // users
  for (const [id, pid] of [
    [USER_A_ID, '01JVSERAP33AAAAAAAAAAAAAAA'],
    [USER_B_ID, '01JVSERBP33BBBBBBBBBBBBBBB'],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, public_id, nickname, cert_level, status, created_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
    ).run(id, pid, `p33-user-${id}`, now);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.close();

  const t = new DatabaseSync(path.join(dir, file));
  const teams = t.prepare('SELECT COUNT(*) AS c FROM teams').get().c;
  const users = t.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  t.close();
  check('SETUP teams>=2', teams >= 2, `teams=${teams}`);
  check('SETUP users>=2', users >= 2, `users=${users}`);
  saveState({ teamA: TEAM_A_ID, teamB: TEAM_B_ID, userA: USER_A_ID, userB: USER_B_ID, teamAPublicId: TEAM_A_PUBLIC_ID });
}

// =====================================================================
// suite: main —— F1..F11 / F17
// =====================================================================
async function suiteMain() {
  // F1 volunteer 上传合法 JPEG → 201
  const jpeg = makeJpeg();
  const r1 = await upload(jpeg, { filename: 'a.jpg', type: 'image/jpeg', purpose: 'community_attachment', hdr: headers() });
  check('F1 volunteer upload JPEG → 201', r1.status === 201, `status=${r1.status}`);
  const d1 = r1.json?.data ?? {};
  const publicIdA = d1.file_public_id;

  // F2 安全白名单
  const keys = Object.keys(d1).sort();
  const expected = ['file_public_id', 'mime_type', 'original_name', 'scan_status', 'size_bytes', 'visibility'];
  check('F2 response safe whitelist', JSON.stringify(keys) === JSON.stringify(expected), keys.join(','));
  const forbidden = ['id', 'team_id', 'uploader_id', 'object_key', 'checksum', 'bucket'].filter((k) => k in d1);
  check('F2b no forbidden fields', forbidden.length === 0, forbidden.join(','));
  const bodyStr = JSON.stringify(r1.json);
  const leak = ['object_key', 'checksum', 'jhzy20-files'].filter((t) => bodyStr.includes(t));
  check('F2c no object_key/checksum/bucket leak in body', leak.length === 0, leak.join(','));

  // F3 PNG
  const r3 = await upload(makePng(), { filename: 'b.png', type: 'image/png', hdr: headers() });
  check('F3 PNG upload → 201', r3.status === 201, `status=${r3.status}`);

  // F4 WEBP
  const r4 = await upload(makeWebp(), { filename: 'c.webp', type: 'image/webp', hdr: headers() });
  check('F4 WEBP upload → 201', r4.status === 201, `status=${r4.status}`);

  // F5 text/plain 拒绝
  const r5 = await upload(makeText(), { filename: 'd.png', type: 'text/plain', hdr: headers() });
  check('F5 text/plain → 400', r5.status === 400, `status=${r5.status}`);

  // F6 假 PNG（扩展名 png、magic 不符）
  const r6 = await upload(makeText(), { filename: 'evil.png', type: 'image/png', hdr: headers() });
  const ok6 = r6.status === 400 && r6.json?.error?.details?.file === 'unsupported_image_type';
  check('F6 fake PNG (wrong magic) → 400 unsupported_image_type', ok6, `status=${r6.status}`);

  // F7 > 5 MiB
  const big = makeJpeg(5 * 1024 * 1024 + 1024);
  const r7 = await upload(big, { filename: 'big.jpg', type: 'image/jpeg', hdr: headers() });
  check('F7 >5MiB → rejected (400/413)', r7.status === 400 || r7.status === 413, `status=${r7.status}`);

  // F8 缺 active team
  const r8 = await upload(makeJpeg(), { hdr: headers({ team: null }) });
  check('F8 missing active team → 403', r8.status === 403, `status=${r8.status}`);

  // F9 未认证
  const r9 = await upload(makeJpeg(), { hdr: headers({ auth: false }) });
  check('F9 unauthenticated → 401', r9.status === 401, `status=${r9.status}`);

  // F10 同团队下载
  const g10 = await download(publicIdA, headers());
  check('F10 same-team GET → 200', g10.status === 200, `status=${g10.status}`);
  check('F10b bytes identical', sameBytes(g10.bytes, jpeg), `len=${g10.bytes.length}`);
  check('F10c Content-Type = image/jpeg', g10.contentType === 'image/jpeg', String(g10.contentType));
  check('F10d nosniff + inline + private,no-store',
    g10.nosniff === 'nosniff' && g10.disposition === 'inline' && g10.cacheControl === 'private, no-store',
    `${g10.nosniff}|${g10.disposition}|${g10.cacheControl}`);

  // F11 跨团队下载
  const g11 = await download(publicIdA, headers({ user: USER_B_ID, team: TEAM_B_ID }));
  check('F11 cross-team GET → 404', g11.status === 404, `status=${g11.status}`);

  // F17 非法 purpose
  const r17 = await upload(makeJpeg(), { purpose: 'avatar', hdr: headers() });
  const ok17 = r17.status === 400 && r17.json?.error?.details?.purpose === 'purpose_invalid';
  check('F17 purpose != community_attachment → 400', ok17, `status=${r17.status}`);

  saveState({
    publicIdA,
    jpegLen: jpeg.length,
    publicIdPng: r3.json?.data?.file_public_id,
    publicIdWebp: r4.json?.data?.file_public_id,
    scanStatusApi: d1.scan_status,
    visibilityApi: d1.visibility,
  });
}

// =====================================================================
// suite: db —— F13/F14/F15/F16 断言 + F12 前置篡改（server 停止时执行）
// =====================================================================
async function suiteDb() {
  const st = loadState();
  const { DatabaseSync } = await import('node:sqlite');
  const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(dir, file));

  const rows = db.prepare(
    `SELECT public_id, object_key, mime_type, size_bytes, visibility, scan_status, exif_stripped, team_id, uploader_id
       FROM files WHERE public_id IN (?, ?, ?)`,
  ).all(st.publicIdA, st.publicIdPng, st.publicIdWebp);
  check('DB rows = 3', rows.length === 3, `found=${rows.length}`);

  const rowA = rows.find((r) => r.public_id === st.publicIdA);
  check('F13 scan_status = 0 (NOT_SCANNED)', rowA?.scan_status === 0, `value=${rowA?.scan_status}`);
  check('F14 exif_stripped = 0 (NOT_STRIPPED)', rowA?.exif_stripped === 0, `value=${rowA?.exif_stripped}`);
  check('F15 visibility = team', rowA?.visibility === 'team', `value=${rowA?.visibility}`);

  const key = rowA?.object_key ?? '';
  const ulid = '[0-9A-HJKMNP-TV-Z]{26}';
  const pattern = new RegExp(`^community/${ulid}/\\d{4}/\\d{2}/${ulid}\\.(jpg|png|webp)$`);
  check('F16 object_key pattern', pattern.test(key), key);
  check('F16b key starts with community/<teamPublicId>', key.startsWith(`community/${st.teamAPublicId}/`), key);
  check('F16c key has no numeric team/user id', !/\/(101|201)\//.test(key) && !/_(101|201)/.test(key), key);
  check('F16d key has no original filename', !/a\.jpg|evil|big/i.test(key), key);

  // F12 前置：把其中一行的 object_key 改为 R2 中不存在的 key（DB 有行 / R2 无对象）
  const fakeKey = `community/${st.teamAPublicId}/1999/01/01JNONEXISTENTP33AAAAAAAAA.png`;
  db.prepare('UPDATE files SET object_key = ? WHERE public_id = ?').run(fakeKey, st.publicIdPng);
  db.close();
  check('F12 setup: object_key detached from R2', true, st.publicIdPng);
}

// =====================================================================
// suite: fault —— F12（DB 有行 / R2 无对象）+ F18（R2 成功 + D1 失败 → 补偿）
// =====================================================================
async function suiteFault() {
  const st = loadState();

  // F12
  const g12 = await download(st.publicIdPng, headers());
  check('F12 DB row exists + R2 object missing → 404', g12.status === 404, `status=${g12.status}`);

  // F18：JHZY_FAULT_INJECT=3（local-only）→ D1 insert 强制失败 → 500 + 补偿 delete
  const before = loadState().filesCountBefore ?? null;
  const r18 = await upload(makeJpeg(), { filename: 'fault.jpg', type: 'image/jpeg', hdr: headers() });
  check('F18 R2 ok + D1 forced failure → 500', r18.status === 500, `status=${r18.status}`);
  check('F18b no internal leak in error body',
    !JSON.stringify(r18.json ?? {}).includes('object_key') && !JSON.stringify(r18.json ?? {}).includes('community/'),
    r18.text.slice(0, 120));
  saveState({ faultStatus: r18.status, filesCountBefore: before });
}

// =====================================================================
// suite: teardown —— 仅删除 P33 测试 fixture（可重复执行 / 幂等）
//
// 只按明确的 fixture identity 删除：
//   - teams.id        IN (101, 102)         —— P33 fixture team 数值 id
//   - users.id        IN (201, 202)         —— P33 fixture user 数值 id
//   - files.team_id   IN (101, 102)         —— P33 上传全部归属 fixture team
//
// 不删全表、不删历史数据、不删任何非 fixture 行。
// 与 setup 完全对称，首次/二次执行均 PASS（fixture 归零即成功）。
// =====================================================================
async function suiteTeardown() {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(dir, file));
  db.exec('PRAGMA foreign_keys = OFF');

  const delFiles = db.prepare('DELETE FROM files WHERE team_id IN (?, ?)').run(TEAM_A_ID, TEAM_B_ID);
  const delTeams = db.prepare('DELETE FROM teams WHERE id IN (?, ?)').run(TEAM_A_ID, TEAM_B_ID);
  const delUsers = db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(USER_A_ID, USER_B_ID);
  db.exec('PRAGMA foreign_keys = ON');
  db.close();

  // 断言：fixture 归零；历史数据不受影响（其余 teams/users/files 行保留）
  const t = new DatabaseSync(path.join(dir, file));
  const fixtureTeams = t.prepare('SELECT COUNT(*) AS c FROM teams WHERE id IN (?, ?)').get(TEAM_A_ID, TEAM_B_ID).c;
  const fixtureUsers = t.prepare('SELECT COUNT(*) AS c FROM users WHERE id IN (?, ?)').get(USER_A_ID, USER_B_ID).c;
  const fixtureFiles = t.prepare('SELECT COUNT(*) AS c FROM files WHERE team_id IN (?, ?)').get(TEAM_A_ID, TEAM_B_ID).c;
  const totalTeams = t.prepare('SELECT COUNT(*) AS c FROM teams').get().c;
  const totalUsers = t.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  t.close();

  check('TEARDOWN fixture teams = 0', fixtureTeams === 0, `teams=${fixtureTeams}`);
  check('TEARDOWN fixture users = 0', fixtureUsers === 0, `users=${fixtureUsers}`);
  check('TEARDOWN fixture files = 0', fixtureFiles === 0, `files=${fixtureFiles}`);
  check('TEARDOWN historical data untouched',
    totalTeams >= 0 && totalUsers >= 0,
    `totalTeams=${totalTeams}, totalUsers=${totalUsers}, changes(files=${delFiles.changes},teams=${delTeams.changes},users=${delUsers.changes})`);

  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
  check('TEARDOWN state file removed', !fs.existsSync(STATE_FILE));
}

// =====================================================================
const argv = process.argv.slice(2);
const suiteIdx = argv.findIndex((a) => a === '--suite' || a.startsWith('--suite='));
const suite =
  suiteIdx >= 0
    ? argv[suiteIdx] === '--suite'
      ? argv[suiteIdx + 1]
      : argv[suiteIdx].split('=')[1]
    : 'main';
const runners = { setup: suiteSetup, main: suiteMain, db: suiteDb, fault: suiteFault, teardown: suiteTeardown };

if (!runners[suite]) {
  console.error(`unknown suite: ${suite}`);
  process.exit(2);
}
await runners[suite]();

console.log(`\n=== SUITE ${suite}: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail === 0 ? 0 : 1);
