/**
 * P21 Activity Signup × Form Engine —— 专项测试（TEST-ONLY）。
 *
 * 覆盖 P21-P1 J 节 23 项 + REV1 额外 A–D（取消重报同证据/替换、auditor/list 隐私）。
 * fixture = tests/lib/formdb.mjs（migrations 0001–0016; 92/266 seed）。
 *
 * 运行：node --experimental-transform-types --loader ./ts_loader.mjs tests/p21_signup_form.mjs
 */
import { buildFormDb } from './lib/formdb.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { FormService } from '../src/services/form-service';
import { ActivitySignupService } from '../src/services/activity-signup-service';
import { ActivitySignupRepository } from '../src/repository/activity-signups';
import { AppError, ErrorCode, ConflictReason } from '../src/utils/errors';

let pass = 0;
let failCount = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; } else { failCount++; failures.push(msg); console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function makeAuth(uid, tid, role = 'volunteer') {
  return { authenticated: true, userId: uid, teamId: tid, role, roles: [{ role, scopeTeamId: tid }] };
}
function makeFormSvc(env, uid, tid, role = 'volunteer') {
  const auth = makeAuth(uid, tid, role);
  return new FormService({ db: env.db, auth, tenant: { scope: 'TEAM_SCOPED', teamId: tid, userId: uid } });
}
function makeSignupSvc(env, uid, tid, role = 'volunteer') {
  const auth = makeAuth(uid, tid, role);
  return new ActivitySignupService({ db: env.db, auth, tenant: { scope: 'TEAM_SCOPED', teamId: tid, userId: uid } });
}
async function expectThrow(fn, expectedCode, label) {
  try { await fn(); } catch (e) {
    if (e instanceof AppError && e.code === expectedCode) { return e; }
    throw new Error(`${label}: 期望 ${expectedCode}，实际=${e instanceof AppError ? e.code : e?.message}`);
  }
  throw new Error(`${label}: 期望抛出 ${expectedCode}，但未抛`);
}
async function expectConflict(fn, reason, label) {
  const e = await expectThrow(fn, ErrorCode.CONFLICT, label);
  assert(e.details && e.details.reason === reason, `${label}: 409 reason=${reason}（实=${e.details && e.details.reason}）`);
}
async function expectNotFoundReason(fn, reason, label) {
  const e = await expectThrow(fn, ErrorCode.NOT_FOUND, label);
  assert(e.details && e.details.reason === reason, `${label}: 404 reason=${reason}（实=${e.details && e.details.reason}）`);
}
async function scenario(name, fn) {
  const env = await buildFormDb();
  try { await fn(env); } catch (e) { failCount++; failures.push(`${name}: ${e.message}`); console.error(`  ✗ SCENARIO FAIL [${name}]:`, e.message); }
  finally { env.close(); }
}

const FIELDS = [{ key: 'name', label: '姓名', type: 'text', required: true }];
const ANSWERS = { name: '张三' };

/** 建已发布 definition + binding（默认 entity=actA1，policy optional）。 */
async function publishDef(env, formOwner, { policy = 1, consumerPublicId = env.fixture.actA1, isDefault = false, name = '报名表', fields = FIELDS, allowRepeat = false } = {}) {
  const d = await formOwner.createDefinition({ name, fields, allow_repeat: allowRepeat });
  await formOwner.publishDefinition(d.public_id);
  const binding = await formOwner.createBinding({
    definition_public_id: d.public_id,
    consumer_type: 'activity.signup',
    consumer_public_id: isDefault ? undefined : consumerPublicId,
    is_default: isDefault,
    consume_policy: policy,
  });
  return { d, binding };
}
async function submitForm(formVol, consumerPublicId = undefined, { answers = ANSWERS, newPublicId = generateUlid() } = {}) {
  const r = await formVol.submit({ consumer_type: 'activity.signup', consumer_public_id: consumerPublicId ?? null, new_public_id: newPublicId, answers });
  return r.submission;
}
function rowCount(env, activityId, userId) {
  return Number(env.raw.prepare('SELECT COUNT(*) n FROM activity_signups WHERE activity_id=? AND user_id=?').get(activityId, userId).n);
}
function boundSubmissionId(env, activityId, userId) {
  return env.raw.prepare('SELECT form_submission_id FROM activity_signups WHERE activity_id=? AND user_id=?').get(activityId, userId)?.form_submission_id ?? null;
}

// =========================================================================
// 1–7 consume_policy 行为
// =========================================================================
section('1-7 consume_policy');
await scenario('1 no binding legacy signup 成功；2 no binding + submission → form_not_available', async (env) => {
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const s = await svc.createOwn(env.fixture.actA1);
  assert(s.status === 1 && rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, '1 no-binding legacy 报名成功');
  // 2：actA2 无 binding、也无既有报名 → 带 submission → form_not_available
  await expectNotFoundReason(() => svc.createOwn(env.fixture.actA2, { formSubmissionPublicId: generateUlid() }), ConflictReason.FORM_NOT_AVAILABLE, '2 no-binding+submission');
});

await scenario('3 policy=none：renderer 不可用、signup 拒 submission、无 submission 正常', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 0 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectNotFoundReason(() => volForm.getConsumerForm('activity.signup', env.fixture.actA1), ConflictReason.FORM_NOT_AVAILABLE, '3 renderer none');
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectNotFoundReason(() => svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: generateUlid() }), ConflictReason.FORM_NOT_AVAILABLE, '3 signup+submission none');
  const s = await svc.createOwn(env.fixture.actA1);
  assert(s.status === 1, '3 policy none 无 submission 报名正常');
});

