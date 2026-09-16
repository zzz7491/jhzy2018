// tests/p1_c4_signup_deadline_contract.mjs
// P1-C4 报名截止时间（signup_deadline）治理契约（窄、确定性、无网络、无 D1）：
// 覆盖：① 截止后按钮变为「报名已截止」且禁用；② 未截止仍可报名（立即报名）；
// ③ 点击无效（handleJoinClick 在截止后 return，不进入确认报名 P20 / POST signup）；
// ④ 文案正确（报名已截止）；⑤ 不新增报名状态 / 不修改 signupStatus；
// ⑥ 回归：P1-C3 取消报名、P1-C2 REJECTED→4、P1-C1 hasV2Session、P1-B3 截止字段映射 均不被破坏。
//
// 设计原则（Backend Authority First）：后端 createOwn 当前未在 signup 创建路径强制 signup_deadline，
// 本契约仅针对「前端 UX 门控」做断言（按钮文案/禁用/点击阻断），绝不声明已替代后端权威校验。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const detailTs = `${ROOT}/miniprogram/pages/detail/detail.ts`;
const detailWxml = `${ROOT}/miniprogram/pages/detail/detail.wxml`;

let src;
let wxml;
try {
  src = readFileSync(detailTs, 'utf8').replace(/\r\n/g, '\n');
} catch (e) {
  console.error(`[FATAL] cannot read ${detailTs}: ${e.message}`);
  process.exit(2);
}
try {
  wxml = readFileSync(detailWxml, 'utf8').replace(/\r\n/g, '\n');
} catch (e) {
  console.error(`[FATAL] cannot read ${detailWxml}: ${e.message}`);
  process.exit(2);
}

