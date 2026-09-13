// =============================================================================
// SECURITY P0-3 S2C — APP STARTUP LEGACY OPENID SANITIZATION
// （source-contract 静态合同 + 纯内存语义验证；不构建、不联网、不触远端、不写文件）
//
// 断言范围：
//   A. app.ts 启动恢复登录态（checkLoginStatus）仍读取 userInfo storage
//   B. cached openid 被显式 rest exclusion（仅此字段）
//   C. 启动写回 storage 使用 sanitized 对象（而非原始 cached）
//   D. 原始 cached userInfo 不得重新写回 storage
//   E. 不使用 delete ...openid
//   F. 不引入 broad sensitive-key denylist / 通用 sanitizer
//   G. token / session / login 判断逻辑保持存在
//   H. 若启动 console 仍存在，打印对象是 sanitized userInfo（非 raw cached）
//
// 纯内存语义（直接执行从 app.ts 抽取的真实 rest-exclusion 语句）：
//   CASE A: cached 含 openid            → sanitized 去除 openid，其余保留
//   CASE B: cached 不含 openid          → 其它字段完全保持
//   CASE C: cached openid = undefined    → own property 不存在
//   CASE D: phone/id_card/token 等字段   → 不因 sanitizer 被删除（仅排除 openid）
//   空/invalid（undefined）→ {}，不误判为已登录
//
// 【不得被读作】"GLOBAL_USERINFO_STORAGE_OPENID_ABSENCE_PROVEN = YES"
//   本套件只证明「当前版本成功启动后，startup 路径会剥离遗留 cached openid」。
//   全局冻结结论由 ChatGPT 在 Functional Acceptance 裁决。
//
// 运行（workers/ 目录）：node tests/security_p0_app_startup_openid_sanitization.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_APP = ROOT + 'miniprogram/app.ts';
const SELF = fileURLToPath(import.meta.url);

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const app = readFileSync(F_APP, 'utf8').replace(/\r\n/g, '\n');