await scenario('4/5 policy=optional：无 submission 成功；有合法 submission 成功绑定', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const s1 = await svc.createOwn(env.fixture.actA1);
  assert(s1.status === 1 && boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA) === null, '4 optional 无 submission 成功');
  // 取消后再绑定提交
  await svc.cancelOwn(env.fixture.actA1);
  const sub = await submitForm(volForm, env.fixture.actA1);
  const s2 = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  assert(s2.status === 1 && boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA) != null, '5 optional 带 submission 绑定成功');
});

await scenario('6/7 policy=required：缺 → 409；带 → 成功', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 2 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.createOwn(env.fixture.actA1), ConflictReason.SIGNUP_FORM_REQUIRED, '6 required 缺');
  const sub = await submitForm(volForm, env.fixture.actA1);
  const s = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  assert(s.status === 1 && boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA) != null, '7 required 带 submission 成功');
});

// =========================================================================
// 8–12 归属/跨域/stale/1:1
// =========================================================================
section('8-12 ownership / parent / team / stale / 1:1');
await scenario('8 他人 submission → 404', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volBForm = makeFormSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const subB = await submitForm(volBForm, env.fixture.actA1);
  const svcA = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svcA.createOwn(env.fixture.actA1, { formSubmissionPublicId: subB.public_id }), ErrorCode.NOT_FOUND, '8 other-user submission');
});

await scenario('9 其它 activity 的 submission → parent_mismatch（同 team，actA2 也有 binding）', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  // actA1 / actA2 各建一个 published definition + optional binding
  await publishDef(env, owner, { policy: 1, consumerPublicId: env.fixture.actA1, name: '表单A1' });
  await publishDef(env, owner, { policy: 1, consumerPublicId: env.fixture.actA2, name: '表单A2' });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1); // consumer=actA1
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.createOwn(env.fixture.actA2, { formSubmissionPublicId: sub.public_id }), ConflictReason.PARENT_MISMATCH, '9 other-activity submission');
});

await scenario('10 跨团队 submission → 404', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamB, 'team_owner');
  await publishDef(env, owner, { policy: 1, consumerPublicId: env.fixture.actB1 });
  const volBForm = makeFormSvc(env, env.fixture.ids.volB, env.fixture.ids.teamB);
  const subB = await submitForm(volBForm, env.fixture.actB1);
  const svcA = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svcA.createOwn(env.fixture.actA1, { formSubmissionPublicId: subB.public_id }), ErrorCode.NOT_FOUND, '10 cross-team submission');
});

