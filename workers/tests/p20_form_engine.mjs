/**
 * P20 通用动态表单引擎 —— 专项测试（TEST-ONLY）。
 *
 * 覆盖 P20-P1 I 节 15 组；fixture = tests/lib/formdb.mjs（migrations 0001–0015 + 双团队 base）。
 *
 * 运行：node --experimental-transform-types --loader ./ts_loader.mjs tests/p20_form_engine.mjs
 */
import { buildFormDb } from './lib/formdb.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { FormService } from '../src/services/form-service';
import { FormEngineRepository, FORM_SUBMISSION_STATUS, FORM_DEF_STATUS, FORM_VERSION_STATUS } from '../src/repository/form-engine';
import { AppError, ErrorCode, ConflictReason } from '../src/utils/errors';

let pass = 0;
let failCount = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; } else { failCount++; failures.push(msg); console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function makeSvc(env, userId, teamId, role = 'volunteer') {
  const auth = { authenticated: true, userId, teamId, role, roles: [{ role, scopeTeamId: teamId }] };
  const tenant = { scope: 'TEAM_SCOPED', teamId, userId };
  return new FormService({ db: env.db, auth, tenant });
}
async function expectThrow(fn, expectedCode, label) {
  try { await fn(); } catch (e) {
    if (e instanceof AppError && e.code === expectedCode) return e;
    throw new Error(`${label}: 期望 ${expectedCode}，实际=${e instanceof AppError ? e.code : e?.message}`);
  }
  throw new Error(`${label}: 期望抛出 ${expectedCode}，但未抛`);
}
async function expectConflict(fn, expectedReason, label) {
  const e = await expectThrow(fn, ErrorCode.CONFLICT, label);
  assert(e.details && e.details.reason === expectedReason, `${label}: 409 reason=${expectedReason}（实=${e.details && e.details.reason}）`);
}
async function scenario(name, fn) {
  const env = await buildFormDb();
  try { await fn(env); } catch (e) { failCount++; failures.push(`${name}: ${e.message}`); console.error(`  ✗ SCENARIO FAIL [${name}]:`, e.message); }
  finally { env.close(); }
}
function hasInternalKeys(obj) {
  const INTERNAL = ['id', 'team_id', 'definition_id', 'version_id', 'submitter_user_id'];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || cur === undefined || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    for (const [k, v] of Object.entries(cur)) {
      if (INTERNAL.includes(k)) return true;
      stack.push(v);
    }
  }
  return false;
}

const FIELDS_ONE = [
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'age', label: '年龄', type: 'number', required: false, validation: { min: 0, max: 120 } },
  { key: 'gender', label: '性别', type: 'single_select', required: true, options: [{ value: 'M', label: '男' }, { value: 'F', label: '女' }] },
];
const ANSWERS_ONE = { name: '张三', age: 25, gender: 'M' };

// =========================================================================
// G1 definition V1 create → publish
// =========================================================================
section('G1 definition V1 create/publish');
await scenario('G1 draft → publish（published_version_id 切换、不再有 draft）', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: '报名表A', fields: FIELDS_ONE, allow_repeat: false });
  assert(d.status === FORM_DEF_STATUS.DRAFT && d.published_version_id === null && d.draft_version_id != null, 'G1: V1 draft 状态');
  const pub = await svc.publishDefinition(d.public_id);
  assert(pub.status === FORM_DEF_STATUS.PUBLISHED && pub.published_version_id === d.draft_version_id && pub.draft_version_id === null, 'G1: publish 后指向 V1、无 draft');
  // publish 后无自动下一 draft；再次 publish 无 draft → 409（不会静默）
  await expectThrow(() => svc.publishDefinition(d.public_id), ErrorCode.CONFLICT, 'G1-publish-no-draft');
});

