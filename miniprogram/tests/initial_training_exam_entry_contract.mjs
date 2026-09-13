// tests/initial_training_exam_entry_contract.mjs
// M2 产品合同测试（窄、确定性、无网络、无 D1）：
// 验证「初始培训 + 考试」用户主链路在前端与后端的契约闭环。
// 覆盖 B6 全部要求：入口可达、指向 INITIAL_VOLUNTEER、不以 required=1 替代 purpose、
// 20 题、>=90 通过、证书≠资格、资格刷新、前端不自算 qualified。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  mineWxml: `${ROOT}/miniprogram/pages/mine/mine.wxml`,
  mineTs: `${ROOT}/miniprogram/pages/mine/mine.ts`,
  trainingApi: `${ROOT}/miniprogram/utils/trainingApi.ts`,
  trainingTs: `${ROOT}/miniprogram/pages/training/training.ts`,
  trainingsTs: `${ROOT}/miniprogram/pages/trainings/trainings.ts`,
  examTakeTs: `${ROOT}/miniprogram/pages/exam/take.ts`,
  examResultTs: `${ROOT}/miniprogram/pages/exam/result.ts`,
  qualApi: `${ROOT}/miniprogram/utils/qualificationApi.ts`,
  examService: `${ROOT}/workers/src/services/exam-service.ts`,
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

// 1) 资格卡「初始培训考试」项存在明确 action（入口可达）
check(/初始培训考试/.test(F.mineWxml), 'qualification card shows 初始培训考试 item');
check(/bindtap="goToInitialTraining"/.test(F.mineWxml), '初始培训考试 item bindtap=goToInitialTraining (entry action)');
check(/去完成/.test(F.mineWxml), 'shows 去完成 action when not passed');
check(/class="arrow"/.test(F.mineWxml), 'item shows navigation arrow');

// 2) 入口实现指向初始培训页
check(/goToInitialTraining\s*\(/.test(F.mineTs), 'mine.ts defines goToInitialTraining');
check(/goToInitialTraining[\s\S]*?\/pages\/training\/training/.test(F.mineTs), 'goToInitialTraining navigates to /pages/training/training');
check(/isLoggedIn/.test(F.mineTs) && /showLoginModal\(\)/.test(F.mineTs), 'goToInitialTraining guards login');

// 3) 前端 API 暴露 purpose（识别 INITIAL_VOLUNTEER 课程所需）
check(/interface CourseView[\s\S]*?purpose\?: string/.test(F.trainingApi), 'trainingApi CourseView exposes purpose field');

// 4) training.ts deriveExamEntry 锁定 INITIAL_VOLUNTEER purpose（不以 required=1 推断）
check(/deriveExamEntry[\s\S]*?purpose === 'INITIAL_VOLUNTEER'/.test(F.trainingTs), 'deriveExamEntry prefers purpose=INITIAL_VOLUNTEER');
check(/INITIAL_VOLUNTEER/.test(F.trainingTs), 'training.ts references INITIAL_VOLUNTEER');

// 5) trainings.ts 不再用 required===1 / 选修完成 作为考试资格闸门
check(!/requiredCompleted\s*&&\s*electiveCompleted/.test(F.trainingsTs), 'trainings.ts does NOT gate exam by requiredCompleted&&electiveCompleted');
check(/purpose === 'INITIAL_VOLUNTEER'/.test(F.trainingsTs), 'trainings.ts targets INITIAL_VOLUNTEER course via purpose');
check(/exam\.eligible/.test(F.trainingsTs), 'trainings.ts bases eligibility on backend exam.eligible (not self-computed)');

// 6) 考试严格 20 题（后端生产不变量）
check(/INITIAL_VOLUNTEER_EXAM_QUESTION_COUNT\s*=\s*20/.test(F.examService), 'backend INITIAL_VOLUNTEER question count = 20');
check(/questions\.length\s*!==\s*INITIAL_VOLUNTEER_EXAM_QUESTION_COUNT/.test(F.examService), 'backend enforces exactly 20 questions at start');

// 7) >=90 通过（后端生产不变量）
check(/INITIAL_VOLUNTEER_PASS_SCORE\s*=\s*90/.test(F.examService), 'backend INITIAL_VOLUNTEER pass score = 90');
check(/resolvePassScore[\s\S]*?INITIAL_VOLUNTEER_PURPOSE\)\s*return INITIAL_VOLUNTEER_PASS_SCORE/.test(F.examService), 'backend resolvePassScore returns 90 for INITIAL_VOLUNTEER');

// 8) 考试前端不本地算分、不自算 qualified
check(/trainingApi\.(startExam|submitExam)/.test(F.examTakeTs), 'exam/take uses backend startExam/submitExam (server-authoritative)');
check(!/qualified\s*=\s*true/.test(F.examTakeTs) && !/qualified:\s*true/.test(F.examTakeTs), 'exam/take does NOT set qualified=true');
check(/result\.passed/.test(F.examResultTs), 'exam/result displays server result.passed');
check(/result\.certificate/.test(F.examResultTs), 'exam/result displays server-issued certificate');
check(!/qualified\s*=\s*true/.test(F.examResultTs) && !/qualified:\s*true/.test(F.examResultTs), 'exam/result does NOT set qualified=true');

// 9) 资格状态：后端唯一权威，前端只读取、不自算
const qualBody = F.qualApi;
check(/interface VolunteerQualification[\s\S]*?initial_training_exam_passed/.test(qualBody), 'qualificationApi exposes initial_training_exam_passed');
check(/reasons/.test(qualBody), 'qualificationApi exposes reasons[] (TRAINING_EXAM_REQUIRED token)');
check(/getStatus\(\)/.test(qualBody), 'qualificationApi.getStatus reads backend projection only');

// 10) 资格刷新：mine.onShow -> loadVolunteerQualification -> getStatus（通过后回资格页能刷新）
check(/onShow[\s\S]*?loadVolunteerQualification/.test(F.mineTs), 'mine.onShow triggers loadVolunteerQualification');
check(/loadVolunteerQualification[\s\S]*?qualificationApi[\s\S]*?getStatus/.test(F.mineTs), 'loadVolunteerQualification calls qualificationApi.getStatus');

// 11) 前端整体不自造 qualified（mine.ts 不手动写 qualified=true）
check(!/qualified:\s*true/.test(F.mineTs) && !/qualified\s*=\s*true/.test(F.mineTs), 'mine.ts never fabricates qualified=true');

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
