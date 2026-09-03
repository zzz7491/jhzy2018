#!/usr/bin/env node
/**
 * S2-6i FINAL REGRESSION 编排器（本轮 BLOCKER B 收口，§6/§7/§8/§12/§13）。
 *
 * 与旧 tests/run_s2_6i.mjs 的区别：旧编排器只跑 S2-6i 自身两套；本编排器实跑
 * 【完整 frozen regression 8 套（340）+ S2-6i 主集成 + S2-6i 原子性双故障模式】，
 * 全部落在同一个【全新隔离 state】上，杜绝"引用历史报告"充当证据。
 *
 * 阶段：
 *   P0  删除并重建 .tmp/s2-6i-final-state，用 Wrangler 原生 `d1 migrations apply` 依次应用 0001→0004；
 *       随后只读校验 d1_migrations = 4 条（不手工写 d1_migrations、不复制 sqlite、不用 node:sqlite 建表）。
 *   P1  启动 NORMAL worker（PORT，非 8787）。
 *   P2  逐套跑 frozen regression：teardown → fixture <mode> → suite → teardown（套件间 fixture 互斥，必须串行）。
 *   P3  S2-6i 主集成（A–E / M / T 组，含时间戳单位硬门禁）。
 *   P4  故障 worker MODE 1（stmt[0] INSERT 失败）→ 原子性 L 组。
 *   P5  故障 worker MODE 2（stmt[1] UPDATE 失败）→ 原子性 P 组（证明已执行 INSERT 被真实回滚）。
 *   P6  最终完整性：foreign_key_check / integrity_check / 目录基线 / 业务表零残留 / migrations=4。
 *
 * 端口纪律（§13）：只使用 PORT（默认 8796），只 kill 监听该端口的 PID；8787（Signivra）绝不触碰、绝不 broad kill。
 * 产物：.tmp/run_s2_6i_final.log（全量日志）、.tmp/s2-6i-final-summary.json（机器可读结论）、
 *       .tmp/suite-<id>.log（每套件独立输出，便于逐套件核对 PASS/FAIL/TOTAL/EXIT）。
 */

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const WRANGLER = resolve('node_modules/wrangler/bin/wrangler.js');
const CWD = resolve('.');
const PORT = Number(process.env.JHZY_TEST_PORT ?? 8796); // 绝不使用 8787（Signivra）
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = resolve('.tmp/s2-6i-final-state');
const D1_DIR = join(STATE, 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = resolve('.tmp/s2-6i-sessions.json');
const TMP = resolve('.tmp');
const LOG = join(TMP, 'run_s2_6i_final.log');
const SUMMARY = join(TMP, 's2-6i-final-summary.json');
const FAULT_CFG_1 = resolve('wrangler.s2-6i-fault1.jsonc');
const FAULT_CFG_2 = resolve('wrangler.s2-6i-fault2.jsonc');

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
const logFd = openSync(LOG, 'w');
function log(s) {
  const line = typeof s === 'string' ? s : JSON.stringify(s);
  try { writeSync(logFd, line + '\n'); } catch {}
  process.stdout.write(line + '\n');
}

/** 本编排器显式启动的进程 PID（§13：只结束这些 PID）。 */
const SPAWNED_PIDS = [];

function runCapture(cmd, args, env, outFile) {
  return new Promise((res) => {
    const fd = openSync(outFile, 'w');
    const p = spawn(cmd, args, { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    p.on('exit', (code) => {
      try { closeSync(fd); } catch {}
      res(code ?? 1);
    });
  });
}

/** 解析套件汇总行（项目内共存三种格式）。 */
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

/** 只结束监听本轮 PORT 的进程（§13：不 broad kill、不动 8787）。 */
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

/** 生成临时故障配置（把 JHZY_FAULT_INJECT 注入 vars —— 实测只有配置文件 vars 能进入 c.env）。 */
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
const results = { suites: [], s2_6i: {}, static: {}, integrity: {}, teardown: {}, port: {} };

// 冻结 frozen regression 套件表（编号 / fixture 模式 / 测试文件 / 冻结基线断言数）
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
  log('===== P0: rebuild isolated final state (native wrangler migrations) =====');
  await killPort(); // 起点先确保端口干净（只针对 PORT）
  if (existsSync(STATE)) { rmSync(STATE, { recursive: true, force: true }); log(`[P0] removed old ${STATE}`); }
  const migLog = join(TMP, 'p0-migrations.log');
  const migCode = await runCapture(NODE, [WRANGLER, 'd1', 'migrations', 'apply', 'jhzy-v2-local', '--local', '--persist-to', STATE], {}, migLog);
  const migOut = readFileSync(migLog, 'utf8');
  log(`[P0] wrangler d1 migrations apply exit=${migCode}`);
  log(migOut.split('\n').filter((l) => /000\d|migration|Migration|✅|success/i.test(l)).join('\n'));
  if (migCode !== 0) throw new Error('MIGRATIONS_APPLY_FAILED');

  const mig = withDb((db) => db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name));
  log(`[P0] d1_migrations (${mig.length}): ${mig.join(' | ')}`);
  results.static.migrations_applied = mig;
  if (mig.length !== 4) throw new Error(`EXPECTED_4_MIGRATIONS_GOT_${mig.length}`);

  // 关键 schema 事实：0004 的 partial unique index 必须存在于本 state（证明确实跑到最终 0004）
  const idx = withDb((db) =>
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('uq_active_attendance','idx_as_signup') ORDER BY name`).all().map((r) => r.name),
  );
  log(`[P0] 0004 indexes present: ${idx.join(',') || '(none)'}`);
  results.static.indexes_0004 = idx;

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
    if (!row.ok) {
      log(`[P2] ${s.id} tail:\n` + txt.split('\n').slice(-25).join('\n'));
    }
    await fixture('teardown', `post-${s.id}`);
  }

  // ================= P3 S2-6i 主集成 =================
  log('===== P3: S2-6i MAIN integration (A–E / M / T) =====');
  await fixture('attendance-management', 'S2-6i-main');
  const mainOut = join(TMP, 'suite-S2-6i-main.log');
  const mainCode = await runCapture(NODE, ['tests/attendance_management_integration.mjs'], env, mainOut);
  const mainTxt = readFileSync(mainOut, 'utf8');
  const mainCnt = parseCounts(mainTxt);
  results.s2_6i.main = { ...mainCnt, total: mainCnt.pass + mainCnt.fail, exit: mainCode };
  log(`[P3] S2-6i MAIN PASS=${mainCnt.pass} FAIL=${mainCnt.fail} TOTAL=${mainCnt.pass + mainCnt.fail} EXIT=${mainCode}`);
  if (mainCode !== 0) log('[P3] failures:\n' + mainTxt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-S2-6i-main');
  await stopWorker('NORMAL');

  // ================= P4 原子性 MODE 1 =================
  log('===== P4: ATOMICITY fault MODE 1 (stmt[0] INSERT fails) =====');
  writeFaultConfig('1', FAULT_CFG_1);
  await startWorker(['--config', FAULT_CFG_1], 'FAULT1');
  await fixture('attendance-management', 'S2-6i-atom1');
  const a1Out = join(TMP, 'suite-S2-6i-atom-mode1.log');
  const a1Code = await runCapture(NODE, ['tests/attendance_management_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '1' }, a1Out);
  const a1Txt = readFileSync(a1Out, 'utf8');
  const a1Cnt = parseCounts(a1Txt);
  results.s2_6i.atomicity_mode1 = { ...a1Cnt, total: a1Cnt.pass + a1Cnt.fail, exit: a1Code };
  log(`[P4] ATOMICITY-1 PASS=${a1Cnt.pass} FAIL=${a1Cnt.fail} TOTAL=${a1Cnt.pass + a1Cnt.fail} EXIT=${a1Code}`);
  if (a1Code !== 0) log('[P4] failures:\n' + a1Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom1');
  await stopWorker('FAULT1');

  // ================= P5 原子性 MODE 2 =================
  log('===== P5: ATOMICITY fault MODE 2 (stmt[1] UPDATE fails → executed INSERT must roll back) =====');
  writeFaultConfig('2', FAULT_CFG_2);
  await startWorker(['--config', FAULT_CFG_2], 'FAULT2');
  await fixture('attendance-management', 'S2-6i-atom2');
  const a2Out = join(TMP, 'suite-S2-6i-atom-mode2.log');
  const a2Code = await runCapture(NODE, ['tests/attendance_management_atomicity.mjs'], { ...env, JHZY_FAULT_MODE: '2' }, a2Out);
  const a2Txt = readFileSync(a2Out, 'utf8');
  const a2Cnt = parseCounts(a2Txt);
  results.s2_6i.atomicity_mode2 = { ...a2Cnt, total: a2Cnt.pass + a2Cnt.fail, exit: a2Code };
  log(`[P5] ATOMICITY-2 PASS=${a2Cnt.pass} FAIL=${a2Cnt.fail} TOTAL=${a2Cnt.pass + a2Cnt.fail} EXIT=${a2Code}`);
  if (a2Code !== 0) log('[P5] failures:\n' + a2Txt.split('\n').filter((l) => l.includes('FAIL')).join('\n'));
  await fixture('teardown', 'post-atom2');
  await stopWorker('FAULT2');

  // ================= P6 最终完整性 / teardown =================
  log('===== P6: FINAL INTEGRITY / TEARDOWN =====');
  const fin = withDb((db) => {
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    const ic = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
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
      sessions: cnt('sessions'),
      user_roles: cnt('user_roles'),
      d1_migrations: cnt('d1_migrations'),
    };
  });
  results.integrity = fin;
  log('[P6] ' + JSON.stringify(fin));
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
const s6iOk = results.s2_6i.main?.exit === 0 && results.s2_6i.atomicity_mode1?.exit === 0 && results.s2_6i.atomicity_mode2?.exit === 0;
const integrityOk =
  results.integrity?.foreign_key_check === 0 &&
  results.integrity?.integrity_check === 'ok' &&
  results.integrity?.roles === 6 &&
  results.integrity?.permissions === 83 &&
  results.integrity?.role_permissions === 238 &&
  results.integrity?.d1_migrations === 4 &&
  ['users', 'teams', 'activities', 'activity_signups', 'attendance_sessions', 'attendance_events', 'sessions', 'user_roles'].every(
    (k) => results.integrity[k] === 0,
  );

log('');
log('=================== FINAL REGRESSION SUMMARY ===================');
for (const s of results.suites) log(`${s.id.padEnd(9)} PASS=${s.pass} FAIL=${s.fail} TOTAL=${s.total} EXIT=${s.exit} (expect ${s.expect})`);
log(`FROZEN HTTP TOTAL = ${frozenPass}/${frozenTotal}  (expect 340/340)  allOk=${frozenAllOk}`);
log(`S2-6i MAIN        = ${results.s2_6i.main?.pass}/${results.s2_6i.main?.total} exit=${results.s2_6i.main?.exit}`);
log(`S2-6i ATOMICITY-1 = ${results.s2_6i.atomicity_mode1?.pass}/${results.s2_6i.atomicity_mode1?.total} exit=${results.s2_6i.atomicity_mode1?.exit}`);
log(`S2-6i ATOMICITY-2 = ${results.s2_6i.atomicity_mode2?.pass}/${results.s2_6i.atomicity_mode2?.total} exit=${results.s2_6i.atomicity_mode2?.exit}`);
log(`INTEGRITY/TEARDOWN ok=${integrityOk}`);
log(`STATE PATH        = ${STATE}`);
log('===============================================================');

const overall = frozenAllOk && frozenPass === 340 && frozenTotal === 340 && s6iOk && integrityOk && !results.error ? 0 : 1;
log(`OVERALL EXIT=${overall}`);
closeSync(logFd);
process.exit(overall);
