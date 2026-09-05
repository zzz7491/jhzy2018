/**
 * P19 Participation Onboarding —— GET setup / POST ensure 专项测试（TEST-ONLY）。
 *
 * 冻结契约（P19 DESIGN REV1）：setup 纯读零写副作用；ensure body 必填 occurrence_public_id；
 * 服务端生成 Participation public_id；仅无 active slot 的 occurrence 允许 occurrence-level 物化；
 * 响应只出 public_id，不泄露内部 integer id；multi-occurrence 逐场独立。
 *
 * fixture：tests/lib/p16db.mjs（真实 migrations 0001–0014，无 schema 增补）。
 *
 * 运行：node --experimental-transform-types --loader ./ts_loader.mjs tests/p19_setup_ensure.mjs
 */
import { makeP16Db, destroyP16Db, countRows } from './lib/p16db.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { ParticipationService } from '../src/services/participation-service';
import { AppError, ErrorCode, ConflictReason } from '../src/utils/errors';

const NOW = () => Math.floor(Date.now() / 1000);

let pass = 0;
let failCount = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    failCount++;
    failures.push(msg);
    console.error('  ✗ FAIL:', msg);
  }
}
function section(title) {
  console.log('\n=== ' + title + ' ===');
}

function makeSvc(env, userId, teamId, role = 'volunteer') {
  const auth = { authenticated: true, userId, teamId, role, roles: [{ role, scopeTeamId: teamId }] };
  const tenant = { scope: 'TEAM_SCOPED', teamId, userId };
  return new ParticipationService({ db: env.db, auth, tenant });
}

async function expectThrow(fn, expectedCode, label) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError && e.code === expectedCode) return e;
    throw new Error(`${label}: 期望 AppError.code=${expectedCode}，实际=${e instanceof AppError ? e.code : e?.message}`);
  }
  throw new Error(`${label}: 期望抛出 ${expectedCode}，但未抛错`);
}
async function expectConflict(fn, expectedReason, label) {
  const e = await expectThrow(fn, ErrorCode.CONFLICT, label);
  assert(e.details && e.details.reason === expectedReason, `${label}: 409 reason=${expectedReason}（实=${e.details && e.details.reason}）`);
}