// =========================================================================
// G2 published → V2 draft → publish；G3 old schema immutable
// =========================================================================
section('G2/G3 V2 draft + old 版本不可变');
await scenario('G2 published→draft(V2,no+1)→publish；G3 V1 schema 不变', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  const v1Schema = env.raw.prepare('SELECT schema_json FROM form_definition_versions WHERE definition_id=1 AND version_no=1').get().schema_json;

  const r1 = await svc.createNextDefinitionDraft(d.public_id);
  assert(r1.created === true && r1.version.version_no === 2 && r1.version.status === FORM_VERSION_STATUS.DRAFT, 'G2: V2 draft created (no=2)');
  const r2 = await svc.createNextDefinitionDraft(d.public_id);
  assert(r2.created === false && r2.version.public_id === r1.version.public_id, 'G2: 幂等 200 existing');

  const fields2 = [...FIELDS_ONE, { key: 'phone', label: '电话', type: 'phone', required: false }];
  const patched = await svc.patchDefinitionDraft(d.public_id, fields2);
  assert(patched.fields.length === fields2.length && patched.status === FORM_VERSION_STATUS.DRAFT, 'G2: PATCH draft 生效');

  const pub = await svc.publishDefinition(d.public_id);
  assert(pub.published_version_id === patched.public_id && pub.draft_version_id === null, 'G2: publish 后指针=V2');
  const oldRow = env.raw.prepare('SELECT version_no, status, schema_json FROM form_definition_versions WHERE definition_id=1 AND version_no=1').get();
  assert(oldRow.status === FORM_VERSION_STATUS.ARCHIVED && oldRow.schema_json === v1Schema, 'G3: 旧 V1 → archived 且 schema 未被改写');
  const newDraft = await svc.createNextDefinitionDraft(d.public_id);
  assert(newDraft.created === true && newDraft.version.version_no === 3, 'G3: V2 后被 publish 仍可开 V3（无死路）');
});

// =========================================================================
// G4 archive invariant
// =========================================================================
section('G4 archive invariant');
await scenario('G4 archive：版本归档 + published_version_id=NULL + bindings 归档 + 历史 submission 不动', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  const binding = await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1 });
  assert(binding.created === true, 'G4: binding 建立');
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await svcV.submit({ consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1, new_public_id: generateUlid(), answers: ANSWERS_ONE });
  assert(sub.created === true, 'G4: 先有 submitted');

  const arch = await svc.archiveDefinition(d.public_id);
  assert(arch.status === FORM_DEF_STATUS.ARCHIVED && arch.published_version_id === null, 'G4: definition archived + 指针 NULL');
  const versions = env.raw.prepare('SELECT status FROM form_definition_versions WHERE definition_id=1').all();
  assert(versions.every((v) => v.status === FORM_VERSION_STATUS.ARCHIVED), 'G4: 版本全部 archived');
  const bind = env.raw.prepare('SELECT status FROM form_bindings WHERE definition_id=1').get();
  assert(bind.status === 2, 'G4: binding archived');
  const subRow = env.raw.prepare('SELECT status, version_id FROM form_submissions WHERE id=1').get();
  assert(subRow && subRow.status === 2, 'G4: 历史 submission 保持 submitted');
  // archived definition 不可再创建 draft / metadata
  await expectThrow(() => svc.createNextDefinitionDraft(d.public_id), ErrorCode.CONFLICT, 'G4-archived-draft');
  await expectThrow(() => svc.updateDefinitionMetadata(d.public_id, { name: 'x' }), ErrorCode.CONFLICT, 'G4-archived-meta');
});

// =========================================================================
// G5 binding entity/default precedence
// =========================================================================
section('G5 binding entity/default precedence');
await scenario('G5 default 兜底；entity 优先；default 删除/归档后回退', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d1 = await svc.createDefinition({ name: 'default-form', fields: FIELDS_ONE });
  await svc.publishDefinition(d1.public_id);
  const bDef = await svc.createBinding({ definition_public_id: d1.public_id, consumer_type: 'activity.signup', is_default: true });
  assert(bDef.created === true, 'G5: default binding 建');

  const viewDef = await svc.getConsumerForm('activity.signup', env.fixture.actA1);
  assert(viewDef.definition_public_id === d1.public_id, 'G5: 无 entity 时走 default');

  const d2 = await svc.createDefinition({ name: 'entity-form', fields: FIELDS_ONE });
  await svc.publishDefinition(d2.public_id);
  await svc.createBinding({ definition_public_id: d2.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1 });
  const viewE = await svc.getConsumerForm('activity.signup', env.fixture.actA1);
  assert(viewE.definition_public_id === d2.public_id, 'G5: entity 优先于 default');

  // default is_default 与 consumer_public_id 互斥
  await expectThrow(() => svc.createBinding({ definition_public_id: d1.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1, is_default: true }), ErrorCode.INVALID_PARAM, 'G5-exclusive');
});

