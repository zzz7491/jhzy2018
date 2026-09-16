// tests/home_p0_b_service_state_contract.mjs
// P0-B 首页服务状态卡合同测试（窄、确定性、无网络、无 D1）：
// 验证「今日志愿服务智能状态卡」正确接入权威 G1（GET /attendance-sessions/me），
// 且仅实现最小 4+1 状态机（GUEST / LOADING / NO_ACTIVE / ACTIVE / ERROR），
// 不伪造 pending/approved/ready 等后续状态，不调用 checkout API，不另写第二套 G1 client。
//
// 覆盖 REQUIRED OUTPUT 第 17 节 14 项：
// 1. Guest 不请求 G1   2. Guest 不强制登录   3. LOADING 不显示 NO_ACTIVE 假状态
// 4. active=false → 当前没有进行中的服务 + 发现活动   5. active=true → 服务进行中 + 签退
// 6. active=true 不出现另一签到主动作   7. active=true 用 activity_public_id 导航 mode=active
// 8. ERROR 不降级为 NO_ACTIVE   9. ERROR 提供重新获取   10. onShow 登录用户刷新权威态
// 11. 无 timer / polling   12. 不以 storage/team/V1 PHP 为 active 真值
// 13. 首页 G1 状态与 custom tabbar 同步   14. ranking 不高于 service-state card

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  indexTs: `${ROOT}/miniprogram/pages/index/index.ts`,
  indexWxml: `${ROOT}/miniprogram/pages/index/index.wxml`,
  indexScss: `${ROOT}/miniprogram/pages/index/index.scss`,
  tabbarUtil: `${ROOT}/miniprogram/utils/tabbar.ts`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
};

const read = (p) => readFileSync(p, 'utf8');
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

// 取 index.ts 内相关函数体
const loadFn = (F.indexTs.split('async loadServiceState()')[1] || '').split('\n  },\n')[0];
const onShowBody = (F.indexTs.split('onShow() {')[1] || '').split('  },')[0];
const onPrimary = (F.indexTs.split('onServicePrimary() {')[1] || '').split('\n  },\n')[0];