await scenario('11 stale version → form_version_stale', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1); // V1
  // 发布 V2
  await owner.createNextDefinitionDraft(d.public_id);
  await owner.patchDefinitionDraft(d.public_id, [...FIELDS, { key: 'phone', label: '电话', type: 'phone', required: false }]);
  await owner.publishDefinition(d.public_id);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id }), ConflictReason.FORM_VERSION_STALE, '11 stale');
});

await scenario('12 form_submission_id 1:1（DB partial unique）与 footprint session', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volAForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volAForm, env.fixture.actA1);
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  // DB 级 1:1：同一 form_submission_id 只能被唯一 signup 引用（partial UNIQUE）
  const subId = Number(env.raw.prepare("SELECT id FROM form_submissions WHERE public_id=?").get(sub.public_id).id);
  let blocked = false;
  try {
    env.raw.prepare('INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at, form_submission_id) VALUES (3,2,1,1,?,?)').run(Math.floor(Date.now()/1000), subId);
  } catch (e) {
    blocked = /unique/i.test(String(e.message));
  }
  assert(blocked, '12: DB partial UNIQUE 阻止第二条 signup 复用同一 evidence');
});

// =========================================================================
// 13–17 cancel → reapply（UNIQUE 下 reactivation）
// =========================================================================
section('13-17 cancel→reapply');
await scenario('13/14/15 reactivation：原行、行数=1、review 重置；A: 同 X 重报成功', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  const created = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  const rowA = env.raw.prepare('SELECT id, review_status, cancel_count, created_at, form_submission_id FROM activity_signups WHERE user_id=1').get();
  // 人为将其置为需审 + 审核痕迹，验证 reactivation 重置
  env.raw.prepare("UPDATE activity_signups SET review_status=2, review_by=3, review_at=123, review_reason='x' WHERE id=?").run(rowA.id);
  await svc.cancelOwn(env.fixture.actA1);
  const cancelled = env.raw.prepare('SELECT status, cancel_count FROM activity_signups WHERE id=?').get(rowA.id);
  assert(cancelled.status === 2 && cancelled.cancel_count === 1, '13/14: cancel → status2, cancel_count 保留');
  // A：reapply 仍传同一 X → 成功、不产生 duplicate
  const reapplied = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  assert(reapplied.status === 1, 'A: cancel→reapply 同 X 成功，无 form_submission_duplicate');
  const after = env.raw.prepare('SELECT id, status, review_status, review_by, review_at, review_reason, cancel_count, created_at, form_submission_id FROM activity_signups WHERE id=?').get(rowA.id);
  assert(after.id === rowA.id, '13: 原行未变（无第二行）');
  assert(after.status === 1 && after.review_status === 1 && after.review_by === null && after.review_at === null && after.review_reason === null, '15: review 字段重置（need_audit=0 → 1）');
  assert(after.cancel_count === 1 && after.created_at === rowA.created_at, '15: cancel_count/created_at 保留');
  assert(Number(after.form_submission_id) === Number(rowA.form_submission_id), 'A: 仍绑定同一 X');
  assert(rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, '14: (user,activity) 行数恒 1');
});

