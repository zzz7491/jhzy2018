// tests/attendance_checkin_checkout_contract.mjs
// M4 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「APPROVED 用户 → 签到 → 签退 → 服务记录/时长」前端闭环契约。
// 覆盖 B3/B4/B5/B6/B7/B8/B9 全部要求：仅 APPROVED 可进入考勤流、
// 资格门后端 authoritative、checkin/checkout 走后端 API、前端不伪造签到态、
// 签退须先签到、服务时长来自后端、定位不入 URL/storage/log、无第二套考勤模型、
// 详情页刷新真实态、完成后可见真实服务记录、PENDING/REJECTED 不可签到。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  detailTs: `${ROOT}/miniprogram/pages/detail/detail.ts`,
  detailWxml: `${ROOT}/miniprogram/pages/detail/detail.wxml`,
  // P0-A NAV-CLOSEOUT: 具体活动考勤执行职责已由 pages/sign/sign（GLOBAL ATTENDANCE HUB / TABBAR CENTER）
  // 迁移至 pages/sign/activity/index（NON-TAB ACTIVITY ATTENDANCE EXECUTION PAGE）。
  // 本合同的 checkin/checkout/GPS/navigateBack 断言继续验证执行页。
  signTs: `${ROOT}/miniprogram/pages/sign/activity/index.ts`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
  attendanceService: `${ROOT}/workers/src/services/attendance-service.ts`,
  serviceRecordsRepo: `${ROOT}/workers/src/repository/service-records.ts`,
  locationTs: `${ROOT}/workers/src/utils/location.ts`,
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

// 1) 活动详情页有考勤入口（handleMainButtonClick → proceedToCheckin）
check(/handleMainButtonClick/.test(F.detailTs), 'detail.ts defines handleMainButtonClick');
check(/bindtap="handleMainButtonClick"/.test(F.detailWxml), 'detail.wxml wires main button to handleMainButtonClick');
check(/proceedToCheckin/.test(F.detailTs), 'detail.ts defines proceedToCheckin (attendance entry)');

