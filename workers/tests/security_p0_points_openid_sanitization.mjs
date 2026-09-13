// =============================================================================
// SECURITY P0-3 S2B — POINTS USERINFO OPENID SANITIZATION
// （source-contract 静态合同 + 纯内存语义验证；不构建、不联网、不触远端、不写文件）
//
// 断言范围：
//   A. points.ts 写回 storage 前的 openid 消毒合同：cached userInfo 与
//      user_info.php 响应两个输入源都被显式排除，且仅排除 openid。
//   B. user_info.php 请求 / 响应处理 / setData / 生命周期行为保持。
//   C. 纯内存语义（直接执行从 points.ts 抽取的真实语句）：A/B/C/D 四用例、
//      合并优先级、输入不被 mutate、null/undefined 安全。
//   D. 全仓 userInfo storage 写入点清单，并输出三条**互斥**的限定语义字段：
//        USERINFO_OPENID_GENERATION_WRITE_PATHS = 0
//        USERINFO_OPENID_NETWORK_REINTRODUCTION_PATHS = 0
//        LEGACY_CACHED_OPENID_PASSTHROUGH_PATHS_REMAIN = YES
//      第三项是既有事实，不得被合并进前两项的 0 值，也不得被读作「无写入路径」。
//
// 【不得被读作】"GLOBAL_USERINFO_STORAGE_OPENID_ABSENCE_PROVEN = YES"
//   —— legacy user_info.php 的响应 shape 不可证
//      （USER_INFO_PHP_OPENID_FIELD_PROVEN = UNKNOWN）；
//   —— 且仍存在 5 处 legacy cached passthrough / cache echo writer（app.ts 启动恢复路径
//      已在 P0-3 S2C 中 sanitize，不再计入；剩余：goods-detail.ts:111、mall.ts:163、
//      mine.ts:66、mine.ts:351、profile/edit.ts:259）。它们不生成新 openid、不从网络
//      重新引入 openid，但理论上可继续回写设备中既存的旧 cached openid。在正常当前版本
//      启动后，这些 writer 从 storage 读取到的缓存已被 startup sanitizer 清理，不再含 openid。
//   故本套件只关闭「生成」与「网络重引入」两类，不宣称全局缺失。
//   全局冻结结论由 ChatGPT 在 Functional Acceptance 裁决。
//
// 运行（workers/ 目录）：node tests/security_p0_points_openid_sanitization.mjs
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root
const F_POINTS = ROOT + 'miniprogram/pages/points/points.ts';
const FE_ROOT = ROOT + 'miniprogram';
const SELF = fileURLToPath(import.meta.url);

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const src = readFileSync(F_POINTS, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

/** 返回唯一匹配的 trim 行；匹配数 != 1 时返回 null（合同要求唯一性）。 */
function uniqueLine(re) {
  const hits = lines.map((l) => l.trim()).filter((l) => re.test(l));
  return hits.length === 1 ? hits[0] : null;
}

// =============================================================================
// A. STATIC SANITIZATION CONTRACT
// =============================================================================
const L_CACHED = uniqueLine(/^const \{ openid: [A-Za-z_$][\w$]*, \.\.\.[A-Za-z_$][\w$]* \} = userInfo \|\| \{\};$/);
const L_RESPONSE = uniqueLine(/^const \{ openid: [A-Za-z_$][\w$]*, \.\.\.[A-Za-z_$][\w$]* \} = userData \|\| \{\};$/);
const L_MERGE = uniqueLine(/^const updatedUserInfo = \{ \.\.\.[A-Za-z_$][\w$]*, \.\.\.[A-Za-z_$][\w$]* \};$/);

const safeInfoName = L_CACHED ? L_CACHED.match(/\.\.\.([A-Za-z_$][\w$]*)/)[1] : null;
const safeDataName = L_RESPONSE ? L_RESPONSE.match(/\.\.\.([A-Za-z_$][\w$]*)/)[1] : null;

// 1. 仍调用 user_info.php
check('preserved: points.ts still calls user_info.php', src.includes("wx.$baseUrl + 'user_info.php'"));
// 2. 仍读取 res.data.data || {}
check('preserved: res.data.data || {} extraction', src.includes('const userData = res.data.data || {};'));
// 3. cached userInfo 的 openid 被排除
check(
  'POINTS_CACHED_OPENID_EXCLUDED = YES (excluded from cached userInfo)',
  L_CACHED !== null,
  L_CACHED || 'not found / not unique',
);
// 4. userData 的 openid 被排除
check(
  'POINTS_RESPONSE_OPENID_EXCLUDED = YES (excluded from response userData)',
  L_RESPONSE !== null,
  L_RESPONSE || 'not found / not unique',
);
// 5. updatedUserInfo 由两个 safe 对象合并
check(
  'POINTS_SANITIZED_MERGE = YES (built from the two safe objects only)',
  L_MERGE !== null && safeInfoName !== null && safeDataName !== null
    && L_MERGE === `const updatedUserInfo = { ...${safeInfoName}, ...${safeDataName} };`,
  L_MERGE || 'not found / not unique',
);
// 6. 仍写回 storage
check('preserved: wx.setStorageSync(userInfo, updatedUserInfo)', src.includes("wx.setStorageSync('userInfo', updatedUserInfo);"));
// 7. 原 blind merge 不得存在
check('POINTS_USERINFO_BLIND_MERGE_REMOVED = YES', !src.includes('{ ...userInfo, ...userData }'));
// 8. 不得使用 delete
check('no delete of updatedUserInfo.openid (exclusion, not deletion)', !/\bdelete\s+/.test(src));
// 9. 不得引入 broad denylist / 通用 sanitizer / clone
check(
  'no broad sensitive-key denylist introduced',
  !/\[\s*['"](?:unionid|openid|id_card|password|session_key|phone)['"]/.test(src)
    && !/Object\.keys\(/.test(src)
    && !/\.forEach\(/.test(src),
);
check('no clone/serialize helper introduced', !/JSON\.(?:parse|stringify)\(/.test(src));

// 消毒范围 = 仅 openid（两个解构都必须恰好只排除 openid 一个键）
check(
  'sanitization scope is openid only (no other key excluded)',
  L_CACHED !== null && L_RESPONSE !== null
    && (L_CACHED.match(/\{([^}]*)\}/)[1].match(/[A-Za-z_$][\w$]*\s*:/g) || []).length === 1
    && (L_RESPONSE.match(/\{([^}]*)\}/)[1].match(/[A-Za-z_$][\w$]*\s*:/g) || []).length === 1,
);

// 写入点数量回归（未新增 storage 写路径）
const pointsUserInfoWrites = (src.match(/wx\.setStorageSync\('userInfo'/g) || []).length;
const pointsAllWrites = (src.match(/wx\.setStorageSync\(/g) || []).length;
check('POINTS_USERINFO_STORAGE_WRITE_SITES = 1', pointsUserInfoWrites === 1, String(pointsUserInfoWrites));
check('POINTS_STORAGE_WRITE_TOTAL = 2 (unchanged: userInfo + displayMode)', pointsAllWrites === 2, String(pointsAllWrites));

// 语句顺序：success 分支 → 解构 1 → 解构 2 → 合并 → 写回
const order = {
  success: src.indexOf('res.data.code === 0 || res.data.code === 200'),
  cached: src.indexOf(L_CACHED || '\u0000'),
  response: src.indexOf(L_RESPONSE || '\u0000'),
  merge: src.indexOf(L_MERGE || '\u0000'),
  write: src.indexOf("wx.setStorageSync('userInfo', updatedUserInfo);"),
};
check(
  'statement order: success-gate → exclude(cached) → exclude(response) → merge → write',
  order.success > -1 && order.success < order.cached && order.cached < order.response
    && order.response < order.merge && order.merge < order.write,
);

// =============================================================================
// B. BEHAVIOR PRESERVATION
// =============================================================================
check('preserved: GET method', src.includes("method: 'GET'"));
check(
  'preserved: Authorization Bearer header',
  src.includes("'Authorization': 'Bearer ' + wx.getStorageSync('access_token')"),
);
check('preserved: success code gate unchanged', src.includes('res.data.code === 0 || res.data.code === 200'));
check('preserved: that.data.pointsData spread', src.includes('...that.data.pointsData,'));
for (const [field, expr] of [
  ['current_points', 'current_points: userData.current_points || 0'],
  ['total_points', 'total_points: userData.total_points || 0'],
  ['level', "level: userData.level || '初级志愿者'"],
  ['next_level_points', 'next_level_points: userData.next_level_points || 100'],
  ['progress', 'progress: userData.progress || 0'],
]) {
  check(`preserved: pointsData.${field} mapping`, src.includes(expr));
}
check('preserved: setData userInfo = updatedUserInfo', src.includes('userInfo: updatedUserInfo'));
check('preserved: isLoggedIn guard in loadUserPoints', src.includes('if (!this.data.isLoggedIn) return;'));
check('preserved: checkLoginStatus gate !!userInfo && !!token', src.includes('const isLoggedIn = !!(userInfo && token);'));
for (const hook of ['onLoad() {', 'onShow() {', 'onReachBottom() {', 'onPullDownRefresh() {']) {
  check(`preserved: lifecycle ${hook}`, src.includes(hook));
}
check('preserved: pagination pageSize 10', src.includes('pageSize: 10'));
check('preserved: hasMore && !loading guard', src.includes('if (this.data.hasMore && !this.data.loading) {'));
check('preserved: loadMoreRecords → fetchTransactions(page+1, true)', src.includes('this.fetchTransactions(this.data.page + 1, true);'));
check('preserved: loadPointsRecords → fetchTransactions(1, false)', src.includes('this.fetchTransactions(1, false);'));

// =============================================================================
// C. IN-MEMORY DYNAMIC SEMANTICS（执行从 points.ts 抽取的真实语句）
// =============================================================================
const dynBody = [L_CACHED, L_RESPONSE, L_MERGE].join('\n') + '\nreturn updatedUserInfo;';
let sanitize = null;
let dynErr = '';
try {
  // eslint-disable-next-line no-new-func
  sanitize = new Function('userInfo', 'userData', dynBody); // 纯内存，无网络
} catch (e) {
  dynErr = String((e && e.message) || e);
}
check('dynamic: sanitizer compiled from real points.ts statements', typeof sanitize === 'function', dynErr || dynBody.replace(/\n/g, ' ⏎ '));

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const noOpenid = (o) => o != null && !hasOwn(o, 'openid') && !('openid' in o) && !('openid' in JSON.parse(JSON.stringify(o)));
const run = (u, d) => (typeof sanitize === 'function' ? sanitize(u, d) : null);

// CASE A：cached 含 openid，userData 不含
const aIn = { openid: 'o_cached_A', real_name: '甲', points: 1 };
const rA = run(aIn, { current_points: 5 });
check('CASE A: cached openid not preserved', noOpenid(rA) && rA.real_name === '甲' && rA.points === 1 && rA.current_points === 5);
// CASE B：cached 不含，userData 含 openid
const rB = run({ real_name: '乙' }, { openid: 'o_resp_B', current_points: 9 });
check('CASE B: response openid not introduced', noOpenid(rB) && rB.real_name === '乙' && rB.current_points === 9);
// CASE C：两边都含
const rC = run({ openid: 'o_c', real_name: '丙' }, { openid: 'o_r', total_points: 3 });
check('CASE C: both sides have openid → still absent', noOpenid(rC) && rC.real_name === '丙' && rC.total_points === 3);
// CASE D：两边都不含 → 正常行为
const rD = run({ real_name: '丁', points: 4 }, { current_points: 6, total_points: 8 });
check(
  'CASE D: normal merge unaffected',
  noOpenid(rD) && rD.real_name === '丁' && rD.points === 4 && rD.current_points === 6 && rD.total_points === 8,
);
// 合并优先级不变：userData 的同名合法字段仍覆盖 cached
const rE = run({ points: 1, real_name: '甲', level: 'x' }, { points: 7 });
check('precedence preserved: userData overrides cached on same key', rE.points === 7 && rE.real_name === '甲' && rE.level === 'x');
// 输入对象不被 mutate（证明是排除而非删除/改写）
check('inputs not mutated (exclusion, not deletion)', aIn.openid === 'o_cached_A' && hasOwn(aIn, 'openid'));
// null / undefined 安全（userInfo || {} / userData || {}）
let nullSafe = false;
try {
  const rN = run(undefined, undefined);
  nullSafe = noOpenid(rN) && Object.keys(rN).length === 0;
} catch (e) {
  nullSafe = false;
}
check('null/undefined inputs safe (no throw, empty result)', nullSafe);
// 本套件不得发起真实网络请求
const selfImports = [...readFileSync(SELF, 'utf8').matchAll(/^import .*?from '([^']+)';/gm)].map((m) => m[1]);
check(
  'no real network client imported by this suite',
  selfImports.length > 0 && selfImports.every((i) => i.startsWith('node:')),
  selfImports.join(','),
);

// =============================================================================
// D. WHOLE-FRONTEND userInfo STORAGE WRITERS
// =============================================================================
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'miniprogram_npm') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(e)) out.push(p);
  }
  return out;
}
function offsetsOf(s) {
  const off = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') off.push(i + 1);
  return off;
}
function braceEnd(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}
const WRITE_RE = /wx\.setStorageSync\(\s*['"]userInfo['"]\s*,/;
const REST_EXCLUSION_RE = /\{\s*openid\s*:\s*[A-Za-z_$][\w$]*\s*,\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}/;

/** 解析 `= <expr>` 的声明（含对象 rest 解构形式）。 */
function declOf(s, off, fromAbs, name) {
  let lo = 0, hi = off.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (off[mid] <= fromAbs) lo = mid; else hi = mid - 1; }
  for (let i = lo - 1; i >= 0 && i > lo - 60; i--) {
    const st = off[i];
    const en = i + 1 < off.length ? off[i + 1] - 1 : s.length;
    const l = s.slice(st, en);
    const re = REST_EXCLUSION_RE;
    const rx = l.match(re);
    if (rx && rx[1] === name && new RegExp('(?:const|let|var)\\s*\\{').test(l)) {
      const eq = l.lastIndexOf('} =');
      return { line: i + 1, text: l.trim(), kind: 'rest_exclusion', absExprStart: st + eq + 3 };
    }
    const m = l.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/);
    if (m && m[1] === name) {
      return { line: i + 1, text: l.trim(), kind: 'binding', rest: m[2].trim(), absExprStart: st + m[0].length - m[2].length };
    }
  }
  return null;
}

/** 追踪表达式来源。返回 { verdict, sanitized } */
function traceExpr(file, s, absStart, depth, seen) {
  if (depth > 5) return { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized: false };
  let q = absStart;
  while (q < s.length && /\s/.test(s[q])) q++;
  const c = s[q];
  if (c === '{') {
    const end = braceEnd(s, q);
    const lit = s.slice(q, end + 1);
    if (/(^|[\s,{])openid\s*:/.test(lit)) return { verdict: 'OPENID_KEY_IN_PAYLOAD', sanitized: false, cacheUnsanitized: false };
    const spreads = [...lit.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((x) => x[1]);
    let net = false, sanitized = false, unresolved = 0, cacheUnsanitized = false;
    for (const sp of spreads) {
      const r = traceVar(file, s, q, sp, depth + 1, seen);
      if (r.verdict === 'OPENID_KEY_IN_PAYLOAD') return r;
      if (r.verdict === 'NETWORK_DERIVED') net = true;
      if (r.verdict === 'UNRESOLVED') unresolved++;
      if (r.sanitized) sanitized = true;
      if (r.cacheUnsanitized) cacheUnsanitized = true;
    }
    if (net) return { verdict: 'NETWORK_DERIVED', sanitized, cacheUnsanitized };
    if (unresolved > 0) return { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized };
    return { verdict: 'LITERAL_CLEAN', sanitized, cacheUnsanitized };
  }
  const idm = /^[A-Za-z_$][\w$]*/.exec(s.slice(q, q + 80));
  return idm ? traceVar(file, s, q, idm[0], depth + 1, seen) : { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized: false };
}

function traceVar(file, s, fromAbs, name, depth, seen) {
  if (depth > 5) return { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized: false };
  const key = file + '#' + name;
  if (seen.has(key)) return { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized: false };
  seen.add(key);
  const d = declOf(s, offsetsOf(s), fromAbs, name);
  if (!d) return { verdict: 'UNRESOLVED', sanitized: false, cacheUnsanitized: false };
  if (d.kind === 'rest_exclusion') {
    const up = traceExpr(file, s, d.absExprStart, depth + 1, seen);
    // openid 已在解构处被剥离 → 该贡献者不再属于「未消毒的缓存直通」
    return { verdict: up.verdict, sanitized: true, cacheUnsanitized: false };
  }
  const e = d.rest;
  if (/^wx\.getStorageSync\(/.test(e)) return { verdict: 'CACHE_PASSTHROUGH', sanitized: false, cacheUnsanitized: true };
  if (/^this\.data\b/.test(e)) return { verdict: 'PAGE_STATE_ECHO', sanitized: false, cacheUnsanitized: true };
  if (/^(?:res|response|resp|result)\s*\.\s*data\b/.test(e)) return { verdict: 'NETWORK_DERIVED', sanitized: false, cacheUnsanitized: false };
  return traceExpr(file, s, d.absExprStart, depth + 1, seen);
}

const writeSites = [];
for (const f of walk(FE_ROOT)) {
  const s = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const re = new RegExp(WRITE_RE.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const absStart = re.lastIndex;
    const off = offsetsOf(s);
    let ln = 0;
    for (let i = 0; i < off.length; i++) if (off[i] <= m.index) ln = i + 1;
    let p = absStart;
    while (p < s.length && /\s/.test(s[p])) p++;
    const exprText = s[p] === '{' ? s.slice(p, braceEnd(s, p) + 1) : (/^[A-Za-z_$][\w$]*/.exec(s.slice(p)) || [''])[0];
    const r = traceExpr(f, s, p, 0, new Set());
    writeSites.push({
      file: f.replace(ROOT, ''),
      line: ln,
      expr: exprText.replace(/\s+/g, ' ').slice(0, 60),
      verdict: r.verdict,
      sanitized: r.sanitized,
      cacheUnsanitized: r.cacheUnsanitized,
    });
  }
}

console.log('\n--- userInfo storage writer inventory ---');
for (const w of writeSites) {
  console.log(`  ${w.file}:${w.line}  [${w.verdict}${w.sanitized ? '+SANITIZED' : ''}${w.cacheUnsanitized ? '+LEGACY_CACHE_PASSTHROUGH' : ''}]  ${w.expr}`);
}

const generationPaths = writeSites.filter((w) => w.verdict === 'OPENID_KEY_IN_PAYLOAD');
const netWriters = writeSites.filter((w) => w.verdict === 'NETWORK_DERIVED');
// 遗留缓存直通 / 回显写入点：不生成 openid、不网络重引入，但会把设备中既存的旧 cached
// openid 原样写回。必须与上面两类严格区分，不得合并进任何一个 0 值字段。
const legacyPassthroughWriters = writeSites.filter((w) => w.cacheUnsanitized === true);

check('USERINFO_STORAGE_WRITE_SITES = 12', writeSites.length === 12, String(writeSites.length));
check(
  'no userInfo writer remains UNRESOLVED',
  writeSites.filter((w) => w.verdict === 'UNRESOLVED').length === 0,
  writeSites.filter((w) => w.verdict === 'UNRESOLVED').map((w) => `${w.file}:${w.line}`).join(','),
);

// =============================================================================
// D2. 三条互斥的冻结语义字段（strictly-qualified，禁止合并为过宽表述）
//   1) GENERATION              : payload 字面量自身构造 openid 键
//   2) NETWORK_REINTRODUCTION  : 网络响应派生写入点是否全部经过 openid 排除
//   3) LEGACY_CACHED_PASSTHROUGH: 未消毒的缓存直通/回显写入点（非 0，是既有事实）
// =============================================================================
check(
  'NETWORK_DERIVED_USERINFO_WRITERS = 1 (points.ts only; prevents vacuous truth above)',
  netWriters.length === 1 && /points\.ts$/.test(netWriters[0].file),
  netWriters.map((w) => `${w.file}:${w.line}`).join(','),
);
check(
  'USERINFO_OPENID_GENERATION_WRITE_PATHS = 0',
  generationPaths.length === 0,
  generationPaths.map((w) => `${w.file}:${w.line}`).join(','),
);
check(
  'USERINFO_OPENID_NETWORK_REINTRODUCTION_PATHS = 0',
  netWriters.every((w) => w.sanitized),
  `network-derived writers=${netWriters.length}; all sanitized=${netWriters.every((w) => w.sanitized)}`,
);
check(
  'LEGACY_CACHED_OPENID_PASSTHROUGH_PATHS_REMAIN = YES',
  legacyPassthroughWriters.length === 5,
  legacyPassthroughWriters.map((w) => `${w.file}:${w.line}`).join(','),
);
check(
  'legacy passthrough paths are excluded from GENERATION and NETWORK_REINTRODUCTION counts',
  legacyPassthroughWriters.every((w) => w.verdict === 'CACHE_PASSTHROUGH' || w.verdict === 'LITERAL_CLEAN')
    && generationPaths.every((w) => w.cacheUnsanitized === false)
    && netWriters.every((w) => w.cacheUnsanitized === false),
);

// =============================================================================
// SUMMARY
// =============================================================================
const passed = results.filter((r) => r.pass).length;
console.log('\n==== SECURITY P0-3 S2B POINTS USERINFO OPENID SANITIZATION ====');
console.log('POINTS_USERINFO_BLIND_MERGE_REMOVED=' + (src.includes('{ ...userInfo, ...userData }') ? 'NO' : 'YES'));
console.log('POINTS_CACHED_OPENID_PRESERVATION=' + (L_CACHED ? 'BLOCKED' : 'NOT_BLOCKED'));
console.log('POINTS_RESPONSE_OPENID_REINTRODUCTION=' + (L_RESPONSE ? 'BLOCKED' : 'NOT_BLOCKED'));
console.log('CLIENT_STORAGE_OPENID_NETWORK_REINTRODUCTION_BLOCKED=' + (L_CACHED && L_RESPONSE && !src.includes('{ ...userInfo, ...userData }') ? 'YES' : 'NO'));
console.log('USER_INFO_PHP_OPENID_FIELD_PROVEN=UNKNOWN');
console.log('USERINFO_OPENID_GENERATION_WRITE_PATHS=' + generationPaths.length);
console.log('USERINFO_OPENID_NETWORK_REINTRODUCTION_PATHS=' + (netWriters.every((w) => w.sanitized) ? 0 : netWriters.filter((w) => !w.sanitized).length));
console.log('LEGACY_CACHED_OPENID_PASSTHROUGH_PATHS_REMAIN=' + (legacyPassthroughWriters.length > 0 ? 'YES' : 'NO') + ' (' + legacyPassthroughWriters.length + ')');
console.log('GLOBAL_USERINFO_STORAGE_OPENID_ABSENCE_PROVEN=NO');
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