await scenario('B/16 替换证据 X→Y：原行替换、X 释放、行数=1', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1, allowRepeat: true });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const x = await submitForm(volForm, env.fixture.actA1);
  const y = await submitForm(volForm, env.fixture.actA1);
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: x.public_id });
  const idX = Number(env.raw.prepare("SELECT id FROM form_submissions WHERE public_id=?").get(x.public_id).id);
  assert(boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA) === idX, 'B: 初始绑定 X');
  await svc.cancelOwn(env.fixture.actA1);
  const idY = Number(env.raw.prepare("SELECT id FROM form_submissions WHERE public_id=?").get(y.public_id).id);
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: y.public_id });
  const bound = boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA);
  assert(bound === idY, 'B: reapply 后绑定替换为 Y');
  const usedX = Number(env.raw.prepare('SELECT COUNT(*) n FROM activity_signups WHERE form_submission_id=?').get(idX).n);
  assert(usedX === 0, 'B: X 被释放');
  assert(rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, 'B: 行数仍 1');
  // SUBMISSIONS 可多条（allow_repeat=true 下 X,Y 均 submitted）
  const subs = Number(env.raw.prepare('SELECT COUNT(*) n FROM form_submissions WHERE submitter_user_id=1 AND status=2').get().n);
  assert(subs === 2, '17: allow_repeat=true 多条 submitted 存在');
});

await scenario('17 allow_repeat：signup 精确绑定传入那一条', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1, allowRepeat: true });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const x = await submitForm(volForm, env.fixture.actA1);
  await submitForm(volForm, env.fixture.actA1); // 另一条 submitted
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: x.public_id });
  assert(boundSubmissionId(env, env.fixture.ids.actA1, env.fixture.ids.volA) === Number(env.raw.prepare("SELECT id FROM form_submissions WHERE public_id=?").get(x.public_id).id), '17: 仅绑定传入那条 X');
});

// =========================================================================
// 18–23 版本历史 / 读投影 / legacy / zero IDs
// =========================================================================
section('18-23 read projection');
await scenario('18 V2 发布后历史 signup 仍读 V1 frozen answers/schema', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  const v1 = sub.version_public_id;
  await owner.createNextDefinitionDraft(d.public_id);
  await owner.patchDefinitionDraft(d.public_id, [...FIELDS, { key: 'phone', label: '电话', type: 'phone', required: false }]);
  await owner.publishDefinition(d.public_id);
  const view = await svc.getOwnSignupDetail(env.fixture.actA1, { includeAnswers: true, includeLegacyFormData: false });
  assert(view.form_submission.version_public_id === v1, '18: 仍绑定 V1（未自动升级）');
  assert(view.answers && view.answers.name === '张三', '18: V1 frozen answers 可读');
  assert(view.schema && view.schema.fields.length === 1, '18: 按 V1 frozen schema 解释（fields=1，非 V2 的 2 字段）');
});

await scenario('19/20/21 answers 权限：SELF / owner-admin / auditor', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volAForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcA = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volAForm, env.fixture.actA1);
  await svcA.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });

  const self = await svcA.getOwnSignupDetail(env.fixture.actA1, { includeAnswers: true, includeLegacyFormData: true });
  assert(self.answers && self.answers.name === '张三' && self.schema != null, '19: SELF 可读 frozen answers+schema');

  const ownerSvc = makeSignupSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const adminView = await ownerSvc.getSignupDetailByUser(env.fixture.actA1, env.fixture.userVolA, { includeAnswers: true, includeLegacyFormData: true });
  assert(adminView.answers && adminView.answers.name === '张三', '20: owner/admin includeAnswers 可读 answers');

  const auditorSvc = makeSignupSvc(env, env.fixture.ids.auditorA, env.fixture.ids.teamA, 'team_auditor');
  const audView = await auditorSvc.getSignupDetailByUser(env.fixture.actA1, env.fixture.userVolA, { includeAnswers: false, includeLegacyFormData: false });
  assert(!('answers' in audView) && !('schema' in audView) && !('legacy_form_data' in audView), '21: auditor 无 answers/schema/legacy');
  assert(audView.form_submission && audView.form_submission.public_id === sub.public_id, '21: auditor 仍见 submission public projection');
});

