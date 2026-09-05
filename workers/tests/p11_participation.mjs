/**
 * S2-NEW-ARCH-P11 Participation —— 全场景离线测试（TEST-ONLY，不触碰真实 D1 / 迁移 / 生产代码）。
 *
 * 执行方式：
 *   node --experimental-strip-types --experimental-loader ./ts_loader.mjs tests/p11_participation.mjs
 *
 * 覆盖（≥27 指定场景，实际 38 个 service 场景 + 6 个 route 集成场景）：
 *   - CREATE SELF / TEAM（occurrence-level & slot-level，含 position/PSP）
 *   - 全部 6 类冻结 ConflictReason：SLOT_AT_CAPACITY / PSP_MISSING / PARENT_MISMATCH /
 *     CROSS_MODE_CONFLICT / OLD_NOT_ACTIVE / PUBLIC_ID_CONFLICT
 *   - 幂等：new_public_id 命中全指纹 → 200 IDEMPOTENT_REPLAY；否则 409 PUBLIC_ID_CONFLICT
 *   - 所有权/团队范围：SELF 仅本人 signup；TEAM manage 跨团队成员受 team-scope 收口
 *   - CANCEL（含取消重试幂等 200）
 *   - UPDATE POSITION（仅改同一条活跃行的 occurrence_position_id）
 *   - REASSIGN SLOT（原子双语句：插入新行 + 条件取消旧行）
 *   - LIST / DETAIL（本人名册 vs 团队名册，跨用户隔离）
 *   - ROUTE 层：HTTP 状态映射（201 新建 / 200 replay / 409 reason / 403 无权限 / 401 未认证）
 *
 * 纪律：每场景独立临时 DB（真实迁移 0001–0014 + 父表 fixture + P11 权限码注入；无任何 schema 增补），
 * 不重置真实 D1，不修改冻结迁移。
 *
 * P11-TEAM-ASSIGN-IDENTITY-FIX：TEAM assign 不再使用 signup_public_id（真实 activity_signups 无
 * public_id 列），改用 user_public_id + route activity 唯一解析 signup；
 * 旧 p11db.mjs 为该列做的 ALTER 增补已删除，测试运行在真实 migrations schema 上。
 */

import { buildP11Db } from './lib/p11db.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { ParticipationService } from '../src/services/participation-service';
import { AppError, ErrorCode } from '../src/utils/errors';

// ---- 轻量测试运行器 ----
let pass = 0;
let failCount = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
    // console.log('  ✓', msg);
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
  const auth = {
    authenticated: true,
    userId,
    teamId,
    role,
    roles: [{ role, scopeTeamId: teamId }],
  };
  const tenant = { scope: 'TEAM_SCOPED', teamId, userId };
  return new ParticipationService({ db: env.db, auth, tenant });
}

/** 期望 fn 抛出 AppError 且 code===expectedCode。返回抛出的错误供进一步断言。 */
async function expectThrow(fn, expectedCode, label) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError && e.code === expectedCode) return e;
    throw new Error(`${label}: 期望 AppError.code=${expectedCode}，实际得到 ${(e instanceof AppError && e.code) || (e && e.message)}`);
  }
  throw new Error(`${label}: 期望抛出 AppError.code=${expectedCode}，但未抛错`);
}

/** 期望 fn 抛出 409 且 details.reason===expectedReason。 */
async function expectConflict(fn, expectedReason, label) {
  const e = await expectThrow(fn, ErrorCode.CONFLICT, label);
  assert(e.details && e.details.reason === expectedReason, `${label}: 409 reason=${expectedReason}（实=${e.details && e.details.reason}）`);
}