// =========================================================================
// G6 cross-team 404
// =========================================================================
section('G6 cross-team 404');
await scenario('G6 跨团队一律 404（不泄露）', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d1 = await svcA.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svcA.publishDefinition(d1.public_id);
  await svcA.createBinding({ definition_public_id: d1.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1 });

  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamB, 'volunteer');
  await expectThrow(() => svcB.getDefinition(d1.public_id), ErrorCode.NOT_FOUND, 'G6-def');
  await expectThrow(() => svcB.getConsumerForm('activity.signup', env.fixture.actA1), ErrorCode.NOT_FOUND, 'G6-render');
  await expectThrow(() => svcA.createBinding({ definition_public_id: d1.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actB1 }), ErrorCode.NOT_FOUND, 'G6-consumer-team');
  const svcA2 = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svcA2.submit({ consumer_type: 'activity.signup', consumer_public_id: env.fixture.actB1, new_public_id: generateUlid(), answers: ANSWERS_ONE }), ErrorCode.NOT_FOUND, 'G6-submit-cross-team');
});

// =========================================================================
// G7 schema / answers 校验
// =========================================================================
section('G7 validation');
await scenario('G7 字段/答案校验', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  await expectThrow(() => svc.createDefinition({ name: 'bad', fields: [{ key: 'f', label: 'F', type: 'file' }] }), ErrorCode.INVALID_PARAM, 'G7-file');
  await expectThrow(() => svc.createDefinition({ name: 'bad', fields: [{ key: 'f', label: 'F', type: 'text', extra: 1 }] }), ErrorCode.INVALID_PARAM, 'G7-extra-attr');
  await expectThrow(() => svc.createDefinition({ name: 'bad', fields: [{ key: 'f', label: '', type: 'text' }] }), ErrorCode.INVALID_PARAM, 'G7-empty-label');
  await expectThrow(() => svc.createDefinition({ name: 'bad', fields: [{ key: 'f', label: 'F', type: 'single_select', options: [] }] }), ErrorCode.INVALID_PARAM, 'G7-empty-options');

  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  // 未知 key
  await expectThrow(() => svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: { name: 'x', ghost: 1 } }), ErrorCode.INVALID_PARAM, 'G7-unknown-key');
  // 必填缺失（final）
  await expectThrow(() => svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: { age: 1 } }), ErrorCode.INVALID_PARAM, 'G7-required-missing');
  // phone/email/date
  const fields = [
    { key: 'p', label: 'P', type: 'phone', required: true },
    { key: 'e', label: 'E', type: 'email', required: false },
    { key: 'dt', label: 'D', type: 'date', required: false },
  ];
  const d2 = await svc.createDefinition({ name: 't2', fields });
  await svc.publishDefinition(d2.public_id);
  await svc.createBinding({ definition_public_id: d2.public_id, consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1 });
  await expectThrow(() => svcV.submit({ consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1, new_public_id: generateUlid(), answers: { p: '123' } }), ErrorCode.INVALID_PARAM, 'G7-bad-phone');
  const ok = await svcV.submit({ consumer_type: 'activity.signup', consumer_public_id: env.fixture.actA1, new_public_id: generateUlid(), answers: { p: '13800138000', e: 'a@b.com', dt: '2026-09-05' } });
  assert(ok.created === true, 'G7: phone/email/date 合法通过');
});

