// =============================================================================
// SECURITY P0-3 S1 — REGISTER SENSITIVE LOGGING REMOVAL（source-contract，静态）
//
// 范围（仅本 S1）：证明 miniprogram/pages/register/register.ts 中会暴露
//   raw openid / code / password / id_card / phone / 完整请求对象 / 完整响应体
// 的 console 输出已消除，且 openid 流程 / 注册请求契约 / 校验逻辑未被改变。
//
// 本测试不覆盖 login-unified、admin/review-aggregate、legacy PHP 与 V2 auth
// （Option B/C/D 明确不在范围内）。
//
// 策略：纯源码契约扫描 —— 不构建、不联网、不触远端、不写任何文件。
// 运行（workers/ 目录）：node tests/security_p0_openid_logging.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_REGISTER = ROOT + 'miniprogram/pages/register/register.ts';
const F_LOGIN_UNIFIED = ROOT + 'miniprogram/pages/login-unified/index.ts';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const register = readFileSync(F_REGISTER, 'utf8');

/** 所有 console.* 调用行。 */
function consoleLines(src) {
  return src
    .split('\n')
    .map((l, i) => ({ n: i + 1, line: l }))
    .filter((x) => /console\.(log|debug|info|warn|error)\s*\(/.test(x.line));
}

/**
 * 抽取 console 调用的「实参表达式」部分，并剥离字符串字面量。
 * 目的：只在实参（真实取值）中判定敏感性，避免日志文案里出现 "openid" 字样造成误报。
 */
function consoleArgs(line) {
  const m = line.match(/console\.(?:log|debug|info|warn|error)\s*\(([\s\S]*)\)\s*;?\s*$/);
  const raw = m ? m[1] : line;
  return raw
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const SCAN = consoleLines(register).map((x) => ({
  n: x.n,
  line: x.line,
  args: consoleArgs(x.line),
}));

// ---------- 计数器（本 S1 的四个量化指标） ----------
// 1) raw openid 出现在 console 实参中
const RAW_OPENID_SITES = SCAN.filter((x) => /\bopenid\b/i.test(x.args));
// 2) 完整注册数据对象（registerData / formData 整体）
const FULL_REGISTER_DATA_SITES = SCAN.filter((x) => /\b(registerData|formData)\b/.test(x.args));
// 3) 完整微信登录响应体（wxRes.data 作为整体取值，而非 wxRes.data.msg 这类标量字段）
const FULL_WECHAT_RESPONSE_SITES = SCAN.filter((x) =>
  /(^|[^A-Za-z0-9_$])(wxRes|res)\s*\.\s*data\s*[,)]/.test(x.args),
);
// 4) 完整注册 API 响应体（res.data 作为整体取值）
const FULL_API_RESPONSE_SITES = SCAN.filter((x) =>
  /(^|[^A-Za-z0-9_$])res\s*\.\s*data\s*[,)]/.test(x.args),
);

// 附加上下文对象整包泄露（onLoad 的 options 内含 openid、phone）
const OPTIONS_DUMP_SITES = SCAN.filter((x) => /(^|[^A-Za-z0-9_$.])options([^A-Za-z0-9_$]|$)/.test(x.args));
// 其他凭证类（code / password / id_card / phone / token）
const CREDENTIAL_SITES = SCAN.filter((x) =>
  /(^|[^A-Za-z0-9_$])(password|id_card|phone|temp_token|access_token|session_id)([^A-Za-z0-9_$]|$)/.test(x.args),
);
// wx.login 的一次性 code（显式禁止记录项）
const WX_CODE_SITES = SCAN.filter((x) => /(^|[^A-Za-z0-9_$])res\s*\.\s*code([^A-Za-z0-9_$]|$)/.test(x.args));

// ---------- A. 已消除的敏感日志点（字符串级直证） ----------
const REMOVED_MARKERS = [
  ['register.ts: onLoad options dump removed', "console.log('注册页面加载', options)"],
  ['register.ts: login-page openid handoff log removed', "console.log('从登录页传递openid:'"],
  ['register.ts: wx.login raw code log removed', "console.log('获取微信code成功:'"],
  ['register.ts: full wxlogin.php response log removed', "console.log('微信登录接口响应:'"],
  ['register.ts: already-registered openid log removed', "console.log('用户已注册，openid:'"],
  ['register.ts: openid-acquired log removed', "console.log('获取openid成功:'"],
  ['register.ts: full registerData payload log removed', "console.log('提交注册数据:'"],
  ['register.ts: full register.php response log removed', "console.log('注册API响应:'"],
];
for (const [name, marker] of REMOVED_MARKERS) {
  check(name, !register.includes(marker));
}