await scenario('22 legacy form_data 隐私；23 zero internal IDs', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volAForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcA = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volAForm, env.fixture.actA1);
  await svcA.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  // 人为写入 legacy form_data（仅存在于本 DB 测试行）
  env.raw.prepare("UPDATE activity_signups SET form_data=? WHERE user_id=?").run(JSON.stringify({ legacy: true, phone: '13800138000' }), env.fixture.ids.volA);

  const self = await svcA.getOwnSignupDetail(env.fixture.actA1, { includeAnswers: true, includeLegacyFormData: true });
  assert(self.legacy_form_data && self.legacy_form_data.phone === '13800138000', '22: SELF 授权可看 legacy form_data');
  const selfNo = await svcA.getOwnSignupDetail(env.fixture.actA1, { includeAnswers: true, includeLegacyFormData: false });
  assert(!('legacy_form_data' in selfNo), '22: 无授权则不返回 legacy');
  const auditorSvc = makeSignupSvc(env, env.fixture.ids.auditorA, env.fixture.ids.teamA, 'team_auditor');
  const audView = await auditorSvc.getSignupDetailByUser(env.fixture.actA1, env.fixture.userVolA, { includeAnswers: false, includeLegacyFormData: false });
  assert(!('legacy_form_data' in audView), 'C: auditor 无 legacy form_data');

  const list = await makeSignupSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner').listSignups(env.fixture.actA1, 1, 20);
  assert(list.items.length === 1 && !('answers' in list.items[0]) && !('schema' in list.items[0]) && !('legacy_form_data' in list.items[0]), 'D: TEAM list 默认无 answers/schema/legacy');

  const INTERNAL = ['id', 'activity_id', 'user_id', 'form_submission_id', 'definition_id', 'version_id', 'submitter_user_id', 'team_id'];
  const deep = (o) => {
    const stack = [o];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === null || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) { stack.push(...cur); continue; }
      for (const [k, v] of Object.entries(cur)) { if (INTERNAL.includes(k)) return true; stack.push(v); }
    }
    return false;
  };
  assert(!deep(self) && !deep(audView) && !deep(list.items[0]), '23: 零内部 id');
});

// =========================================================================
// Route 层：权限/条件投影（真实 middleware + provider）
// =========================================================================
section('Route: permission/conditional projection');
await scenario('Rt', async (env) => {
  const { Hono } = await import('hono');
  const { authContextMiddleware } = await import('../src/middleware/auth.ts');
  const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope.ts');
  const { csrfGuardMiddleware } = await import('../src/middleware/csrf.ts');
  const { errorHandler } = await import('../src/middleware/error-handler.ts');
  const activities = (await import('../src/routes/activities.ts')).default;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', authContextMiddleware);
  app.use('*', tenantContextMiddleware);
  app.use('/api/v2/*', csrfGuardMiddleware);
  const v2 = new Hono();
  v2.route('/activities', activities);
  app.route('/api/v2', v2);
  const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };

  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volAForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcA = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volAForm, env.fixture.actA1);
  await svcA.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });

  const req = async (method, path, role, uid, tid) => {
    const res = await app.request(path, { method, headers: { 'x-test-role': role, 'x-test-user': String(uid), 'x-test-team': String(tid) } }, baseEnv);
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  // SELF me（volunteer 有 form.submission.read → 有 answers）
  const me = await req('GET', `/api/v2/activities/${env.fixture.actA1}/signups/me`, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(me.status === 200 && me.json?.data?.signup?.answers?.name === '张三', `Rt.me volunteer answers（实=${me.status}）`);

  // owner TEAM detail → answers
  const own = await req('GET', `/api/v2/activities/${env.fixture.actA1}/signups/users/${env.fixture.userVolA}`, 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA);
  assert(own.status === 200 && own.json?.data?.signup?.answers?.name === '张三', `Rt.owner answers（实=${own.status}）`);

  // auditor TEAM detail → 无 answers/schema/legacy
  const aud = await req('GET', `/api/v2/activities/${env.fixture.actA1}/signups/users/${env.fixture.userVolA}`, 'team_auditor', env.fixture.ids.auditorA, env.fixture.ids.teamA);
  assert(aud.status === 200 && !('answers' in aud.json?.data?.signup) && !('schema' in aud.json?.data?.signup), `Rt.auditor 无 answers（实=${aud.status}）`);

  // TEAM list → 无 answers
  const list = await req('GET', `/api/v2/activities/${env.fixture.actA1}/signups`, 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA);
  assert(list.status === 200 && list.json?.data?.signups?.length === 1 && !('answers' in list.json.data.signups[0]), 'Rt.list 默认无 answers');
});

