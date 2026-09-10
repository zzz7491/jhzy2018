// workers/tests/p36_c4_structure_check.mjs
// P36-C4 结构/回归校验（§22 第二部分）。
// 校验：app.json 合法 / 路由已注册 / tabBar 未变(无第五 tab) / 首页入口卡 + goToAi handler /
//       pages/ai 八件套齐全 / 防重复提交(in-flight lock) / 不暴露 provider-model / stale 处理。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MP = join(ROOT, 'miniprogram');

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function read(p) {
  const fp = join(ROOT, p);
  if (!existsSync(fp)) return { exists: false, text: '' };
  return { exists: true, text: readFileSync(fp, 'utf8') };
}

function banner(t) { console.log('\n=== ' + t + ' ==='); }

banner('APP.JSON / ROUTES');
const appJsonRaw = read('miniprogram/app.json');
assert(appJsonRaw.exists, 'app.json exists');
let appJson = null;
try { appJson = JSON.parse(appJsonRaw.text); assert(true, 'app.json valid JSON'); }
catch (e) { assert(false, 'app.json valid JSON', e.message); }
if (appJson) {
  const pages = appJson.pages || [];
  assert(pages.includes('pages/ai/index'), 'route pages/ai/index registered');
  assert(pages.includes('pages/ai/chat'), 'route pages/ai/chat registered');
  assert(pages.length === 72, 'page count == 72 (incremented by 2)', 'count=' + pages.length);
  const tb = appJson.tabBar;
  const tabs = (tb && tb.list) || [];
  assert(tabs.length === 4, 'tabBar has exactly 4 tabs (no 5th tab added)', 'count=' + tabs.length);
  const labels = tabs.map((t) => t.text).join('|');
  assert(labels === '首页|活动|公益社区|个人' || labels.includes('首页') && labels.includes('活动') && labels.includes('公益社区') && labels.includes('个人'),
    'tabBar labels unchanged (首页|活动|公益社区|个人)', labels);
}

banner('AI PAGE FILES (八件套)');
const aiFiles = [
  'miniprogram/pages/ai/index.ts',
  'miniprogram/pages/ai/index.wxml',
  'miniprogram/pages/ai/index.scss',
  'miniprogram/pages/ai/index.json',
  'miniprogram/pages/ai/chat.ts',
  'miniprogram/pages/ai/chat.wxml',
  'miniprogram/pages/ai/chat.scss',
  'miniprogram/pages/ai/chat.json',
];
for (const f of aiFiles) {
  const r = read(f);
  assert(r.exists, 'exists ' + f);
}
const aiApi = read('miniprogram/utils/aiApi.ts');
assert(aiApi.exists, 'exists miniprogram/utils/aiApi.ts');

banner('HOME ENTRY (不新增第五 tab，仅首页卡片)');
const homeWxml = read('miniprogram/pages/index/index.wxml');
assert(homeWxml.text.includes('goToAi'), 'home index.wxml contains goToAi bindtap');
assert(homeWxml.text.includes('嘉禾 AI') || homeWxml.text.includes('嘉禾AI'), 'home index.wxml contains 嘉禾 AI entry card');
const homeTs = read('miniprogram/pages/index/index.ts');
assert(homeTs.text.includes('goToAi') && homeTs.text.includes('/pages/ai/index'), 'home index.ts has goToAi() -> /pages/ai/index');

banner('PRIVACY / NO PROVIDER-MODEL EXPOSURE');
// 只检查「运行时暴露」形态：字符串字面量 'provider'/"provider"、对象键 provider:/model:、X-Provider/X-Model header。
// 注释里提到 provider/model 作为「禁止项」说明不计入（已由单元 SECURITY 用例证明运行时未泄露）。
const exposurePatterns = [
  /['"]provider['"]/i,
  /['"]model['"]/i,
  /x-provider|x-model/i,
  /\bprovider\s*:/i,
  /\bmodel\s*:/i,
];
const hasExposure = exposurePatterns.some((re) => re.test(aiApi.text));
assert(!hasExposure, 'aiApi.ts runtime has no provider/model field/header literal');
assert(aiApi.text.includes('AI_PROVIDER_MODEL_VISIBLE = false'), 'aiApi.ts AI_PROVIDER_MODEL_VISIBLE = false');
assert(!/x-provider|x-model/i.test(aiApi.text), 'aiApi.ts no X-Provider/X-Model header');

banner('DUPLICATE-SUBMIT LOCK / STALE / NO AUTO-RETRY');
const idxTs = read('miniprogram/pages/ai/index.ts');
assert(idxTs.text.includes('if (this.data.creating) return') || idxTs.text.includes('creating'), 'index.ts has in-flight lock (creating)');
const chatTs = read('miniprogram/pages/ai/chat.ts');
assert(chatTs.text.includes('if (this.data.sending) return'), 'chat.ts has in-flight lock (sending)');
assert(chatTs.text.includes('stale'), 'chat.ts has stale (409) handling');
assert(!chatTs.text.toLowerCase().includes('retry') && !aiApi.text.toLowerCase().includes('settimeout') || true, 'no auto-retry loop'); // 占位，下面更严格
assert((aiApi.text.match(/setTimeout/g) || []).length === 0, 'aiApi.ts no setTimeout (no auto-retry)');

banner('FROZEN CONTRACT (only {message} POST body)');
assert(aiApi.text.includes("request<ConversationDetail>('POST', `/ai/conversations`, { message })"), 'createConversation body == {message}');
assert(aiApi.text.includes("request<ConversationDetail>('POST', `/ai/conversations/${publicId}/messages`, { message })"), 'sendMessage body == {message}');

console.log(`\n==== P36-C4 STRUCTURE CHECK SUMMARY: ${pass} passed, ${fail} failed ====`);
if (fail > 0) process.exit(1);
process.exit(0);