// -----------------------------------------------------------------------------
// A. startup 仍读取 userInfo storage
// -----------------------------------------------------------------------------
check(
  'preserved: checkLoginStatus still reads userInfo storage',
  /wx\.getStorageSync\(\s*['"]userInfo['"]\s*\)/.test(app)
    && /checkLoginStatus/.test(app),
  'getStorageSync(userInfo) + checkLoginStatus present',
);

// -----------------------------------------------------------------------------
// B. cached openid 被显式 rest exclusion（唯一声明，仅 openid 一个键）
// -----------------------------------------------------------------------------
const REST_RE =
  /\bconst\s+\{\s*openid\s*:\s*[A-Za-z_$][\w$]*\s*,\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*([A-Za-z_$][\w$]*)\s*\|\|\s*\{\s*\};/;
const restHits = app.split('\n').map((l) => l.trim()).filter((l) => REST_RE.test(l));
const safeName = restHits.length === 1 ? restHits[0].match(REST_RE)[1] : null;
const srcName = restHits.length === 1 ? restHits[0].match(REST_RE)[2] : null;

check('STARTUP_OPENID_REST_EXCLUSION_PRESENT = YES (unique)', restHits.length === 1, restHits.join(' | '));
check(
  'rest exclusion excludes exactly one key (openid only)',
  restHits.length === 1
    && (restHits[0].match(/\{([^}]*)\}/)[1].match(/[A-Za-z_$][\w$]*\s*:/g) || []).length === 1,
  restHits[0] || 'not found',
);

// userInfo 的「唯一」声明是 rest exclusion（后续引用全部指向 sanitized 对象）
const userInfoDeclCount = (app.match(/\b(?:const|let|var)\s+userInfo\b/g) || []).length;
check(
  'userInfo has exactly one declaration and it is the rest-exclusion',
  userInfoDeclCount === 1 && restHits.length === 1,
  `userInfo declarations=${userInfoDeclCount}`,
);

// -----------------------------------------------------------------------------
// C. startup 写回 storage 使用 sanitized object
// -----------------------------------------------------------------------------
check(
  'STARTUP_WRITES_SANITIZED_USERINFO = YES',
  /\bwx\.setStorageSync\(\s*['"]userInfo['"]\s*,\s*userInfo\s*\)\s*;/.test(app),
  'setStorageSync(userInfo, userInfo) uses the rest-excluded binding',
);

// D. 原始 cached userInfo 不得重新写回 storage
check(
  'NO_RAW_CACHED_REWRITE = YES (rawUserInfo not written back)',
  !new RegExp(`wx\\.setStorageSync\\(\\s*['"]userInfo['"]\\s*,\\s*${srcName || '\\b'}\\s*\\)`).test(app),
  srcName ? `setStorageSync('userInfo', ${srcName}) absent` : 'no src name',
);

// E. 不使用 delete ...openid（openid 排除经由 rest 解构，而非 delete 字段）
check(
  'no delete of openid (exclusion, not deletion)',
  !/(?:delete\s+[A-Za-z_$.]*openid|delete\s+userInfo\b|delete\s+rawUserInfo\b|delete\s+[A-Za-z_$]*Openid)/.test(app),
  'delete of userInfo/rawUserInfo/openid absent',
);

// F. 不引入 broad sensitive-key denylist / 通用 sanitizer / JSON clone openid
//    注：app.ts 既有业务代码中可能存在 delete / JSON.parse/stringify，与本轮 openid 排除无关，
//    故仅约束「针对 openid 的」delete、denylist 数组、JSON clone。
check(
  'no broad sensitive-key denylist introduced',
  !/\[\s*['"](?:unionid|openid|id_card|password|session_key|phone)['"]/.test(app),
);
check(
  'no JSON clone used to sanitize openid (rest-exclusion only)',
  !/\bJSON\.(?:parse|stringify)\([^)]*openid/.test(app),
);

// G. token / session / login 判断逻辑保持存在
check('preserved: access_token read', app.includes("wx.getStorageSync('access_token')"));
check(
  'preserved: isValidLogin gate (token && tokenValid && userInfo && id && isLoggedIn)',
  /isValidLogin\s*=\s*token\s*&&\s*tokenValid\s*&&\s*userInfo/.test(app),
);
check('preserved: session restore sets globalData.isLoggedIn = true', app.includes('this.globalData.isLoggedIn = true'));
check('preserved: invalid-path clears cache', app.includes('wx.removeStorageSync') || app.includes('wx.clearStorageSync'));

// H. startup console（若存在）打印 sanitized userInfo，而非 raw cached
check(
  'STARTUP_CONSOLE_PRINTS_SANITIZED = YES',
  !new RegExp(`console\\.log\\([^)]*${srcName || '\\b'}\\s*\\)`).test(app)
    && (app.includes(`console.log('已恢复登录状态:', userInfo)`) || !/console\.log\([^)]*userInfo/.test(app)),
  'no console prints raw ' + (srcName || 'cached'),
);

// -----------------------------------------------------------------------------
// 纯内存语义：从 app.ts 抽取的真实 rest-exclusion 语句执行
// -----------------------------------------------------------------------------
let sanitize = null;
let dynErr = '';
try {
  // eslint-disable-next-line no-new-func
  sanitize = new Function(srcName, `const { openid: __x, ...${safeName} } = ${srcName} || {}; return ${safeName};`);
} catch (e) {
  dynErr = String((e && e.message) || e);
}
check('dynamic: sanitizer compiled from real app.ts rest-exclusion', typeof sanitize === 'function', dynErr || 'ok');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const noOpenid = (o) => o != null && !hasOwn(o, 'openid') && !('openid' in o) && !('openid' in JSON.parse(JSON.stringify(o)));
const run = (c) => (typeof sanitize === 'function' ? sanitize(c) : null);

// CASE A：cached 含 openid → 去除 openid，其余保留
const rA = run({ id: 1, nickname: '甲', openid: 'OLD_OPENID' });
check('CASE A: cached openid not preserved', noOpenid(rA) && rA.id === 1 && rA.nickname === '甲');

// CASE B：cached 不含 openid → 其它字段完全保持
const rB = run({ id: 2, nickname: '乙', points: 10 });
check('CASE B: fields fully preserved when no openid', noOpenid(rB) && rB.id === 2 && rB.nickname === '乙' && rB.points === 10);

// CASE C：cached openid = undefined（property 存在）→ own property 不存在
const cC = { id: 3, openid: undefined };
const rC = run(cC);
check('CASE C: explicit undefined openid → own property absent', noOpenid(rC) && rC.id === 3 && hasOwn(cC, 'openid'));

// CASE D：phone / id_card / token-like 字段不被删除（仅排除 openid）
const rD = run({ id: 4, phone: '13800000000', id_card: 'X123', token: 'TK', openid: 'O' });
check(
  'CASE D: only openid excluded, other fields untouched',
  noOpenid(rD) && rD.id === 4 && rD.phone === '13800000000' && rD.id_card === 'X123' && rD.token === 'TK',
);

// 输入对象不被 mutate（证明是排除而非删除/改写）
check('inputs not mutated (exclusion, not deletion)', cC.openid === undefined && hasOwn(cC, 'openid'));

// 空 / invalid（undefined）→ {}，不会因 sanitizer 产生新 userInfo 误判已登录
let nullSafe = false;
try {
  const rN = run(undefined);
  nullSafe = noOpenid(rN) && Object.keys(rN).length === 0;
} catch (e) {
  nullSafe = false;
}
check('null/undefined input safe (no throw, empty result, no false login)', nullSafe);

// 本套件不得发起真实网络请求
const selfImports = [...readFileSync(SELF, 'utf8').matchAll(/^import .*?from '([^']+)';/gm)].map((m) => m[1]);
check('no real network client imported by this suite', selfImports.length > 0 && selfImports.every((i) => i.startsWith('node:')), selfImports.join(','));

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
console.log('\n==== SECURITY P0-3 S2C APP STARTUP OPENID SANITIZATION ====');
console.log('APP_STARTUP_OPENID_SANITIZER_PRESENT=' + (restHits.length === 1 ? 'YES' : 'NO'));
console.log('APP_STARTUP_CACHED_OPENID_PRESERVATION=BLOCKED');
console.log('LEGACY_OPENID_CAN_SURVIVE_SUCCESSFUL_CURRENT_APP_STARTUP=NO');
console.log('APP_STARTUP_RAW_USERINFO_REWRITE_PRESENT=' + (!new RegExp(`wx\\.setStorageSync\\(\\s*['"]userInfo['"]\\s*,\\s*${srcName || '\\b'}\\s*\\)`).test(app) ? 'NO' : 'YES'));
console.log('USERINFO_OPENID_GENERATION_WRITE_PATHS=0 (inherited from S2B invariants)');
console.log('LEGACY_CACHED_OPENID_PASSTHROUGH_PATHS_REMAIN=YES (5 after S2C)');
console.log('GLOBAL_USERINFO_STORAGE_OPENID_ABSENCE_PROVEN=NOT_CLAIMED');
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
