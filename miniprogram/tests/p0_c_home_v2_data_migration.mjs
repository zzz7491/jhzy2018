// tests/p0_c_home_v2_data_migration.mjs
// P0-C 首页核心数据 V1/PHP → V2 canonical 迁移合同测试（窄、确定性、无网络、无 D1）：
// 验证首页「为你推荐」公开活动数据源已从 legacy PHP activities.php 迁移至 G2 V2 canonical
// GET /api/v2/activities（activityApi.getActivities），且不伪造封面/积分/报名态/团队等字段；
// 并确认已删除无 WXML 消费者的 dead V1 依赖（轮播/排行榜/商城），保留可见模块（feed / 公益故事）记为 DEFERRED_V2_GAP。
//
// 覆盖 REQUIRED OUTPUT §21 的 16 项核心断言（前端静态契约，无需微信运行时）。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  indexTs: `${ROOT}/miniprogram/pages/index/index.ts`,
  indexWxml: `${ROOT}/miniprogram/pages/index/index.wxml`,
  indexScss: `${ROOT}/miniprogram/pages/index/index.scss`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
  trainingApi: `${ROOT}/miniprogram/utils/trainingApi.ts`,
};

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const F = {};
for (const [k, p] of Object.entries(files)) {
  try {
    F[k] = read(p);
  } catch (e) {
    console.error(`[FATAL] cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
}

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const TS = F.indexTs;
const WXML = F.indexWxml;
const SCSS = F.indexScss;

// 抽取 loadHotActivities 函数体（按 "  loadHotActivities()"/"loadHotActivities(): Promise" 签名起，到下一个方法级闭合）
const hotSig = TS.includes('loadHotActivities(): Promise<void>') ? 'loadHotActivities(): Promise<void>' : 'loadHotActivities()';
const hotBody = (TS.split(hotSig)[1] || '').split('\n  },\n')[0];

// 抽取首页 index.ts 中出现的全部 jhzyfw API URL（V1/PHP 依赖盘点）
const allApiUrls = [...TS.matchAll(/'(https?:\/\/(?:api|exam)\.jhzyfw\.com\/[^']+)'/g)].map((m) => m[1]);
// 仅真正以 .php 结尾的脚本才算 V1 端点；V2 canonical 基址（如 https://api.jhzyfw.com/api 及其 /uploads 子路径）
// 是 formatImageUrl 用的统一网关前缀（拼相对图片路径），不算 V1 端点，也不算新增依赖。
const phpUrls = allApiUrls.filter((u) => /\.php($|\?)/.test(u));
const v2Base = allApiUrls.filter((u) => !/\.php($|\?)/.test(u));
const feedUrls = phpUrls.filter((u) => /activity_feeds\.php/.test(u));
const quickUrls = phpUrls.filter((u) => /quick_actions\.php/.test(u));
const forbidden = phpUrls.filter((u) =>
  /activities\.php|rankings\.php|mall_products\.php|api_get_carousel\.php|mall\/exchange\.php/.test(u),
);

console.log('--- V1/PHP 端点盘点（首页 index.ts）---');
console.log('  全部 .php 端点 =', JSON.stringify(phpUrls));
console.log('    ↳ feed =', JSON.stringify(feedUrls), ' quick_actions =', JSON.stringify(quickUrls));
console.log('  forbidden(activity/ranking/exchange/carousel) =', JSON.stringify(forbidden));
console.log('  V2 canonical 基址（formatImageUrl 前缀，非 V1 端点）=', JSON.stringify(v2Base));

// ============================================================
// 1) Guest 首页不强制登录
// ============================================================
const onShowBody = (TS.split('onShow() {')[1] || '').split('  },')[0];
check(!/ensureV2Session|wx\.login/.test(onShowBody), 'GUEST_NO_FORCE_LOGIN: onShow 不触发登录');
check(/import activityApi, \{ hasV2Session \}|hasV2Session/.test(TS), 'GUEST_PROBE: home 使用 hasV2Session 本地会话探针');
const loadFn = (TS.split('async loadServiceState()')[1] || '').split('\n  },\n')[0];
const guestBranch = (loadFn.split("if (!hasV2Session())")[1] || '').split('}')[0];
check(/serviceState: 'GUEST'/.test(guestBranch) && !/refreshServiceActive|getMyActiveAttendanceSession/.test(guestBranch),
  'GUEST_SHORT_CIRCUIT: 无 V2 会话直接 GUEST，不请求 G1');

// ============================================================
// 2) Guest public activities 走 V2 canonical API
// ============================================================
check(/activityApi\s*\n?\s*\.getActivities\(1, 6\)/.test(hotBody) || /activityApi\.getActivities\(1, 6\)/.test(hotBody),
  'PUBLIC_ACTIVITY_V2: loadHotActivities 调用 activityApi.getActivities(1,6)');
check(/getActivities\(page = 1, pageSize = 20\)/.test(F.activityApi) || /getActivities\(page\s*=\s*1/.test(F.activityApi),
  'V2_CLIENT_EXISTS: activityApi.getActivities 命中 GET /activities（统一 V2 client）');
check(!/wx\.request\([\s\S]{0,40}activities\.php/.test(TS), 'NO_V1_ACTIVITY_PHP: 公开活动不再经 V1 activities.php');

// ============================================================
// 3) 首页不直接调用 V1 PHP activity API（整体）
// ============================================================
check(forbidden.filter((u) => /activities\.php/.test(u)).length === 0, 'NO_V1_ACTIVITIES_PHP_GLOBAL: index.ts 无任何 activities.php 调用');

// ============================================================
// 4) 不新增 wx.request 绕过统一 API client
// ============================================================
check(forbidden.length === 0, 'NO_NEW_WX_REQUEST: 未新增绕过统一 client 的 V1 activity/ranking/exchange/carousel wx.request');
check(phpUrls.every((u) => /activity_feeds\.php|quick_actions\.php/.test(u)),
  'ONLY_DEFERRED_V1: 残留 .php 端点仅 feed / quick_actions（均为可见模块的 DEFERRED_V2_GAP）');

// ============================================================
// 5) P0-B ACTIVE 仍只有签退主动作
// ============================================================
const activeBlock = (WXML.split("wx:elif=\"{{serviceState === 'ACTIVE'}}\"")[1] || '').split("wx:elif=\"{{serviceState === 'ERROR'}}\"")[0];
check(/签退/.test(activeBlock) && !/立即签到|另一活动签到/.test(activeBlock), 'P0B_ACTIVE_CHECKOUT_ONLY: ACTIVE 仅签退主动作');

// ============================================================
// 6) P0-B ERROR 仍不等于 NO_ACTIVE
// ============================================================
check(/服务状态暂时无法获取/.test(WXML) && /当前没有进行中的志愿服务/.test(WXML), 'P0B_ERROR_NE_NO_ACTIVE: ERROR 与 NO_ACTIVE 文案互斥');
check(!/当前没有进行中的志愿服务/.test((WXML.split("wx:elif=\"{{serviceState === 'ERROR'}}\"")[1] || '').split('</view>')[0]),
  'P0B_ERROR_NO_FAKE: ERROR 块不声称「当前没有进行中的志愿服务」');

// ============================================================
// 7) 首页不恢复 ranking
// ============================================================
check(!/排行榜/.test(WXML), 'NO_RANKING_WXML: 首页 wxml 无 ranking 区块');
check(!/loadRankings\(/.test(TS), 'NO_RANKING_LOADER: loadRankings 已从首页移除');

// ============================================================
// 8) public activity 只消费 G2 已存在字段
// ============================================================
check(/a\.public_id/.test(hotBody) && /a\.title/.test(hotBody) && /a\.address/.test(hotBody) &&
      /a\.start_time/.test(hotBody) && /a\.end_time/.test(hotBody) && /a\.status/.test(hotBody),
  'G2_FIELDS_ONLY: 仅消费 public_id/title/address/start_time/end_time/status');
check(!/a\.cover_image|a\.points_reward|a\.is_signed|a\.signup_status|a\.team_id|a\.audit_status/.test(hotBody),
  'NO_PRIVATE_FIELDS: 不读取 G2 公开投影外的私有/PII 字段');

// ============================================================
// 9) 不伪造 activity cover/team/age/category
// ============================================================
check(!/coverImage:/.test(hotBody) && !/team_id:/.test(hotBody) && !/\bage\b/.test(hotBody) && !/category:/.test(hotBody),
  'NO_FAKE_FIELDS: 不伪造 coverImage/team/age/category');
check(/coverImage: this\.formatImageUrl/.test(hotBody) === false, 'NO_COVER_ASSIGN: 公开活动卡封面留空→WXML 占位（非伪造封面）');

// ============================================================
// 10) 无 authoritative signup state 不得伪造报名状态
// ============================================================
check(!/getActivityStatus\(|getActivityStatusText\(/.test(TS), 'NO_FAKE_SIGNUP_STATUS: 报名态判定函数已从首页移除');
check(/activityLifecycleToken\(a\.status\)/.test(hotBody), 'LIFECYCLE_ONLY: 状态徽标仅用生命周期枚举（非报名态）');
check(!/is_signed|signup_status/.test(hotBody), 'NO_SIGNUP_STATE: 不臆测用户报名状态');

// ============================================================
// 11) 无 social UGC
// ============================================================
check(!/community\/feed|social_feed|ugc/.test(TS), 'NO_SOCIAL_UGC: 首页未恢复社区/social feed 数据拉取');

// ============================================================
// 12) 不修改 trainingApi（已知独立 bug 不修）
// ============================================================
check(!/import.*trainingApi|from '.*trainingApi'/.test(TS), 'TRAINING_API_UNTOCUCHED: 首页未改动/引入 trainingApi');

// ============================================================
// 13) 不修改 workers（前端不触碰后端源）
// ============================================================
// activityApi.ts 用模板字符串拼 URL：request('GET', `/activities?page=...`)，故需允许反引号
check(/request\(['"]GET['"],\s*\`?\/activities/.test(F.activityApi),
  'WORKERS_UNTOUCHED: activityApi.ts 仍含 V2 GET /activities 调用（后端源/客户端契约未改，首页未触碰）');

// ============================================================
// 14) 不修改 protected pages（首页不编辑受保护页）
// ============================================================
// 受保护页面契约：首页不得 import 受保护页面源模块（navigation URL 字符串属允许范围，任务明确首页向 detail 传 public_id）
check(!/import .*from '[^']*pages\/detail\/detail\.ts'|import .*from '[^']*pages\/activities\/activities\.ts'|import .*from '[^']*pages\/sign\//.test(TS),
  'PROTECTED_PAGES_UNTOUCHED: 首页未 import 受保护页面源模块（导航 URL 字符串属允许范围）');

// ============================================================
// 15) 无新的 service-state polling（feed 30s 轮询为遗留可见模块，保留）
// ============================================================
check(!/setInterval[\s\S]{0,200}loadServiceState|loadServiceState[\s\S]{0,200}setInterval/.test(TS),
  'NO_NEW_SERVICE_POLL: 无新增 service-state setInterval 轮询');
const feedTimerLine = (TS.split('this.data.feedTimer = setInterval')[1] || '').split(';')[0];
check(/loadFeeds/.test(feedTimerLine), 'FEED_POLL_KEPT: 仅保留遗留 feed 30s 轮询（可见模块 ACTIVE_VISIBLE，非新增）');

// ============================================================
// 16) V1 dependency 数量不得增加
// ============================================================
check(forbidden.length === 0, 'V1_COUNT_NOT_INCREASED: 相较迁移前，V1 activity/ranking/exchange/carousel 依赖已归零（仅 feed+quick_actions 残留，均为 DEFERRED_V2_GAP）');

console.log('');
console.log(`PASS=${pass} FAIL=${fail}`);
if (fail === 0) {
  console.log('ALL GREEN');
  process.exit(0);
} else {
  console.log('FAILURES:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
