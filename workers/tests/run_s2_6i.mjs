#!/usr/bin/env node
/**
 * S2-6i 测试编排 harness（§15/§17/§18/§21）。
 *
 * 职责：
 *  1) 以隔离 D1 state（.tmp/s2-6i-state）原生应用 4 条迁移（0001–0004）；
 *  2) 启动【普通】worker（port 8799，非 8787 Signivra 不动）→ fixture → 主集成测试；
 *  3) 关停普通 worker → 启动【故障注入】worker（临时配置注入 JHZY_FAULT_INJECT=1）→ fixture 重置 → 原子性测试；
 *  4) 关停 worker、清理临时配置；仅 kill 本 harness 启动的 8799 进程（不动 8787）。
 *
 * 退出码：主测试或原子性测试任一失败 → 非 0；全 PASS → 0。
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, openSync, writeSync, closeSync, readFileSync as rf } from 'node:fs';
import { join, resolve } from 'node:path';

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const WRANGLER = resolve('node_modules/wrangler/bin/wrangler.js');
const CWD = resolve('.');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = resolve('.tmp/s2-6i-state');
const D1_DIR = join(STATE, 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = resolve('.tmp/s2-6i-sessions.json');
const FAULT_CFG = resolve('wrangler.s2-6i-fault.jsonc');
const LOG = resolve('.tmp/run_s2_6i.log');
const PROBE_OK = resolve('.tmp/s2-6i-probe.json');

const logFd = openSync(LOG, 'w');
function log(s) {
  try { writeSync(logFd, s + '\n'); } catch {}
}
function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (code) => resolve(code ?? 1));
  });
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
async function killPort(port) {
  // 仅 kill 监听 8799 的 workerd / 其 node 父进程；不动 8787(Signivra)。
  const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
  await run('powershell.exe', ['-NoProfile', '-Command', ps]);
  await new Promise((r) => setTimeout(r, 1500));
}

// 生成临时故障配置（向 vars 注入 JHZY_FAULT_INJECT=1，不改源 wrangler.jsonc）
function writeFaultConfig() {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  const out = src.replace(
    /"vars":\s*{\s*\n\s*"ENVIRONMENT":\s*"local",\s*\n\s*"IDENTITY_HMAC_KEY_PREVIOUS":\s*"[^"]*"\s*\n\s*}/,
    '"vars": {\n    "ENVIRONMENT": "local",\n    "IDENTITY_HMAC_KEY_PREVIOUS": "test-previous-hmac-key-2026",\n    "JHZY_FAULT_INJECT": "1"\n  }',
  );
  if (out === src) throw new Error('FAULT_CFG_REPLACE_FAILED');
  writeFileSync(FAULT_CFG, out);
  log('[harness] fault config written -> ' + FAULT_CFG);
}

async function startWorker(extraArgs) {
  const args = [WRANGLER, 'dev', '--port', String(PORT), '--local', '--persist-to', STATE, ...extraArgs];
  const p = spawn(NODE, args, { cwd: CWD, env: { ...process.env }, stdio: ['ignore', logFd, logFd] });
  log(`[harness] worker launched pid=${p.pid} args=${args.join(' ')}`);
  return p;
}

let mainCode = 1;
let atomCode = 1;
let worker = null;

try {
  log('[harness] phase 0: apply migrations to isolated state');
  await run(NODE, [WRANGLER, 'd1', 'migrations', 'apply', 'jhzy-v2-local', '--local', '--persist-to', STATE], { JHZY_D1_DIR: D1_DIR });

  // ---------- PHASE 1: 普通 worker + 主集成测试 ----------
  log('[harness] phase 1: start NORMAL worker');
  worker = await startWorker([]);
  let ok = await waitHealth(150000);
  if (!ok) { log('[harness] NORMAL worker not ready'); throw new Error('NORMAL_WORKER_NOT_READY'); }
  log('[harness] NORMAL worker ready');

  log('[harness] phase 1: fixture attendance-management');
  await run(NODE, ['tests/fixture.mjs', 'attendance-management'], { JHZY_D1_DIR: D1_DIR, JHZY_MANIFEST: MANIFEST });
  log('[harness] phase 1: run main integration test');
  mainCode = await run(NODE, ['tests/attendance_management_integration.mjs'], {
    BASE_URL: BASE, JHZY_D1_DIR: D1_DIR, JHZY_MANIFEST: MANIFEST,
  });
  log(`[harness] phase 1 main test exit=${mainCode}`);

  log('[harness] phase 1: stop NORMAL worker');
  if (worker) try { worker.kill('SIGKILL'); } catch {}
  await killPort(PORT);
  worker = null;

  // ---------- PHASE 2: 故障注入 worker + 原子性测试 ----------
  log('[harness] phase 2: write fault config');
  writeFaultConfig();
  log('[harness] phase 2: start FAULT worker');
  worker = await startWorker(['--config', FAULT_CFG]);
  ok = await waitHealth(150000);
  if (!ok) { log('[harness] FAULT worker not ready'); throw new Error('FAULT_WORKER_NOT_READY'); }
  log('[harness] FAULT worker ready (JHZY_FAULT_INJECT=1)');

  log('[harness] phase 2: fixture reset');
  await run(NODE, ['tests/fixture.mjs', 'attendance-management'], { JHZY_D1_DIR: D1_DIR, JHZY_MANIFEST: MANIFEST });
  log('[harness] phase 2: run atomicity test');
  atomCode = await run(NODE, ['tests/attendance_management_atomicity.mjs'], {
    BASE_URL: BASE, JHZY_D1_DIR: D1_DIR, JHZY_MANIFEST: MANIFEST,
  });
  log(`[harness] phase 2 atomicity test exit=${atomCode}`);
} catch (e) {
  log('[harness] ERROR: ' + (e?.stack ?? e));
} finally {
  if (worker) try { worker.kill('SIGKILL'); } catch {}
  await killPort(PORT).catch(() => {});
  if (existsSync(FAULT_CFG)) { try { rmSync(FAULT_CFG); } catch {} log('[harness] fault config removed'); }
  closeSync(logFd);
}

const overall = mainCode === 0 && atomCode === 0 ? 0 : 1;
log(`[harness] OVERALL main=${mainCode} atomicity=${atomCode} -> exit ${overall}`);
process.exit(overall);
