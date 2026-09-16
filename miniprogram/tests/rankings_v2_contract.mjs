// miniprogram/tests/rankings_v2_contract.mjs
// P3-G Rankings Domain Contract —— 静态源码契约（含 Backend Authority 断言）。
//
// 断言五类：
//  1) Wrapper 层：utils/rankingsApi.ts 是 Rankings 域唯一接入层（收敛 + 错误分类 + 公开端点语义）。
//  2) Backend Authority：逐能力核对 workers/src 真实源码，V2 未实现的能力必须仍走 legacy 且显式标注。
//  3) 页面：pages/rankings/rankings.ts 无裸请求、无硬编码 host、无裸 storage。
//  4) 行为保全：hasMore / 追加分页 / PullDown / 触底 / 错误 toast / complete 语义逐字保留。
//  5) 作用域：index.ts 与其它的域页面未被本次迁移触碰；avatar 保持直绑（决策 2=A）。

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
  rankingsApi: read(join(MINI, 'utils', 'rankingsApi.ts')),
  page: read(join(MINI, 'pages', 'rankings', 'rankings.ts')),
  wxml: read(join(MINI, 'pages', 'rankings', 'rankings.wxml')),
  rankingsJs: read(join(MINI, 'pages', 'rankings', 'rankings.js')),
  index: read(join(MINI, 'pages', 'index', 'index.ts')),
  mine: read(join(MINI, 'pages', 'mine', 'mine.ts')),
  mall: read(join(MINI, 'pages', 'mall', 'mall.ts')),
  points: read(join(MINI, 'pages', 'points', 'points.ts')),
  beApp: read(join(WORKERS, 'app.ts')),
  beTree: readTreeStripped(WORKERS),
  miTree: readTreeStripped(MIGRATIONS),
  apiV2Tree: readTreeStripped(API_V2),
};

const WA = stripComments(F.rankingsApi);
const WA_FULL = F.rankingsApi; // Backend Authority 注释块必须真的写在 Legacy 方法头部，故不能去注释
const PAGE = stripComments(F.page);

