#!/usr/bin/env node
/**
 * S2-6k1 V1 REGRESSION 编排器（Time Foundation）。
 *
 * 在全新隔离 state（.tmp/s2-6k1-state，原生 0001→0005）上实跑：
 *   P0   原生迁移 + 校验 migrations=5 / 0005 存在 / 0006 不存在 / 0004 索引
 *   P1   NORMAL worker（PORT 8795，非 8787）
 *   P2   frozen regression 8 套（340）—— 本轮 runtime/schema 已变，必须重跑
 *   P2.5 S2-6k1 Time Foundation 集成（time_policy_integration.mjs，不计入 340）
 *   P3   S2-6i 主集成（80）
 *   P6   S2-6j 主集成（87）
 *   P4/7 S2-6i + S2-6j atomic MODE1（fault worker 1）
 *   P5/8 S2-6i + S2-6j atomic MODE2（fault worker 2）
 *   P9   完整性 / teardown（FK 0 / integrity ok / catalog 6·83·238 / 业务表 0 / 8787 不动）
 *   P10  catalog 静态校验（JSON-only）
 *
 * 端口纪律：仅用 PORT（默认 8795），只 kill 监听该端口的 PID；8787（Signivra）绝不触碰。
 */

import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function removeState() {
  if (!existsSync(STATE)) return;
  try { rmSync(STATE, { recursive: true, force: true }); }
  catch {
    try { execFileSync('rm', ['-rf', STATE], { stdio: 'ignore' }); }
    catch {
      try { execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', STATE], { stdio: 'ignore' }); }
      catch { /* 交由 migrations apply 覆盖 */ }
    }
  }
}

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const WRANGLER = resolve('node_modules/wrangler/bin/wrangler.js');
const CWD = resolve('.');
const PORT = Number(process.env.JHZY_TEST_PORT ?? 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = resolve('.tmp/s2-6k1-state');
const D1_DIR = join(STATE, 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = join('.tmp', 's2-6k1-manifest.json');
const TMP = resolve('.tmp');
const LOG = join(TMP, 'run_s2_6k1.log');
const SUMMARY = join(TMP, 's2-6k1-summary.json');
const FAULT_CFG_1 = resolve('wrangler.s2-6k1-fault1.jsonc');
const FAULT_CFG_2 = resolve('wrangler.s2-6k1-fault2.jsonc');

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
const logFd = openSync(LOG, 'w');
function log(s) {
  const line = typeof s === 'string' ? s : JSON.stringify(s);
  try { writeSync(logFd, line + '\n'); } catch {}
  process.stdout.write(line + '\n');
}

const SPAWNED_PIDS = [];
function runCapture(cmd, args, env, outFile) {
  return new Promise((res) => {
    const fd = openSync(outFile, 'w');
    const p = spawn(cmd, args, { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    p.on('exit', (code) => { try { closeSync(fd); } catch {} res(code ?? 1); });
  });
}
function parseCounts(text) {
  let m = text.match(/TOTAL:\s*(\d+)\s*pass(?:ed)?,\s*(\d+)\s*fail(?:ed)?/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  m = text.match(/pass=(\d+)\s+fail=(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  return { pass: null, fail: null };
}
async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}
async function killPort() {
  const ps = `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
  await runCapture('powershell.exe', ['-NoProfile', '-Command', ps], {}, join(TMP, 'killport.log'));
  await new Promise((r) => setTimeout(r, 1500));
}
let worker = null;
async function startWorker(extraArgs, tag) {
  const args = [WRANGLER, 'dev', '--port', String(PORT), '--local', '--persist-to', STATE, ...extraArgs];
  const p = spawn(NODE, args, { cwd: CWD, env: { ...process.env }, stdio: ['ignore', logFd, logFd] });
  SPAWNED_PIDS.push(p.pid);
  log(`[harness] ${tag} worker launched pid=${p.pid}`);
  worker = p;
  const ok = await waitHealth(180000);
  if (!ok) throw new Error(`${tag}_WORKER_NOT_READY`);
  log(`[harness] ${tag} worker READY on ${BASE}`);
  return p;
}
async function stopWorker(tag) {
  if (worker) { try { worker.kill('SIGKILL'); } catch {} }
  await killPort();
  worker = null;
  log(`[harness] ${tag} worker stopped; port ${PORT} released`);
}
function writeFaultConfig(mode, outPath) {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  const out = src.replace(
    /"vars":\s*{\s*\n\s*"ENVIRONMENT":\s*"local",\s*\n\s*"IDENTITY_HMAC_KEY_PREVIOUS":\s*"[^"]*"\s*\n\s*}/,
    `"vars": {\n    "ENVIRONMENT": "local",\n    "IDENTITY_HMAC_KEY_PREVIOUS": "test-previous-hmac-key-2026",\n    "JHZY_FAULT_INJECT": "${mode}"\n  }`,
  );
  if (out === src) throw new Error('FAULT_CFG_REPLACE_FAILED');
  writeFileSync(outPath, out);
  log(`[harness] fault config (mode ${mode}) -> ${outPath}`);
}
function dbFile() {
  const f = readdirSync(D1_DIR).filter((x) => x.endsWith('.sqlite') && x !== 'metadata.sqlite');
  if (f.length !== 1) throw new Error(`expected 1 sqlite, got ${f.join(',')}`);
  return join(D1_DIR, f[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try { return fn(db); } finally { db.close(); }
}
const env = { JHZY_D1_DIR: D1_DIR, JHZY_MANIFEST: MANIFEST, BASE_URL: BASE };
const results = { suites: [], time_policy: {}, s2_6i: {}, s2_6j: {}, static: {}, catalog: {}, integrity: {}, teardown: {}, port: {} };

const SUITES = [
  { id: 'S2-5', fixture: 'setup', test: 'api_integration.mjs', expect: 58 },
  { id: 'S2-6c-1', fixture: 'session', test: 'session_integration.mjs', expect: 19 },
  { id: 'S2-6c-2', fixture: 'auth', test: 'auth_integration.mjs', expect: 34 },
  { id: 'S2-6c-3', fixture: 'firstlogin', test: 'firstlogin_integration.mjs', expect: 31 },
  { id: 'S2-6c-4', fixture: 'sec', test: 'session_security_integration.mjs', expect: 24 },
  { id: 'S2-6f', fixture: 'authz', test: 'authorization_integration.mjs', expect: 42 },
  { id: 'S2-6g', fixture: 'signup', test: 'activity_signup_integration.mjs', expect: 61 },
  { id: 'S2-6h-R2', fixture: 'attendance', test: 'attendance_integration.mjs', expect: 71 },
];
async function fixture(mode, tag) {
  const code = await runCapture(NODE, ['tests/fixture.mjs', mode], env, join(TMP, `fixture-${tag}.log`));
  const out = readFileSync(join(TMP, `fixture-${tag}.log`), 'utf8').trim();
  log(`[fixture:${mode}] exit=${code} :: ${out.split('\n').slice(-1)[0]}`);
  if (code !== 0) throw new Error(`FIXTURE_FAILED_${mode}: ${out}`);
}

try {
  // ================= P0 全新隔离 state（原生迁移）=================
  log('===== P0: rebuild isolated S2-6k1 state (native wrangler migrations 0001-0005) =====');
  await killPort();
  if (existsSync(STATE)) { removeState(); log(`[P0] removed old ${STATE}`); }
  const migLog = join(TMP, 'p0-migrations.log');
  const migCode = await runCapture(NODE, [WRANGLER, 'd1', 'migrations', 'apply', 'jhzy-v2-local', '--local', '--persist-to', STATE], {}, migLog);
  const migOut = readFileSync(migLog, 'utf8');
  log(`[P0] wrangler d1 migrations apply exit=${migCode}`);
  log(migOut.split('\n').filter((l) => /000\d|migration|Migration|✅|success/i.test(l)).join('\n'));
  if (migCode !== 0) throw new Error('MIGRATIONS_APPLY_FAILED');
  const mig = withDb((db) => db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name));
  log(`[P0] d1_migrations (${mig.length}): ${mig.join(' | ')}`);
  results.static.migrations_applied = mig;
  if (mig.length !== 5) throw new Error(`EXPECTED_5_MIGRATIONS_GOT_${mig.length}`);
  if (!mig.some((n) => n.includes('0005'))) throw new Error('MISSING_0005_MIGRATION');
  if (mig.some((n) => n.includes('0006'))) throw new Error('UNEXPECTED_0006_MIGRATION');
  const idx = withDb((db) =>
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('uq_active_attendance','idx_as_signup') ORDER BY name`).all().map((r) => r.name),
  );
  log(`[P0] 0004 indexes present: ${idx.join(',') || '(none)'}`);
  results.static.indexes_0004 = idx;
  // 0005 列存在确认
  const cols = withDb((db) => ({
    biz: db.prepare("SELECT name FROM pragma_table_info('attendance_sessions') WHERE name='business_service_date'").get()?.name,
    msm: db.prepare("SELECT name FROM pragma_table_info('activities') WHERE name='max_session_minutes'").get()?.name,
  }));
  if (!cols.biz || !cols.msm) throw new Error('0005_COLUMNS_MISSING');
  log(`[P0] 0005 columns present: business_service_date=${cols.biz}, max_session_minutes=${cols.msm}`);

  // ================= P1 NORMAL worker =================
  log('===== P1: start NORMAL worker =====');
  await startWorker([], 'NORMAL');

  // ================= P2 frozen regression 8 套 =================
  log('===== P2: FROZEN REGRESSION (8 suites, isolated state) =====');
  for (const s of SUITES) {
    await fixture('teardown', `pre-${s.id}`);
    await fixture(s.fixture, s.id);
    const outFile = join(TMP, `suite-${s.id}.log`);
    const code = await runCapture(NODE, [`tests/${s.test}`], env, outFile);
    const txt = readFileSync(outFile, 'utf8');
    const { pass, fail } = parseCounts(txt);
    const total = pass == null ? null : pass + fail;
    const row = { id: s.id, test: s.test, pass, fail, total, exit: code, expect: s.expect, ok: code === 0 && fail === 0 && total === s.expect };
    results.suites.push(row);
    log(`[P2] ${s.id.padEnd(9)} PASS=${pass} FAIL=${fail} TOTAL=${total} EXIT=${code} EXPECT=${s.expect} ${row.ok ? 'OK' : '*** MISMATCH ***'}`);
    if (!row.ok) log(`[P2] ${s.id} tail:\n` + txt.split('\n').slice(-25).join('\n'));
    await fixture('teardown', `post-${s.id}`);
  }

  // ================= P2.5 S2-6k1 Time Foundation 集成（不计入 340）=================
  log('===== P2.5: S2-6k1 TIME POLICY integration =====');
  await fixture('attendance', 'S2-6k1');
  const tpOut = join(TMP, 'suite-S2-6k1.log');
  const tpCode = await runCapture(NODE, ['tests/time_policy_integration.mjs'], env, tpOut);
  const tpTxt = readFileSync(tpOut, 'utf8');
  const tpCnt = parseCounts(tpTxt);
  results.time_policy = { ...tpCnt, total: tpCnt.pass + tpCnt.fail, exit: tpCode, ok: tpCode === 0 && tpCnt.fail === 0 };
  log(`[P2.5] S2-6k1 TIME POLICY PASS=${tpCnt.pass} FAIL=${tpCnt.fail} TOTAL=${tpCnt.pass + tpCnt.fail} EXIT=${tpCode}`);
  if (tpCode !== 0) log('[P2.5] failures:\n' + tpTxt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-S2-6k1');

  // ================= P3 S2-6i 主集成 =================
  log('===== P3: S2-6i MAIN integration (80) =====');
  await fixture('attendance-management', 'S2-6i-main');
  const mainOut = join(TMP, 'suite-S2-6i-main.log');
  const mainCode = await runCapture(NODE, ['tests/attendance_management_integration.mjs'], env, mainOut);
  const mainTxt = readFileSync(mainOut, 'utf8');
  const mainCnt = parseCounts(mainTxt);
  results.s2_6i.main = { ...mainCnt, total: mainCnt.pass + mainCnt.fail, exit: mainCode };
  log(`[P3] S2-6i MAIN PASS=${mainCnt.pass} FAIL=${mainCnt.fail} TOTAL=${mainCnt.pass + mainCnt.fail} EXIT=${mainCode}`);
  if (mainCode !== 0) log('[P3] failures:\n' + mainTxt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-S2-6i-main');

  // ================= P6 S2-6j 主集成 =================
  log('===== P6: S2-6j MAIN integration (87) =====');
  await fixture('anomaly', 'S2-6j-main');
  const jOut = join(TMP, 'suite-S2-6j-main.log');
  const jCode = await runCapture(NODE, ['tests/attendance_anomaly_integration.mjs'], env, jOut);
  const jTxt = readFileSync(jOut, 'utf8');
  const jCnt = parseCounts(jTxt);
  results.s2_6j.main = { ...jCnt, total: jCnt.pass + jCnt.fail, exit: jCode, expect: 87 };
  log(`[P6] S2-6j MAIN PASS=${jCnt.pass} FAIL=${jCnt.fail} TOTAL=${jCnt.pass + jCnt.fail} EXIT=${jCode}`);
  if (jCode !== 0) log('[P6] failures:\n' + jTxt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-S2-6j-main');
  await stopWorker('NORMAL');

  // ================= P4/7 S2-6i + S2-6j atomic MODE 1 =================
  log('===== P4/7: ATOMICITY fault MODE 1 (stmt[0] INSERT fails) =====');
  writeFaultConfig('1', FAULT_CFG_1);
  await startWorker(['--config', FAULT_CFG_1], 'FAULT1');
  await fixture('attendance-management', 'S2-6i-atom1');
  const a1Out = join(TMP, 'suite-S2-6i-atom-mode1.log');
  const a1Code = await runCapture(NODE, ['tests/attendance_management_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '1' }, a1Out);
  const a1Txt = readFileSync(a1Out, 'utf8');
  const a1Cnt = parseCounts(a1Txt);
  results.s2_6i.atomicity_mode1 = { ...a1Cnt, total: a1Cnt.pass + a1Cnt.fail, exit: a1Code };
  log(`[P4] S2-6i ATOMICITY-1 PASS=${a1Cnt.pass} FAIL=${a1Cnt.fail} TOTAL=${a1Cnt.pass + a1Cnt.fail} EXIT=${a1Code}`);
  if (a1Code !== 0) log('[P4] failures:\n' + a1Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom1-s2-6i');

  await fixture('anomaly', 'S2-6j-atom1');
  const ja1Out = join(TMP, 'suite-S2-6j-atom-mode1.log');
  const ja1Code = await runCapture(NODE, ['tests/attendance_anomaly_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '1' }, ja1Out);
  const ja1Txt = readFileSync(ja1Out, 'utf8');
  const ja1Cnt = parseCounts(ja1Txt);
  results.s2_6j.atomicity_mode1 = { ...ja1Cnt, total: ja1Cnt.pass + ja1Cnt.fail, exit: ja1Code };
  log(`[P7] S2-6j ATOMICITY-1 PASS=${ja1Cnt.pass} FAIL=${ja1Cnt.fail} TOTAL=${ja1Cnt.pass + ja1Cnt.fail} EXIT=${ja1Code}`);
  if (ja1Code !== 0) log('[P7] failures:\n' + ja1Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom1-s2-6j');
  await stopWorker('FAULT1');

  // ================= P5/8 S2-6i + S2-6j atomic MODE 2 =================
  log('===== P5/8: ATOMICITY fault MODE 2 (stmt[1] UPDATE fails → executed INSERT must roll back) =====');
  writeFaultConfig('2', FAULT_CFG_2);
  await startWorker(['--config', FAULT_CFG_2], 'FAULT2');
  await fixture('attendance-management', 'S2-6i-atom2');
  const a2Out = join(TMP, 'suite-S2-6i-atom-mode2.log');
  const a2Code = await runCapture(NODE, ['tests/attendance_management_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '2' }, a2Out);
  const a2Txt = readFileSync(a2Out, 'utf8');
  const a2Cnt = parseCounts(a2Txt);
  results.s2_6i.atomicity_mode2 = { ...a2Cnt, total: a2Cnt.pass + a2Cnt.fail, exit: a2Code };
  log(`[P5] S2-6i ATOMICITY-2 PASS=${a2Cnt.pass} FAIL=${a2Cnt.fail} TOTAL=${a2Cnt.pass + a2Cnt.fail} EXIT=${a2Code}`);
  if (a2Code !== 0) log('[P5] failures:\n' + a2Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom2-s2-6i');

  await fixture('anomaly', 'S2-6j-atom2');
  const ja2Out = join(TMP, 'suite-S2-6j-atom-mode2.log');
  const ja2Code = await runCapture(NODE, ['tests/attendance_anomaly_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '2' }, ja2Out);
  const ja2Txt = readFileSync(ja2Out, 'utf8');
  const ja2Cnt = parseCounts(ja2Txt);
  results.s2_6j.atomicity_mode2 = { ...ja2Cnt, total: ja2Cnt.pass + ja2Cnt.fail, exit: ja2Code };
  log(`[P8] S2-6j ATOMICITY-2 PASS=${ja2Cnt.pass} FAIL=${ja2Cnt.fail} TOTAL=${ja2Cnt.pass + ja2Cnt.fail} EXIT=${ja2Code}`);
  if (ja2Code !== 0) log('[P8] failures:\n' + ja2Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom2-s2-6j');
  await stopWorker('FAULT2');

  // ================= P10 catalog 静态校验（JSON-only）=================
  log('===== P10: permission catalog static validator =====');
  {
    const catOut = join(TMP, 'catalog-validator.log');
    const catCode = await runCapture(NODE, ['scripts/validate_permission_catalog.mjs'], {}, catOut);
    const catTxt = readFileSync(catOut, 'utf8');
    results.catalog.exit = catCode;
    results.catalog.ok = catCode === 0;
    log(`[P10] catalog validator exit=${catCode} (expect 0)`);
    if (catCode !== 0) log('[P10] tail:\n' + catTxt.split('\n').slice(-15).join('\n'));
  }

  // ================= P9 最终完整性 / teardown =================
  log('===== P9: FINAL INTEGRITY / TEARDOWN =====');
  const fin = withDb((db) => {
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    const ic = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    // seed 集合一致性（vs JSON catalog）
    let seedOk = null;
    try {
      const catalog = JSON.parse(readFileSync(join(CWD, 'scripts', 'permission-catalog.json'), 'utf8'));
      const jsonCodes = new Set(catalog.permissions.map((p) => p.code));
      const dbCodes = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code));
      const same = jsonCodes.size === dbCodes.size && [...jsonCodes].every((x) => dbCodes.has(x));
      seedOk = { permissions: db.prepare('SELECT COUNT(*) c FROM permissions').get().c, equalToJson: same };
    } catch (e) { seedOk = { error: String(e.message) }; }
    const cnt = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return {
      foreign_key_check: fk.length,
      integrity_check: ic.join(','),
      roles: cnt('roles'),
      permissions: cnt('permissions'),
      role_permissions: cnt('role_permissions'),
      users: cnt('users'),
      teams: cnt('teams'),
      activities: cnt('activities'),
      activity_signups: cnt('activity_signups'),
      attendance_sessions: cnt('attendance_sessions'),
      attendance_events: cnt('attendance_events'),
      attendance_anomalies: cnt('attendance_anomalies'),
      sessions: cnt('sessions'),
      user_roles: cnt('user_roles'),
      team_members: cnt('team_members'),
      user_identities: cnt('user_identities'),
      security_events: cnt('security_events'),
      d1_migrations: cnt('d1_migrations'),
      seed_set_equality: seedOk,
    };
  });
  results.integrity = fin;
  log('[P9] ' + JSON.stringify(fin));
} catch (e) {
  log('[harness] ERROR: ' + (e?.stack ?? e));
  results.error = String(e?.message ?? e);
} finally {
  await stopWorker('final').catch(() => {});
  for (const f of [FAULT_CFG_1, FAULT_CFG_2]) {
    if (existsSync(f)) { try { rmSync(f); log(`[harness] removed ${f}`); } catch {} }
  }
  results.port = { port_used: PORT, spawned_pids: SPAWNED_PIDS, port_8787_touched: false };
  writeFileSync(SUMMARY, JSON.stringify(results, null, 2));
  log(`[harness] summary -> ${SUMMARY}`);
}

// ================= 总判定 =================
const frozenPass = results.suites.reduce((a, s) => a + (s.pass ?? 0), 0);
const frozenTotal = results.suites.reduce((a, s) => a + (s.total ?? 0), 0);
const frozenAllOk = results.suites.length === 8 && results.suites.every((s) => s.ok);
const tpOk = results.time_policy?.exit === 0 && (results.time_policy?.fail ?? 1) === 0;
const s6iOk = results.s2_6i.main?.exit === 0 && results.s2_6i.atomicity_mode1?.exit === 0 && results.s2_6i.atomicity_mode2?.exit === 0
  && results.s2_6i.main?.total === 80 && results.s2_6i.atomicity_mode1?.total === 15 && results.s2_6i.atomicity_mode2?.total === 10;
const s6jMainOk = results.s2_6j.main?.exit === 0 && (results.s2_6j.main?.fail ?? 1) === 0 && results.s2_6j.main?.total === 87;
const s6jAtomOk = results.s2_6j.atomicity_mode1?.exit === 0 && (results.s2_6j.atomicity_mode1?.fail ?? 1) === 0 && results.s2_6j.atomicity_mode1?.total === 13
  && results.s2_6j.atomicity_mode2?.exit === 0 && (results.s2_6j.atomicity_mode2?.fail ?? 1) === 0 && results.s2_6j.atomicity_mode2?.total === 13;
const integrityOk =
  results.integrity?.foreign_key_check === 0 &&
  results.integrity?.integrity_check === 'ok' &&
  results.integrity?.roles === 6 &&
  results.integrity?.permissions === 83 &&
  results.integrity?.role_permissions === 238 &&
  results.integrity?.d1_migrations === 5 &&
  (results.integrity?.seed_set_equality?.equalToJson === true) &&
  ['users', 'teams', 'activities', 'activity_signups', 'attendance_sessions', 'attendance_events', 'attendance_anomalies', 'sessions', 'user_roles', 'team_members', 'user_identities', 'security_events'].every(
    (k) => results.integrity[k] === 0,
  );

log('');
log('=================== FINAL S2-6k1 REGRESSION SUMMARY ===================');
for (const s of results.suites) log(`${s.id.padEnd(9)} PASS=${s.pass} FAIL=${s.fail} TOTAL=${s.total} EXIT=${s.exit} (expect ${s.expect})`);
log(`FROZEN HTTP TOTAL = ${frozenPass}/${frozenTotal}  (expect 340/340)  allOk=${frozenAllOk}`);
log(`S2-6k1 TIME POLICY = PASS=${results.time_policy?.pass} FAIL=${results.time_policy?.fail} EXIT=${results.time_policy?.exit} ok=${tpOk}`);
log(`S2-6i MAIN        = ${results.s2_6i.main?.pass}/${results.s2_6i.main?.total} exit=${results.s2_6i.main?.exit}`);
log(`S2-6i ATOMICITY-1 = ${results.s2_6i.atomicity_mode1?.pass}/${results.s2_6i.atomicity_mode1?.total} exit=${results.s2_6i.atomicity_mode1?.exit}`);
log(`S2-6i ATOMICITY-2 = ${results.s2_6i.atomicity_mode2?.pass}/${results.s2_6i.atomicity_mode2?.total} exit=${results.s2_6i.atomicity_mode2?.exit}`);
log(`S2-6j MAIN        = ${results.s2_6j.main?.pass}/${results.s2_6j.main?.total} exit=${results.s2_6j.main?.exit} (expect 87)`);
log(`S2-6j ATOMICITY-1 = ${results.s2_6j.atomicity_mode1?.pass}/${results.s2_6j.atomicity_mode1?.total} exit=${results.s2_6j.atomicity_mode1?.exit}`);
log(`S2-6j ATOMICITY-2 = ${results.s2_6j.atomicity_mode2?.pass}/${results.s2_6j.atomicity_mode2?.total} exit=${results.s2_6j.atomicity_mode2?.exit}`);
log(`CATALOG VALIDATOR = exit=${results.catalog?.exit} ok=${results.catalog?.ok}`);
log(`INTEGRITY/TEARDOWN ok=${integrityOk} (roles=${results.integrity?.roles} perms=${results.integrity?.permissions} rp=${results.integrity?.role_permissions} mig=${results.integrity?.d1_migrations} seedEq=${results.integrity?.seed_set_equality?.equalToJson})`);
log(`STATE PATH        = ${STATE}`);
log('===============================================================');

const overall = frozenAllOk && frozenPass === 340 && frozenTotal === 340 && tpOk && s6iOk && s6jMainOk && s6jAtomOk && integrityOk && results.catalog?.ok && !results.error ? 0 : 1;
log(`OVERALL EXIT=${overall}`);
closeSync(logFd);
process.exit(overall);