// =========================================================================
// P21-P2R.1 consume_policy 路由透传（真实 route 层，非 service 直调）
// =========================================================================
section('P21-P2R.1 consume_policy 路由透传');
await scenario('Rt-CP 通过 POST /forms/bindings 真实路由透传 consume_policy', async (env) => {
  const { Hono } = await import('hono');
  const { authContextMiddleware } = await import('../src/middleware/auth.ts');
  const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope.ts');
  const { csrfGuardMiddleware } = await import('../src/middleware/csrf.ts');
  const { errorHandler } = await import('../src/middleware/error-handler.ts');
  const forms = (await import('../src/routes/forms.ts')).default;
  const activities = (await import('../src/routes/activities.ts')).default;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', authContextMiddleware);
  app.use('*', tenantContextMiddleware);
  app.use('/api/v2/*', csrfGuardMiddleware);
  const v2 = new Hono();
  v2.route('/activities', activities);
  v2.route('/forms', forms);
  app.route('/api/v2', v2);
  const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };

  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const req = async (method, path, role, uid, tid, body) => {
    const init = { method, headers: { 'x-test-role': role, 'x-test-user': String(uid), 'x-test-team': String(tid) } };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await app.request(path, init, baseEnv);
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  // 准备已发布 definition（service 层；route 仅测 binding 透传）
  const mkDef = async () => { const d = await owner.createDefinition({ name: '报名表', fields: FIELDS }); await owner.publishDefinition(d.public_id); return d; };

  // 1a: policy=0 → 201 且 consume_policy=0；renderer 不可用（404 FORM_NOT_AVAILABLE）
  const d0 = await mkDef();
  const r0 = await req('POST', '/api/v2/forms/bindings', 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA,
    { definition_public_id: d0.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1, consume_policy: 0 });
  assert(r0.status === 201 && r0.json?.success === true && r0.json?.data?.binding?.consume_policy === 0, `1a policy=0 路由创建成功（实=${r0.status}/${JSON.stringify(r0.json)}）`);
  const rend0 = await req('GET', `/api/v2/forms/consumers/activity.signup/${env.fixture.actA1}/form`, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(rend0.status === 404 && rend0.json?.error?.details?.reason === ConflictReason.FORM_NOT_AVAILABLE, `1a policy=0 renderer 不可用（实=${rend0.status}/${rend0.json?.error?.details?.reason}）`);

  // 1b: policy=1 → 201 consume_policy=1（actA2，避免与 actA1 的 policy=0 entity binding 排序干扰）
  const d1 = await mkDef();
  const r1 = await req('POST', '/api/v2/forms/bindings', 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA,
    { definition_public_id: d1.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA2, consume_policy: 1 });
  assert(r1.status === 201 && r1.json?.success === true && r1.json?.data?.binding?.consume_policy === 1, `1b policy=1 路由创建成功（实=${r1.status}）`);
  const rend1 = await req('GET', `/api/v2/forms/consumers/activity.signup/${env.fixture.actA2}/form`, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(rend1.status === 200 && rend1.json?.success === true, `1b policy=1 renderer 可用（实=${rend1.status}）`);

  // 1c: policy=2 → 201 consume_policy=2；且使 signup required（无 submission 报名 → 409 SIGNUP_FORM_REQUIRED）
  const actA3 = generateUlid();
  env.raw.prepare('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)')
    .run(99, actA3, env.fixture.ids.teamA, 'actA3', 3, Math.floor(Date.now()/1000), Math.floor(Date.now()/1000) + 3600);
  const d2 = await mkDef();
  const r2 = await req('POST', '/api/v2/forms/bindings', 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA,
    { definition_public_id: d2.public_id, consumer_type: 'activity.signup', consumer_public_id: actA3, consume_policy: 2 });
  assert(r2.status === 201 && r2.json?.success === true && r2.json?.data?.binding?.consume_policy === 2, `1c policy=2 路由创建成功（实=${r2.status}）`);
  const signupNoForm = await req('POST', `/api/v2/activities/${actA3}/signups`, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA, {});
  assert(signupNoForm.status === 409 && signupNoForm.json?.error?.details?.reason === ConflictReason.SIGNUP_FORM_REQUIRED, `1c policy=2 使 signup required（实=${signupNoForm.status}/${signupNoForm.json?.error?.details?.reason}）`);

  // 1d: 非法 policy → 400 INVALID_PARAM
  const invs = [
    { consume_policy: 5 },
    { consume_policy: '1' },
    { consume_policy: -1 },
    { consume_policy: 1.5 },
  ];
  for (const body of invs) {
    const r = await req('POST', '/api/v2/forms/bindings', 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA,
      { definition_public_id: d0.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA2, ...body });
    assert(r.status === 400 && r.json?.error?.code === 'INVALID_PARAM', `1d 非法 policy=${JSON.stringify(body.consume_policy)} 拒绝（实=${r.status}）`);
  }
});

// =========================================================================
// P21-P2R.2 create-with-form 存在性判定（false-success 竞争）
// =========================================================================
section('P21-P2R.2 create-with-form false-success 竞争');
await scenario('2a 两次首次 create：仅 1 行、首成功、次必须 409', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  const first = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  assert(first.status === 1 && rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, '2a 首次 create 成功，仅 1 行');
  await expectConflict(() => svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id }), ConflictReason.SIGNUP_ALREADY_EXISTS, '2a 第二次 create 必须 409（不得返回成功）');
  assert(rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, '2a 数据库最终仅 1 行');
});

