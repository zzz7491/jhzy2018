import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';

const LOG = 'W:/wrangler_8796_s2_6h_r2.log';
const logFd = openSync(LOG, 'w');
function logLine(s) {
  try { writeSync(logFd, s + '\n'); } catch {}
}


const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const WRANGLER = 'W:/node_modules/wrangler/bin/wrangler.js';
const CWD = 'W:/';
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;

function spawnDetached(cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: CWD,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });
  return child;
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

const server = spawnDetached(NODE, [WRANGLER, 'dev', '--port', String(PORT), '--local']);
console.log(`[harness] wrangler dev launched pid=${server.pid} on ${BASE}`);

let healthy = false;
try {
  healthy = await waitHealth(150000);
} catch (e) {
  console.error('[harness] health poll error', e);
}

if (!healthy) {
  console.error('[harness] DEV NOT READY — aborting');
  try {
    const log = readFileSync(LOG, 'utf8');
    console.error('[harness] ---- wrangler log (last 60 lines) ----\n' + log.split('\n').slice(-60).join('\n'));
  } catch {}
  try { server.kill('SIGTERM'); } catch {}
  closeSync(logFd);
  process.exit(1);
}
console.log('[harness] DEV READY');

function runFixture(mode) {
  return new Promise((resolve) => {
    const p = spawn(NODE, ['W:/tests/fixture.mjs', mode], {
      cwd: CWD,
      env: { ...process.env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

// 先清零测试数据，再加载 attendance fixture（fixture 非幂等，必须先 teardown）。
console.log('[harness] teardown (clean slate) ...');
await runFixture('teardown');
console.log('[harness] loading fixture:attendance ...');
const fxCode = await runFixture('attendance');
console.log(`[harness] fixture exit=${fxCode}`);

const test = spawn(NODE, ['W:/tests/attendance_integration.mjs'], {
  cwd: CWD,
  env: { ...process.env, BASE_URL: BASE },
  stdio: 'inherit',
});

let testCode = 1;
await new Promise((resolve) => {
  test.on('exit', (code) => {
    testCode = code ?? 1;
    resolve();
  });
});

console.log(`[harness] TEST exit=${testCode}`);

// teardown 清零测试数据（验证零残留）。
const tdCode = await runFixture('teardown');
console.log(`[harness] teardown exit=${tdCode}`);

try { server.kill('SIGTERM'); } catch {}
// give workerd a moment to release the port
await new Promise((res) => setTimeout(res, 500));
process.exit(testCode);
