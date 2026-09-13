// =============================================================================
// SECURITY P0-3 S2A — LOGIN-UNIFIED USERINFO OPENID PERSISTENCE REMOVAL
// （source-contract，静态；不构建、不联网、不触远端、不写文件）
//
// 断言范围（严格）：
//   1) login-unified 构造 local userInfo 时不再写入 openid 属性
//   2) raw openid 获取链路保留（wx.login → get_openid.php → 页面内存）
//   3) legacy login.php 的 openid 转发保留（&openid=<页面变量>）
//   4) setStorageSync('userInfo', userInfo) / access_token / 字段 / 导航 / 失败流保留
//   5) 全仓不存在「读取持久化 userInfo.openid」的消费者
//
// 【重要边界】本测试 **不** 断言、也**不得**被读作：
//   "GLOBAL_STORAGE_OPENID_ABSENCE_PROVEN"
//   —— 已知残留向量：pages/points/points.ts 的 { ...userInfo, ...userData }
//      会把 legacy user_info.php 响应整体并回 storage，其响应 shape UNKNOWN。
//   故本测试仅声明 LOGIN_WRITE_REMOVED，并独立、显式地声明全局缺失「未证明」。
//
// 运行（workers/ 目录）：node tests/security_p0_userinfo_openid_storage.mjs
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_LOGIN = ROOT + 'miniprogram/pages/login-unified/index.ts';
const F_POINTS = ROOT + 'miniprogram/pages/points/points.ts';
const FE_ROOT = ROOT + 'miniprogram';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const login = readFileSync(F_LOGIN, 'utf8');

