// miniprogram/tests/points_v2_contract.mjs
// P3-F Points Domain Contract —— 静态源码契约（含 Backend Authority 断言）。
//
// 断言三类：
//  1) Wrapper 层：utils/pointsApi.ts 是 Points 域唯一接入层（收敛 + 错误分类 + openid 安全约束）。
//  2) Backend Authority：逐能力核对 workers/src 真实源码，V2 未实现的能力必须仍走 legacy 且显式标注。
//  3) 页面 / 作用域：pages/points/points.ts 无裸请求、无裸令牌读取；其它域页面【未】被本次迁移触碰。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const MINI = join(ROOT, 'miniprogram');
const WORKERS = join(ROOT, 'workers', 'src');

const read = (p) => readFileSync(p, 'utf8');

/** 去掉行注释与块注释，避免把注释里的说明文字误判成实现。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 递归读取目录全部文本（用于后端不存在的负向断言）。 */
function readTree(dir) {
  let out = '';
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += readTree(p);
    else out += read(p);
  }
  return out;
}

const F = {
  pointsApi: read(join(MINI, 'utils', 'pointsApi.ts')),
  page: read(join(MINI, 'pages', 'points', 'points.ts')),
  wxml: read(join(MINI, 'pages', 'points', 'points.wxml')),
  mall: read(join(MINI, 'pages', 'mall', 'mall.ts')),
  goodsDetail: read(join(MINI, 'pages', 'goods-detail', 'goods-detail.ts')),
  mine: read(join(MINI, 'pages', 'mine', 'mine.ts')),
  adminPoints: read(join(MINI, 'pages', 'admin', 'points-manager', 'index.ts')),
  bePointsRoute: read(join(WORKERS, 'routes', 'points.ts')),
  beApp: read(join(WORKERS, 'app.ts')),
  beTree: readTree(WORKERS),
};

const WA = stripComments(F.pointsApi);
const WA_FULL = F.pointsApi; // 需要检查 Backend Authority 注释块是否真的写在 Legacy 方法头部
const PAGE = stripComments(F.page);

let pass = 0;
const failures = [];
function check(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}

// ============================== 1. Wrapper 收敛 ==============================

check(/export (async )?function getPointsSummary/.test(F.pointsApi), 'WRAPPER_EXISTS: pointsApi.getPointsSummary');
check(/export function getPointsTransactions/.test(F.pointsApi), 'WRAPPER_EXISTS: pointsApi.getPointsTransactions');
check(/export function classifyPointsError/.test(F.pointsApi), 'WRAPPER_EXISTS: pointsApi.classifyPointsError');
check(/export function readLoginSnapshot/.test(F.pointsApi), 'WRAPPER_EXISTS: pointsApi.readLoginSnapshot');
check(/export function formatUnits/.test(F.pointsApi), 'WRAPPER_EXISTS: pointsApi.formatUnits');