let pass = 0;
const failures = [];
function check(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

// ============================== 1. Wrapper 收敛 ==============================

check(/export function listRankings/.test(F.rankingsApi), 'WRAPPER_EXISTS: rankingsApi.listRankings');
check(/export function classifyRankingsError/.test(F.rankingsApi), 'WRAPPER_EXISTS: rankingsApi.classifyRankingsError');
check(
  /'backend' \| 'network' \| 'unauthorized' \| 'expired' \| 'denied'/.test(F.rankingsApi),
  'ERROR_KINDS: 五类错误分类齐备',
);
check(/import \{ buildHeaders, toApiError \} from '\.\/transport'/.test(F.rankingsApi), 'TRANSPORT_REUSE: 复用唯一 Header Builder 与 Error Pipeline');
check(/toApiError\(0, null, true/.test(WA), 'TOAPIERROR_USED: 网络失败经 toApiError 归一');

// ---- 公开端点语义（P3-G 最重要约束：不得被令牌污染） ----
check(!/getLegacyToken|getV2Token/.test(WA), 'PUBLIC_NO_TOKEN_IMPORT: wrapper 不读取任何令牌');
check(!/Authorization/.test(WA), 'PUBLIC_NO_AUTH_HEADER: wrapper 不产生 Authorization 头');
check(!/teamScoped/.test(WA), 'PUBLIC_NO_TEAM_HEADER: wrapper 不注入 X-Team-Id');
check(!/from '\.\/session'/.test(WA), 'PUBLIC_NO_SESSION_IMPORT: wrapper 不依赖 Session Manager');
check(!/from '\.\/request'/.test(WA), 'PUBLIC_NOT_VIA_JHZYREQUEST: 刻意不走 utils/request（其令牌过期闸门会把游客踢到登录页）');
check(/buildHeaders\(\)/.test(WA), 'PUBLIC_HEADER_BUILDER_EMPTY_OPTS: buildHeaders 以空 opts 调用');
check(!/getStorageSync\(|setStorageSync\(/.test(WA), 'NO_RAW_STORAGE_WRAPPER: wrapper 不裸碰 storage');
check(!/access_token'\)/.test(WA), 'NO_RAW_TOKEN_KEY_WRAPPER: wrapper 不出现裸 token key');
check(!/ensureV2Session/.test(WA), 'NO_V2_SESSION_BOOTSTRAP: wrapper 不做 V2 会话引导');

// 跨域：不得引入任何其它业务域 wrapper
for (const forbidden of ['activityApi', 'adminApi', 'profileApi', 'teamApi', 'feedbackApi', 'pointsApi', 'mallApi', 'analyticsApi']) {
  check(!WA.includes(forbidden), `NO_CROSS_DOMAIN_${forbidden.toUpperCase()}: wrapper 不引入无关业务域 wrapper`);
}

// ============================== 2. Backend Authority ==============================

const LEGACY_HEADER = 'Backend Authority:\n * NO V2 IMPLEMENTATION\n * Keep legacy endpoint until V2 backend exists.';
const fnAt = WA_FULL.indexOf('export function listRankings');
const headerAt = WA_FULL.lastIndexOf(LEGACY_HEADER, fnAt);
check(fnAt > 0 && headerAt > 0 && fnAt - headerAt < 1400, 'BA_HEADER_ON_LEGACY_FN: listRankings 头部写死三行 Backend Authority 注释');
check(/NO V2 IMPLEMENTATION/.test(F.rankingsApi), 'BA_NO_V2_MARKER: 文件内显式标注 NO V2 IMPLEMENTATION');
check(/rankings\.php/.test(WA), 'LEGACY_ENDPOINT_KEPT: 底层仍为 legacy rankings.php');

// —— 后端源码证据：V2 侧确实不存在 Rankings ——
check(!/rankings/.test(F.beApp), 'BE_APP_NO_MOUNT: workers/src/app.ts 挂载清单无 rankings');
check(!existsSync(join(WORKERS, 'routes', 'rankings.ts')), 'BE_NO_ROUTE_FILE: 无 routes/rankings.ts');
check(!/\brank(ing|ings)?\b|leaderboard/i.test(F.beTree), 'BE_TREE_NO_CONCEPT: workers/src 全树（去注释）无 rank/leaderboard 概念');
check(!/\brank(ing|ings)?\b|leaderboard/i.test(F.miTree), 'BE_MIGRATIONS_NO_TABLE: 42 个 migration 无排行榜表');
check(!/\brank(ing|ings)?\b|leaderboard/i.test(F.apiV2Tree), 'API_V2_NO_PLAN: api-v2（ThinkPHP 骨架）亦无 rankings 规划');
check(!/\/api\/v2\//.test(WA), 'NO_FAKE_V2_URL: wrapper 未伪造任何 /api/v2 路径');
check(!/resolveV2Base|apiEnv/.test(WA), 'NO_V2_BASE: wrapper 不引入 V2 base 解析');

// —— 近似物不可复用（analytics/overview 仅聚合数字）——
check(!/analytics/.test(WA), 'ANALYTICS_NOT_BORROWED: 未借用 analytics/overview 冒充排行榜');
check(existsSync(join(WORKERS, 'routes', 'analytics.ts')), 'ANALYTICS_ROUTE_EXISTS: analytics 路由存在但语义不符（契约留证）');

// ============================== 3. 页面纯净 ==============================

check(/import \{ listRankings, classifyRankingsError \} from '\.\.\/\.\.\/utils\/rankingsApi'/.test(F.page), 'PAGE_IMPORTS_WRAPPER: 页面经唯一 wrapper 取数');
check(!/wx\.request\(/.test(PAGE), 'NO_RAW_WXREQUEST_PAGE: 页面无裸 wx.request');
check(!/api\.jhzyfw\.com/.test(PAGE), 'NO_HARDCODED_HOST_PAGE: 页面无硬编码 API host');
check(!/getStorageSync\(|setStorageSync\(/.test(PAGE), 'NO_RAW_STORAGE_PAGE: 页面无裸 storage 读写');
check(!/access_token/.test(PAGE), 'NO_TOKEN_PAGE: 页面不涉及令牌');

// ============================== 4. 行为保全 ==============================

check(/hasMore: rankingsData\.length === this\.data\.limit/.test(PAGE), 'BEHAVIOR_HAS_MORE: hasMore 判定 = 返回条数 === limit');
check(/reset \? rankingsData : \[\.\.\.this\.data\.rankings, \.\.\.rankingsData\]/.test(PAGE), 'BEHAVIOR_APPEND: reset 清空 / 非 reset 追加');
check(/allRankings/.test(PAGE) && /rankings: allRankings/.test(PAGE), 'BEHAVIOR_WRITE_BACK: setData(rankings)');
check(/page: currentPage \+ 1/.test(PAGE), 'BEHAVIOR_PAGE_INC: page = currentPage + 1');
check(/const currentPage = reset \? 1 : this\.data\.page/.test(PAGE), 'BEHAVIOR_PAGE_SOURCE: 页码取值语义保留');
check(/this\.setData\(\{ loading: true, page: 1, hasMore: true \}\)/.test(PAGE), 'BEHAVIOR_RESET_STATE: reset 分支状态重置');
check(/this\.setData\(\{ isMoreLoading: true \}\)/.test(PAGE), 'BEHAVIOR_MORE_STATE: 非 reset 分支静默加载');
check(/this\.data\.isMoreLoading \|\| !this\.data\.hasMore \|\| this\.data\.loading/.test(PAGE), 'BEHAVIOR_LOADMORE_GUARD: 触底守卫条件保留');
check(/this\.loadRankings\(true\)/.test(PAGE) && /this\.loadRankings\(false\)/.test(PAGE), 'BEHAVIOR_BOTH_MODES: 刷新(true) 与触底(false) 两条路径保留');
check(/wx\.stopPullDownRefresh\(\)/.test(PAGE), 'BEHAVIOR_PULLDOWN_STOP: 下拉刷新关闭动画保留');
check(/loadRankings\(true\)\.finally\(/.test(PAGE), 'BEHAVIOR_FINALLY_CHAIN: 下拉刷新依赖 finally（Promise 不得 reject）');
check(/async loadRankings\(reset = false\): Promise<void>/.test(PAGE), 'BEHAVIOR_PROMISE_VOID: 返回 Promise<void> 且从不抛出');
check(/title: '网络请求失败'/.test(PAGE), 'BEHAVIOR_TOAST: 失败 toast 文案保留');
check(/console\.error\('加载排行榜失败:'/.test(PAGE), 'BEHAVIOR_LOG: 失败日志保留');
check(/loading: false,\s*\n\s*isMoreLoading: false,/.test(PAGE), 'BEHAVIOR_COMPLETE: finally 中双标志位复位（原 complete 语义）');
check(/limit: 20/.test(PAGE), 'BEHAVIOR_LIMIT_20: 每页条数 20 保留');
check(/loading: true, \/\/ 全屏加载/.test(F.page), 'BEHAVIOR_INIT_LOADING: 首屏全屏 loading（含原注释）保留');
check(/console\.log\('排行榜页面加载'\)/.test(PAGE), 'BEHAVIOR_ONLOAD_LOG: onLoad 日志保留');
check(/console\.log\('触底加载更多，当前页：', this\.data\.page\)/.test(PAGE), 'BEHAVIOR_LOADMORE_LOG: 触底日志保留');
check(/wx\.vibrateShort\(\)/.test(PAGE), 'BEHAVIOR_VIBRATE: 详情弹窗震动反馈保留');
check(/志愿者ID: \$\{volunteer\.volunteer_id\}\\n总积分: \$\{volunteer\.total_points\}\\n服务时长: \$\{volunteer\.total_hours\}小时/.test(PAGE), 'BEHAVIOR_MODAL_TEXT: 详情弹窗文案逐字保留');
check(/if \(!volunteer\) return/.test(PAGE), 'BEHAVIOR_MODAL_GUARD: 空行守卫保留');

// ============================== 5. avatar 决策 2=A：保持现状 ==============================

check(!/normalizeAvatar|normalizeAvatarUrl|头像归一/.test(WA), 'AVATAR_NOT_NORMALIZED_WRAPPER: wrapper 不做头像 URL 归一');
check(!/normalizeAvatar/.test(PAGE), 'AVATAR_NOT_NORMALIZED_PAGE: 页面不做头像 URL 归一');
check(/\{\{item\.avatar\}\}/.test(F.wxml), 'AVATAR_DIRECT_BIND: wxml 仍直绑 {{item.avatar}}');
check(/\{\{rankings\[0\]\.avatar\}\}/.test(F.wxml), 'AVATAR_PODIUM_BIND: 前三名头像绑定未变');

// ============================== 6. 作用域边界 ==============================

check(/url: '\/pages\/rankings\/rankings'/.test(F.index), 'SCOPE_INDEX_ENTRY_KEPT: 首页入口未变');
check(!/rankingsApi/.test(F.index), 'SCOPE_INDEX_UNTOUCHED: index.ts 未被本次迁移触碰');
check(!/rankingsApi/.test(F.mine), 'SCOPE_MINE_UNTOUCHED: mine.ts 未引入 rankingsApi');
check(!/rankingsApi/.test(F.mall), 'SCOPE_MALL_UNTOUCHED: mall.ts 未引入 rankingsApi');
check(!/rankingsApi/.test(F.points), 'SCOPE_POINTS_UNTOUCHED: points.ts 未引入 rankingsApi');
check(!/rankings\.php/.test(F.index), 'SCOPE_NO_LEAK: 首页未重新引入 rankings.php（P0-C 已移除非 bystander 依赖）');
check(!/rankings\.php/.test(PAGE), 'SCOPE_PAGE_NO_ENDPOINT_LITERAL: 页面不再出现裸端点文件名');

// ============================== 汇总 ==============================

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ Rankings Contract FAILED — ${failures.length} / ${total} assertion(s) failed:\n`);
  for (const f of failures) console.error('  - ' + f);
  console.error('');
  process.exit(1);
}
console.log(`✅ Rankings Contract PASSED — ${pass} / ${total} assertions`);
