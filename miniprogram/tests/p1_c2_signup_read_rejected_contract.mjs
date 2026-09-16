// tests/p1_c2_signup_read_rejected_contract.mjs
// P1-C2 读路径状态机契约（窄、确定性、无网络、无 D1）：
// 仅验证 GET /signups/me 读路径 checkSignupStatus 对 REJECTED(review_status===2) 的映射，
// 必须与 doSignup 写路径一致 → signupStatus = 4（报名未通过），
// 不得再出现 REJECTED → 待审核(1)。不修改任何其它 Contract。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const detailTs = `${ROOT}/miniprogram/pages/detail/detail.ts`;

let src;
try {
  src = readFileSync(detailTs, 'utf8');
} catch (e) {
  console.error(`[FATAL] cannot read ${detailTs}: ${e.message}`);
  process.exit(2);
}

// 抽取 checkSignupStatus 方法体（GET /signups/me 读路径），用于局部断言，避免命中 doSignup 写路径。
const m = src.match(/checkSignupStatus\(\)\s*\{([\s\S]*?)\n  \}/);
const readBody = m ? m[1] : '';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}`); }
}

// 1) 读路径身份确认：GET /signups/me
check(/getSignupMe/.test(readBody), 'checkSignupStatus is the GET /signups/me read path (calls getSignupMe)');

// 2) REJECTED → signupStatus = 4（读路径与写路径一致）
check(/review_status === 2\)\s*status = 4/.test(readBody), 'GET /signups/me REJECTED(review_status===2) → signupStatus=4');

// 3) APPROVED → signupStatus = 2（保持，未回归）
check(/review_status === 1\)\s*status = 2/.test(readBody), 'GET /signups/me APPROVED(review_status===1) → signupStatus=2 (unchanged)');

// 4) 回归守卫：读路径不得再使用 review_status === 1 ? 2 : 1 三元（曾将 REJECTED 错归为 待审核=1）
check(!/review_status === 1\s*\?\s*2\s*:\s*1/.test(readBody), 'read path no longer collapses REJECTED into ternary (? 2 : 1)');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