check(/'backend' \| 'network' \| 'unauthorized' \| 'expired' \| 'denied'/.test(F.pointsApi), 'ERROR_KINDS: 五类错误分类齐备');
check(/import \{ send/.test(F.pointsApi), 'TRANSPORT_REUSE: V2 路径复用 transport.send');
check(/from '\.\/request'/.test(F.pointsApi), 'LEGACY_TRANSPORT_REUSE: legacy 路径复用 utils/request');
check(/from '\.\/session'/.test(F.pointsApi), 'SESSION_REUSE: 会话读取经 Session Manager');

check(!/wx\.request\(/.test(WA), 'NO_RAW_WXREQUEST_WRAPPER: wrapper 不裸调 wx.request');
check(!/getStorageSync\(|setStorageSync\(/.test(WA), 'NO_RAW_STORAGE_WRAPPER: wrapper 不裸碰 storage');
check(!/access_token'\)/.test(WA), 'NO_RAW_TOKEN_KEY_WRAPPER: wrapper 不出现裸 token key');

// 其它业务域 wrapper 一律不得被引入（formatPoints 透传除外，理由见下）
for (const forbidden of ['activityApi', 'adminApi', 'profileApi', 'teamApi', 'feedbackApi']) {
  check(!WA.includes(forbidden), 'NO_CROSS_DOMAIN_' + forbidden.toUpperCase() + ': wrapper 不引入无关业务域 wrapper');
}
check(/import \{ formatPoints \} from '\.\/mallApi'/.test(F.pointsApi), 'FORMATTER_PASSTHROUGH: 展示口径透传自 mallApi.formatPoints（唯一实现）');
check(/return formatPoints\(units\)/.test(WA), 'FORMATTER_DELEGATES: formatUnits 仅做透传，未实现第二份口径');

// ============================== 2. Backend Authority：Legacy 能力必须显式标注 ==============================

const LEGACY_HEADER = 'Backend Authority:\n * NO V2 IMPLEMENTATION\n * Keep legacy endpoint until V2 backend exists.';
const summaryFnAt = WA_FULL.indexOf('export async function getPointsSummary');
const headerAt = WA_FULL.lastIndexOf(LEGACY_HEADER, summaryFnAt);
check(
  summaryFnAt > 0 && headerAt > 0 && summaryFnAt - headerAt < 400,
  'BA_LEGACY_HEADER: getPointsSummary 函数头写明 NO V2 IMPLEMENTATION',
);

// （1）积分概况 + 志愿者等级 → legacy user_info.php
check(/url: 'user_info\.php'/.test(WA), 'BA_LEVEL_LEGACY_ENDPOINT: 等级/进度唯一来源仍是 legacy user_info.php');
check(/res\.code !== 0 && res\.code !== 200/.test(WA), 'BA_LEGACY_CONTRACT: 沿用该端点 code===0/200 成功契约');
check(/omitOpenid\(/.test(WA), 'P03_S2B_OPENID_STRIPPED: openid 剔除集中在 wrapper');
check(/omitOpenid\(getUserInfo\(\)\)/.test(WA), 'P03_S2B_CACHED_SOURCE: 本地缓存侧也剥离 openid');
check(/omitOpenid\(userData\)/.test(WA), 'P03_S2B_RESPONSE_SOURCE: 响应侧也剥离 openid');

// 等级字段被完整保留（决策 2=A：不得删除等级显示）
check(/level: toStringValue\(/.test(WA), 'LEVEL_PRESERVED: wrapper 返回 level');
check(/next_level_points:/.test(WA), 'NEXT_LEVEL_PRESERVED: wrapper 返回 next_level_points');
check(/progress: toNumber\(/.test(WA), 'PROGRESS_PRESERVED: wrapper 返回 progress');
check(/pointsData\.level/.test(F.wxml), 'LEVEL_RENDERED: wxml 仍渲染等级');
check(/pointsData\.next_level_points/.test(F.wxml), 'NEXT_LEVEL_RENDERED: wxml 仍渲染晋升阈值');
check(/pointsData\.progress/.test(F.wxml), 'PROGRESS_RENDERED: wxml 仍渲染进度条');

// （2）积分流水 → V2 已实现
check(/\/points\/transactions\?page=/.test(F.pointsApi), 'BA_TX_V2_ENDPOINT: 流水走 GET /api/v2/points/transactions');
check(/page_size=\$\{pageSize\}/.test(F.pointsApi), 'BA_TX_PAGINATION: 分页参数 page/page_size 透传后端');
check(!/user_id=|team_id=/.test(F.pointsApi), 'BA_TX_SELF_ONLY: 不提交 user_id / team_id（SELF scope）');

// ============================== 3. Backend Authority：服务端真实证据 ==============================

check(/v2\.route\('\/points', points\)/.test(F.beApp), 'BE_MOUNT: workers/src/app.ts 挂载 /points');
check(/points\.get\('\/account'/.test(F.bePointsRoute), 'BE_ACCOUNT_EXISTS: GET /api/v2/points/account 已实现');
check(/points\.get\('\/transactions'/.test(F.bePointsRoute), 'BE_TRANSACTIONS_EXISTS: GET /api/v2/points/transactions 已实现');
check(/points\.account\.read/.test(F.bePointsRoute), 'BE_PERMISSION: 端点受 points.account.read 保护');

const pointsMethods = F.bePointsRoute.match(/points\.(get|post|put|patch|delete)\(/g) || [];
check(pointsMethods.length === 2 && pointsMethods.every((m) => m.includes('get')), 'BE_POINTS_READONLY: /points 路由器仅 2 个 GET，无写端点');

check(!/points\.(post|put|patch|delete)\(/.test(F.bePointsRoute), 'NO_V2_EXCHANGE: POST /points/exchange 不存在（NO V2 IMPLEMENTATION）');
check(!/\/points\/history/.test(F.bePointsRoute), 'NO_V2_HISTORY: GET /points/history 不存在（等价能力为 /transactions）');
check(!/reward/i.test(F.beTree), 'NO_V2_REWARDS: workers/src 全仓无 reward 实现 → GET /rewards、POST /rewards/exchange 均为 NO V2 IMPLEMENTATION');
check(!/next_level|level_name/i.test(F.beTree), 'NO_V2_LEVEL: workers/src 无 next_level / level_name → 等级晋升在 V2 无等价能力');

// ============================== 4. 数值口径（决策 3=A：本阶段禁止换算） ==============================

// 只针对「积分单位」的乘除换算做负向断言（排除时间戳 *1000 等无关算术）
const UNIT_CONVERSION = /(units|amount_units|balance_units)\s*(\*|\/)\s*100|100\s*(\*|\/)\s*(units|amount_units|balance_units)/;

check(!UNIT_CONVERSION.test(WA), 'NO_UNIT_CONVERSION_WRAPPER: wrapper 无 units↔points 乘除换算');
check(!UNIT_CONVERSION.test(PAGE), 'NO_UNIT_CONVERSION_PAGE: 页面无 units↔points 乘除换算');
check(/formatUnits\(t\.amount_units\)/.test(PAGE), 'SINGLE_FORMATTER_PAGE: 流水金额一律经唯一 formatter 展示');
check(!/formatPoints/.test(PAGE), 'NO_DIRECT_FORMATTER_PAGE: 页面不再直接调用跨域 formatter');

// ============================== 5. 页面：禁止裸请求 / 裸令牌 ==============================

check(!/wx\.request\(/.test(PAGE), 'NO_RAW_WXREQUEST_PAGE: 页面无裸 wx.request');
check(!/wx\.uploadFile\(/.test(PAGE), 'NO_RAW_UPLOADFILE_PAGE: 页面无裸 wx.uploadFile');
check(!/getStorageSync\('userInfo'\)|getStorageSync\('access_token'\)/.test(F.page), 'NO_TOKEN_RAW_READ_PAGE: 页面不裸读 userInfo / access_token');
check(!/setStorageSync\('userInfo'\)/.test(F.page), 'NO_USERINFO_RAW_WRITE_PAGE: 页面不裸写 userInfo');
check(!/wx\.\$baseUrl|apiBaseUrl/.test(PAGE), 'NO_BASEURL_ASSEMBLY_PAGE: 页面不再自行拼装 API URL');
check(/from '\.\.\/\.\.\/utils\/pointsApi'/.test(F.page), 'PAGE_USES_WRAPPER: 页面接入 pointsApi');
check(/setUserInfo\(summary\.safeUserInfo\)/.test(PAGE), 'STORAGE_VIA_SESSION: userInfo 写回经 Session Manager 唯一写入口');
check(/import \{ setUserInfo \} from '\.\.\/\.\.\/utils\/session'/.test(F.page), 'SESSION_IMPORT: 页面从 Session Manager 获取写入口');

// UI 偏好（displayMode）属非认证存储，允许保留
check(/getStorageSync\('displayMode'\)/.test(F.page), 'DISPLAY_MODE_KEPT: 老年版偏好仍在本页读写（非认证存储）');

// ============================== 6. 行为保全 ==============================

check(/\/pages\/login-unified\/index/.test(F.page), 'LOGIN_REDIRECT_KEPT: 未登录跳转统一登录页');
check(/\/pages\/mall\/mall/.test(F.page), 'MALL_ENTRY_KEPT: 积分商城入口保留');
check(/\/pages\/quick-action\/quick-action/.test(F.page), 'QUICK_ACTION_ENTRY_KEPT: 随手公益入口保留');
check(/pageSize: 10/.test(F.page), 'PAGESIZE_KEPT: 分页大小 10 未变');
check(/reward': '奖励'/.test(F.page), 'TYPEMAP_KEPT: 流水类型映射表保留');
check(/hasMore = page < pg\.pagination\.total_pages/.test(F.page), 'PAGINATION_SEMANTICS_KEPT: 翻页判定沿用后端 total_pages');
check(/max: 5/.test(F.page), 'CASUAL_LIMIT_KEPT: 随手公益 5/日静态上限保留');
check(/imported_max_per_year: 200/.test(F.page), 'EXCHANGE_LIMIT_KEPT: 导入积分 200/年静态上限保留');
check(!/\/pages\/profile\/login\/login/.test(F.page), 'NO_DEAD_ROUTE: 未重新引入失效登录路由');

// ============================== 7. 作用域边界（本阶段未迁移的页面） ==============================

for (const [label, src] of [
  ['MALL_PAGE', F.mall],
  ['GOODS_DETAIL_PAGE', F.goodsDetail],
  ['MINE_PAGE', F.mine],
  ['ADMIN_POINTS_PAGE', F.adminPoints],
]) {
  check(!/utils\/pointsApi/.test(src), `SCOPE_NOT_MIGRATED_${label}: ${label} 未引入 pointsApi（超出 P3-F 授权范围）`);
}
check(/admin_add_points\.php/.test(F.adminPoints), 'SCOPE_ADMIN_LEGACY_KEPT: Admin 加积分仍走原 legacy 端点（未纳管）');
check(/getPointsTransactions/.test(F.mall) === false, 'SCOPE_MALL_UNTOUCHED: mall 页未改动为 pointsApi');

// ============================== 输出 ==============================

const total = pass + failures.length;
if (failures.length) {
  console.error('P3-F POINTS CONTRACT — FAIL');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`PASS=${pass} FAIL=${failures.length} TOTAL=${total}`);
  process.exit(1);
}
console.log(`P3-F POINTS CONTRACT — OK (${total} assertions)`);
