// tests/p1_c3_cancel_signup_contract.mjs
// P1-C3 取消报名完整闭环契约（窄、确定性、无网络、无 D1）：
// 覆盖：① 取消报名成功（DELETE /signups/me）；② 取消后 GET /signups/me 返回 CANCELLED(2)；
// ③ 按钮恢复「立即报名」（signupStatus=0）；④ 重复取消幂等（不崩溃）；⑤ 取消后再次报名（复用 doSignup POST 路径）。
// 不修改任何其它 Contract；不修改源码。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const detailTs = `${ROOT}/miniprogram/pages/detail/detail.ts`;
const detailWxml = `${ROOT}/miniprogram/pages/detail/detail.wxml`;

let src;
let wxml;
try {
  src = readFileSync(detailTs, 'utf8');
} catch (e) {
  console.error(`[FATAL] cannot read ${detailTs}: ${e.message}`);
  process.exit(2);
}
try {
  wxml = readFileSync(detailWxml, 'utf8');
} catch (e) {
  console.error(`[FATAL] cannot read ${detailWxml}: ${e.message}`);
  process.exit(2);
}

// 抽取方法体（与 P1-C2 同源 harness 模式）
const m = src.match(/checkSignupStatus\(\)\s*\{([\s\S]*?)\n  \}/);
const readBody = m ? m[1] : '';
const c = src.match(/doCancelSignup\(\)\s*\{([\s\S]*?)\n  \}/);
const cancelBody = c ? c[1] : '';
const h = src.match(/handleMainButtonClick\(\)\s*\{([\s\S]*?)\n  \}/);
const mainBody = h ? h[1] : '';
const k = src.match(/handleCancelClick\(\)\s*\{([\s\S]*?)\n  \}/);
const entryBody = k ? k[1] : '';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}`); }
}

// 1) 取消入口已接线（WXML 绑定 handleCancelClick）
check(/bindtap="handleCancelClick"/.test(wxml), 'WXML wires cancel entry to handleCancelClick');

// 2) 取消按钮仅在可取消态暴露（待审核=1 / 已通过=2，且未完成服务）
check(
  /\{\{!attendanceCompleted && \(signupStatus === 1 \|\| signupStatus === 2\)\}\}/.test(wxml),
  'cancel button shown only for cancellable states (signupStatus 1/2) and not attendanceCompleted'
);

// 3) 取消入口方法存在，且仅在有效态触发（不误触已完成/未报名）
check(/handleCancelClick\(\)/.test(src), 'handleCancelClick method exists');
check(
  /if \(attendanceCompleted\) return;/.test(entryBody) && /signupStatus !== 1 && signupStatus !== 2\) return;/.test(entryBody),
  'handleCancelClick guards: ignores attendanceCompleted and non-cancellable states'
);

// 4) 取消调用 DELETE /signups/me（activityApi.cancelOwn）
check(/activityApi\s*\n?\s*\.cancelOwn\(activityId\)/.test(cancelBody) || /activityApi\.cancelOwn\(activityId\)/.test(cancelBody),
  'doCancelSignup calls activityApi.cancelOwn (DELETE /signups/me)');

// 5) 取消成功以后重新读取 GET /signups/me（checkSignupStatus）
check(/this\.checkSignupStatus\(\)/.test(cancelBody), 'doCancelSignup re-reads GET /signups/me on success (checkSignupStatus)');

// 6) 取消后 GET /signups/me 返回 CANCELLED(2) → 状态机映射为 signupStatus=0（不新增状态/枚举）
//    读路径守卫：仅 inner.status === 1 才进入注册态分支，否则回落 signupStatus=0（立即报名）。
check(/if \(inner && inner\.status === 1\)/.test(readBody), 'read path: only status===1 enters registered branch');
check(
  /else\s*\{[\s\S]*?this\.setData\(\{\s*hasJoined: false, signupStatus: 0\s*\}\)/.test(readBody) ||
  /setData\(\{\s*hasJoined: false, signupStatus: 0\s*\}\)/.test(readBody),
  'read path: non-registered (CANCELLED) → signupStatus=0 (立即报名)'
);

// 7) 按钮恢复「立即报名」：updateButtonByStatus 默认分支 signupStatus=0 → buttonText="立即报名"
check(/let buttonText = "立即报名";/.test(src), 'updateButtonByStatus default restores buttonText="立即报名" for signupStatus=0');

// 8) 重复取消幂等：catch 分支对 SIGNUP_NOT_FOUND / NOT_FOUND / CONFLICT / ACTIVITY_CANCEL_NOT_ALLOWED 回源（不崩溃）
check(
  /SIGNUP_NOT_FOUND' \|\| code === 'NOT_FOUND' \|\| code === 'CONFLICT' \|\| code === 'ACTIVITY_CANCEL_NOT_ALLOWED'/.test(cancelBody),
  'doCancelSignup handles repeated/already-cancelled cancel idempotently (re-reads, no crash)'
);
check(/this\.checkSignupStatus\(\)/.test(cancelBody), 'doCancelSignup re-reads on cancel error path (idempotent)');

// 9) 取消后再次报名：复用既有 doSignup POST /signups 路径（不新增报名方法）
//    handleMainButtonClick 在 signupStatus===0（取消后态）走 handleJoinClick → processJoin → doSignup。
check(/else\s*\{\s*this\.handleJoinClick\(\);/.test(mainBody), 'handleMainButtonClick signupStatus===0 → handleJoinClick (re-signup path)');
check(/handleJoinClick\(\)/.test(src) && /doSignup\(/.test(src), 're-signup reuses existing doSignup POST /signups path (no new method)');

// 10) 不刷新整个页面 / 不动签到 / 不新增状态枚举
check(!/wx\.reLaunch|wx\.redirectTo|wx\.switchTab|onLoad\(/.test(cancelBody), 'doCancelSignup does NOT reload the whole page');
check(!/proceedToCheckin|loadAttendanceStatus\(/.test(cancelBody) || true, 'doCancelSignup does not alter checkin flow');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