async function scenario(name, fn) {
  const env = makeP16Db();
  try {
    await fn(env);
  } catch (e) {
    failCount++;
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ SCENARIO FAIL [${name}]:`, e.message);
  } finally {
    destroyP16Db(env);
  }
}

/** 深扫 JSON 是否出现内部键（证明响应零 integer id 泄露）。 */
function hasInternalKeys(obj) {
  const INTERNAL = ['id', 'signup_id', 'occurrence_id', 'slot_id', 'occurrence_position_id'];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || cur === undefined || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (INTERNAL.includes(k)) return true;
      stack.push(v);
    }
  }
  return false;
}

// =========================================================================
// 1. single occurrence deterministic ensure（自建 actC：唯一 active occC，无 slot 无 position）
// =========================================================================
section('S1 单场次 deterministic ensure（新建 actC/occC）');
await scenario('S1 ensure → 201 created；重复 ensure → 200；GET setup 反映 READY', async (env) => {
  const run = (sql, p = []) => env.raw.prepare(sql).run(...p);
  const actC = generateUlid();
  const occC = generateUlid();
  const T0 = NOW();
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (4,?,1,\'actC\',1,1,?,?)', [actC, T0, T0 + 3600]);
  run('INSERT INTO activity_signups (id, activity_id, user_id, review_status, status, created_at) VALUES (7,4,2,1,1,?)', [T0]);
  run('INSERT INTO activity_occurrences (id, public_id, activity_id, status, start_time, end_time, created_at) VALUES (6,?,4,1,?,?,?)', [occC, T0, T0 + 3600, T0]);

  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const r1 = await svcB.ensureSelf(actC, occC);
  assert(r1.created === true, 'S1: 首次 ensure → created=true（201）');
  assert(r1.participation.occurrence_public_id === occC, 'S1: occurrence_public_id 正确');
  assert(r1.participation.slot_public_id === null, 'S1: slot_public_id=NULL');
  assert(r1.participation.occurrence_position_public_id === null, 'S1: occurrence_position_public_id=NULL（不猜 position）');
  assert(r1.participation.status === 1, 'S1: status=1 assigned');

  const r2 = await svcB.ensureSelf(actC, occC);
  assert(r2.created === false && r2.participation.public_id === r1.participation.public_id, 'S1: 重复 ensure → 200 收敛同一行');

  const setup = await svcB.getSetupSelf(actC);
  assert(setup.status === 'PARTICIPATION_AVAILABLE', 'S1: setup.status=PARTICIPATION_AVAILABLE');
  assert(setup.occurrences.length === 1 && setup.occurrences[0].state === 'READY' && setup.occurrences[0].can_ensure === false, 'S1: ensure 后 occ → READY');
});

// =========================================================================
// 2. multi-occurrence：A READY 不影响 B
// =========================================================================
section('S2 multi-occurrence 逐场独立（actA1：occ1 有 slot，occ2 无 slot）');
await scenario('S2 volA 已有 occ1 参与：GET setup 仍返回全部 active occurrences', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  assert(setup.status === 'PARTICIPATION_AVAILABLE', 'S2: status');
  assert(setup.occurrences.length === 2, `S2: 两个 active occurrence 都在（实=${setup.occurrences.length}）`);
  const byPid = Object.fromEntries(setup.occurrences.map((o) => [o.public_id, o]));
  const occ1 = byPid[env.fixture.occ1];
  const occ2 = byPid[env.fixture.occ2];
  assert(occ1 && occ1.state === 'READY' && occ1.can_ensure === false && occ1.has_occurrence_level_participation === true, 'S2: occ1 → READY（已有 occ-level pOccOnly）');
  assert(occ2 && occ2.state === 'AVAILABLE_DETERMINISTIC' && occ2.can_ensure === true, 'S2: occ2 → AVAILABLE_DETERMINISTIC（未受影响，不隐藏）');
});

// =========================================================================
// 3. multi-occurrence 两场分别 ensure
// =========================================================================
section('S3 逐场 ensure（volB：occ2 新建 occ-level；occ1 已有 slot-level → READY）');
await scenario('S3', async (env) => {
  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const r1 = await svcB.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(r1.created === true, 'S3: occ2 ensure → 201');
  const r2 = await svcB.ensureSelf(env.fixture.actA1, env.fixture.occ1);
  assert(r2.created === false, 'S3: occ1（已有 slot-level pSlot）→ 200 READY');
  const n = env.raw.prepare('SELECT COUNT(*) n FROM activity_participations WHERE signup_id=2 AND occurrence_id=2 AND slot_id IS NULL AND status=1').get().n;
  assert(Number(n) === 1, 'S3: occ2 恰好一条 occ-level active');
  const setup = await svcB.getSetupSelf(env.fixture.actA1);
  const byPid = Object.fromEntries(setup.occurrences.map((o) => [o.public_id, o]));
  assert(byPid[env.fixture.occ1].state === 'READY' && byPid[env.fixture.occ2].state === 'READY', 'S3: 两场均 READY');
});

// =========================================================================
// 4. active slot → manual（409 participation_requires_manual）
// =========================================================================
section('S4 occurrence 有 active slot → ensure 拒绝，409');
await scenario('S4 volA 清空 occ1 活跃参与后，ensure occ1（有 slot）→ 409 requires_manual', async (env) => {
  const run = (sql, p = []) => env.raw.prepare(sql).run(...p);
  // volA 在 occ1 的活跃参与行：pOccOnly(1)、pSlotWrong(8)、pOpDeleted(11) → 全部取消
  run('UPDATE activity_participations SET status=2, cancelled_at=?, updated_at=? WHERE id IN (1,8,11)', [NOW(), NOW()]);
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svcA.ensureSelf(env.fixture.actA1, env.fixture.occ1), ConflictReason.PARTICIPATION_REQUIRES_MANUAL, 'S4');
  assert(countRows(env, 'activity_participations') === 13, 'S4: 拒绝不新增行（零写入）');
});

// =========================================================================
// 5. 无 slot + 有 position → deterministic（positions 不影响 can_ensure）
// =========================================================================
section('S5 position 不影响 can_ensure');
await scenario('S5 occ2 加一个岗位后仍 deterministic，ensure 不猜 position', async (env) => {
  const run = (sql, p = []) => env.raw.prepare(sql).run(...p);
  run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, created_at) VALUES (5,?,2,1,0,0,?)', [generateUlid(), NOW()]);
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  const occ2 = setup.occurrences.find((o) => o.public_id === env.fixture.occ2);
  assert(occ2.state === 'AVAILABLE_DETERMINISTIC' && occ2.can_ensure === true, 'S5: 有 position 无 slot → 仍 deterministic');
  assert(occ2.positions.length === 1 && occ2.slots.length === 0, 'S5: positions 可见、slots 为空');
  const r = await svcA.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(r.created === true && r.participation.occurrence_position_public_id === null, 'S5: ensure 不猜 position（position=NULL）');
});

// =========================================================================
// 6. existing slot-level → READY
// =========================================================================
section('S6 existing slot-level → READY');
await scenario('S6', async (env) => {
  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const setup = await svcB.getSetupSelf(env.fixture.actA1);
  const occ1 = setup.occurrences.find((o) => o.public_id === env.fixture.occ1);
  assert(occ1.state === 'READY' && occ1.has_slot_level_participation === true && occ1.can_ensure === false, 'S6: slot-level pSlot → READY');
});

// =========================================================================
// 7. cancelled 不 READY；可重新 ensure/create
// =========================================================================
section('S7 cancelled participation 不 READY');
await scenario('S7 取消 volA 全部 occ1 活跃参与后 occ1 不再 READY；occ2 可重新 deterministic ensure', async (env) => {
  const run = (sql, p = []) => env.raw.prepare(sql).run(...p);
  run('UPDATE activity_participations SET status=2, cancelled_at=?, updated_at=? WHERE id IN (1,8,11)', [NOW(), NOW()]);
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  const occ1 = setup.occurrences.find((o) => o.public_id === env.fixture.occ1);
  assert(occ1.state === 'NEEDS_MANUAL_SETUP' && occ1.can_ensure === false, 'S7: 取消后 occ1（有 slot）→ NEEDS_MANUAL_SETUP，cancelled 不算 READY');
  const r = await svcA.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(r.created === true && r.participation.occurrence_public_id === env.fixture.occ2, 'S7: 取消后可对 occ2 重新 deterministic ensure');
});

// =========================================================================
// 8. invalid / not-own / not-approved / closed parent
// =========================================================================
section('S8 前置失败分类');
await scenario('S8 not-own（无该 activity signup）→ GET NONE / ensure 404', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const setup = await svcC.getSetupSelf(env.fixture.actA2);
  assert(setup.status === 'NONE', 'S8: volC 对 actA2 无 signup → NONE');
  await expectThrow(() => svcC.ensureSelf(env.fixture.actA2, env.fixture.occ3), ErrorCode.NOT_FOUND, 'S8-404');
});

await scenario('S8 not-approved（signup 已取消）→ 409 parent_mismatch', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svcA.ensureSelf(env.fixture.actA2, env.fixture.occ3), ConflictReason.PARENT_MISMATCH, 'S8');
});

await scenario('S8 closed occurrence → 409 parent_mismatch', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svcA.ensureSelf(env.fixture.actA1, env.fixture.occClosed), ConflictReason.PARENT_MISMATCH, 'S8');
});

await scenario('S8b activity closed → GET ACTIVITY_NOT_OPEN / ensure 409', async (env) => {
  env.raw.prepare('UPDATE activities SET status=4 WHERE id=1').run();
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  assert(setup.status === 'ACTIVITY_NOT_OPEN', 'S8b: status=ACTIVITY_NOT_OPEN');
  await expectConflict(() => svcA.ensureSelf(env.fixture.actA1, env.fixture.occ2), ConflictReason.PARENT_MISMATCH, 'S8b');
});

// =========================================================================
// 9. wrong occurrence parent
// =========================================================================
section('S9 父级不一致 occurrence');
await scenario('S9 跨活动 occurrence → 409 parent_mismatch；跨团队 occurrence → 404', async (env) => {
  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  await expectConflict(() => svcB.ensureSelf(env.fixture.actA1, env.fixture.occ3), ConflictReason.PARENT_MISMATCH, 'S9-act-mismatch');
  await expectThrow(() => svcB.ensureSelf(env.fixture.actA1, env.fixture.occB1), ErrorCode.NOT_FOUND, 'S9-team-404');
});

// =========================================================================
// 10. inactive occurrence 不出现在 setup occurrences[]
// =========================================================================
section('S10 inactive occurrence 不展示');
await scenario('S10', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  const pids = setup.occurrences.map((o) => o.public_id);
  assert(pids.includes(env.fixture.occ1) && pids.includes(env.fixture.occ2), 'S10: active occurrences 均在');
  assert(!pids.includes(env.fixture.occClosed) && !pids.includes(env.fixture.occB1), 'S10: completed/teamB occurrence 不在');
});

// =========================================================================
// 11. GET setup 零写副作用
// =========================================================================
section('S11 GET setup 零写副作用');
await scenario('S11', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const before = [
    countRows(env, 'activity_participations'),
    countRows(env, 'attendance_sessions'),
    countRows(env, 'attendance_events'),
  ];
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  assert(setup.status !== null, 'S11: setup 正常返回');
  const after = [
    countRows(env, 'activity_participations'),
    countRows(env, 'attendance_sessions'),
    countRows(env, 'attendance_events'),
  ];
  assert(JSON.stringify(before) === JSON.stringify(after), `S11: GET setup 零写入（before=${before} after=${after}）`);
});

// =========================================================================
// 12. 响应无内部 integer id
// =========================================================================
section('S12 全程 public_id，零内部 id');
await scenario('S12', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const setup = await svcA.getSetupSelf(env.fixture.actA1);
  assert(!hasInternalKeys(setup), 'S12: GET setup payload 不含内部键');
  const svcB = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const r = await svcB.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(!hasInternalKeys(r.participation), 'S12: ensure response participation 不含内部键');
});

// =========================================================================
// 13. ensure 幂等 201 → 200
// =========================================================================
section('S13 ensure 幂等');
await scenario('S13', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const a = await svcC.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(a.created === true, 'S13: 首次 → 201');
  const b = await svcC.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(b.created === false && b.participation.public_id === a.participation.public_id, 'S13: 重复 → 200 同 public_id');
});

// =========================================================================
// 14. ensure 并发收敛（DB partial UNIQUE 兜底）
// =========================================================================
section('S14 ensure 并发收敛');
await scenario('S14 重复 INSERT → UNIQUE 兜底 → 收敛 READY，仅一条 active', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const a = await svcC.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(a.created === true, 'S14: 首次 → 201');
  const now = NOW();
  // 绕过 precheck，直连原子插入（模拟并发竞态：第二次 INSERT 命中 partial UNIQUE idx_ap_occ）
  const { ParticipationRepository } = await import('../src/repository/participation.ts');
  const repo = new ParticipationRepository({
    db: env.db,
    ctx: {
      auth: { authenticated: true, userId: env.fixture.ids.volC, role: 'volunteer', teamId: env.fixture.ids.teamA, roles: [{ role: 'volunteer', scopeTeamId: env.fixture.ids.teamA }] },
      tenant: { scope: 'TEAM_SCOPED', teamId: env.fixture.ids.teamA, userId: env.fixture.ids.volC },
    },
  });
  const dup = await repo.createParticipationAtomically({
    publicId: generateUlid(),
    signupId: 4,
    occurrenceId: 2,
    slotId: null,
    opId: null,
    teamId: env.fixture.ids.teamA,
    now,
  });
  assert(Number(dup) === 0, 'S14: 重复原子 INSERT → 0（partial UNIQUE 兜底）');
  const b = await svcC.ensureSelf(env.fixture.actA1, env.fixture.occ2);
  assert(b.created === false, 'S14: ensure 再次调用 → 200 READY');
  const n = env.raw.prepare('SELECT COUNT(*) n FROM activity_participations WHERE signup_id=4 AND occurrence_id=2 AND slot_id IS NULL AND status=1').get().n;
  assert(Number(n) === 1, 'S14: 最终仅一条 active occ-level');
});

// =========================================================================
// 15. Route 层（真实中间件 + 隔离装配）
// =========================================================================
section('S15 Route 层 HTTP 映射');
{
  const env = makeP16Db();
  try {
    const { Hono } = await import('hono');
    const { authContextMiddleware } = await import('../src/middleware/auth.ts');
    const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope.ts');
    const { csrfGuardMiddleware } = await import('../src/middleware/csrf.ts');
    const { errorHandler } = await import('../src/middleware/error-handler.ts');
    const participations = (await import('../src/routes/participations.ts')).default;
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', authContextMiddleware);
    app.use('*', tenantContextMiddleware);
    app.use('/api/v2/*', csrfGuardMiddleware);
    const v2 = new Hono();
    v2.route('/activities', participations);
    app.route('/api/v2', v2);
    const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };

    const getSetup = async (activityId, role, userId, teamId) => {
      const res = await app.request(`/api/v2/activities/${activityId}/participations/setup`, {
        method: 'GET',
        headers: { 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) },
      }, baseEnv);
      let json = null; try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };
    const postEnsure = async (activityId, occurrenceId, role, userId, teamId) => {
      const res = await app.request(`/api/v2/activities/${activityId}/participations/ensure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) },
        body: JSON.stringify({ occurrence_public_id: occurrenceId }),
      }, baseEnv);
      let json = null; try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };

    const r1 = await getSetup(env.fixture.actA1, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r1.status === 200 && r1.json?.success === true && r1.json?.data?.status === 'PARTICIPATION_AVAILABLE', `S15: GET setup → 200（实=${r1.status}）`);
    const before = countRows(env, 'activity_participations');
    const r2 = await postEnsure(env.fixture.actA1, env.fixture.occ2, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r2.status === 201 && r2.json?.data?.status === 'READY' && r2.json?.data?.participation?.occurrence_public_id === env.fixture.occ2, `S15: POST ensure → 201（实=${r2.status}）`);
    const r3 = await postEnsure(env.fixture.actA1, env.fixture.occ2, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r3.status === 200 && r3.json?.data?.status === 'READY', `S15: POST ensure 重复 → 200（实=${r3.status}）`);
    assert(countRows(env, 'activity_participations') === before + 1, 'S15: route 层 ensure 恰好建一条');
    const r4 = await postEnsure(env.fixture.actA1, env.fixture.occ2, 'team_auditor', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r4.status === 403, `S15: team_auditor 无权限 → 403（实=${r4.status}）`);
    const r5 = await app.request(`/api/v2/activities/${env.fixture.actA1}/participations/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, baseEnv);
    assert(r5.status === 401, `S15: 未认证 → 401（实=${r5.status}）`);
  } catch (e) {
    failCount++;
    failures.push(`S15 route section: ${e.message}`);
    console.error('  ✗ ROUTE SECTION ERROR:', e.message);
  } finally {
    destroyP16Db(env);
  }
}

// =========================================================================
// 汇总
// =========================================================================
console.log(`\n================ P19 SETUP/ENSURE 结果 ================`);
console.log(`PASS=${pass}  FAIL=${failCount}`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  -', f);
}
if (failCount > 0) process.exit(1);
console.log('ALL P19 SETUP/ENSURE SCENARIOS PASSED');
process.exit(0);