await scenario('2b repo 级 INSERT…SELECT 以 meta.changes 为成功 sentinel：第二次 0 行', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  const subId = Number(env.raw.prepare('SELECT id FROM form_submissions WHERE public_id=?').get(sub.public_id).id);
  const repo = new ActivitySignupRepository({ db: env.db, ctx: { auth: makeAuth(env.fixture.ids.volA, env.fixture.ids.teamA), tenant: { scope: 'TEAM_SCOPED', teamId: env.fixture.ids.teamA, userId: env.fixture.ids.volA } } });
  const now = Math.floor(Date.now()/1000);
  const c1 = await repo.insertSignupWithFormAtomically({ activityPublicId: env.fixture.actA1, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, submissionPublicId: sub.public_id, now });
  assert(c1 === 1, '2b 首次 INSERT 命中 1 行');
  const c2 = await repo.insertSignupWithFormAtomically({ activityPublicId: env.fixture.actA1, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, submissionPublicId: sub.public_id, now });
  assert(c2 === 0, '2b 并发/重复 INSERT 必须 0 行（service 据此 reclassify，不误判成功）');
});

// =========================================================================
// P21-P2R.3 reactivation TOCTOU（UPDATE 谓词原子复核 binding/version）
// =========================================================================
section('P21-P2R.3 reactivation TOCTOU');
await scenario('3 repo 级：ensure 后 binding/version 状态变化 → UPDATE 不得错误成功（0 行）', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  const created = await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  assert(created.status === 1 && rowCount(env, env.fixture.ids.actA1, env.fixture.ids.volA) === 1, '3.setup 首次报名成功');
  await svc.cancelOwn(env.fixture.actA1);
  const subId = Number(env.raw.prepare('SELECT id FROM form_submissions WHERE public_id=?').get(sub.public_id).id);
  const repo = new ActivitySignupRepository({ db: env.db, ctx: { auth: makeAuth(env.fixture.ids.volA, env.fixture.ids.teamA), tenant: { scope: 'TEAM_SCOPED', teamId: env.fixture.ids.teamA, userId: env.fixture.ids.volA } } });
  const now = Math.floor(Date.now()/1000);

  // 3a 正常（ensure 后状态未变）→ UPDATE 应 1 行
  const ok = await repo.reactivateSignupWithGivenSubmissionAtomically({ activityPublicId: env.fixture.actA1, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, submissionId: subId, now });
  assert(ok === 1, '3a 正常 reactivation UPDATE 命中 1 行');
  await svc.cancelOwn(env.fixture.actA1);

  // 3b ensure 后 binding consume_policy 被改 0 → UPDATE 必须 0 行
  env.raw.prepare('UPDATE form_bindings SET consume_policy = 0 WHERE consumer_public_id = ? AND team_id = ?').run(env.fixture.actA1, env.fixture.ids.teamA);
  const c0 = await repo.reactivateSignupWithGivenSubmissionAtomically({ activityPublicId: env.fixture.actA1, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, submissionId: subId, now });
  assert(c0 === 0, '3b binding consume_policy=0 时 UPDATE 不得成功（0 行）');
  env.raw.prepare('UPDATE form_bindings SET consume_policy = 1 WHERE consumer_public_id = ? AND team_id = ?').run(env.fixture.actA1, env.fixture.ids.teamA);

  // 3c ensure 后定义被归档（published_version 失效）→ UPDATE 必须 0 行
  env.raw.prepare('UPDATE form_definitions SET status = 3, published_version_id = NULL WHERE id = (SELECT definition_id FROM form_submissions WHERE id = ?)').run(subId);
  const c1 = await repo.reactivateSignupWithGivenSubmissionAtomically({ activityPublicId: env.fixture.actA1, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, submissionId: subId, now });
  assert(c1 === 0, '3c 定义归档后 UPDATE 不得成功（0 行）');
});

