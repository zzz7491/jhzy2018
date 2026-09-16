// tests/p1_c5_qualification_experience_contract.mjs
// P1-C5 志愿者资格（Qualification）体验闭环 —— 产品合同测试（窄、确定性、无网络、无 D1）。
// 验证：后端返回 QUALIFICATION_REQUIRED 时前端立即终止报名流程、显示统一资格提示、
// 提供「去完成资格」官方入口、不自行判断资格、不新增状态、不修改后端。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  detailTs: `${ROOT}/miniprogram/pages/detail/detail.ts`,
  detailWxml: `${ROOT}/miniprogram/pages/detail/detail.wxml`,
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

// 1) 后端 QUALIFICATION_REQUIRED 由前端 doSignup catch 处理（Backend Authority First）
check(/QUALIFICATION_REQUIRED/.test(F.detailTs), 'doSignup handles backend QUALIFICATION_REQUIRED');

// 2) 提取 QUALIFICATION_REQUIRED catch 分支（从 if 到其 return），用于局部断言
const qStart = F.detailTs.indexOf("if (code === 'QUALIFICATION_REQUIRED')");
check(qStart >= 0, 'QUALIFICATION_REQUIRED branch exists in doSignup catch');
const afterQ = F.detailTs.slice(qStart);
const qBranch = afterQ.slice(0, afterQ.indexOf('return;') + 'return;'.length);
check(/return;/.test(qBranch), 'QUALIFICATION_REQUIRED branch terminates via return (stops signup flow)');

// 3) 收到 QUALIFICATION_REQUIRED → 立即终止，不进入 P20 表单 / 不二次 POST signup / 不进入签到
check(!/showFormModal/.test(qBranch), 'on QUALIFICATION_REQUIRED: does NOT open P20 form modal');
check(!/fetchSignupForm/.test(qBranch), 'on QUALIFICATION_REQUIRED: does NOT fetch signup form (P20)');
check(!/this\.doSignup\(/.test(qBranch), 'on QUALIFICATION_REQUIRED: does NOT re-POST signup');
check(!/this\.processJoin\(/.test(qBranch), 'on QUALIFICATION_REQUIRED: does NOT re-enter processJoin');
check(!/proceedToCheckin/.test(qBranch), 'on QUALIFICATION_REQUIRED: does NOT proceed to check-in');

// 4) 显示统一资格提示（wx.showModal + 引导文案）
check(/wx\.showModal/.test(qBranch), 'on QUALIFICATION_REQUIRED: shows unified modal prompt');
check(/尚不具备报名资格/.test(qBranch), 'qualification modal title = 尚不具备报名资格');
check(/qualificationGuidance\(/.test(qBranch), 'qualification prompt text derived from qualificationGuidance (reasons→人话)');

// 5) 提供「去完成资格」入口（跳官方页面；不伪造页面）
check(/goCompleteQualification/.test(F.detailTs), 'goCompleteQualification method defined');
check(/switchTab\(\{\s*url:\s*'\/pages\/mine\/mine'\s*\}/.test(F.detailTs), 'goCompleteQualification switches to official 我的 page (tabBar, real qualification hub)');
check(/res\.confirm\)\s*this\.goCompleteQualification\(\)/.test(qBranch), 'modal confirm triggers goCompleteQualification entry');
check(/bindtap="goCompleteQualification"/.test(F.detailWxml), 'wxml renders 去完成资格 entry bound to goCompleteQualification');
check(/wx:if="{{qualificationBlocked}}"/.test(F.detailWxml), 'wxml shows persistent qualification banner when blocked');

// 6) 前端绝不自行判断资格（不复制资格规则 / 不预检）
check(!/getVolunteerQualification\(/.test(F.detailTs), 'detail.ts does NOT call qualification API to self-judge (Backend Authority)');
check(!/assertVolunteerQualified/.test(F.detailTs), 'detail.ts does NOT assert qualification locally');

// 7) 不新增资格状态 / 不修改 signupStatus 枚举（资格仅用 qualificationBlocked 标志位，不引入新报名状态值）
check(!/signupStatus\s*=\s*[0-9]/.test(qBranch), 'QUALIFICATION_REQUIRED branch does NOT assign a new signupStatus value');
check(!/qualificationStatus/.test(F.detailTs), 'no new qualification status field invented');

// 8) reasons token 透传（IDENTITY_REQUIRED / PHONE_REQUIRED / TRAINING_EXAM_REQUIRED）
check(/err\.details\.reasons/.test(F.detailTs), 'reads reasons tokens from backend error.details.reasons');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
