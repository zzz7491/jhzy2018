// workers/tests/p_beta_b1_qrverify_v2_wiring.mjs
// Beta-B1 聚焦测试：qrVerify 扫码核销接到 V2（POST /api/v2/mall/admin/orders/verify）。
//
// 覆盖（任务书 §9 A–P）：
//   A. qrVerify 源码不含任何 legacy `.php` 调用（除说明性注释）
//   B. 调用正确 V2 verify endpoint
//   C. 不发送 numeric internal id（order_no / id）
//   D. 不发送客户端 team_id
//   E. 使用现有 API client 鉴权范式（Bearer + X-Team-Id 由 mallApi 注入）
//   F. TEAM header 行为与 V2 mall contract 一致（X-Team-Id 来自 activeTeamPublicId）
//   G. success UI
//   H. 400 / I. 401 / J. 403 / K. 404 / L. 409 / M. 5xx
//   N. double-submit lock
//   O. 无自动 retry
//   P. 无 legacy stats request（verifier_stats.php / admin_stats.php）

import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINI = join(ROOT, 'miniprogram');
const PAGE_TS = join(MINI, 'pages', 'admin', 'qrVerify', 'qrVerify.ts');

// ---- mock wx ----
let storage = {};
let requestLog = [];
let responder = null;

globalThis.setInterval = () => 0; // 避免 onLoad 的定时器挂住事件循环

globalThis.wx = {
  getStorageSync(k) { return storage[k]; },
  setStorageSync(k, v) { storage[k] = v; },
  removeStorageSync(k) { delete storage[k]; },
  request(req) {
    requestLog.push(req);
    if (!responder) { req.fail && req.fail(new Error('no responder set')); return; }
    const res = responder(req);
    if (res && res.__fail) { req.fail && req.fail(res.__err || new Error('network')); return; }
    req.success({ statusCode: res.statusCode, data: res.data });
  },
  scanCode() {}, showToast() {}, showModal() {}, redirectTo() {}, navigateTo() {}, stopPullDownRefresh() {},
};

// ---- capture Page ----
let capturedPage = null;
globalThis.Page = (cfg) => { capturedPage = cfg; };

// ---- harness ----
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function resetRequests() { requestLog = []; }
function lastReq() { return requestLog[requestLog.length - 1]; }
function allUrls() { return requestLog.map((r) => r.url); }
function setStorage(s) { storage = Object.assign({}, s); }
function setResponder(fn) { responder = fn; }

const VERIFY_URL = 'https://api.jhzyfw.com/api/v2/mall/admin/orders/verify';
const ORDER_VIEW = { order_no: '01ABC2DEF3GHI4JKL5MN6OPQ7', exchange_code: 'ABCD1234EFGH', product_public_id: '01ABC2DEF3GHI4JKL5MN6OPQR', product_title: '爱心物资', points_units: 50, status: 1, verified_at: null, created_at: 1700000000, updated_at: 1700000000, user_public_id: '01ABC2DEF3GHI4JKL5MN6OPQR', verified_by_public_id: null };

function successResponder(req) {
  if (req.url.indexOf('/admin/orders/verify') === -1) return { statusCode: 404, data: { success: false, error: { code: 'NOT_FOUND', message: '' } } };
  return { statusCode: 200, data: { success: true, data: { status: 'verified', order: ORDER_VIEW } } };
}
function failResponder(statusCode, code, message) {
  return (req) => ({ statusCode, data: { success: false, error: { code, message } } });
}
function networkFailResponder(req) { return { __fail: true, __err: new Error('network') }; }

