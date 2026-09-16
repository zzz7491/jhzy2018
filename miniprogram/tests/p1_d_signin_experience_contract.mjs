// tests/p1_d_signin_experience_contract.mjs
// P1-D 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「签到 / 签退体验」前端闭环契约（Backend Authority First；仅 UX 收敛，不新增 / 不修改业务规则）。
// 覆盖：签到成功 / 签到失败 / 重复签到 / 重复签退 / 定位失败 / 权限拒绝 / 网络失败 /
//       按钮立即变化 / 状态刷新 / loading / toast / 统一异常 / 错误横幅 + 重试 / 导航。
// 二维码（⑨⑩⑪）记为【已递延缺口】：后端无志愿者扫码签到端点，且 QR 生成为组织方职责（超出 P1-D 范围）；
//   本合同断言 checkin 仅经 activityApi（后端权威），不引入第二签到路径（无 wx.scanCode 直接签到）。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  signTs: `${ROOT}/miniprogram/pages/sign/activity/index.ts`,
  signWxml: `${ROOT}/miniprogram/pages/sign/activity/index.wxml`,
  signScss: `${ROOT}/miniprogram/pages/sign/activity/index.scss`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
  attendanceService: `${ROOT}/workers/src/services/attendance-service.ts`,
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

// ---- 0) 后端权威：checkin/checkout 走 activityApi（/api/v2），绝不回退 legacy PHP ----
check(/activityApi\s*\n?\s*\.checkin\(/.test(F.signTs) || /activityApi\.checkin\(/.test(F.signTs), 'sign.ts calls activityApi.checkin (backend API)');
check(/activityApi\s*\n?\s*\.checkout\(/.test(F.signTs) || /activityApi\.checkout\(/.test(F.signTs), 'sign.ts calls activityApi.checkout (backend API)');
check(/\/attendance\/checkin/.test(F.activityApi), 'activityApi.checkin targets POST /activities/:id/attendance/checkin');
check(/\/attendance\/checkout/.test(F.activityApi), 'activityApi.checkout targets POST /activities/:id/attendance/checkout');

// ---- 1) 不伪造状态：location 不入 storage；不写第二考勤模型；checkinStatus 不硬编码 ----
check(/wx\.getLocation/.test(F.signTs), 'sign.ts uses wx.getLocation for attendance GPS');
check(!/setStorageSync\([^)]*latitude/.test(F.signTs) && !/setStorageSync\([^)]*longitude/.test(F.signTs), 'sign.ts does NOT persist precise location to storage');
check(!/attendance_sessions/.test(F.signTs), 'sign.ts does NOT write a second attendance model (attendance_sessions)');
// checkinStatus=1 只在「成功」或「已签到(409)」分支置位（非初始化硬编码）
check(/setData\(\{\s*isChecking:\s*false,\s*checkinStatus:\s*1\s*\}\)/.test(F.signTs), 'sign.ts sets checkinStatus:1 only on checkin success (exact pattern preserved)');

// ---- 2) 签到成功：精确 setData 形态 + Toast success（按钮立即变化） ----
check(/onSigninTap\(\)\s*\{[\s\S]*?this\.setData\(\{\s*isChecking:\s*false,\s*checkinStatus:\s*1\s*\}\)/.test(F.signTs), 'checkin success sets checkinStatus:1 (button changes immediately)');
check(/wx\.showToast\(\{\s*title:\s*'签到成功'/.test(F.signTs), 'checkin success shows 签到成功 Toast');

// ---- 3) 签退成功：精确 setData 形态 + navigateBack（真实刷新由详情页完成） ----
check(/onSignoutTap\(\)\s*\{[\s\S]*?this\.setData\(\{\s*isChecking:\s*false,\s*checkinStatus:\s*2\s*\}\)/.test(F.signTs), 'checkout success sets checkinStatus:2 (button changes immediately)');
check(/wx\.navigateBack\(\)/.test(F.signTs), 'sign.ts navigateBack after checkout (detail refreshes real state)');

// ---- 4) 统一状态机：phase (idle/submitting/success/error) + errorText + errorAction ----
check(/phase:\s*'idle'/.test(F.signTs), 'sign.ts defines phase state machine (idle)');
check(/'submitting'|"submitting"/.test(F.signTs), 'phase includes submitting (loading)');
check(/'success'|"success"/.test(F.signTs), 'phase includes success');
check(/'error'|"error"/.test(F.signTs), 'phase includes error');
check(/errorText/.test(F.signTs), 'sign.ts defines errorText (error banner)');
check(/errorAction/.test(F.signTs), 'sign.ts defines errorAction (retry/qualification)');

// ---- 5) loading：进入请求前 isChecking=true（统一 loading 收尾） ----
const signinBody = F.signTs.split('async onSigninTap()')[1] || '';
check(/this\.setData\(\{\s*isChecking:\s*true/.test(signinBody), 'onSigninTap sets isChecking:true before request (loading)');
const signoutBody = F.signTs.split('onSignoutTap()')[1] || '';
check(/this\.setData\(\{\s*isChecking:\s*true/.test(signoutBody), 'onSignoutTap sets isChecking:true before request (loading)');

// ---- 6) 统一异常：reportCheckinError / reportCheckoutError 集中映射 ----
check(/reportCheckinError/.test(F.signTs), 'sign.ts defines reportCheckinError (centralized error mapping)');
check(/reportCheckoutError/.test(F.signTs), 'sign.ts defines reportCheckoutError (centralized error mapping)');
// 所有错误分支均复位 isChecking（统一 loading 收尾，无悬挂 loading）
check(/reportCheckinError\(err: any\)\s*\{[\s\S]*?this\.setData\(\{\s*isChecking:\s*false,\s*phase:\s*'error'/.test(F.signTs), 'reportCheckinError resets isChecking + sets phase:error');
check(/reportCheckoutError\(err: any\)\s*\{[\s\S]*?this\.setData\(\{\s*isChecking:\s*false,\s*phase:\s*'error'/.test(F.signTs), 'reportCheckoutError resets isChecking + sets phase:error');
// 统一为单一 Toast 风格：签到/签退异常不使用 wx.showModal（避免多套风格）
check(!/wx\.showModal/.test(F.signTs), 'sign.ts does NOT use wx.showModal for attendance errors (unified Toast style)');

// ---- 7) 后端错误码覆盖（前端不复制规则，仅映射展示） ----
check(/ATTENDANCE_ALREADY_CHECKED_IN/.test(F.signTs), 'checkin maps ATTENDANCE_ALREADY_CHECKED_IN (idempotent)');
check(/ATTENDANCE_NOT_SIGNED_UP/.test(F.signTs), 'checkin maps ATTENDANCE_NOT_SIGNED_UP');
check(/ATTENDANCE_PARTICIPATION_NOT_ACTIVE/.test(F.signTs), 'checkin maps ATTENDANCE_PARTICIPATION_NOT_ACTIVE (new coverage)');
check(/PARENT_MISMATCH/.test(F.signTs), 'checkin maps PARENT_MISMATCH (new coverage)');
check(/QUALIFICATION_REQUIRED/.test(F.signTs), 'checkin maps QUALIFICATION_REQUIRED (backend-authoritative gate)');
check(/TEAM_SCOPE_REQUIRED/.test(F.signTs), 'checkin maps TEAM_SCOPE_REQUIRED');
check(/ATTENDANCE_ALREADY_CHECKED_OUT/.test(F.signTs), 'checkout maps ATTENDANCE_ALREADY_CHECKED_OUT (idempotent)');
check(/ATTENDANCE_CHECKIN_REQUIRED/.test(F.signTs), 'checkout maps ATTENDANCE_CHECKIN_REQUIRED');

// ---- 8) 幂等：重复签到/签退 → 本地直接置位（按钮立即变化，不重复请求） ----
const rce = F.signTs.split('reportCheckinError(err: any)')[1] || '';
check(/ATTENDANCE_ALREADY_CHECKED_IN[\s\S]*?this\.setData\(\{\s*checkinStatus:\s*1/.test(rce), 'duplicate checkin → checkinStatus:1 immediately');
const rco = F.signTs.split('reportCheckoutError(err: any)')[1] || '';
check(/ATTENDANCE_ALREADY_CHECKED_OUT[\s\S]*?this\.setData\(\{\s*checkinStatus:\s*2/.test(rco), 'duplicate checkout → checkinStatus:2 immediately');

// ---- 9) 网络失败：err.isNetwork → 统一提示 + 重试横幅 ----
check(/isNetwork\s*\?\s*'网络异常，请稍后重试'/.test(F.signTs), 'network failure maps unified 网络异常，请稍后重试');
check(/errorAction:\s*'retry-checkin'/.test(F.signTs), 'checkin network/unknown error offers retry-checkin');
check(/errorAction:\s*'retry-checkout'/.test(F.signTs), 'checkout network/unknown error offers retry-checkout');

// ---- 10) 定位失败 / 权限拒绝 / GPS 关闭：非阻塞（location 可为 null，后端可选） ----
const gl = F.signTs.split('getLocation(): Promise')[1] || '';
check(/resolve\(\{\s*location:\s*null,\s*denied,\s*gpsOff\s*\}\)/.test(gl), 'getLocation failure resolves null location (non-blocking, backend-optional)');
check(/denied/.test(gl) && /gpsOff/.test(gl), 'getLocation distinguishes permission-denied vs gps-off');
check(/未授权定位，将不影响签到/.test(F.signTs), 'permission denied → non-blocking Toast (签到不受影响)');
check(/请开启手机定位\(GPS\)/.test(F.signTs), 'GPS off → guidance Toast (non-blocking)');

// ---- 11) 错误横幅 + 重试 / 关闭 / 去认证（wxml） ----
check(/att-error-banner/.test(F.signWxml), 'wxml renders error banner (errorText)');
check(/bindtap="onRetryTap"/.test(F.signWxml), 'wxml wires retry to onRetryTap');
check(/bindtap="onErrorDismiss"/.test(F.signWxml), 'wxml wires dismiss to onErrorDismiss');
check(/errorAction === 'retry-checkin' \|\| errorAction === 'retry-checkout'/.test(F.signWxml), 'wxml shows 重试 for retry actions');
check(/errorAction === 'qualification'/.test(F.signWxml), 'wxml shows 去认证 for qualification action');

// ---- 12) onRetryTap：按 errorAction 路由（不伪造） ----
const rt = F.signTs.split('onRetryTap()')[1] || '';
check(/retry-checkin'\)\s*\{\s*this\.onSigninTap\(\)/.test(rt), 'onRetryTap retry-checkin → onSigninTap');
check(/retry-checkout'\)\s*\{\s*this\.onSignoutTap\(\)/.test(rt), 'onRetryTap retry-checkout → onSignoutTap');
check(/qualification'\)\s*\{[\s\S]*?wx\.switchTab\(\{\s*url:\s*'\/pages\/mine\/mine'\s*\}\)/.test(rt), 'onRetryTap qualification → switchTab /pages/mine/mine (official, no fake page)');

// ---- 13) 状态刷新：loadCheckinStatus → loadActivityDetail（不本地伪造） ----
check(/loadCheckinStatus\(\)\s*\{[\s\S]*?this\.loadActivityDetail\(\)/.test(F.signTs), 'loadCheckinStatus refreshes via loadActivityDetail (backend source)');

// ---- 14) 二维码（⑨⑩⑪）已递延：无志愿者侧扫码直接签到路径（保持后端权威） ----
check(!/wx\.scanCode/.test(F.signTs), 'sign.ts has NO volunteer-side wx.scanCode checkin (QR deferred; backend-authoritative only)');
check(/列为【已递延缺口】|已递延|QR/.test(F.signTs) || /二维码扫码签到：当前志愿者侧无扫码入口/.test(F.signTs), 'sign.ts documents QR checkin as deferred gap (backend-authoritative)');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
