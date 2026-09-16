// tests/p1_b3_activity_detail_contract.mjs
// P1-B3 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「活动详情页最小产品合同闭环」前端契约 —— 对应 P1-B3-ACTIVITY-DETAIL-MINIMAL-CLOSEOUT 验收要求。
//
// 覆盖 §3 INSURANCE（移除假二维码 / §16 STOP 条件）、§4 SIGNUP SEMANTICS、
// §5 SIGNUP DEADLINE、§6 ACTIVITY STATUS、§7 TEAM IDENTITY、§8 GUIDE（DEFERRED）、
// §9 AGE（不伪造）、§10 ATTENDANCE（Foundation 兼容，单 active-session）、§11 VISUAL（保留 2.0）、
// §12 TEST 全部条目。
//
// 关键约束：
//  - 不得通过让测试迁就错误生产代码来制造绿灯（fail 即真实失败）。
//  - 受保护文件（workers/**、app.json、custom-tab-bar/**、其它 pages、trainingApi.ts、
//    migrations/**、0042*、unrelated WIP）以 git diff（§14）为权威判定；本测试仅作源码级 proxy。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  detailTs: `${ROOT}/miniprogram/pages/detail/detail.ts`,
  detailWxml: `${ROOT}/miniprogram/pages/detail/detail.wxml`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
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
const detailTs = F.detailTs;
const detailWxml = F.detailWxml;
const activityApi = F.activityApi;
const combined = detailTs + detailWxml;

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

// ============================================================
// 1) 游客浏览契约保留（guest browsing contract preserved）
// ============================================================
check(
  !detailTs.includes('/pages/profile/login/login'),
  'GUEST_BROWSE: detail.ts 不再使用错误登录路由 /pages/profile/login/login',
);
check(
  /activityApi\s*\n?\s*\.getActivity\(activityId\)/.test(detailTs) ||
    /activityApi\.getActivity\(activityId\)/.test(detailTs),
  'GUEST_BROWSE: 游客/登录均走 canonical getActivity 公开读',
);

