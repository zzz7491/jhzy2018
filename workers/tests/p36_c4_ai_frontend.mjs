// workers/tests/p36_c4_ai_frontend.mjs
// P36-C4 前端单元测试（§21）。
//
// 覆盖范围（可执行客户端逻辑层）：
//   ENTRY / TEAM   -> hasActiveTeam / AI_PROVIDER_MODEL_VISIBLE(privacy)
//   LIST           -> GET url + query + header(Bearer/X-Team-Id) + 成功信封解析
//   CREATE         -> POST body 严格 {message}
//   DETAIL         -> GET url + 成功信封解析
//   SEND           -> POST url + body 严格 {message}
//   ERROR          -> friendlyMessage 全状态码映射(400/401/403-TEAM/403-other/404/409/429/503/network)
//   SECURITY       -> body/header/url 不泄露 provider/model/context/tools；无 token 不挂 Authorization；
//                     输入校验(empty/too_long/trim)；无自动重试(单次失败仅 1 次 request)
//
// 说明：本测试只验证 aiApi.ts 的纯逻辑（请求构造 / 错误映射 / 隐私边界）。
// 页面级导航 / tabBar / 入口卡 等结构校验在 §22 回归中完成（见 p36_c4_structure_check.mjs 与 git diff）。

import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // workers/tests -> project root
const ENTRY = join(ROOT, 'miniprogram', 'utils', 'aiApi.ts');

// ---- mock wx ----
let storage = {};
let requestLog = [];
let responder = null; // (req) => { statusCode, data } | { __fail:true }

globalThis.wx = {
  getStorageSync(k) { return storage[k]; },
  request(req) {
    requestLog.push(req);
    if (!responder) { req.fail && req.fail(new Error('no responder set')); return; }
    const res = responder(req);
    if (res && res.__fail) { req.fail && req.fail(res.__err || new Error('network')); return; }
    req.success({ statusCode: res.statusCode, data: res.data });
  },
  showToast() {}, navigateTo() {}, showModal() {}, stopPullDownRefresh() {},
};

// ---- test harness ----
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function resetMocks() { storage = {}; requestLog = []; responder = null; }
function setStorage(s) { storage = Object.assign({}, s); }
function setResponder(fn) { responder = fn; }
function lastReq() { return requestLog[requestLog.length - 1]; }
function allUrls() { return requestLog.map((r) => r.url); }