// 抽取方法体（与 P1-C2 / P1-C3 同源 harness 模式）
const ub = src.match(/updateButtonByStatus\(\)\s*\{([\s\S]*?)\n  \}/);
const updateBody = ub ? ub[1] : '';
const hj = src.match(/handleJoinClick\(\)\s*\{([\s\S]*?)\n  \}/);
const joinBody = hj ? hj[1] : '';
const hm = src.match(/handleMainButtonClick\(\)\s*\{([\s\S]*?)\n  \}/);
const mainBody = hm ? hm[1] : '';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}`); }
}

// 1) updateButtonByStatus 是按钮文案权威（方法存在 & 默认「立即报名」）
check(/updateButtonByStatus\(\)/.test(src), 'updateButtonByStatus method exists');
check(/let buttonText = "立即报名";/.test(updateBody), 'updateButtonByStatus default buttonText="立即报名" (baseline not broken)');

// 2) 截止门控仅作用于 signupStatus===0（不影响 待审核/已通过/签到/取消报名）
check(/else if \(signupStatus === 0\)/.test(updateBody), 'deadline gate scoped to signupStatus===0 only');
check(
  /signupStatus === 1\)\s*\{\s*buttonText = "待审核"/.test(updateBody),
  'regression: signupStatus===1 still 待审核 (unaffected by deadline)'
);
check(
  /signupStatus === 2\)\s*\{[\s\S]*?buttonText = "立即签到";/.test(updateBody),
  'regression: signupStatus===2 still 立即签到 (unaffected by deadline)'
);

// 3) 截止后文案 = 报名已截止（基于 signup_deadline epoch 秒 *1000 <= Date.now()）
check(
  /activity && activity\.signup_deadline/.test(updateBody) && /dl \* 1000 <= Date\.now\(\)/.test(updateBody),
  'updateButtonByStatus computes deadline from real signup_deadline (epoch sec) vs Date.now()'
);
check(/buttonText = "报名已截止";/.test(updateBody), 'updateButtonByStatus shows 报名已截止 when deadline passed');
check(
  /setData\(\{\s*buttonText, buttonBgColor, signupDeadlinePassed: deadlinePassed\s*\}\)/.test(updateBody) ||
  /signupDeadlinePassed: deadlinePassed/.test(updateBody),
  'updateButtonByStatus exposes signupDeadlinePassed flag for wxml disabled binding'
);

// 4) 未截止仍可报名：signupStatus===0 且未截止 → 默认「立即报名」保留（不覆盖）
check(
  /let buttonText = "立即报名";/.test(updateBody) && /buttonText = "报名已截止"/.test(updateBody),
  'not-deadline path keeps 立即报名; deadline path overrides to 报名已截止'
);

// 5) 点击无效：handleJoinClick 在截止后 return，不进入确认报名(P20) / POST signup
check(/handleJoinClick\(\)/.test(src), 'handleJoinClick method exists');
check(
  /const dl = this\.data\.activity && this\.data\.activity\.signup_deadline;/.test(joinBody) &&
  /const deadlinePassed = typeof dl === 'number' && dl > 0 && dl \* 1000 <= Date\.now\(\);/.test(joinBody) &&
  /if \(deadlinePassed\)\s*\{[\s\S]*?return;/.test(joinBody),
  'handleJoinClick blocks (returns) after deadline before any signup action'
);
// 截止 guard 必须在 showConfirmDialog（P20）/ doSignup / processJoin（POST）之前
const idxDeadline = joinBody.indexOf('if (deadlinePassed)');
const idxConfirm = joinBody.indexOf('this.showConfirmDialog()');
const idxDoSignup = joinBody.indexOf('this.doSignup');
const idxProcessJoin = joinBody.indexOf('this.processJoin');
check(
  idxDeadline > -1 &&
  (idxConfirm === -1 || idxDeadline < idxConfirm) &&
  (idxDoSignup === -1 || idxDeadline < idxDoSignup) &&
  (idxProcessJoin === -1 || idxDeadline < idxProcessJoin),
  'deadline guard precedes P20 confirm dialog / POST signup calls in handleJoinClick'
);

// 6) wxml：CTA 按钮在截止态禁用（disabled 绑定 signupDeadlinePassed && signupStatus===0）
check(/bindtap="handleMainButtonClick"/.test(wxml), 'WXML CTA button still wired to handleMainButtonClick');
check(
  /disabled="\{\{signupDeadlinePassed && signupStatus === 0\}\}"/.test(wxml),
  'WXML CTA button disabled when deadline passed and signupStatus===0'
);
check(
  /buttonText === '报名已截止' \? 'cta-btn--disabled'/.test(wxml),
  'WXML applies disabled style for 报名已截止'
);

// 7) 不新增报名状态 / 不修改 signupStatus 定义
check(/signupStatus: 0, \/\/ 0:未报名/.test(src), 'signupStatus enum definition unchanged (0:未报名)');
check(!/signupStatus = 5|signupStatus = 6|signupStatus = 7/.test(src), 'no new signup status value introduced');
check(
  /this\.data\.activity && this\.data\.activity\.signup_deadline/.test(joinBody) ||
  /activity && activity\.signup_deadline/.test(updateBody),
  'deadline check reads real signup_deadline (no fabricated deadline)'
);

// 8) 回归守卫：P1-C3 取消报名闭环不被破坏
check(/handleCancelClick\(\)/.test(src), 'regression: handleCancelClick still present (P1-C3)');
check(
  /activityApi\.cancelOwn\(activityId\)/.test(src) || /activityApi\s*\n?\s*\.cancelOwn\(activityId\)/.test(src),
  'regression: cancelOwn call present (P1-C3)'
);
check(
  /else\s*\{\s*this\.handleJoinClick\(\);/.test(mainBody),
  'regression: handleMainButtonClick signupStatus===0 → handleJoinClick (P1-C3 re-signup path intact)'
);

// 9) 回归守卫：P1-C2 REJECTED→4 / P1-C1 hasV2Session / P1-B3 截止字段映射
check(/review_status === 2\)\s*status = 4/.test(src), 'regression: REJECTED→signupStatus=4 (P1-C2)');
check(/hasV2Session/.test(src), 'regression: V2 session gate present (P1-C1)');
check(/signup_deadline:\s*a\.signup_deadline/.test(src), 'regression: real signup_deadline mapped (P1-B3)');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
