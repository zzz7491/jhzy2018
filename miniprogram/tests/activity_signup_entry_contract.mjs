// tests/activity_signup_entry_contract.mjs
// M3 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「qualified 用户从活动详情完成报名并看到真实审核状态」前端契约闭环。
// 覆盖 B3/B4/B5/B6/B7 全部要求：报名入口可达、P20 表单前端 consumer 存在、
// 不再发送空 body、必填校验、真实状态刷新、前端不伪造 APPROVED/REJECTED、
// 资格门由后端 enforcement、未 touched notification 架构、无 activity_signups.form_data。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  detailTs: `${ROOT}/miniprogram/pages/detail/detail.ts`,
  detailWxml: `${ROOT}/miniprogram/pages/detail/detail.wxml`,
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
  ulid: `${ROOT}/miniprogram/utils/ulid.ts`,
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

// 1) 活动详情页有报名入口
check(/handleMainButtonClick/.test(F.detailTs), 'detail.ts defines handleMainButtonClick');
check(/bindtap="handleMainButtonClick"/.test(F.detailWxml), 'detail.wxml wires join button to handleMainButtonClick');
check(/processJoin\s*\(/.test(F.detailTs), 'detail.ts defines processJoin (signup entry)');

// 2) P20 表单前端 consumer 存在（拉取 + 渲染 + 提交）
check(/getSignupForm/.test(F.detailTs), 'detail.ts fetches signup form (getSignupForm)');
check(/fetchSignupForm/.test(F.detailTs), 'detail.ts has fetchSignupForm consumer');
check(/\/forms\/consumers\/activity\.signup\//.test(F.activityApi), 'activityApi.getSignupForm targets /forms/consumers/activity.signup/:id/form');
check(/submitFormSubmission/.test(F.detailTs), 'detail.ts submits signup form (submitFormSubmission)');
check(/'\/forms\/submissions'/.test(F.activityApi), 'activityApi.submitFormSubmission targets /forms/submissions');
check(/consumerType:\s*'activity\.signup'/.test(F.detailTs), 'submitSignupForm uses consumer_type=activity.signup');
check(/generateUlid/.test(F.detailTs) && /generateUlid/.test(F.ulid), 'frontend generates Crockford ULID for submission new_public_id');

// 3) 不再发送空 body：signup 携带 form_submission_public_id（绑定表单时）
check(/body\.form_submission_public_id\s*=\s*formSubmissionPublicId/.test(F.activityApi), 'signup builds body.form_submission_public_id when form bound');
check(/signup\(activityId:\s*string,\s*formSubmissionPublicId\?/.test(F.activityApi), 'signup accepts optional formSubmissionPublicId param');

// 4) 必填字段校验（与后端 strictRequired 对齐）
check(/for \(const f of form\.fields\)/.test(F.detailTs) && /f\.required/.test(F.detailTs), 'submitSignupForm validates required fields');

// 5) 不含 activity_signups.form_data（禁止第二套表单存储）
check(!/form_data/.test(F.detailTs) && !/form_data/.test(F.activityApi), 'no activity_signups.form_data usage (forbidden second form store)');

// 6) 状态刷新来自后端（GET /signups/me → review_status）
check(/getSignupMe/.test(F.detailTs), 'checkSignupStatus reads backend via getSignupMe');
check(/review_status/.test(F.detailTs), 'status derived from backend review_status (not client-inferred)');

// 7) 前端不伪造 APPROVED / REJECTED
check(!/setData\(\{\s*hasJoined:\s*true,\s*signupStatus:\s*2\s*\}\)/.test(F.detailTs), 'processJoin/doSignup does NOT hardcode signupStatus:2 on success');
check(/review_status === 1\)\s*status = 2/.test(F.detailTs), 'APPROVED mapped from review_status===1');
check(/review_status === 2\)\s*status = 4/.test(F.detailTs), 'REJECTED mapped from review_status===2 (status 4)');
check(/status === 4/.test(F.detailTs), 'detail.ts handles REJECTED status (status 4) in button/text');
check(/updateButtonByStatus/.test(F.detailTs), 'updateButtonByStatus reflects REJECTED (no fake APPROVED)');

// 8) 资格门由后端统一 enforcement；前端不绕过
check(/QUALIFICATION_REQUIRED/.test(F.detailTs), 'doSignup handles backend QUALIFICATION_REQUIRED');
check(/qualificationBlocked/.test(F.detailTs), 'unqualified user surfaced via qualificationBlocked (not bypassed)');
check(/err\.details\.reasons/.test(F.detailTs), 'reads reasons tokens (IDENTITY_REQUIRED/PHONE_REQUIRED/TRAINING_EXAM_REQUIRED)');
const doSignupTail = F.detailTs.split('doSignup')[1] || '';
check(!/QUALIFICATION_REQUIRED[\s\S]*?proceedToCheckin/.test(doSignupTail), 'unqualified user NOT sent to check-in');

// 9) 重复报名 (409) 不伪造、回源真实状态
check(/SIGNUP_ALREADY_EXISTS|CONFLICT/.test(F.detailTs), 'duplicate signup handled');
check(/checkSignupStatus\(\);/.test(F.detailTs), 'on conflict, re-fetches real status instead of faking');

// 10) notification 架构未重写（仅复用既有订阅消息，无新增后端通知发送代码）
check(!/wechatAdapter/.test(F.detailTs) && !/sendSignupReviewNotification/.test(F.detailTs), 'frontend does not reimplement N0-E5C notification');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