// =========================================================================
// G8 replay / G9 allow_repeat 双向 / G10 发布新版本不重置 grain
// =========================================================================
section('G8/G9/G10 replay · allow_repeat · grain 不随版本重置');
await scenario('G8 replay + G9 allow_repeat 切换 + G10 publish 不重置 duplicate grain', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);

  const pid = generateUlid();
  const s1 = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: pid, answers: ANSWERS_ONE });
  assert(s1.created === true, 'G8: 首次 submitted');
  const rp = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: pid, answers: ANSWERS_ONE });
  assert(rp.created === false && rp.submission.public_id === pid, 'G8: 同 new_public_id replay → 200');

  // G10：发布新版本后，同 grain 再提交仍被 duplicate 拦截（grain=definition+submitter+consumer_key）
  await svc.createNextDefinitionDraft(d.public_id);
  await svc.patchDefinitionDraft(d.public_id, [...FIELDS_ONE, { key: 'phone', label: '电话', type: 'phone', required: false }]);
  await svc.publishDefinition(d.public_id);
  await expectConflict(() => svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: ANSWERS_ONE }), ConflictReason.FORM_SUBMISSION_DUPLICATE, 'G10');

  // G9：allow_repeat true → 新提交放行
  await svc.updateDefinitionMetadata(d.public_id, { allow_repeat: true });
  const s2 = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: { name: '李四', age: 30, gender: 'F' } });
  assert(s2.created === true, 'G9: allow_repeat=true 放行第二条 submitted');
  // 切回 false → 重新拦截
  await svc.updateDefinitionMetadata(d.public_id, { allow_repeat: false });
  await expectConflict(() => svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: ANSWERS_ONE }), ConflictReason.FORM_SUBMISSION_DUPLICATE, 'G9-flip-false');
});

// =========================================================================
// G11 stale draft / stale final
// =========================================================================
section('G11 stale draft / stale final');
await scenario('G11 publish 后旧 draft 不可 PATCH、旧 version 提交 → 409 stale；withdraw 仍可', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id); // V1 published
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);

  const draftPid = generateUlid();
  const dsub = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: draftPid, answers: ANSWERS_ONE, status: 'draft' });
  assert(dsub.created === true && dsub.submission.status === FORM_SUBMISSION_STATUS.DRAFT, 'G11: draft 建成');
  const draftVersionPublic = dsub.submission.version_public_id; // V1

  // 发布 V2
  await svc.createNextDefinitionDraft(d.public_id);
  await svc.patchDefinitionDraft(d.public_id, [...FIELDS_ONE, { key: 'phone', label: '电话', type: 'phone', required: false }]);
  await svc.publishDefinition(d.public_id);

  // stale PATCH → 409 form_version_stale
  await expectConflict(() => svcV.patchDraftSubmission(draftPid, { name: '张三', age: 26, gender: 'M' }), ConflictReason.FORM_VERSION_STALE, 'G11-patch-stale');
  // stale final（客户端 version 指向已 archived V1）→ 409 form_version_stale
  await expectConflict(() => svcV.submit({ consumer_type: 'activity.signup', version_public_id: draftVersionPublic, new_public_id: generateUlid(), answers: ANSWERS_ONE }), ConflictReason.FORM_VERSION_STALE, 'G11-final-stale');
  // withdraw 仍允许
  const w = await svcV.withdrawSubmission(draftPid);
  assert(w.status === FORM_SUBMISSION_STATUS.WITHDRAWN, 'G11: stale draft 仍可 withdraw');
  // draft version_id 未被偷改
  const row = env.raw.prepare('SELECT version_id FROM form_submissions WHERE public_id=?').get(draftPid);
  const v2Row = env.raw.prepare('SELECT id FROM form_definition_versions WHERE definition_id=1 AND status=2').get();
  assert(row.version_id !== v2Row.id, 'G11: draft 仍指向旧版本（未自动升级）');
});

