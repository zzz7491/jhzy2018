// tests/guest_entry_browsing_contract.mjs
// P0-B 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「未登录游客最小浏览闭环」前端契约 —— 对应 P0-B 阶段验收要求。
//
// 覆盖：
//   1) 默认入口改为首页（游客首屏不再强制登录页）
//   2) 登录页仍保留且 tabBar 结构不破坏
//   3) 首页纯浏览行为不再因未登录被 showLoginModal 拦截
//      （onMainSwiperTap / goToActivityDetail / goToAllActivities / viewAllRankings / viewVolunteerRank）
//   4) 活动列表「查看详情」不再要求登录（公开浏览）
//   5) 活动详情页允许游客进入，但报名/签到/签退等身份动作仍要求登录
//   6) 已确认的错误登录路由 /pages/profile/login/login 已从本阶段授权目标文件中移除
//
// 不覆盖（属后续阶段，不在本合同断言范围内）：
//   培训/社区/团队/嘉禾AI 游客模式、八中心 UI、登录页视觉、首页视觉重构、
//   profile/my-results 旧错误路由、exam 注释、Step 6B、J1-J17。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  appJson: `${ROOT}/miniprogram/app.json`,
  indexTs: `${ROOT}/miniprogram/pages/index/index.ts`,
  activitiesTs: `${ROOT}/miniprogram/pages/activities/activities.ts`,
  detailTs: `${ROOT}/miniprogram/pages/detail/detail.ts`,
  pointsTs: `${ROOT}/miniprogram/pages/points/points.ts`,
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

// 方法级分块：Page({}) 内方法均以 "  },"（2 空格缩进 + 闭合花括号 + 逗号）结尾，
// 嵌套闭合花括号为更深缩进，故该切分安全。方法块以 "  <name>(" 行首签名起始，
// 用正则精确匹配方法定义（避免误匹配方法内部对其它方法的调用）。
function methodBlock(blocks, name) {
  const re = new RegExp('(^|\\n)  ' + name + '\\(');
  return blocks.find((b) => re.test(b)) || '';
}

const indexBlocks = F.indexTs.split(/\n  \},\n/);
const onMainSwiperTap = methodBlock(indexBlocks, 'onMainSwiperTap');
const goToActivityDetail = methodBlock(indexBlocks, 'goToActivityDetail');
const goToAllActivities = methodBlock(indexBlocks, 'goToAllActivities');
const viewAllRankings = methodBlock(indexBlocks, 'viewAllRankings');
const viewVolunteerRank = methodBlock(indexBlocks, 'viewVolunteerRank');

const activitiesBlocks = F.activitiesTs.split(/\n  \},\n/);
const goToDetail = methodBlock(activitiesBlocks, 'goToDetail');

const detailBlocks = F.detailTs.split(/\n  \},\n/);
const handleJoinClick = methodBlock(detailBlocks, 'handleJoinClick');
const processJoin = methodBlock(detailBlocks, 'processJoin');
const handleMainButtonClick = methodBlock(detailBlocks, 'handleMainButtonClick');

// 1) 默认入口 = 首页（游客首屏）
const appJson = JSON.parse(F.appJson);
check(appJson.pages[0] === 'pages/index/index', 'DEFAULT_ENTRY: pages[0] === pages/index/index');
check(
  appJson.tabBar && appJson.tabBar.list[0].pagePath === 'pages/index/index',
  'TABBAR_FIRST: tabBar.list[0] === pages/index/index (tabBar 未破坏)',
);

// 2) 登录页仍保留（降级为按需进入，不删除、不改实现）
check(
  appJson.pages.includes('pages/login-unified/index'),
  'LOGIN_PAGE_PRESERVED: pages/login-unified/index 仍在 pages 注册',
);

// 3) 首页纯浏览行为解除登录拦截
check(
  !onMainSwiperTap.includes("showLoginModal('查看活动')") &&
    onMainSwiperTap.includes("/pages/detail/detail?id=' + banner.id"),
  'HOME_NAV: onMainSwiperTap 活动 banner 直达详情（不再强制登录）',
);
check(
  !goToActivityDetail.includes("showLoginModal('查看活动详情')") &&
    goToActivityDetail.includes("/pages/detail/detail?id=' + id"),
  'HOME_NAV: goToActivityDetail 直达详情（不再强制登录）',
);
check(
  !goToAllActivities.includes("showLoginModal('查看活动')") &&
    goToAllActivities.includes("url: '/pages/activities/activities'"),
  'HOME_NAV: goToAllActivities 直达活动列表（不再强制登录）',
);
check(
  !viewAllRankings.includes("showLoginModal('查看排行榜')") &&
    viewAllRankings.includes("url: '/pages/rankings/rankings'"),
  'HOME_NAV: viewAllRankings 直达公开排行榜（不再强制登录）',
);
check(
  !viewVolunteerRank.includes('!this.data.userInfo') &&
    viewVolunteerRank.includes("url: '/pages/rankings/rankings'"),
  'HOME_NAV: viewVolunteerRank 公开排行可达（移除 userInfo 拦截）',
);

// 4) 活动列表「查看详情」公开（不再要求登录）
check(
  !goToDetail.includes('showLoginModal') &&
    !goToDetail.includes('checkLoginStatus()') &&
    goToDetail.includes('`/pages/detail/detail?id=${id}`'),
  'ACTIVITY_LIST_DETAIL: goToDetail 游客可进入详情（移除登录门禁）',
);

// 5) 活动详情页允许游客进入；报名/签到/签退等身份动作仍要求登录
// 5a) 详情页未用错误登录路由
check(
  !F.detailTs.includes('/pages/profile/login/login'),
  'DETAIL_NO_INVALID_ROUTE: detail.ts 不再使用 /pages/profile/login/login',
);
// 5b) 报名仍要求登录，且跳转真实登录页
check(
  /if \(!this\.data\.isLoggedIn\)/.test(handleJoinClick) &&
    handleJoinClick.includes("url: '/pages/login-unified/index'"),
  'SIGNUP_REQUIRES_LOGIN: handleJoinClick 仍要求登录且跳 login-unified',
);
check(
  /if \(!this\.data\.isLoggedIn\)/.test(processJoin) &&
    processJoin.includes("url: '/pages/login-unified/index'"),
  'SIGNUP_REQUIRES_LOGIN: processJoin 仍要求登录且跳 login-unified',
);
// 5c) 签到入口受报名状态门控（signupStatus===2 方可 proceedToCheckin；未登录用户走 else→handleJoinClick 登录门）
check(
  handleMainButtonClick.includes('if (signupStatus === 2)') &&
    handleMainButtonClick.includes('proceedToCheckin') &&
    handleMainButtonClick.includes('handleJoinClick()'),
  'CHECKIN_GATED: handleMainButtonClick 仅 APPROVED(signupStatus===2) 进入签到，否则走登录门',
);

// 6) points.ts 错误登录路由已修复（个人数据/积分属身份动作，登录门禁保留，仅路由修正）
check(
  !F.pointsTs.includes('/pages/profile/login/login'),
  'POINTS_NO_INVALID_ROUTE: points.ts 不再使用 /pages/profile/login/login',
);

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