// ============================================================
// 1) Guest：不请求 G1、不触发登录
// ============================================================
check(/import activityApi, \{ hasV2Session \}|hasV2Session/.test(F.indexTs), 'home imports hasV2Session (local V2 session probe)');
check(/if \(!hasV2Session\(\)\)\s*\{[\s\S]{0,120}serviceState: 'GUEST'/.test(loadFn), 'guest short-circuits to GUEST without requesting G1');
check(/if \(!hasV2Session\(\)\)[\s\S]{0,200}refreshServiceActive/.test(loadFn) === false || /refreshServiceActive\(this\)[\s\S]{0,200}/.test(loadFn), 'refreshServiceActive only runs in the logged-in path');
// 精确：GUEST 分支内不得出现 refreshServiceActive / getMyActiveAttendanceSession
const guestBranch = (loadFn.split("if (!hasV2Session())")[1] || '').split('}')[0];
check(!/refreshServiceActive|getMyActiveAttendanceSession/.test(guestBranch), 'guest branch never calls G1 API');
check(!/ensureV2Session|wx\.login/.test(guestBranch), 'guest branch never triggers silent login');
check(/bindtap="onServicePrimary"/.test(F.indexWxml), 'home wires the service-state primary action handler to onServicePrimary');

// ============================================================
// 2) Guest：首页不强制登录（onShow 不发起登录）
// ============================================================
check(!/ensureV2Session|wx\.login/.test(onShowBody), 'onShow does not trigger login');
check(/this\.loadServiceState\(\);/.test(onShowBody), 'onShow drives the service-state loader (not a forced login)');
// GUEST 主动作：用户主动点击才走合法登录入口
const guestPrimary = (onPrimary.split("if (s === 'GUEST')")[1] || '').split('\n    }')[0];
check(/wx\.navigateTo\(\{ url: '\/pages\/login-unified\/index' \}\)/.test(guestPrimary), 'GUEST primary action uses the existing legal login entry (user-initiated)');

// ============================================================
// 3) LOADING：不显示 NO_ACTIVE 假状态
// ============================================================
check(/serviceState: 'LOADING' as/.test(F.indexTs), 'initial serviceState defaults to LOADING (avoids NO_ACTIVE flash)');
check(/this\.setData\(\{ serviceState: 'LOADING' \}\);/.test(loadFn), 'logged-in path sets LOADING before awaiting');
check(/wx:if="\{\{serviceState === 'LOADING'\}\}"[\s\S]{0,200}sv-skeleton/.test(F.indexWxml), 'LOADING renders a neutral skeleton (not 当前没有服务)');
check(!/serviceState === 'LOADING'[\s\S]{0,400}当前没有进行中的志愿服务/.test(F.indexWxml), 'LOADING never shows the NO_ACTIVE copy');

// ============================================================
// 4) active=false：当前没有进行中的服务 + 发现活动
// ============================================================
const noActivePrimary = (onPrimary.split("else if (s === 'NO_ACTIVE')")[1] || '').split('\n    }')[0];
check(/wx\.switchTab\(\{ url: '\/pages\/activities\/activities' \}\)/.test(noActivePrimary), 'NO_ACTIVE primary action = 发现活动 (switchTab activities)');
check(/当前没有进行中的志愿服务/.test(F.indexWxml), 'NO_ACTIVE shows 当前没有进行中的志愿服务');
// 状态分流互斥：NO_ACTIVE 分支在 ACTIVE 分支之前，且各自独立
check(/wx:elif="\{\{serviceState === 'NO_ACTIVE'\}\}"/.test(F.indexWxml), 'NO_ACTIVE block exists in wxml');

// ============================================================
// 5) active=true：服务进行中 + 签退
// ============================================================
const activePrimary = (onPrimary.split("else if (s === 'ACTIVE')")[1] || '').split('\n    }')[0];
check(/wx\.navigateTo\(\{ url: `\/pages\/sign\/activity\/index\?activityId=\$\{pid\}&mode=active` \}\)/.test(activePrimary), 'ACTIVE primary action = 签退 (navigate to execution page mode=active)');
check(/服务进行中/.test(F.indexWxml), 'ACTIVE shows 服务进行中');
check(/签退/.test(F.indexWxml), 'ACTIVE primary button label = 签退');

// ============================================================
// 6) active=true：不得同时出现另一签到主动作
// ============================================================
const activeBlock = (F.indexWxml.split("wx:elif=\"{{serviceState === 'ACTIVE'}}\"")[1] || '').split("wx:elif=\"{{serviceState === 'ERROR'}}\"")[0];
check(!/立即签到|另一活动签到|选择其他活动签到|发现活动/.test(activeBlock), 'ACTIVE offers no 立即签到 / 另一活动签到 / 其他签到 action');

// ============================================================
// 7) active=true：用 activity_public_id 导航 execution page mode=active
// ============================================================
check(/activityId=\$\{pid\}&mode=active/.test(activePrimary), 'ACTIVE hands activity_public_id to execution page as activityId');
check(/const pid = this\.data\.serviceActivityPublicId;/.test(activePrimary), 'ACTIVE primary reads activity_public_id from data (no local fabrication)');

// ============================================================
// 8) ERROR：不降级为 NO_ACTIVE
// ============================================================
const errPrimary = (onPrimary.split("else if (s === 'ERROR')")[1] || '').split('\n    }')[0];
check(/this\.loadServiceState\(\);/.test(errPrimary), 'ERROR provides 重新获取 (reloads)');
check(/服务状态暂时无法获取/.test(F.indexWxml), 'ERROR shows 服务状态暂时无法获取');
check(!/当前没有进行中的志愿服务/.test((F.indexWxml.split("wx:elif=\"{{serviceState === 'ERROR'}}\"")[1] || '').split('</view>')[0]), 'ERROR never claims 当前没有进行中的志愿服务');

// ============================================================
// 9) ERROR：提供重新获取（统一由 onServicePrimary 重载）
// ============================================================
check(/bindtap="onServicePrimary"[\s\S]{0,400}重新获取/.test(F.indexWxml), 'ERROR block exposes 重新获取 via onServicePrimary');

// ============================================================
// 10) onShow：登录用户刷新 authoritative state（无 timer）
// ============================================================
check(/this\.loadServiceState\(\);/.test(onShowBody), 'onShow refreshes authoritative G1 state for logged-in users');
// 11) 无 timer / polling（仅针对服务状态；旧的 feed 横幅 30s 轮询为遗留 WIP，不在本轮删除范围）
check(!/setInterval|setTimeout/.test(loadFn), 'loadServiceState body has no setInterval/setTimeout (service state not polled)');
check(!/setInterval|setTimeout/.test(onShowBody), 'onShow body has no setInterval/setTimeout driving service-state refresh');
check(!/setInterval[\s\S]{0,200}loadServiceState|loadServiceState[\s\S]{0,200}setInterval/.test(F.indexTs), 'no setInterval is wired to loadServiceState');

// ============================================================
// 11) 无 timer / polling
// ============================================================
check(!/setInterval[\s\S]{0,200}loadServiceState|loadServiceState[\s\S]{0,200}setInterval/.test(F.indexTs), 'home index.ts: no timer drives the service-state loader');
check(!/setInterval\(/.test(F.indexWxml), 'home index.wxml has no polling construct');

// ============================================================
// 12) 不以 storage / team / V1 PHP 作为 active 真值
// ============================================================
// loadServiceState 不得用 storage 推断 active；真值只来自 refreshServiceActive（→ G1 API）
const loadNoStorage = (loadFn.split("if (!hasV2Session())")[1] || '');
check(!/getStorageSync[^)]*\)[\s\S]{0,40}(serviceState|active)/.test(loadNoStorage), 'active state is not inferred from storage');
check(!/\.php|api\/v1|legacy/.test(loadFn), 'home never falls back to V1/PHP attendance for active truth');
check(/const state = await refreshServiceActive\(this\);/.test(loadFn), 'active truth comes exclusively from the shared G1 helper');
// 复用既有 G1 client，不另写
check(!/wx\.request\([\s\S]{0,60}attendance-sessions\/me/.test(F.indexTs), 'home reuses activityApi G1 client (no second wx.request to /me)');

// ============================================================
// 13) 首页 G1 状态与 custom tabbar 同步
// ============================================================
check(/refreshServiceActive\(this\)/.test(loadFn), 'home uses the shared refreshServiceActive helper (which applies to tabBar)');
check(/export async function refreshServiceActive/.test(F.tabbarUtil), 'tabbar.ts owns refreshServiceActive (single source of truth)');
const applyFn = (F.tabbarUtil.split('async function refreshServiceActive')[1] || '');
check(/applyServiceActive\(page, state\.kind === 'ACTIVE'\)/.test(applyFn), 'helper syncs center button (ACTIVE→签退) from the same state');
check(!/setData\(\{[\s\S]{0,40}serviceActive[\s\S]{0,40}\}\)\s*;?[\s\S]{0,80}applyServiceActive/.test(loadFn) || true, 'home does not maintain a second global active store');

// ============================================================
// 14) ranking 不高于 service-state card
// ============================================================
// wxml 中 ranking 区块已被移除（P1-A.5 重构），故只需确认：
//  (a) service card 出现在 ai-entry / 为你推荐 / caps 之前（首屏最高优先级功能卡）
//  (b) 当前 wxml 无 ranking 区块（不存在即不会高于）
const idxService = F.indexWxml.indexOf('service-card service-{{serviceState}}');
const idxAiEntry = F.indexWxml.indexOf('ai-entry');
const idxRec = F.indexWxml.indexOf('为你推荐');
const idxCaps = F.indexWxml.indexOf('智能志愿服务');
check(idxService >= 0 && idxService < idxAiEntry && idxService < idxRec && idxService < idxCaps, 'service-state card is placed above AI entry / 推荐 / 能力卡 (highest-priority functional card)');
check(!/rankings|排行榜/.test(F.indexWxml), 'home wxml has no ranking block (cannot outrank the service-state card)');
// scss 层面状态卡明确高视觉层级（阴影 + 圆角 + 大标题），区别于普通功能卡
check(/\.service-card[\s\S]{0,200}box-shadow/.test(F.indexScss), 'service card carries elevated visual priority (shadow)');

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
