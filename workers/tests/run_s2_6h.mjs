#!/usr/bin/env node
/**
 * S2-6h-R2 回归 harness（§18 冻结回归 re-run）。
 *
 * 复用标准本地 .wrangler state（与 validate_* / migrate:local 同一路径，已含 4 条迁移 + seed 83/238）。
 * 启动 worker（port 8798，不动 8787 Signivra） → fixture attendance → 运行 attendance_integration.mjs → 关停。
 * 退出码：测试非零 → 非 0；全 PASS → 0。
 */

import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const WRANGLER = resolve('node_modules/wrangler/bin/wrangler.js');
const CWD = resolve('.');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = resolve('.tmp/run_s2_6h.log');

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
  const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
  await run('powershell.exe', ['-NoProfile', '-Command', ps]);
  await new Promise((r) => setTimeout(r, 1500));
}

let code = 1;
let worker = null;
try {
  // 标准 .wrangler state 已含迁移+seed；此处不再重复 apply（与 validate_* 同源）。
  log('[s2-6h] start worker on ' + PORT);
  worker = spawn(NODE, [WRANGLER, 'dev', '--port', String(PORT), '--local'], { cwd: CWD, env: { ...process.env }, stdio: ['ignore', logFd, logFd] });
  const ok = await waitHealth(150000);
  if (!ok) { log('[s2-6h] worker not ready'); throw new Error('WORKER_NOT_READY'); }
  log('[s2-6h] worker ready');

  log('[s2-6h] fixture attendance');
  const fx = await run(NODE, ['tests/fixture.mjs', 'attendance'], {});
  log(`[s2-6h] fixture exit=${fx}`);

  log('[s2-6h] run attendance_integration');
  code = await run(NODE, ['tests/attendance_integration.mjs'], { BASE_URL: BASE });
  log(`[s2-6h] test exit=${code}`);
} catch (e) {
  log('[s2-6h] ERROR: ' + (e?.stack ?? e));
} finally {
  if (worker) try { worker.kill('SIGKILL'); } catch {}
  await killPort(PORT).catch(() => {});
  closeSync(logFd);
}
process.exit(code === 0 ? 0 : 1);