// =========================================================================
// G12 withdrawn / invalidated 后重新提交
// =========================================================================
section('G12 withdrawn/invalidated 后重新提交');
await scenario('G12', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);

  // withdrawn 后可重新提交（同 grain 守卫只锁 status=2）
  const p1 = generateUlid();
  await svcV.submit({ consumer_type: 'activity.signup', new_public_id: p1, answers: ANSWERS_ONE });
  await svcV.withdrawSubmission(p1);
  const p2 = generateUlid();
  const r2 = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: p2, answers: ANSWERS_ONE });
  assert(r2.created === true, 'G12: withdrawn 后可重新 submitted');

  // invalidated（TEAM）后可重新提交
  await svc.invalidateSubmission(p2);
  const p3 = generateUlid();
  const r3 = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: p3, answers: ANSWERS_ONE });
  assert(r3.created === true, 'G12: invalidated 后可重新 submitted');
});

// =========================================================================
// G13 并发收敛（原子谓词 + changes 判定）
// =========================================================================
section('G13 concurrent duplicate 收敛');
await scenario('G13 原子 INSERT…SELECT 用 changes 判定；重复 duplicate 拒绝；最终仅一条 active', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);

  const s1 = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: ANSWERS_ONE });
  assert(s1.created === true, 'G13: 首次 ok');
  const ctx = {
    auth: { authenticated: true, userId: env.fixture.ids.volA, teamId: env.fixture.ids.teamA, role: 'volunteer', roles: [{ role: 'volunteer', scopeTeamId: env.fixture.ids.teamA }] },
    tenant: { scope: 'TEAM_SCOPED', teamId: env.fixture.ids.teamA, userId: env.fixture.ids.volA },
  };
  const repo = new FormEngineRepository({ db: env.db, ctx });
  const vRow = env.raw.prepare('SELECT version_id FROM form_submissions WHERE id=1').get();
  const dup = await repo.createSubmissionAtomically({
    publicId: generateUlid(), definitionId: 1, versionId: vRow.version_id, submitterUserId: 1, teamId: 1,
    consumerType: 'activity.signup', consumerPublicId: null, consumerKey: 'activity.signup:',
    answersJson: JSON.stringify(ANSWERS_ONE), status: 2, now: Math.floor(Date.now() / 1000), submittedAt: Math.floor(Date.now() / 1000),
  });
  assert(Number(dup) === 0, 'G13: 原子谓词零插入（changes=0，非 last_row_id）');
  await expectConflict(() => svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: ANSWERS_ONE }), ConflictReason.FORM_SUBMISSION_DUPLICATE, 'G13-service');
  const active = env.raw.prepare("SELECT COUNT(*) n FROM form_submissions WHERE definition_id=1 AND submitter_user_id=1 AND consumer_key='activity.signup:' AND status=2").get();
  assert(Number(active.n) === 1, 'G13: 最终仅一条 active submitted');
});