// ============================================================
// 2) canonical getActivity（真实后端读，无 legacy 端点）
// ============================================================
check(
  /getActivity\(id:\s*string\)/.test(activityApi) || /getActivity\(/.test(activityApi),
  'CANONICAL: activityApi.getActivity 存在（GET /activities/:id）',
);
check(
  !/\.php['"`]/.test(detailTs) && !/v1\/activity/.test(detailTs),
  'CANONICAL: loadActivityDetail 不回退 legacy PHP 端点（无 .php / v1/activity 请求）',
);

// ============================================================
// 3) INSURANCE：彻底移除硬编码假二维码（§3 / §16）
// ============================================================
check(
  !/api\.jhzyfw\.com\/static\/insurance-qr/.test(combined),
  'INSURANCE_NO_HARDCODED_QR: 无硬编码保险二维码 URL（api.jhzyfw.com/static/insurance-qr）',
);
check(
  !/insurance-qr/.test(combined),
  'INSURANCE_NO_QR_REF: 无任何 insurance-qr 引用',
);
check(
  !/\bsaveInsuranceQRCode\s*\(/.test(detailTs),
  'INSURANCE_NO_QR_DOWNLOAD_METHOD: saveInsuranceQRCode 方法定义已移除（无伪造二维码下载）',
);
check(
  !/wx\.downloadFile/.test(detailTs),
  'INSURANCE_NO_QR_DOWNLOAD: 无 wx.downloadFile 假二维码下载',
);
check(
  !/长按识别二维码购买保险/.test(detailWxml),
  'INSURANCE_NO_FAKE_PURCHASE_TEXT: 无「长按识别二维码购买保险」伪造购买文案',
);
check(
  !/保存二维码/.test(detailWxml),
  'INSURANCE_NO_SAVE_BUTTON: 保险弹窗无「保存二维码」按钮',
);

// ============================================================
// 4) INSURANCE：平台级引导（至少提前一天；无伪造购买入口/硬编码联系人）
// ============================================================
check(
  /至少提前一天|前一天/.test(detailWxml),
  'INSURANCE_AHEAD_1DAY: 保险提醒含「至少提前一天 / 前一天」引导',
);
check(
  /通过活动招募联系人办理/.test(detailWxml),
  'INSURANCE_PLATFORM_GUIDED: 改为「通过活动招募联系人办理」平台引导（非个人伪造）',
);
check(
  !/(1[3-9]\d{9})/.test(combined),
  'INSURANCE_NO_HARDCODED_PHONE: 保险区无硬编码手机号',
);
check(
  /保险购买弹窗[\s\S]*?我知道了/.test(detailWxml) || /modal-btn--primary" bindtap="closeInsuranceModal">我知道了/.test(detailWxml),
  'INSURANCE_MODAL_CLOSE_ONLY: 保险弹窗仅「我知道了」关闭，无其它动作',
);

// ============================================================
// 5) 联系人仅来自真实 API（§3 / §16 STOP 条件）
// ============================================================
check(
  !/getTeamPublicContact/.test(detailTs),
  'CONTACT_NO_FAKECALL: detail.ts 不调用 getTeamPublicContact（无法可靠获得活动所属 team → 不伪造调用）',
);
check(
  (detailTs.match(/contactPerson:\s*''/g) || []).length >= 1 &&
    (detailTs.match(/contactPhone:\s*''/g) || []).length >= 1,
  'CONTACT_EMPTY_DEFAULT: contactPerson/contactPhone 仅默认空串（无硬编码招募联系人）',
);
check(
  !/activeTeamId/.test(detailTs) && !/team_id/.test(detailTs),
  'CONTACT_NO_TEAM_IMPERSONATION: 不用 storage.activeTeamId / team_id 冒充活动团队',
);
check(
  !/(王|李|张|刘|陈)老师|招募联系人[:：]/.test(combined),
  'CONTACT_NO_HARDCODED_NAME: 无硬编码招募联系人姓名',
);

// ============================================================
// 6) SIGNUP SEMANTICS（§4）：禁止「报名成功」；pending/approved 区分
// ============================================================
check(
  !/报名成功/.test(detailTs),
  'SIGNUP_NO_SUCCESS_TEXT: 无「报名成功」禁用文案',
);
check(
  /review_status === 1\)\s*status = 2/.test(detailTs),
  'SIGNUP_APPROVED_MAPPED: review_status===1 → status 2（APPROVED）',
);
check(
  /review_status === 2\)\s*status = 4/.test(detailTs),
  'SIGNUP_REJECTED_MAPPED: review_status===2 → status 4（REJECTED）',
);
// pending（review_status 非 1/2）→ status=1，文案「报名已提交，等待审核」（非 approved）
// 使用无标点子串断言，避免中文全/半角逗号差异导致误判。
check(
  detailTs.includes('报名已提交') && detailTs.includes('等待审核'),
  'SIGNUP_PENDING_TEXT: pending 文案为「报名已提交，等待审核」（非 approved）',
);
check(
  detailTs.includes('审核已通过') && detailTs.includes('请前往签到'),
  'SIGNUP_APPROVED_TEXT: APPROVED 文案为「审核已通过，请前往签到」',
);
check(
  detailTs.includes('报名未通过审核'),
  'SIGNUP_REJECTED_TEXT: REJECTED 文案为「报名未通过审核」',
);

// ============================================================
// 7) SIGNUP DEADLINE（§5）：映射真实 signup_deadline，渲染「报名截止」，无伪造
// ============================================================
check(
  /signup_deadline:\s*a\.signup_deadline/.test(detailTs),
  'DEADLINE_MAPPED: detail.ts 映射真实字段 a.signup_deadline',
);
check(
  !/signupDeadlineText:\s*'/.test(detailTs),
  'DEADLINE_NO_FAKE_LITERAL: signupDeadlineText 非硬编码字面值',
);
check(
  /报名截止/.test(detailWxml) &&
    /activity\.signupDeadlineText/.test(detailWxml) &&
    /wx:if="{{activity\.signupDeadlineText}}"/.test(detailWxml),
  'DEADLINE_RENDERED: wxml 以 wx:if 渲染「报名截止」行（有值才显示，无值不伪造）',
);

// ============================================================
// 8) ACTIVITY STATUS（§6）：权威生命周期 enum 1/2/3/4
// ============================================================
const ml = detailTs.match(/mapLifecycleStatus\(status[^)]*\)[^}]*\{(\s*[\s\S]*?)\}/);
const mlBody = ml ? ml[1] : '';
check(
  /case 1:\s*return '报名中'/.test(mlBody) &&
    /case 2:\s*return '进行中'/.test(mlBody) &&
    /case 3:\s*return '已结束'/.test(mlBody) &&
    /case 4:\s*return '已取消'/.test(mlBody),
  'LIFECYCLE_ENUM: mapLifecycleStatus 对齐权威 enum（1报名中/2进行中/3已结束/4已取消）',
);
check(
  /default:\s*return '';/.test(mlBody),
  'LIFECYCLE_NO_FABRICATED: 非 1-4 状态返回空（无伪造状态）',
);
check(
  /活动状态/.test(detailWxml) &&
    /activity\.lifecycleStatusText/.test(detailWxml) &&
    /wx:if="{{activity\.lifecycleStatusText}}"/.test(detailWxml),
  'LIFECYCLE_RENDERED: wxml 以 wx:if 渲染「活动状态」行',
);