// ---------- B. 量化计数（全部必须为 0） ----------
check('REGISTER_RAW_OPENID_LOG_SITES = 0', RAW_OPENID_SITES.length === 0, RAW_OPENID_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_FULL_REGISTER_DATA_LOGS = 0', FULL_REGISTER_DATA_SITES.length === 0, FULL_REGISTER_DATA_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_FULL_WECHAT_RESPONSE_LOGS = 0', FULL_WECHAT_RESPONSE_SITES.length === 0, FULL_WECHAT_RESPONSE_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_FULL_API_RESPONSE_LOGS = 0', FULL_API_RESPONSE_SITES.length === 0, FULL_API_RESPONSE_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_OPTIONS_DUMP_LOGS = 0', OPTIONS_DUMP_SITES.length === 0, OPTIONS_DUMP_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_CREDENTIAL_LOGS = 0', CREDENTIAL_SITES.length === 0, CREDENTIAL_SITES.map((x) => `L${x.n}`).join(','));
check('REGISTER_WX_CODE_LOGS = 0', WX_CODE_SITES.length === 0, WX_CODE_SITES.map((x) => `L${x.n}`).join(','));

// ---------- C. 功能保持（OPENID_FLOW_CHANGED = NO） ----------
check('wx.login call preserved', register.includes('wx.login({'));
check('wxlogin.php request preserved', register.includes("apiBaseUrl + 'wxlogin.php'"));
check('wxlogin.php POST body (code) preserved', /data:\s*\{\s*code:\s*res\.code\s*\}/.test(register));
check('openid extraction from wxlogin response preserved', (register.match(/wxRes\.data\.data\.openid/g) || []).length === 2);
check('hasOpenid state defined', register.includes('hasOpenid: false,'));
check('hasOpenid set on both wxlogin success branches', (register.match(/hasOpenid: true/g) || []).length === 3);
check('hasOpenid gate in validateForm preserved', /if \(!hasOpenid\) \{/.test(register));
check('hasOpenid gate in onSubmit preserved', /if \(!this\.data\.hasOpenid\) \{/.test(register));
check('openid passed into registerData preserved', /const \{ formData, simpleMode, openid \} = this\.data;/.test(register));

// ---------- D. 注册请求契约保持（REGISTER_REQUEST_CONTRACT_CHANGED = NO） ----------
check('register.php request preserved', register.includes("apiBaseUrl + 'register.php'"));
check('register.php POST body still registerData', /data:\s*registerData,/.test(register));
check('registerData.openid field preserved', /openid:\s*openid,/.test(register));
for (const f of ['real_name', 'id_card', 'phone', 'password']) {
  check(`registerData.${f} field preserved`, new RegExp(`${f}:\\s*formData\\.${f}\\b`).test(register));
}
check('optional emergency fields preserved', register.includes('registerData.emergency_contact = formData.emergency_contact;') && register.includes('registerData.emergency_phone = formData.emergency_phone;'));
check('temp_token persistence (business logic) preserved', register.includes("wx.setStorageSync('access_token', responseData.temp_token);"));
check('response code branches preserved', [0, -6, -8].every((c) => register.includes(`res.data.code === ${c}`)));

// ---------- E. 校验与状态机保持（REGISTER_VALIDATION_CHANGED = NO） ----------
check('id_card validation regex preserved', register.includes('/^\\d{17}[\\dXx]$/'));
check('phone validation regex preserved', register.includes('/^1[3-9]\\d{9}$/'));
check('password length rule preserved', register.includes('value.length >= 6 && value.length <= 20'));
check('protocol gate preserved', register.includes('if (!this.data.agreeProtocol) {'));
check('loading guard preserved', register.includes('if (this.data.loading) return;'));

// ---------- F. Option B 未触碰（只读证明） ----------
{
  const loginUnified = readFileSync(F_LOGIN_UNIFIED, 'utf8');
  check('OPTION_B: login-unified userInfo.openid field untouched', loginUnified.includes('openid: userInfoData?.openid || openid,'));
  check('OPTION_B: login-unified storage write untouched', loginUnified.includes("wx.setStorageSync('userInfo',"));
  check('OPTION_B: login-unified openid network handoff untouched', loginUnified.includes('&openid=${encodeURIComponent(openid)}'));
}

// ---------- summary ----------
const passed = results.filter((r) => r.pass).length;
console.log('\n==== SECURITY P0-3 S1 REGISTER OPENID-LOGGING ====');
console.log(`REGISTER_RAW_OPENID_LOG_SITES=${RAW_OPENID_SITES.length}`);
console.log(`REGISTER_FULL_REGISTER_DATA_LOGS=${FULL_REGISTER_DATA_SITES.length}`);
console.log(`REGISTER_FULL_WECHAT_RESPONSE_LOGS=${FULL_WECHAT_RESPONSE_SITES.length}`);
console.log(`REGISTER_FULL_API_RESPONSE_LOGS=${FULL_API_RESPONSE_SITES.length}`);
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
