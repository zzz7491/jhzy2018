// miniprogram/tests/identity_onboarding_contract.mjs
// 最小、确定性、无网络、无 D1 的前端契约测试（P0-A 实名认证入口闭环）。
//
// 覆盖 M1-6 要求：
//   1) identity 页面已注册
//   2) identity 入口可达（mine 页跳转 + wxml 绑定）
//   3) 请求使用既有的 P0-A API（/volunteer/identity/verify + /status，body 字段 real_name/id_card）
//   4) 必填输入校验
//   5) INVALID_INPUT 处理
//   6) 成功处理（VERIFIED）
//   7) 状态刷新（onLoad 拉取 status）
//   8) 完整身份证号不写入 storage / URL / log，成功后清空明文
//   9) qualification 不伪造 qualified（后端投影仍只读）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // miniprogram/

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

let failures = 0;
function check(cond, label, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

// 1) identity page registered
const appJson = JSON.parse(read('app.json'));
check(
  appJson.pages.includes('pages/identity-verify/identity-verify'),
  'identity page registered in app.json',
);

// 2) entry reachable
const mineTs = read('pages/mine/mine.ts');
const mineWxml = read('pages/mine/mine.wxml');
check(/goToIdentityVerify\s*\(/.test(mineTs), 'mine.ts defines goToIdentityVerify');
check(
  mineTs.includes("'/pages/identity-verify/identity-verify'"),
  'mine.ts navigates to identity-verify page',
);
check(
  /bindtap="goToIdentityVerify"/.test(mineWxml),
  'mine.wxml binds goToIdentityVerify on identity item',
);

// 3) exact P0-A API
const api = read('utils/identityApi.ts');
check(api.includes('/volunteer/identity/verify'), 'identityApi POST /volunteer/identity/verify');
check(api.includes('/volunteer/identity/status'), 'identityApi GET /volunteer/identity/status');
check(
  /real_name:\s*realName/.test(api) && /id_card:\s*idCard/.test(api),
  'identityApi sends real_name + id_card body',
);

// 4) required input validation
const page = read('pages/identity-verify/identity-verify.ts');
check(/if\s*\(!realName\)/.test(page) && /if\s*\(!idCard\)/.test(page), 'page validates realName + idCard non-empty');

// 5) INVALID_INPUT handling (400)
check(/status\s*===?\s*400/.test(page) && /invalidInput/.test(page), 'page handles INVALID_INPUT (400)');

// 6) success handling
check(/res\.status\s*===?\s*'VERIFIED'/.test(page), "page handles VERIFIED success");

// 7) status refresh on load
check(/onLoad\(\)\s*{\s*this\.loadStatus\(\)/.test(page) || page.includes('this.loadStatus()'), 'page loads status on onLoad');

// 8) full ID card not in storage / URL / log; cleared after success
check(
  !/setStorageSync\([^)]*idCard/i.test(page) && !/setStorageSync\([^)]*id_card/i.test(page),
  'no id_card written to storage',
);
check(
  !/console\.log\([^)]*idCard/i.test(page) && !/console\.log\([^)]*id_card/i.test(page),
  'no id_card in console.log',
);
check(!/id_card=/.test(api) && !/real_name=/.test(api), 'no id_card/real_name in URL query');
check(
  (page.includes("realName: ''") && page.includes("idCard: ''")) ||
    /setData\(\{\s*realName:\s*''[\s\S]*?idCard:\s*''/.test(page),
  'page clears realName+idCard after success',
);

// 9) qualification not faked
const qApi = read('utils/qualificationApi.ts');
check(
  qApi.includes('identity_verified: boolean') && !/qualified\s*=\s*true/.test(qApi),
  'qualificationApi remains read-only (no qualified fake)',
);
check(
  !/qualified\s*[:=]/.test(page) && !/setData\([^)]*qualified/.test(page),
  'identity-verify page does not fake qualified state',
);

console.log('---');
console.log('FAILURES=' + failures);
process.exit(failures === 0 ? 0 : 1);