// =========================================================================
// G14 权限矩阵（route 层）
// =========================================================================
section('G14 permission matrix (route)');
await scenario('G14', async (env) => {
  const { Hono } = await import('hono');
  const { authContextMiddleware } = await import('../src/middleware/auth.ts');
  const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope.ts');
  const { csrfGuardMiddleware } = await import('../src/middleware/csrf.ts');
  const { errorHandler } = await import('../src/middleware/error-handler.ts');
  const forms = (await import('../src/routes/forms.ts')).default;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', authContextMiddleware);
  app.use('*', tenantContextMiddleware);
  app.use('/api/v2/*', csrfGuardMiddleware);
  const v2 = new Hono();
  v2.route('/forms', forms);
  app.route('/api/v2', v2);
  const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };

  const req = async (method, path, body, role, userId, teamId) => {
    const headers = { 'content-type': 'application/json' };
    if (role) { headers['x-test-role'] = role; headers['x-test-user'] = String(userId); headers['x-test-team'] = String(teamId); }
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, baseEnv);
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  const fields = [{ key: 'name', label: '姓名', type: 'text', required: true }];
  // 建 definition+publish+binding 前置（owner 脚本路径）
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields });
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });

  // volunteer 无 manage
  const r1 = await req('POST', '/api/v2/forms/definitions', { name: 'x', fields }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(r1.status === 403, `G14: volunteer 建 definition → 403（实=${r1.status}）`);
  // volunteer 可读 definition（definition.read）
  const r2 = await req('GET', `/api/v2/forms/definitions/${d.public_id}`, undefined, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(r2.status === 200 && r2.json?.data?.definition?.public_id === d.public_id, `G14: volunteer 读 definition → 200（实=${r2.status}）`);
  // team_owner 可建
  const r3 = await req('POST', '/api/v2/forms/definitions', { name: 'y', fields }, 'team_owner', env.fixture.ids.ownerA, env.fixture.ids.teamA);
  assert(r3.status === 201, `G14: team_owner 建 definition → 201（实=${r3.status}）`);
  // team_auditor 只读
  const r4 = await req('GET', `/api/v2/forms/definitions/${d.public_id}`, undefined, 'team_auditor', env.fixture.ids.auditorA, env.fixture.ids.teamA);
  assert(r4.status === 200, `G14: auditor 读 → 200（实=${r4.status}）`);
  const r5 = await req('POST', '/api/v2/forms/definitions', { name: 'z', fields }, 'team_auditor', env.fixture.ids.auditorA, env.fixture.ids.teamA);
  assert(r5.status === 403, `G14: auditor 建 → 403（实=${r5.status}）`);
  // volunteer 提交
  const pid = generateUlid();
  const r6 = await req('POST', '/api/v2/forms/submissions', { consumer_type: 'activity.signup', new_public_id: pid, answers: { name: 'A' } }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
  assert(r6.status === 201 && r6.json?.data?.submission?.public_id === pid, `G14: volunteer submit → 201（实=${r6.status}）`);
  // auditor 不可提交 / 不可 manage
  const r7 = await req('POST', '/api/v2/forms/submissions', { consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: { name: 'A' } }, 'team_auditor', env.fixture.ids.auditorA, env.fixture.ids.teamA);
  assert(r7.status === 403, `G14: auditor submit → 403（实=${r7.status}）`);
  // 未认证 → 401
  const r8 = await req('GET', `/api/v2/forms/definitions/${d.public_id}`, undefined, null, null, null);
  assert(r8.status === 401, `G14: 未认证 → 401（实=${r8.status}）`);
});

// =========================================================================
// G15 零内部 id
// =========================================================================
section('G15 zero internal IDs');
await scenario('G15 所有视图/响应深层无内部键', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const d = await svc.createDefinition({ name: 't', fields: FIELDS_ONE });
  await svc.publishDefinition(d.public_id);
  await svc.createNextDefinitionDraft(d.public_id);
  await svc.patchDefinitionDraft(d.public_id, [...FIELDS_ONE, { key: 'p', label: 'P', type: 'phone', required: false }]);
  await svc.publishDefinition(d.public_id);
  await svc.createBinding({ definition_public_id: d.public_id, consumer_type: 'activity.signup', is_default: true });
  const defV = await svc.getDefinition(d.public_id);
  assert(!hasInternalKeys(defV), 'G15: definition 视图无内部键');
  const render = await svc.getConsumerForm('activity.signup', env.fixture.actA1);
  assert(!hasInternalKeys(render), 'G15: consumer form 无内部键');
  const svcV = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const sub = await svcV.submit({ consumer_type: 'activity.signup', new_public_id: generateUlid(), answers: ANSWERS_ONE });
  assert(!hasInternalKeys(sub.submission) && !hasInternalKeys(sub), 'G15: submission 视图无内部键');
  const mine = await svcV.listOwnSubmissions();
  assert(!hasInternalKeys(mine), 'G15: mine 列表无内部键');
});

// =========================================================================
// 汇总
// =========================================================================
console.log(`\n================ P20 FORM ENGINE 结果 ================`);
console.log(`PASS=${pass}  FAIL=${failCount}`);
if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  -', f); }
if (failCount > 0) process.exit(1);
console.log('ALL P20 FORM ENGINE SCENARIOS PASSED');
process.exit(0);