// ---- build + import page ----
const out = await build({ entryPoints: [PAGE_TS], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const tmp = join(tmpdir(), `beta_b1_qrverify_${Date.now()}.mjs`);
await writeFile(tmp, out.outputFiles[0].text);
await import('file://' + tmp.replace(/\\/g, '/'));
await rm(tmp);

function freshPage() {
  const page = Object.create(capturedPage);
  page.data = Object.assign({}, capturedPage.data);
  page.setData = (patch) => { Object.assign(page.data, patch); };
  return page;
}

// =========================================================================
console.log('Beta-B1 — qrVerify V2 wiring');
console.log('----------------------------------------');

// A. 静态检查：源码无 production .php 调用（仅允许注释中的说明）
const src = readFileSync(PAGE_TS, 'utf8');
const phpLines = src.split('\n').filter((l) => l.includes('.php') && !l.trim().startsWith('//'));
assert(phpLines.length === 0, 'A: qrVerify 源码无 legacy .php 调用', phpLines.join(' | '));

// 前置：登录态 + 团队上下文
setStorage({ access_token: 'TOKEN123', activeTeamPublicId: 'TEAM456', adminInfo: { real_name: '王核销', role: 'verifier' } });

// onLoad 不应触发任何 legacy stats 请求
const page0 = freshPage();
page0.onLoad();
assert(allUrls().filter((u) => u.includes('.php')).length === 0, 'P(onLoad): 无 legacy stats request');

// B/C/D/E/F — 基础请求契约
setResponder(successResponder);
resetRequests();
const page1 = freshPage();
await page1.doVerify('ABCD1234EFGH');
const req1 = lastReq();
assert(req1.url === VERIFY_URL, 'B: 命中 V2 verify endpoint', req1 && req1.url);
assert(req1.method === 'POST', 'B: POST 方法');
assert(JSON.stringify(req1.data) === JSON.stringify({ exchange_code: 'ABCD1234EFGH' }), 'C/D: body 仅含 exchange_code（无 numeric id / 无 team_id / 无 user_id / 无 order_no）', req1 && JSON.stringify(req1.data));
assert(typeof req1.data.exchange_code === 'string' && !/^\d+$/.test(String(req1.data.exchange_code)), 'C: 不发送纯数字 internal id');
assert(req1.header && req1.header['Authorization'] === 'Bearer TOKEN123', 'E: 使用现有 Bearer 鉴权范式');
assert(req1.header && req1.header['X-Team-Id'] === 'TEAM456', 'E/F: X-Team-Id 由 mallApi 从 activeTeamPublicId 注入');
assert(!('team_id' in (req1.data || {})), 'D: 不客户端提交 team_id');
assert(req1.url.indexOf('team_id') === -1, 'D: URL 不含 team_id 覆盖参数');
assert(allUrls().filter((u) => u.includes('.php')).length === 0, 'P: doVerify 无 legacy stats request');

// G. success UI
assert(page1.data.showResultModal === true, 'G: 显示结果弹窗');
assert(page1.data.verifySuccess === true, 'G: 核销成功标记');
assert(/核销成功/.test(page1.data.verifyMessage) && /爱心物资/.test(page1.data.verifyMessage) && /50/.test(page1.data.verifyMessage), 'G: 结果含物品与积分', page1.data.verifyMessage);

// H–M 错误语义映射（与 mall.ts 后端合约一致）
async function errorCase(name, status, code, expectMsgFragment, expectSuccess) {
  setResponder(failResponder(status, code, '核销失败，请稍后重试'));
  resetRequests();
  const p = freshPage();
  await p.doVerify('ABCD1234EFGH');
  assert(p.data.showResultModal === true, name + ': 显示结果弹窗');
  assert(p.data.verifySuccess === expectSuccess, name + ': verifySuccess=' + expectSuccess);
  assert((p.data.verifyMessage || '').indexOf(expectMsgFragment) !== -1, name + ': 提示文案匹配 [' + expectMsgFragment + ']', p.data.verifyMessage);
  assert(requestLog.length === 1, 'O: ' + name + ' 无自动 retry');
}
await errorCase('H(400)', 400, 'INVALID_EXCHANGE_CODE', '兑换码格式无效', false);
await errorCase('I(401)', 401, 'UNAUTHENTICATED', '登录已过期', false);
await errorCase('J(403)', 403, 'FORBIDDEN', '无核销权限或未选择团队', false);
await errorCase('K(404)', 404, 'NOT_FOUND', '兑换码不存在或不属于当前团队', false);
await errorCase('L(409)', 409, 'MALL_ORDER_NOT_VERIFIABLE', '该订单当前不可核销', false);
await errorCase('M(500)', 500, 'INTERNAL', '核销失败', false);

// M 网络层失败（wx.request fail → status 0）
setResponder(networkFailResponder);
resetRequests();
const pNet = freshPage();
await pNet.doVerify('ABCD1234EFGH');
assert(pNet.data.verifySuccess === false, 'M(network): 失败标记');
assert(/网络错误/.test(pNet.data.verifyMessage), 'M(network): 网络错误文案', pNet.data.verifyMessage);
assert(requestLog.length === 1, 'O: 网络失败无自动 retry');

// N. double-submit lock
setResponder(successResponder);
resetRequests();
const pN = freshPage();
const p1 = pN.doVerify('CODE-FIRST');
pN.doVerify('CODE-SECOND'); // 进行中，应被锁丢弃
await p1;
await new Promise((r) => setTimeout(r, 20));
assert(requestLog.length === 1, 'N: double-submit 仅一次请求', 'requests=' + requestLog.length);
assert(requestLog[0].data.exchange_code === 'CODE-FIRST', 'N: 仅首个码被提交', requestLog[0] && requestLog[0].data.exchange_code);

// ---- summary ----
console.log('----------------------------------------');
console.log(`BETA_B1_SUMMARY pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