// 每个 service 场景用独立临时 DB，保证确定性隔离
async function scenario(name, fn) {
  const env = await buildP11Db();
  try {
    await fn(env);
  } catch (e) {
    failCount++;
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ SCENARIO FAIL [${name}]:`, e.message);
  } finally {
    env.close();
  }
}

// =========================================================================
// A. CREATE SELF（occurrence-level）
// =========================================================================
section('A. CREATE SELF — occurrence-level');
await scenario('A1 本人 occurrence-level 创建（无 slot）', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  const r = await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  assert(r.replay === false, 'A1: 首次创建 replay=false');
  assert(r.participation.slot_id === null, 'A1: occurrence-level slot_id=null');
  assert(r.participation.status === 1, 'A1: status=1');
  const row = env.raw.prepare('SELECT * FROM activity_participations WHERE public_id=?').get(pid);
  assert(row && row.status === 1 && row.cancelled_at === null, 'A1: DB 落库活跃行');
});

await scenario('A2 同 new_public_id 命中 → 200 IDEMPOTENT_REPLAY', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  const r1 = await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  assert(r1.replay === false, 'A2: 首次 replay=false');
  const r2 = await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  assert(r2.replay === true, 'A2: 重放 replay=true');
  assert(r2.participation.public_id === pid, 'A2: 返回同一参与行');
});

await scenario('A3 new_public_id 非法（非 ULID）→ 400 invalidParam', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: 'not-a-ulid' }),
    ErrorCode.INVALID_PARAM,
    'A3',
  );
});

await scenario('A4 occurrence 不存在 → 404', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: generateUlid(), new_public_id: generateUlid() }),
    ErrorCode.NOT_FOUND,
    'A4',
  );
});

await scenario('A5 跨活动父级不匹配（occ 属 actA2，signup 属 actA1）→ PARENT_MISMATCH', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ3, new_public_id: generateUlid() }),
    'parent_mismatch',
    'A5',
  );
});

await scenario('A6 报名未批准（review_status=0）→ PARENT_MISMATCH', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volD, env.fixture.ids.teamA);
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    'parent_mismatch',
    'A6',
  );
});

// =========================================================================
// B. CREATE SELF（slot-level）
// =========================================================================
section('B. CREATE SELF — slot-level / position / PSP / 容量 / 互斥');
await scenario('B1 本人 slot-level 创建（无 position）→ 201', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  const r = await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  assert(r.replay === false, 'B1: 新建');
  assert(r.participation.slot_id != null && r.participation.occurrence_position_id === null, 'B1: slot 设值 / position 为 null');
});

await scenario('B2 slot-level + 有效 position（PSP 存在）→ 201，position 写入', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  const r = await svc.createSelf(env.fixture.actA1, {
    occurrence_public_id: env.fixture.occ1,
    slot_public_id: env.fixture.slot1,
    position_public_id: env.fixture.op1,
    new_public_id: pid,
  });
  assert(r.participation.slot_id != null && r.participation.occurrence_position_id != null, 'B2: slot+position 均写入');
});

await scenario('B3 slot-level + position 但 PSP 缺失（slot2×op2 无 PSP）→ PSP_MISSING', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, {
      occurrence_public_id: env.fixture.occ1,
      slot_public_id: env.fixture.slot2,
      position_public_id: env.fixture.op2,
      new_public_id: generateUlid(),
    }),
    'psp_missing',
    'B3',
  );
});

await scenario('B4 已存在 occurrence-level，再建 slot-level → CROSS_MODE_CONFLICT', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() });
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() }),
    'cross_mode_conflict',
    'B4',
  );
});

await scenario('B5 已存在 slot-level，再建 occurrence-level → CROSS_MODE_CONFLICT', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    'cross_mode_conflict',
    'B5',
  );
});

await scenario('B6 同 slot 同 signup 重复建（不同 new_public_id）→ PUBLIC_ID_CONFLICT', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  await expectConflict(
    () => svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() }),
    'public_id_conflict',
    'B6',
  );
});

await scenario('B7 slot 硬容量满（slot2 cap=2）→ SLOT_AT_CAPACITY', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const svcE = makeSvc(env, env.fixture.ids.volE, env.fixture.ids.teamA);
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: generateUlid() });
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: generateUlid() });
  await expectConflict(
    () => svcE.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: generateUlid() }),
    'slot_at_capacity',
    'B7',
  );
});

// =========================================================================
// C. CREATE TEAM（manage）
// =========================================================================
section('C. CREATE TEAM — manage 代分配');
await scenario('C1 协调员以 user_public_id 为成员代分配 slot-level → 201，且命中正确 signup', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  const pid = generateUlid();
  const r = await svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  assert(r.replay === false && r.participation.slot_id != null, 'C1: 代分配成功');
  const row = env.raw.prepare('SELECT signup_id FROM activity_participations WHERE public_id=?').get(pid);
  const volASignupId = env.raw.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(env.fixture.ids.actA1, env.fixture.ids.volA)?.id;
  assert(row?.signup_id === volASignupId, 'C1: 解析到的 signup 确为 volA→actA1（activity+user 唯一解析）');
});

await scenario('C2 代分配缺少 user_public_id → 400', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  await expectThrow(
    () => svc.createForTeam(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    ErrorCode.INVALID_PARAM,
    'C2',
  );
});

await scenario('C2b 代分配 malformed user_public_id → 400', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  await expectThrow(
    () => svc.createForTeam(env.fixture.actA1, { user_public_id: 'not-a-ulid', occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    ErrorCode.INVALID_PARAM,
    'C2b',
  );
});

await scenario('C3 代分配同 new_public_id → 200 replay', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  const pid = generateUlid();
  await svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  const r2 = await svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  assert(r2.replay === true, 'C3: 代分配 replay=true');
});

await scenario('C4 目标用户无该 activity signup（含跨团队 volB@teamB）→ 404', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  await expectThrow(
    () => svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolB, occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    ErrorCode.NOT_FOUND,
    'C4',
  );
});

await scenario('C5 代分配跨模式互斥 → CROSS_MODE_CONFLICT', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  await svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() });
  await expectConflict(
    () => svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() }),
    'cross_mode_conflict',
    'C5',
  );
});

await scenario('C6 team_owner 可代分配 → 201', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.ownerA, env.fixture.ids.teamA, 'team_owner');
  const pid = generateUlid();
  const r = await svc.createForTeam(env.fixture.actA1, { user_public_id: env.fixture.userVolC, occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  assert(r.replay === false, 'C6: team_owner 代分配成功');
});

// =========================================================================
// D. CANCEL
// =========================================================================
section('D. CANCEL — SELF / TEAM / 幂等 / 所有权');
await scenario('D1 取消本人参与 → status=2 + cancelled_at', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  const cancelled = await svc.cancelSelf(pid);
  assert(cancelled.status === 2 && cancelled.cancelled_at != null, 'D1: 逻辑取消');
});

await scenario('D2 取消重试 → 幂等 200（不抛错）', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  await svc.cancelSelf(pid);
  const again = await svc.cancelSelf(pid);
  assert(again.status === 2, 'D2: 取消重试幂等');
});

await scenario('D3 SELF 取消他人参与 → 404（所有权）', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const pidC = generateUlid();
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pidC });
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svcA.cancelSelf(pidC), ErrorCode.NOT_FOUND, 'D3');
});

await scenario('D4 取消不存在 → 404', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svc.cancelSelf(generateUlid()), ErrorCode.NOT_FOUND, 'D4');
});

await scenario('D5 TEAM 协调员取消他人参与 → status=2', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const pidC = generateUlid();
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pidC });
  const svcAdmin = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  const r = await svcAdmin.cancelForTeam(pidC);
  assert(r.status === 2, 'D5: 协调员可取消团队内任意参与');
});

// =========================================================================
// E. UPDATE POSITION
// =========================================================================
section('E. UPDATE POSITION — 仅改同一条活跃行的岗位');
await scenario('E1 本人改岗位（slot×op 有 PSP）→ 写新 occurrence_position_id', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  const r0 = await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, position_public_id: env.fixture.op1, new_public_id: pid });
  assert(r0.participation.occurrence_position_id != null, 'E1: 初始岗位=op1');
  const r1 = await svc.updatePositionSelf(pid, env.fixture.op2);
  assert(r1.occurrence_position_id != null && r1.occurrence_position_id !== r0.participation.occurrence_position_id, 'E1: 岗位改为 op2');
});

await scenario('E2 改岗位但 PSP 缺失 → PSP_MISSING', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: pid }); // slot2 无 position
  await expectConflict(() => svc.updatePositionSelf(pid, env.fixture.op2), 'psp_missing', 'E2');
});

await scenario('E3 改已取消参与的岗位 → 404（无副作用）', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, position_public_id: env.fixture.op1, new_public_id: pid });
  await svc.cancelSelf(pid);
  await expectThrow(() => svc.updatePositionSelf(pid, env.fixture.op2), ErrorCode.NOT_FOUND, 'E3');
});

await scenario('E4 SELF 改他人参与岗位 → 404', async (env) => {
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const pidC = generateUlid();
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, position_public_id: env.fixture.op1, new_public_id: pidC });
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svcA.updatePositionSelf(pidC, env.fixture.op2), ErrorCode.NOT_FOUND, 'E4');
});

// =========================================================================
// F. REASSIGN SLOT
// =========================================================================
section('F. REASSIGN SLOT — 原子双语句（插新 + 条件取消旧）');
await scenario('F1 改派 slot1→slot2 → 新行建 + 旧行取消', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const oldPid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid });
  const newPid = generateUlid();
  const r = await svc.reassignSelf(oldPid, { new_slot_public_id: env.fixture.slot2, new_public_id: newPid });
  assert(r.replay === false, 'F1: 新建改派行');
  assert(r.participation.slot_id != null && r.participation.status === 1, 'F1: 新行活跃 + 落在新 slot');
  const oldRow = env.raw.prepare('SELECT * FROM activity_participations WHERE public_id=?').get(oldPid);
  assert(oldRow.status === 2 && oldRow.cancelled_at != null, 'F1: 旧行已逻辑取消');
  const newRow = env.raw.prepare('SELECT * FROM activity_participations WHERE public_id=?').get(newPid);
  assert(newRow.slot_id != null, 'F1: 新行位于 slot2');
});

await scenario('F2 改派至相同 slot → OLD_NOT_ACTIVE', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  await expectConflict(() => svc.reassignSelf(pid, { new_slot_public_id: env.fixture.slot1, new_public_id: generateUlid() }), 'old_not_active', 'F2');
});

await scenario('F3 对 occurrence-level 参与改派 → OLD_NOT_ACTIVE', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, new_public_id: pid });
  await expectConflict(() => svc.reassignSelf(pid, { new_slot_public_id: env.fixture.slot1, new_public_id: generateUlid() }), 'old_not_active', 'F3');
});

await scenario('F4 改派 new_public_id 命中目标 slot 已有活跃行（同指纹）→ 200 replay', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const oldPid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid });
  const newPid = generateUlid();
  await svc.reassignSelf(oldPid, { new_slot_public_id: env.fixture.slot2, new_public_id: newPid });
  // 再建一条 slot1 活跃参与
  const oldPid2 = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid2 });
  // 用同一 new_public_id 改派到 slot2（slot2 已存在 newPid 活跃行）→ replay
  const r = await svc.reassignSelf(oldPid2, { new_slot_public_id: env.fixture.slot2, new_public_id: newPid });
  assert(r.replay === true, 'F4: 命中目标 slot 已有同 public_id 活跃行 → replay');
});

await scenario('F5 改派 new_public_id 冲突（目标 slot 已有不同 public_id 活跃行）→ PUBLIC_ID_CONFLICT', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const oldPid = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid });
  const newPid = generateUlid();
  await svc.reassignSelf(oldPid, { new_slot_public_id: env.fixture.slot2, new_public_id: newPid });
  const oldPid2 = generateUlid();
  await svc.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid2 });
  await expectConflict(() => svc.reassignSelf(oldPid2, { new_slot_public_id: env.fixture.slot2, new_public_id: generateUlid() }), 'public_id_conflict', 'F5');
});

await scenario('F6 改派目标 slot 容量满 → SLOT_AT_CAPACITY', async (env) => {
  // 先占满 slot2（volC + volE），再由 volA 把 slot1 改派到 slot2
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const svcE = makeSvc(env, env.fixture.ids.volE, env.fixture.ids.teamA);
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: generateUlid() });
  await svcE.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot2, new_public_id: generateUlid() });
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const oldPid = generateUlid();
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: oldPid });
  await expectConflict(() => svcA.reassignSelf(oldPid, { new_slot_public_id: env.fixture.slot2, new_public_id: generateUlid() }), 'slot_at_capacity', 'F6');
});

// =========================================================================
// G. LIST / DETAIL
// =========================================================================
section('G. LIST / DETAIL — 本人名册 vs 团队名册');
await scenario('G1 listOwn 仅返回本人参与', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  const mine = await svcA.listOwn(env.fixture.actA1);
  assert(mine.length === 1 && mine[0].signup_id === env.fixture.ids.volA, 'G1: 仅本人 1 行');
});

await scenario('G2 listTeam 返回团队名册（含 volA + volC）', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  await svcC.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: generateUlid() });
  const svcAdmin = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  const team = await svcAdmin.listTeam(env.fixture.actA1);
  assert(team.length === 2, 'G2: 团队名册含 2 行');
});

await scenario('G3 getDetailSelf 本人 OK / 他人 404', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  const ok = await svcA.getDetailSelf(pid);
  assert(ok.public_id === pid, 'G3: 本人详情可读');
  const svcC = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await expectThrow(() => svcC.getDetailSelf(pid), ErrorCode.NOT_FOUND, 'G3-他人');
});

await scenario('G4 getDetailTeam 协调员可读团队内任意行', async (env) => {
  const svcA = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const pid = generateUlid();
  await svcA.createSelf(env.fixture.actA1, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid });
  const svcAdmin = makeSvc(env, env.fixture.ids.adminA, env.fixture.ids.teamA, 'team_admin');
  const r = await svcAdmin.getDetailTeam(pid);
  assert(r.public_id === pid, 'G4: 协调员可读团队名册中任意参与');
});

// =========================================================================
// H. ROUTE 层集成（HTTP 状态映射 + RBAC + 认证）
// =========================================================================
section('H. ROUTE 层 — HTTP 状态映射 / RBAC / 认证（真实 Hono + 真实中间件 + D1 shim）');
{
  const env = await buildP11Db();
  try {
    const { Hono } = await import('hono');
    const { authContextMiddleware } = await import('../src/middleware/auth.ts');
    const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope.ts');
    const { csrfGuardMiddleware } = await import('../src/middleware/csrf.ts');
    const { errorHandler } = await import('../src/middleware/error-handler.ts');
    const participations = (await import('../src/routes/participations.ts')).default;

    // 隔离式装配：仅挂载 P11 Participation 路由 + 真实中间件链（避免拖入既有 Attendance 模块
    // 的无关 import 错误）。挂载前缀与真实 app.ts 完全一致（/api/v2/activities）。
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', authContextMiddleware);
    app.use('*', tenantContextMiddleware);
    app.use('/api/v2/*', csrfGuardMiddleware);
    const v2 = new Hono();
    v2.route('/activities', participations);
    app.route('/api/v2', v2);

    const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };
    const post = async (path, body, role, userId, teamId) => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) },
        body: JSON.stringify(body),
      }, baseEnv);
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    };

    // H1 创建 → 201
    const pid1 = generateUlid();
    const r1 = await post(`/api/v2/activities/${env.fixture.actA1}/participations`, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid1 }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r1.status === 201 && r1.json?.success === true && r1.json?.data?.participation?.public_id === pid1, 'H1: 创建 → 201');

    // H2 同 new_public_id → 200 replay
    const r2 = await post(`/api/v2/activities/${env.fixture.actA1}/participations`, { occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid1 }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r2.status === 200 && r2.json?.success === true, 'H2: 重放 → 200');

    // H3 跨模式冲突 → 409 + reason
    const r3 = await post(`/api/v2/activities/${env.fixture.actA1}/participations`, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r3.status === 409 && r3.json?.error?.details?.reason === 'cross_mode_conflict', 'H3: 跨模式 → 409 cross_mode_conflict');

    // H4 无权限角色（team_auditor 无 participation.*）→ 403
    const r4 = await post(`/api/v2/activities/${env.fixture.actA1}/participations`, { occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }, 'team_auditor', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r4.status === 403, 'H4: 无权限 → 403');

    // H5 未认证（无 x-test-role）→ 401
    const res5 = await app.request(`/api/v2/activities/${env.fixture.actA1}/participations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }),
    }, baseEnv);
    assert(res5.status === 401, 'H5: 未认证 → 401');

    // H6 TEAM assign 用 volunteer（无 manage）→ 403
    const r6 = await post(`/api/v2/activities/${env.fixture.actA1}/participations/assign`, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }, 'volunteer', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r6.status === 403, 'H6: volunteer 代分配 → 403');

    // H6b TEAM assign 用 team_auditor（无 manage）→ 403
    const r6b = await post(`/api/v2/activities/${env.fixture.actA1}/participations/assign`, { user_public_id: env.fixture.userVolA, occurrence_public_id: env.fixture.occ1, new_public_id: generateUlid() }, 'team_auditor', env.fixture.ids.volA, env.fixture.ids.teamA);
    assert(r6b.status === 403, 'H6b: team_auditor 代分配 → 403');

    // H7 TEAM assign 用 team_admin → 201（代 volC 报名，区别于 H1 已占用的 volA 名额）
    const pid7 = generateUlid();
    const r7 = await post(`/api/v2/activities/${env.fixture.actA1}/participations/assign`, { user_public_id: env.fixture.userVolC, occurrence_public_id: env.fixture.occ1, slot_public_id: env.fixture.slot1, new_public_id: pid7 }, 'team_admin', env.fixture.ids.adminA, env.fixture.ids.teamA);
    assert(r7.status === 201 && r7.json?.data?.participation?.public_id === pid7, 'H7: team_admin 代分配 → 201');
  } catch (e) {
    failCount++;
    failures.push(`H route section: ${e.message}`);
    console.error('  ✗ ROUTE SECTION ERROR:', e.message);
  } finally {
    env.close();
  }
}

// =========================================================================
// 汇总
// =========================================================================
console.log(`\n================ P11 场景测试结果 ================`);
console.log(`PASS=${pass}  FAIL=${failCount}`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  -', f);
}
if (failCount > 0) {
  process.exit(1);
}
console.log('ALL P11 SCENARIOS PASSED');
process.exit(0);
