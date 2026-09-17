// miniprogram/tests/quick_action_v2_contract.mjs
// P3-H Quick Action Domain Contract —— 静态源码契约（含 Backend Authority 断言）。
//
// 断言五类：
//  1) Wrapper 层：utils/quickActionApi.ts 是 Quick Action 域唯一接入层（收敛 + 错误分类 + 令牌经 Session）。
//  2) Backend Authority：逐能力核对 workers/src 真实源码，V2 未实现的能力必须仍走 legacy 且显式标注。
//  3) 页面：pages/quick-action/quick-action.ts 无裸请求、无硬编码 host、无裸 token 直连 API（登录检查除外）。
//  4) 行为保全：登录检查 / 第三方地图 / 表单校验 / hasMore / 触底 / 下拉 / 成功 modal / code===0 契约逐字保留。
//  5) 作用域：index.ts / admin / 其它域页面未被本次迁移触碰；session.ts / transport.ts / fileApi.ts 未被改动。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const MINI = join(ROOT, 'miniprogram');
const WORKERS = join(ROOT, 'workers', 'src');
const MIGRATIONS = join(ROOT, 'workers', 'migrations');
const API_V2 = join(ROOT, 'api-v2');

const read = (p) => readFileSync(p, 'utf8');

/** 去掉行注释与块注释，避免把注释里的说明文字误判成实现。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 递归读取目录全部文本（去注释后用于「不存在」的负向断言）。 */
function readTreeStripped(dir) {
  let out = '';
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += readTreeStripped(p);
    else out += stripComments(read(p));
  }
  return out;
}

const F = {
  quickActionApi: read(join(MINI, 'utils', 'quickActionApi.ts')),
  page: read(join(MINI, 'pages', 'quick-action', 'quick-action.ts')),
  index: read(join(MINI, 'pages', 'index', 'index.ts')),
  mine: read(join(MINI, 'pages', 'mine', 'mine.ts')),
  mall: read(join(MINI, 'pages', 'mall', 'mall.ts')),
  points: read(join(MINI, 'pages', 'points', 'points.ts')),
  adminPoints: read(join(MINI, 'pages', 'admin', 'points-manager', 'index.ts')),
  beApp: read(join(WORKERS, 'app.ts')),
  beTree: readTreeStripped(WORKERS),
  miTree: readTreeStripped(MIGRATIONS),
  apiV2Tree: readTreeStripped(API_V2),
};

const WA = stripComments(F.quickActionApi);
const WA_FULL = F.quickActionApi; // Backend Authority 注释块必须真的写在 Legacy 方法头部，故不能去注释
const PAGE = stripComments(F.page);