// ============================================================
// 9) TEAM IDENTITY（§7）：平台表达，不冒充主办团队
// ============================================================
check(
  /host-name">嘉禾志愿/.test(detailWxml) && /提供平台服务/.test(detailWxml),
  'TEAM_PLATFORM_EXPRESSION: 主办方表达为「嘉禾志愿 / 提供平台服务」',
);
check(
  !/嘉兴市嘉禾志愿服务中心/.test(detailWxml),
  'TEAM_NOT_ORGANIZER: 不再硬编码冒充「嘉兴市嘉禾志愿服务中心」为主办团队',
);

// ============================================================
// 10) GUIDE（§8 DEFERRED）与 AGE（§9）：不伪造
// ============================================================
check(
  !/活动攻略|guide_url|guideUrl|活动指南/.test(combined),
  'GUIDE_DEFERRED: 无伪造活动攻略（guide）URL（backend field NOT FOUND → DEFERRED）',
);
check(
  !/年龄/.test(detailWxml) && !/age_requirement|ageRequirement/.test(detailTs),
  'AGE_NO_FABRICATED: 无伪造年龄要求字段',
);

// ============================================================
// 11) ATTENDANCE（§10）：Foundation 兼容，单 active-session，仍路由 sign/activity/index
// ============================================================
check(
  /wx\.navigateTo\(\{\s*url:\s*`\/pages\/sign\/activity\/index/.test(detailTs),
  'ATTENDANCE_SINGLE_PATH: proceedToCheckin 仍路由 /pages/sign/activity/index',
);
check(
  !/\/pages\/sign\/sign['"`]/.test(detailTs),
  'ATTENDANCE_NO_SECOND_SESSION: 不跳转旧 tabBar hub /pages/sign/sign（无第二套 active-session）',
);
check(
  /getParticipationSetup/.test(detailTs) && /ensureParticipation/.test(detailTs),
  'ATTENDANCE_FOUNDATION_COMPAT: 复用 G1 participation setup/ensure（不改 backend）',
);

// ============================================================
// 12) VISUAL（§11）：保留 2.0 detail-v2 设计资产，仍被引用
// ============================================================
check(
  /images\/detail-v2\/icon-check\.svg/.test(detailWxml) &&
    /images\/detail-v2\/icon-time\.svg/.test(detailWxml) &&
    /images\/detail-v2\/icon-insurance\.svg/.test(detailWxml),
  'VISUAL_DETAIL_V2_ASSETS: detail-v2 SVG 资产（icon-check/icon-time/icon-insurance）仍被引用',
);

// ============================================================
// 13) 受保护文件（源码级 proxy；git diff 为权威判定，见 §14）
// ============================================================
check(
  !/workers\/|migrations\/|trainingApi|0042/.test(detailTs),
  'PROTECTED_PROXY: detail.ts 未引用 workers/migrations/trainingApi/0042 等受保护域',
);

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