// 2) 仅 APPROVED(signupStatus===2) 可进入考勤流；PENDING(1)/REJECTED(4) 不可
const hmb = F.detailTs.split('handleMainButtonClick()')[1] || '';
check(/if \(signupStatus === 2\)\s*\{[\s\S]*?this\.proceedToCheckin\(\)/.test(hmb), 'APPROVED(signupStatus===2) calls proceedToCheckin');
check(/else if \(signupStatus === 1\)\s*\{[\s\S]*?待审核/.test(hmb), 'PENDING(signupStatus===1) does NOT reach checkin (shows 待审核)');
check(/else if \(signupStatus === 4\)\s*\{[\s\S]*?报名未通过/.test(hmb), 'REJECTED(signupStatus===4) does NOT reach checkin (shows 报名未通过)');

// 3) 完成后（attendanceCompleted）拦截重复进入
check(/if \(attendanceCompleted\)\s*\{[\s\S]*?wx\.showToast\([^)]*已完成此活动/.test(hmb), 'attendanceCompleted blocks re-entry into attendance flow');

// 4) 资格门由后端统一 enforcement（前端不绕过）
check(/assertVolunteerQualified/.test(F.attendanceService), 'backend attendance-service enforces assertVolunteerQualified (qualification gate)');
check(/QUALIFICATION_REQUIRED/.test(F.detailTs) || /QUALIFICATION_REQUIRED/.test(F.attendanceService), 'QUALIFICATION_REQUIRED surfaced (backend-authoritative gate)');

// 5) checkin 走后端 API（前端不伪造签到态）
check(/activityApi\s*\n?\s*\.checkin\(/.test(F.signTs) || /activityApi\.checkin\(/.test(F.signTs), 'sign.ts calls activityApi.checkin (backend API)');
check(/\/attendance\/checkin/.test(F.activityApi), 'activityApi.checkin targets POST /activities/:id/attendance/checkin');
// 签到态仅在 API 成功后本地置位（非伪造）
check(/setData\(\{\s*isChecking:\s*false,\s*checkinStatus:\s*1\s*\}\)/.test(F.signTs), 'sign.ts sets checkinStatus:1 only inside checkin API success');

// 6) checkout 走后端 API，且须先签到
check(/activityApi\s*\n?\s*\.checkout\(/.test(F.signTs) || /activityApi\.checkout\(/.test(F.signTs), 'sign.ts calls activityApi.checkout (backend API)');
check(/\/attendance\/checkout/.test(F.activityApi), 'activityApi.checkout targets POST /activities/:id/attendance/checkout');
check(/ATTENDANCE_CHECKIN_REQUIRED/.test(F.attendanceService), 'backend checkout requires prior checkin (ATTENDANCE_CHECKIN_REQUIRED)');
check(/ATTENDANCE_ALREADY_CHECKED_OUT/.test(F.attendanceService) || /ATTENDANCE_ALREADY_CHECKED_OUT/.test(F.signTs), 'backend/UI guards duplicate checkout');
// 签退成功后返回详情页触发真实刷新（不本地伪造「已参与」）
check(/wx\.navigateBack\(\)/.test(F.signTs), 'sign.ts navigateBack after checkout (detail refreshes real state)');

// 7) 服务时长来自后端 contract（前端不自算 checkout_at - checkin_at）
check(/CAST\(\(s\.checkout_at - s\.checkin_at\) \/ 60 AS INTEGER\)/.test(F.serviceRecordsRepo), 'service time computed backend-side: (checkout_at - checkin_at)/60 minutes');
check(!/this\.data\.checkin_at - this\.data\.checkout_at/.test(F.signTs), 'sign.ts does NOT compute service time client-side');

// 8) 定位隐私：不入 URL / storage / log
check(/wx\.getLocation/.test(F.signTs), 'sign.ts uses wx.getLocation for attendance GPS');
check(!/setStorageSync\([^)]*latitude/.test(F.signTs) && !/setStorageSync\([^)]*longitude/.test(F.signTs), 'sign.ts does NOT persist precise location to storage');
check(/AttendanceLocation/.test(F.locationTs) && /latitude/.test(F.locationTs) && /longitude/.test(F.locationTs), 'backend location contract: latitude/longitude, GCJ-02, stored only in DB event');
check(F.locationTs.includes('返回 null（不阻断签到）'), 'backend treats missing GPS as optional (no hard location capture)');

// 9) 无第二套考勤模型（前端不直写后端考勤表；不造 activity_signups.form_data 式第二存储）
check(!/attendance_sessions/.test(F.detailTs) && !/attendance_sessions/.test(F.signTs), 'frontend does NOT write a second attendance model (attendance_sessions)');
check(!/form_data/.test(F.detailTs), 'detail.ts does NOT use activity_signups.form_data (no second form store)');

// 10) 详情页刷新真实态（onShow → checkSignupStatus + loadAttendanceStatus）
check(/loadAttendanceStatus/.test(F.detailTs), 'detail.ts defines loadAttendanceStatus (real-state refresh)');
check(/getServiceRecordsMine\(50\)/.test(F.detailTs), 'loadAttendanceStatus reads backend via getServiceRecordsMine (not client-inferred)');
check(/checkActiveCheckin\(\);/.test(F.detailTs), 'onShow triggers real attendance status refresh');
// 完成态仅由后端服务记录推导（非硬编码）：records.find 出现在 attendanceCompleted: true 之前
check(F.detailTs.includes('r.activity_public_id === activity.public_id'), 'attendanceCompleted derived from backend service record for THIS activity');
check(
  F.detailTs.indexOf('records.find') >= 0 &&
    F.detailTs.indexOf('attendanceCompleted: true') > F.detailTs.indexOf('records.find'),
  'attendanceCompleted:true is set only AFTER backend record lookup (not hardcoded)',
);

// 11) 完成后可见真实服务记录（详情页稳定入口展示名称/日期/状态/时长）
check(/attendanceCompleted && serviceRecord/.test(F.detailWxml), 'detail.wxml shows service-record card when completed');
check(/serviceRecord\.minutes/.test(F.detailWxml), 'service-record card shows backend service minutes (service time)');
check(/serviceRecord\.business_service_date/.test(F.detailWxml), 'service-record card shows backend business_service_date');
check(/activity\.title/.test(F.detailWxml), 'service-record card shows activity name');

// 12) 按钮文本反映真实后端态（已完成=已参与；APPROVED=立即签到；REJECTED=报名未通过）
const ubb = F.detailTs.split('updateButtonByStatus() {')[1] || '';
check(/if \(attendanceCompleted\)\s*\{[\s\S]*?已参与/.test(ubb), 'button shows 已参与 when attendanceCompleted (real backend state)');
check(/else if \(signupStatus === 4\)\s*\{[\s\S]*?报名未通过/.test(ubb), 'button shows 报名未通过 for REJECTED (status 4)');
check(!/立即签退/.test(ubb.split('attendanceCompleted')[1] || ''), 'button does NOT show 立即签退 for plain APPROVED (avoids pre-checkin mislabel)');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
