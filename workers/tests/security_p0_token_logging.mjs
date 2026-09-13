// =============================================================================
// SECURITY P0-2 — FULL TOKEN CONSOLE LOGGING 回归（source-contract，静态）
//
// 范围（S0-B1）：仅证明两处「完整 legacy session token」console 输出已消除，
// 且 token 获取 / Authorization 头 / 请求 URL 行为未被改变。
// 不做全仓 console 清理（quick-action.ts 的 token fragment 不在本 P0-2 范围）。
//
// 策略：纯源码契约扫描，不构建、不联网、不触远端。
// 运行（workers/ 目录）：node tests/security_p0_token_logging.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_CHECKIN = ROOT + 'miniprogram/services/checkinService.js';
const F_INDEX = ROOT + 'miniprogram/pages/index/index.ts';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const checkin = readFileSync(F_CHECKIN, 'utf8');
const index = readFileSync(F_INDEX, 'utf8');

// 提取所有含 console.* 的行（用于精确判定「console 是否输出了完整 token」）。
function consoleLines(src) {
  return src
    .split('\n')
    .map((l, i) => ({ n: i + 1, line: l }))
    .filter((x) => /console\.(log|debug|info|warn|error)\s*\(/.test(x.line));
}
// 一个 console 行是否把「完整的 token 变量值」输出：
//  - 在 console 调用内出现裸标识符 token（非 !!token / hasToken / token.length 等派生布尔/片段）
function logsFullToken(line) {
  const call = line.replace(/^.*console\.(log|debug|info|warn|error)\s*\(/, 'console(');
  // 裸 token：前后为分隔符（非字母数字/_ / . / !）
  return /(^|[^A-Za-z0-9_$.!])token([^A-Za-z0-9_$]|$)/.test(call);
}

// ---------- checkinService.js ----------
{
  const bad = consoleLines(checkin).filter((x) => logsFullToken(x.line));
  check('checkinService: no console logs a full token', bad.length === 0, bad.map((b) => `L${b.n}`).join(','));
}
check(
  'checkinService: request-token log removed',
  !checkin.includes("console.log('checkinService请求token:'"),
);
check(
  'checkinService: full response-body log removed',
  !checkin.includes('checkinService响应'),
);
check(
  'checkinService: token acquisition preserved',
  checkin.includes("wx.getStorageSync('access_token')"),
);
check(
  'checkinService: Authorization header preserved',
  checkin.includes("'Authorization': token ? `Bearer ${token}` : ''"),
);
check(
  'checkinService: token NOT moved to query string',
  !/[?&]token=/.test(checkin),
);
check(
  'checkinService: request URL unchanged (legacy base intact)',
  checkin.includes("const API_BASE = 'https://api.jhzyfw.com/api'"),
);

// ---------- pages/index/index.ts ----------
{
  const bad = consoleLines(index).filter((x) => logsFullToken(x.line));
  check('index.ts: no console logs a full token', bad.length === 0, bad.map((b) => `L${b.n}`).join(','));
}
check(
  'index.ts: unsafe syncLoginStatus object log removed',
  !index.includes('{ isValidLogin, userInfo, token, isLoggedIn }'),
);
check(
  'index.ts: non-sensitive status summary present',
  index.includes('hasToken: !!token'),
);
check(
  'index.ts: token acquisition preserved',
  index.includes("wx.getStorageSync('access_token')"),
);

// ---------- summary ----------
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== SECURITY P0-2 TOKEN-LOGGING ====`);
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