// ---- load module ----
const out = await build({
  entryPoints: [ENTRY],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const tmp = join(tmpdir(), `p36_c4_aiapi_${Date.now()}.mjs`);
await writeFile(tmp, out.outputFiles[0].text);
const mod = await import(pathToFileURL(tmp).href);
const { aiApi, hasActiveTeam, validateMessageInput, friendlyMessage, AI_MAX_MESSAGE_LENGTH, AI_PROVIDER_MODEL_VISIBLE } = mod;

function banner(t) { console.log('\n=== ' + t + ' ==='); }

async function main() {
  banner('ENTRY / TEAM');
  resetMocks();
  setStorage({ activeTeamPublicId: 'team_pub_1' });
  assert(hasActiveTeam() === true, 'TEAM hasActiveTeam=true when activeTeamPublicId set');
  setStorage({});
  assert(hasActiveTeam() === false, 'TEAM hasActiveTeam=false when no activeTeamPublicId');
  assert(AI_PROVIDER_MODEL_VISIBLE === false, 'PRIVACY AI_PROVIDER_MODEL_VISIBLE === false (provider/model 不暴露)');

  banner('LIST');
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  setResponder(() => ({ statusCode: 200, data: { success: true, data: {
    items: [{ public_id: 'c1', title: 't1', created_at: 1700000000 }],
    pagination: { page: 1, page_size: 20, total: 1, total_pages: 1 },
  } } }));
  requestLog = [];
  const listRes = await aiApi.listConversations(1, 20);
  const lr = lastReq();
  assert(/https:\/\/api\.jhzyfw\.com\/api\/v2\/ai\/conversations\?page=1&page_size=20$/.test(lr.url), 'LIST GET url + page/page_size query', lr.url);
  assert(lr.method === 'GET' || lr.method === 'GET', 'LIST method GET', lr.method);
  assert(lr.header['Authorization'] === 'Bearer tok123', 'LIST Authorization Bearer injected');
  assert(lr.header['X-Team-Id'] === 'team_pub_1', 'LIST X-Team-Id injected');
  assert(Array.isArray(listRes.items) && listRes.items[0].public_id === 'c1', 'LIST resolves data.items');
  assert(listRes.pagination.total_pages === 1, 'LIST resolves data.pagination');

  banner('CREATE');
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  let createReq = null;
  setResponder((req) => { createReq = req; return { statusCode: 200, data: { success: true, data: {
    public_id: 'c_new', title: null, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello', source_labels: ['活动'] }],
    created_at: 1700000000, updated_at: 1700000001,
  } } }; });
  const createRes = await aiApi.createConversation('你好');
  assert(createReq.method === 'POST' || createReq.method === 'POST', 'CREATE method POST', createReq.method);
  assert(JSON.stringify(createReq.data) === JSON.stringify({ message: '你好' }), 'CREATE body strictly {message}', JSON.stringify(createReq.data));
  assert(Object.keys(createReq.data).length === 1 && createReq.data.message === '你好', 'CREATE no extra keys (history/provider/model)');
  assert(createRes.public_id === 'c_new', 'CREATE resolves detail.public_id');
  assert(Array.isArray(createRes.messages) && createRes.messages.length === 2, 'CREATE resolves detail.messages');

  banner('DETAIL');
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  let detailReq = null;
  setResponder((req) => { detailReq = req; return { statusCode: 200, data: { success: true, data: {
    public_id: 'c1', title: 't1', messages: [{ role: 'assistant', content: 'a', source_labels: ['积分'] }],
    created_at: 1700000000, updated_at: 1700000001,
  } } }; });
  const detailRes = await aiApi.getConversation('c1');
  assert(detailReq.url === 'https://api.jhzyfw.com/api/v2/ai/conversations/c1', 'DETAIL GET url with publicId', detailReq.url);
  assert(detailRes.public_id === 'c1' && detailRes.messages[0].source_labels[0] === '积分', 'DETAIL resolves messages + source_labels');

  banner('SEND');
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  let sendReq = null;
  setResponder((req) => { sendReq = req; return { statusCode: 200, data: { success: true, data: {
    public_id: 'c1', title: 't1', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    created_at: 1700000000, updated_at: 1700000002,
  } } }; });
  const sendRes = await aiApi.sendMessage('c1', '下一轮问题');
  assert(sendReq.url === 'https://api.jhzyfw.com/api/v2/ai/conversations/c1/messages', 'SEND POST url /:id/messages', sendReq.url);
  assert(JSON.stringify(sendReq.data) === JSON.stringify({ message: '下一轮问题' }), 'SEND body strictly {message}', JSON.stringify(sendReq.data));
  assert(Object.keys(sendReq.data).length === 1, 'SEND no extra keys (history)');
  assert(sendRes.messages.length === 2, 'SEND resolves full server messages');

  banner('ERROR (friendlyMessage)');
  const mkErr = (status, code) => ({ status, code: code || '', message: '', details: undefined, isNetwork: false });
  assert(friendlyMessage(mkErr(400)) === '输入内容无效，请检查后重试', 'ERR 400');
  assert(friendlyMessage(mkErr(401)) === '登录已过期，请重新登录', 'ERR 401');
  assert(friendlyMessage(mkErr(403, 'TEAM_SCOPE_REQUIRED')) === '请先在「我的」中选择一个服务团队', 'ERR 403 TEAM_SCOPE_REQUIRED');
  assert(friendlyMessage(mkErr(403, 'NO_PERMISSION')) === '当前账号暂无嘉禾 AI 使用权限', 'ERR 403 other');
  assert(friendlyMessage(mkErr(404)) === '会话不存在或无可访问权限', 'ERR 404');
  assert(friendlyMessage(mkErr(409)) === '会话已更新，请重新加载后再试', 'ERR 409');
  assert(friendlyMessage(mkErr(429)) === '请求过于频繁，请稍后再试', 'ERR 429');
  assert(friendlyMessage(mkErr(503)) === '嘉禾 AI 暂时不可用，请稍后再试', 'ERR 503');
  assert(friendlyMessage({ status: 0, code: 'NETWORK', message: '', isNetwork: true }) === '网络异常，请重试', 'ERR network');

  banner('SECURITY / PRIVACY');
  // body / header / url 不泄露 provider/model/context/tools
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  setResponder(() => ({ statusCode: 200, data: { success: true, data: {
    public_id: 'c_sec', title: null, messages: [], created_at: 1700000000, updated_at: 1700000001 } } }));
  await aiApi.createConversation('secret-question');
  const cr = lastReq();
  const bodyStr = JSON.stringify(cr.data).toLowerCase();
  const headerStr = JSON.stringify(cr.header).toLowerCase();
  const urlStr = cr.url.toLowerCase();
  assert(!bodyStr.includes('provider') && !bodyStr.includes('model') && !bodyStr.includes('context') && !bodyStr.includes('tools'), 'SECURITY body has no provider/model/context/tools', bodyStr);
  assert(!headerStr.includes('provider') && !headerStr.includes('model') && !headerStr.includes('x-provider'), 'SECURITY header has no provider/model', headerStr);
  assert(!urlStr.includes('provider') && !urlStr.includes('model'), 'SECURITY url has no provider/model', urlStr);
  // 无 token 时不挂 Authorization
  resetMocks();
  setStorage({ activeTeamPublicId: 'team_pub_1' }); // 无 access_token
  setResponder(() => ({ statusCode: 200, data: { success: true, data: { items: [], pagination: { page: 1, page_size: 20, total: 0, total_pages: 0 } } } }));
  await aiApi.listConversations(1, 20);
  assert(lastReq().header['Authorization'] === undefined, 'SECURITY no Authorization when no token');
  // 有 token 时挂 Authorization
  resetMocks();
  setStorage({ access_token: 'tokX', activeTeamPublicId: 'team_pub_1' });
  setResponder(() => ({ statusCode: 200, data: { success: true, data: { items: [], pagination: { page: 1, page_size: 20, total: 0, total_pages: 0 } } } }));
  await aiApi.listConversations(1, 20);
  assert(lastReq().header['Authorization'] === 'Bearer tokX', 'SECURITY Authorization present when token set');

  banner('INPUT VALIDATION');
  assert(validateMessageInput('   ').ok === false && validateMessageInput('   ').reason === 'empty', 'VALIDATE empty/whitespace -> empty');
  assert(validateMessageInput('').ok === false, 'VALIDATE truly empty -> empty');
  const longStr = 'x'.repeat(AI_MAX_MESSAGE_LENGTH + 1);
  assert(validateMessageInput(longStr).ok === false && validateMessageInput(longStr).reason === 'too_long', 'VALIDATE over 2000 -> too_long');
  assert(validateMessageInput('  hello  ').ok === true && validateMessageInput('  hello  ').value === 'hello', 'VALIDATE trims value');
  assert(AI_MAX_MESSAGE_LENGTH === 2000, 'VALIDATE AI_MAX_MESSAGE_LENGTH === 2000');

  banner('NO AUTO-RETRY');
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  setResponder(() => ({ statusCode: 503, data: { success: false, error: { code: 'AI_UNAVAILABLE', message: 'x' } } }));
  requestLog = [];
  let errored = false;
  try { await aiApi.listConversations(1, 20); } catch (e) { errored = true; }
  assert(errored === true, 'RETRY request rejected on 503');
  assert(requestLog.length === 1, 'RETRY exactly ONE wx.request (no auto-retry)', 'count=' + requestLog.length);

  // network fail path
  resetMocks();
  setStorage({ access_token: 'tok123', activeTeamPublicId: 'team_pub_1' });
  setResponder(() => ({ __fail: true }));
  requestLog = [];
  let netErr = null;
  try { await aiApi.listConversations(1, 20); } catch (e) { netErr = e; }
  assert(netErr && netErr.isNetwork === true && netErr.status === 0, 'RETRY network failure -> isNetwork error', JSON.stringify(netErr));
  assert(requestLog.length === 1, 'RETRY network fail -> ONE wx.request (no auto-retry)', 'count=' + requestLog.length);
}

try {
  await main();
} catch (e) {
  console.error('UNCAUGHT', e);
  fail++;
} finally {
  await rm(tmp, { force: true }).catch(() => {});
}

console.log(`\n==== P36-C4 FRONTEND TEST SUMMARY: ${pass} passed, ${fail} failed ====`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
process.exit(0);