/** 从 marker 之后的第一个 '{' 起做花括号配对，返回对象字面量文本。 */
function objectLiteralAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const start = src.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** 对象字面量是否含有 own property `openid:`（顶层或嵌套均视为命中，从严）。 */
function hasOpenidProperty(literal) {
  return literal != null && /(^|[\s,{])openid\s*:/m.test(literal);
}

// ---------- 1. LOGIN_WRITE_REMOVED ----------
const volunteerLiteral = objectLiteralAfter(login, 'const userInfo = {');
// 第二个同类字面量为 adminLogin 分支：定位其 marker 之后再次查找
const adminLiteral = (() => {
  const first = login.indexOf('const userInfo = {');
  const next = login.indexOf('const userInfo = {', first + 1);
  return next < 0 ? null : objectLiteralAfter(login.slice(next), 'const userInfo = {');
})();

check('login-unified: volunteer userInfo literal located', volunteerLiteral != null);
check('login-unified: admin userInfo literal located', adminLiteral != null);
check(
  'LOGIN_WRITE_REMOVED: volunteer userInfo literal has no openid property',
  !hasOpenidProperty(volunteerLiteral),
);
check(
  'LOGIN_WRITE_REMOVED: admin userInfo literal has no openid property',
  !hasOpenidProperty(adminLiteral),
);
check(
  'login-unified: raw openid property line removed verbatim',
  !login.includes('openid: userInfoData?.openid || openid,'),
);
check('login-unified: no delete openid migration code', !/delete\s+[\w$.]*openid/.test(login));
check('login-unified: no removeStorageSync introduced', !/removeStorageSync\(/.test(login));

// ---------- 2. raw openid acquisition preserved ----------
check('preserved: wx.login call', login.includes('wx.login({'));
check('preserved: get_openid.php endpoint', login.includes("'https://api.jhzyfw.com/api/get_openid.php'"));
check('preserved: openid into page memory', /this\.setData\(\{\s*openid:\s*resp\.data\.openid\s*\}\)/.test(login));
check('preserved: getUserOpenid invoked on load', login.includes('this.getUserOpenid()'));
check('preserved: page-level openid destructured for login', /const \{ account, password, currentRole, openid \} = this\.data/.test(login));

// ---------- 3. legacy login openid forwarding preserved ----------
check(
  'LEGACY_LOGIN_OPENID_FORWARDING_PRESENT: &openid= built from page variable',
  login.includes('&openid=${encodeURIComponent(openid)}'),
);
check('preserved: ADMIN_ guard on forwarding', login.includes("openid && !openid.startsWith('ADMIN_')"));
check('preserved: login.php endpoint', login.includes("'https://api.jhzyfw.com/api/login.php'"));
check('preserved: account/password form body', login.includes('`account=${encodeURIComponent(phone)}&password=${encodeURIComponent(password)}`'));
check('preserved: admin_login.php endpoint', login.includes("'https://api.jhzyfw.com/api/admin_login.php'"));

// ---------- 4. response handling / token / fields / navigation preserved ----------
check('preserved: success branch code === 0', login.includes('res.data.code === 0'));
check('preserved: user_info response source', login.includes('res.data.data?.user_info || res.data.user_info'));
check('preserved: access_token write', login.includes("wx.setStorageSync('access_token', token)"));
check('preserved: token alias write', login.includes("wx.setStorageSync('token', token)"));
check('preserved: userInfo write retained', login.includes("wx.setStorageSync('userInfo', userInfo)"));
check('preserved: isLoggedIn write', login.includes("wx.setStorageSync('isLoggedIn', true)"));
check('preserved: token_expire write', login.includes("wx.setStorageSync('token_expire', Date.now() + 30 * 24 * 60 * 60 * 1000)"));
check('preserved: globalData sync', login.includes('app.globalData.userInfo = userInfo'));
for (const f of ['id', 'username', 'real_name', 'phone', 'points', 'volunteer_id', 'activity_count', 'service_hours', 'current_points', 'total_points']) {
  check(`preserved: userInfo field ${f}`, new RegExp(`(^|[\\s,{])${f}:`,'m').test(volunteerLiteral || ''));
}
check('preserved: success navigation switchTab index', login.includes("wx.switchTab({ url: '/pages/index/index' })"));
check('preserved: admin redirect adminPanel', login.includes("wx.redirectTo({ url: '/pages/adminPanel/adminPanel' })"));
check('preserved: verifier redirect qrVerify', login.includes("wx.redirectTo({ url: '/pages/admin/qrVerify/qrVerify' })"));
check('preserved: volunteer failure reject', login.includes("reject(res.data.msg || '登录失败')"));
check('preserved: network failure reject', login.includes("reject('网络错误')"));
check('preserved: onShow session restore uses is_admin only', login.includes('if (userInfo.is_admin) {'));
check('preserved: register entry navigation', login.includes("wx.navigateTo({ url: '/pages/register/register' })"));

// ---------- 5. persisted userInfo.openid readers (whole frontend) ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'miniprogram_npm') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|wxml)$/.test(e)) out.push(p);
  }
  return out;
}
const readerHits = [];
for (const f of walk(FE_ROOT)) {
  const src = readFileSync(f, 'utf8');
  if (!/getStorageSync\(.userInfo.\)/.test(src)) continue;
  const vars = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*wx\.getStorageSync\(.userInfo.\)/g)) vars.add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*wx\.getStorageSync\(.userInfo.\)/g)) vars.add(m[1]);
  for (const v of vars) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*\\??\\.\\s*openid\\b', 'i');
    if (re.test(src)) readerHits.push(f.replace(ROOT, '') + ' <' + v + '.openid>');
  }
}
check('PERSISTED_USERINFO_OPENID_READERS = 0', readerHits.length === 0, readerHits.join(','));
check('no inline getStorageSync(userInfo).openid', !/getStorageSync\(.userInfo.\)\s*\??\.\s*openid/i.test(walk(FE_ROOT).map((f) => readFileSync(f, 'utf8')).join('\n')));

// ---------- 6. explicit NON-claim: global absence NOT proven ----------
const points = readFileSync(F_POINTS, 'utf8');
const residualPresent = points.includes('{ ...userInfo, ...userData }');
check(
  'RESIDUAL_REINTRODUCTION_VECTOR untouched (points.ts server-merge intact)',
  residualPresent,
  'points.ts / user_info.php shape UNKNOWN',
);
check(
  'GLOBAL_STORAGE_OPENID_ABSENCE_PROVEN = NO (this suite makes no such claim)',
  residualPresent === true,
);

// ---------- summary ----------
const passed = results.filter((r) => r.pass).length;
console.log('\n==== SECURITY P0-3 S2A LOGIN USERINFO OPENID STORAGE ====');
console.log('LOGIN_USERINFO_OPENID_WRITE_SITES=0');
console.log('PERSISTED_USERINFO_OPENID_READERS=' + readerHits.length);
console.log('LEGACY_LOGIN_OPENID_FORWARDING_PRESENT=YES');
console.log('LOGIN_WRITE_REMOVED=YES');
console.log('GLOBAL_STORAGE_OPENID_ABSENCE_PROVEN=NO');
console.log('RESIDUAL_REINTRODUCTION_VECTOR=points.ts / user_info.php UNKNOWN');
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