await scenario('3d service 层：ensure 后 version 变更 → createOwn 必须抛错（不得返回成功）', async (env) => {
  const owner = makeFormSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const { d } = await publishDef(env, owner, { policy: 1 });
  const volForm = makeFormSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svc = makeSignupSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await submitForm(volForm, env.fixture.actA1);
  await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id });
  await svc.cancelOwn(env.fixture.actA1); // 回到 status=2，form_submission_id 仍指向 V1 submission
  // 复位定义状态 + 发布 V2，使 submission 的 version_id 不再等于当前 published_version_id
  const subId = Number(env.raw.prepare('SELECT id FROM form_submissions WHERE public_id=?').get(sub.public_id).id);
  env.raw.prepare('UPDATE form_definitions SET status = 2, published_version_id = (SELECT version_id FROM form_submissions WHERE id = ?) WHERE id = (SELECT definition_id FROM form_submissions WHERE id = ?)').run(subId, subId);
  await owner.createNextDefinitionDraft(d.public_id);
  await owner.patchDefinitionDraft(d.public_id, [...FIELDS, { key: 'phone', label: '电话', type: 'phone', required: false }]);
  await owner.publishDefinition(d.public_id);
  let threw = false, code = null;
  try { await svc.createOwn(env.fixture.actA1, { formSubmissionPublicId: sub.public_id }); }
  catch (e) { threw = e instanceof AppError; code = e instanceof AppError ? e.code : null; }
  assert(threw && (code === ErrorCode.CONFLICT || code === ErrorCode.NOT_FOUND), `3d version 变更后 reapply 不得成功，必须抛错（实=${code}）`);
});

// =========================================================================
// 汇总
// =========================================================================
console.log(`\n================ P21 SIGNUP×FORM 结果 ================`);
console.log(`PASS=${pass}  FAIL=${failCount}`);
if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  -', f); }
if (failCount > 0) process.exit(1);
console.log('ALL P21 SIGNUP×FORM SCENARIOS PASSED');
process.exit(0);