let pass = 0;
const failures = [];
function check(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

// ============================== 1. Wrapper 收敛 ==============================

check(/export (async )?function getQuickStats/.test(F.quickActionApi), 'WRAPPER_EXISTS: quickActionApi.getQuickStats');
check(/export async function listQuickActions/.test(F.quickActionApi), 'WRAPPER_EXISTS: quickActionApi.listQuickActions');
check(/export async function uploadQuickActionImage/.test(F.quickActionApi), 'WRAPPER_EXISTS: quickActionApi.uploadQuickActionImage');
check(/export async function submitQuickAction/.test(F.quickActionApi), 'WRAPPER_EXISTS: quickActionApi.submitQuickAction');
check(/export function classifyQuickActionError/.test(F.quickActionApi), 'WRAPPER_EXISTS: quickActionApi.classifyQuickActionError');
check(
  /'backend' \| 'network' \| 'unauthorized' \| 'expired' \| 'denied'/.test(F.quickActionApi),
  'ERROR_KINDS: 五类错误分类齐备',
);
check(/import \{ getLegacyToken \} from '\.\/session'/.test(F.quickActionApi), 'SESSION_REUSE: 令牌读取经 Session Manager（决策 3=A：getLegacyToken）');
check(/import \{ buildHeaders, toApiError, ApiError \} from '\.\/transport'/.test(F.quickActionApi), 'TRANSPORT_REUSE: 复用唯一 Header Builder 与 Error Pipeline');
check(/import jhzyRequest from '\.\/request'/.test(F.quickActionApi), 'LEGACY_TRANSPORT_REUSE: legacy 路径复用 utils/request');
check(/getLegacyToken\(\)/.test(WA), 'TOKEN_USED: wrapper 实际读取 legacy 令牌');

check(!/wx\.request\(/.test(WA), 'NO_RAW_WXREQUEST_WRAPPER: wrapper 不裸调 wx.request');
check(!/getStorageSync\(|setStorageSync\(/.test(WA), 'NO_RAW_STORAGE_WRAPPER: wrapper 不裸碰 storage');
check(!/access_token'\)/.test(WA), 'NO_RAW_TOKEN_KEY_WRAPPER: wrapper 不出现裸 token key');
check(!/fileApi/.test(WA), 'NO_FILEAPI_IMPORT: wrapper 不引入 fileApi（仍走 legacy 上传端点）');

// 跨域：不得引入任何其它业务域 wrapper
for (const forbidden of ['activityApi', 'adminApi', 'profileApi', 'teamApi', 'feedbackApi', 'pointsApi', 'rankingsApi', 'mallApi', 'analyticsApi']) {
  check(!WA.includes(forbidden), `NO_CROSS_DOMAIN_${forbidden.toUpperCase()}: wrapper 不引入无关业务域 wrapper`);
}

// upload 路径：wx.uploadFile + multipart（字段名 file + formData.type）逐字保留
check(/wx\.uploadFile\(/.test(WA), 'UPLOAD_WX_UPLOADFILE: 图片上传走 wx.uploadFile');
check(/name: 'file'/.test(WA), 'UPLOAD_FIELD_FILE: multipart 字段名仍为 file');
check(/formData: \{ type: 'quick_action' \}/.test(WA), 'UPLOAD_FORM_TYPE: formData.type 保持 quick_action');
check(/buildHeaders\(\{ token, contentType: '' \}\)/.test(WA), 'UPLOAD_HEADER_BUILDER: Header 经统一 buildHeaders（不含 Content-Type，保 multipart boundary）');

// ============================== 2. code===0 契约（成功判定逐字保留） ==============================

check(/if \(!res \|\| res\.code !== 0\)/.test(WA), 'CONTRACT_CODE0_STATS_LIST_SUBMIT: stats/list/submit 均以 code===0 为成功');
check(/raw\.code !== 0 \|\| !raw\.data \|\| !raw\.data\.full_url/.test(WA), 'CONTRACT_CODE0_UPLOAD: upload 以 code===0 且 data.full_url 存在为成功');

// ============================== 3. Backend Authority ==============================

const LEGACY_HEADER = 'Backend Authority:\n * NO V2 IMPLEMENTATION\n * Keep legacy endpoint until V2 backend exists.';
for (const fn of [
  'export async function getQuickStats',
  'export async function listQuickActions',
  'export async function uploadQuickActionImage',
  'export async function submitQuickAction',
]) {
  const fnAt = WA_FULL.indexOf(fn);
  const headerAt = WA_FULL.lastIndexOf(LEGACY_HEADER, fnAt);
  check(fnAt > 0 && headerAt > 0 && fnAt - headerAt < 1800, `BA_HEADER_ON_${fn.replace(/[^a-zA-Z]/g, '_')}`);
}

check(/NO V2 IMPLEMENTATION/.test(F.quickActionApi), 'BA_NO_V2_MARKER: 文件内显式标注 NO V2 IMPLEMENTATION');
check(/quick_actions\.php/.test(WA), 'LEGACY_ENDPOINT_STATS_LIST_SUBMIT: 底层仍为 legacy quick_actions.php');
check(/upload_quick_action\.php/.test(WA), 'LEGACY_ENDPOINT_UPLOAD: 底层仍为 legacy upload_quick_action.php');
check(!/\/api\/v2\//.test(WA), 'NO_FAKE_V2_URL: wrapper 未伪造任何 /api/v2 路径');

// —— 后端源码证据：V2 侧确实不存在 Quick Action ——
check(!/quick_action|quickAction/i.test(F.beApp), 'BE_APP_NO_MOUNT: workers/src/app.ts 挂载清单无 quick');
check(!existsSync(join(WORKERS, 'routes', 'quick-action.ts')) && !existsSync(join(WORKERS, 'routes', 'quick.ts')), 'BE_NO_ROUTE_FILE: 无 routes/quick 路由文件');
check(!/quick_action|quickAction/i.test(F.beTree), 'BE_TREE_NO_CONCEPT: workers/src 全树（去注释）无 quick_action 概念');
check(!/quick_action|quickAction/i.test(F.miTree), 'BE_MIGRATIONS_NO_TABLE: 42 个 migration 无随手公益表');
check(!/quick_action|quickAction/i.test(F.apiV2Tree), 'API_V2_NO_PLAN: api-v2（ThinkPHP 骨架）亦无 quick 规划');

// ============================== 4. 页面纯净 ==============================

check(
  /import \{ getQuickStats, listQuickActions, uploadQuickActionImage, submitQuickAction \} from '\.\.\/\.\.\/utils\/quickActionApi'/.test(F.page),
  'PAGE_IMPORTS_WRAPPER: 页面经唯一 wrapper 取数',
);
check(/import type \{ QuickActionRecord \} from '\.\.\/\.\.\/utils\/quickActionApi'/.test(F.page), 'PAGE_IMPORTS_TYPE: 页面引入记录类型');
check(!/api\.jhzyfw\.com/.test(PAGE), 'NO_HARDCODED_HOST_PAGE: 页面无硬编码 API host');
check(!/quick_actions\.php/.test(PAGE), 'NO_ENDPOINT_LITERAL_PAGE: 页面不再出现 quick_actions.php 字面量');
check(!/upload_quick_action\.php/.test(PAGE), 'NO_UPLOAD_ENDPOINT_LITERAL_PAGE: 页面不再出现 upload_quick_action.php 字面量');
check(!/wx\.request\(\{\s*url: `https:\/\/api\.jhzyfw/.test(PAGE), 'NO_RAW_API_REQUEST_PAGE: 页面无直连 api.jhzyfw.com 的 wx.request');

// ============================== 5. 行为保全 ==============================

// 登录检查（决策 3=A：保持直读 access_token / userInfo / isLoggedIn，不改 session.ts）
check(/getStorageSync\('access_token'\)/.test(PAGE), 'LOGIN_CHECK_TOKEN: 登录检查仍直读 access_token');
check(/getStorageSync\('userInfo'\)/.test(PAGE), 'LOGIN_CHECK_USERINFO: 登录检查仍直读 userInfo');
check(/getStorageSync\('isLoggedIn'\)/.test(PAGE), 'LOGIN_CHECK_FLAG: 登录检查仍直读 isLoggedIn');
check(/showLoginRegisterModal\(/.test(PAGE), 'LOGIN_MODAL: 未登录仍弹统一登录 modal');
check(/if \(!this\.data\.isLoggedIn \|\| !this\.data\.userInfo\) return;/.test(PAGE), 'LOGIN_GUARD: loadTodayPoints / loadQuickRecords 保留登录守门');

// 第三方地图逆地理编码（决策 2=A：保持第三方 wx.request 原样）
check(/apis\.map\.qq\.com/.test(PAGE), 'MAP_THIRD_PARTY: 腾讯地图逆编码保留第三方调用');
check(/逆地理编码失败/.test(PAGE), 'MAP_GEOCODE_FAIL_LOG: 逆编码失败日志保留');
check(/wx\.request\(\{\s*url: `https:\/\/apis\.map\.qq\.com/.test(PAGE), 'MAP_RAW_REQUEST: 地图调用仍为裸 wx.request（决策 2=A 不收敛）');

// 表单校验逐字保留
check(/请上传照片凭证/.test(PAGE), 'VALIDATE_PHOTO: 照片校验文案保留');
check(/请至少输入10个字的描述/.test(PAGE), 'VALIDATE_DESC: 描述≥10字校验保留');
check(/请获取或输入位置信息/.test(PAGE), 'VALIDATE_LOCATION: 位置校验保留');

// 积分计算 / hasMore / 分页 / 触底 / 下拉
check(/progressPercent: percent > 100 \? 100 : Math\.round\(percent\)/.test(PAGE), 'BEHAVIOR_PROGRESS: 进度百分比计算逐字保留');
check(/hasMore: hasMore,/.test(PAGE), 'BEHAVIOR_HASMORE: hasMore 由 wrapper 返回写入');
check(/const nextPage = this\.data\.page \+ 1;/.test(PAGE), 'BEHAVIOR_NEXT_PAGE: 下一页 = page + 1');
check(/this\.loadQuickRecords\(nextPage, true\);/.test(PAGE), 'BEHAVIOR_LOADMORE_CALL: 触底加载更多保留');
check(/this\.loadMoreRecords\(\);/.test(PAGE), 'BEHAVIOR_REACH_BOTTOM: onReachBottom 保留');
check(/this\.loadTodayPoints\(\);/.test(PAGE), 'BEHAVIOR_PULLDOWN_TODAY: 下拉刷新今日积分保留');
check(/this\.loadQuickRecords\(\);/.test(PAGE), 'BEHAVIOR_PULLDOWN_LIST: 下拉刷新列表保留');
check(/wx\.stopPullDownRefresh\(\)/.test(PAGE), 'BEHAVIOR_PULLDOWN_STOP: 下拉刷新关闭动画保留');
check(/formatTime\(timeString/.test(PAGE), 'BEHAVIOR_FORMAT_TIME: 时间格式化保留');

// 图片上传语义（full_url 透传）
check(/images: imageUrl,/.test(PAGE), 'BEHAVIOR_IMAGE_URL: 提交 body 的 images 为上传返回的 full_url');

// 提交成功 modal 文案逐字保留
check(/记录提交成功/.test(PAGE), 'BEHAVIOR_SUCCESS_TITLE: 成功 modal 标题保留');
check(/继续做公益/.test(PAGE), 'BEHAVIOR_SUCCESS_CONFIRM: 成功 modal 确认按钮文案保留');
check(/审核通过后将获得/.test(PAGE), 'BEHAVIOR_SUCCESS_POINTS: 成功 modal 积分提示保留');

// 成功判定映射（wrapper 内 status→text 逐字保留）
check(/status_text: record\.status === 1 \? '已通过' : record\.status === 0 \? '审核中' : '已拒绝'/.test(WA), 'BEHAVIOR_STATUS_TEXT: 记录 status→展示文本映射逐字保留');

// ============================== 6. 作用域边界 ==============================

check(/url: '\/pages\/quick-action\/quick-action'/.test(F.index), 'SCOPE_INDEX_ENTRY_KEPT: 首页入口未变');
check(!/quickActionApi/.test(F.index), 'SCOPE_INDEX_UNTOUCHED: index.ts 未引入 quickActionApi');
// 注意：index.ts 行 404 的 quick_actions.php 是【公益故事区块】（决策 1=A 明确排除，属授权范围外且本阶段未改动）；
// 故此处仅断言 P3-H 未向 index.ts 注入新的 quickActionApi wrapper，不以「首页出现 quick_actions.php」误判。
check(!/quickActionApi/.test(F.index), 'SCOPE_INDEX_NO_NEW_WRAPPER: index.ts 未被 P3-H 注入统一 wrapper（公益故事区块保持原状）');
check(!/quickActionApi/.test(F.mine), 'SCOPE_MINE_UNTOUCHED: mine.ts 未引入 quickActionApi');
check(!/quickActionApi/.test(F.mall), 'SCOPE_MALL_UNTOUCHED: mall.ts 未引入 quickActionApi');
check(!/quickActionApi/.test(F.points), 'SCOPE_POINTS_UNTOUCHED: points.ts 未引入 quickActionApi');
check(!/quickActionApi/.test(F.adminPoints), 'SCOPE_ADMIN_UNTOUCHED: admin 页面未引入 quickActionApi');

// ============================== 汇总 ==============================

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ Quick Action Contract FAILED — ${failures.length} / ${total} assertion(s) failed:\n`);
  for (const f of failures) console.error('  - ' + f);
  console.error('');
  process.exit(1);
}
console.log(`✅ Quick Action Contract PASSED — ${pass} / ${total} assertions`);
