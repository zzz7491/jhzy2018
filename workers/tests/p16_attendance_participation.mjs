/**
 * S2-NEW-ARCH-P16 Attendance Participation —— Targeted 测试（TEST-ONLY，零真实 D1 / 迁移 / 生产破坏）。
 *
 * 目标：只验证【当前已存在的】P16 Attendance Participation implementation（先测试，后判断）。
 *
 * 覆盖（P16-TARGETED-TESTS 指定 1–30）：
 *   Service 层（每场景独立隔离临时 DB，0001–0014 真实迁移 + p16db fixture）：
 *     1–9  三个合法签到路径（occ-only / slot / slot+position+PSP）+ 写库字段断言
 *     10   cancelled Participation → 409 attendance_participation_not_active
 *     11   signup 非 REGISTERED → 409 attendance_not_signed_up
 *     12   route activity mismatch → 404
 *     13   occurrence completed → 409 parent_mismatch
 *     14   slot deleted → 409 parent_mismatch
 *     15   slot occurrence mismatch → 409 parent_mismatch
 *     16   occurrence_position deleted → 409 parent_mismatch
 *     17   occurrence_position occurrence mismatch → 409 parent_mismatch
 *     18   underlying activity_position deleted / mismatch → 409 parent_mismatch
 *     19   slot+op 但 active PSP 不存在 → 409 parent_mismatch
 *     20   同一 Participation 已有 active attendance → 409 attendance_already_checked_in
 *     21   同一 user 另一 Participation 已有 active attendance → 409 attendance_already_checked_in
 *     22   checkout 后同一 Participation 可再次 check-in
 *     23   legacy participation_id=NULL active attendance 可 checkout
 *     24   Participation 在 session 开始后 cancelled，session 仍可 checkout
 *     25   checkout 不要求 participation_public_id（service 签名 + route 无 body 读取）
 *   Route 层（真实 Hono + 真实中间件 + D1 shim；隔离装配，避免拖入无关模块）：
 *     26   未认证 + malformed body → 401（非 400）
 *     27   有认证无权限 + malformed body → 403（非 400）
 *     28   认证+权限 + 缺 participation_public_id → 400
 *     29   malformed participation_public_id → 400
 *     +   合法 route check-in 201 / route checkout 200（空 body）
 *   并发：
 *     30   DB UNIQUE fallback：重复 INSERT → 409 attendance_already_checked_in，
 *         最终仅 1 条 active session（node:sqlite 同步，仅 sequential duplicate + UNIQUE fallback）
 *
 * 运行：node --experimental-transform-types --loader ./ts_loader.mjs tests/p16_attendance_participation.mjs
 *
 * 说明：route 层会经 middleware/rbac → services/permission-provider（D1PermissionProvider:
 * 构造器参数属性 parameter properties），strip-only 模式不支持，必须 `--experimental-transform-types`。
 */
import { makeP16Db, destroyP16Db, seedLegacyAttendanceSession, countRows } from './lib/p16db.mjs';
import { generateUlid } from './lib/d1-shim.mjs';
import { ActivityAttendanceService } from '../src/services/attendance-service';
import { AttendanceSessionRepository, ATTENDANCE_STATUS } from '../src/repository/attendance-sessions';
import { AppError, ErrorCode, ConflictReason } from '../src/utils/errors';

const NOW = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// 轻量测试运行器
// ---------------------------------------------------------------------------
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
  return new ActivityAttendanceService({ db: env.db, auth, tenant });
}

function makeCtx(envUserId, envTeamId) {
  return {
    auth: { authenticated: true, userId: envUserId, role: 'volunteer', teamId: envTeamId, roles: [{ role: 'volunteer', scopeTeamId: envTeamId }] },
    tenant: { scope: 'TEAM_SCOPED', teamId: envTeamId, userId: envUserId },
  };
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

// =========================================================================
// A. 合法签到（1–3）+ 写库字段（4–9）
// =========================================================================
section('A. Valid check-in paths (1-3)');
await scenario('S1 occurrence-only check-in → success', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const v = await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  assert(v.session_id > 0 && v.status === ATTENDANCE_STATUS.CHECKED_IN, 'S1: view session created, status=CHECKED_IN');
  assert(v.participation_id === env.fixture.ids.pOccOnly, 'S1: view participation_id');
  assert(v.participation_public_id === env.fixture.pOccOnly, 'S1: view participation_public_id');
  const ev = env.raw.prepare("SELECT COUNT(*) n FROM attendance_events WHERE session_id=? AND event_type='checkin'").get(v.session_id);
  assert(Number(ev?.n ?? 0) === 1, 'S1: 1 checkin event written');
});

await scenario('S2 slot-only check-in → success', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const v = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlot, null);
  assert(v.session_id > 0 && v.status === ATTENDANCE_STATUS.CHECKED_IN, 'S2: session created');
  assert(v.participation_id === env.fixture.ids.pSlot, 'S2: participation_id');
  const row = env.raw.prepare('SELECT slot FROM attendance_sessions WHERE id=?').get(v.session_id);
  assert(row?.slot === '', 'S2: slot text written as empty string');
});

await scenario('S3 slot+position+active PSP check-in → success', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const v = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, { latitude: 30.123, longitude: 120.456, accuracy: 5 });
  assert(v.session_id > 0 && v.status === ATTENDANCE_STATUS.CHECKED_IN, 'S3: session created');
  assert(v.participation_id === env.fixture.ids.pSlotPos, 'S3: participation_id');
});

section('A. Session write field verification (4-9)');
await scenario('S4 validated session row fields (participation_id/signup/activity/user/team/slot)', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const v = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, null);
  const row = env.raw
    .prepare('SELECT signup_id, activity_id, user_id, team_id, participation_id, slot, status, checkin_at, checkout_at, service_date FROM attendance_sessions WHERE id=?')
    .get(v.session_id);
  assert(row.participation_id === env.fixture.ids.pSlotPos, '4: participation_id 由 resolved Participation 派生');
  assert(row.signup_id === 4, '4: signup_id = Participation.signup_id（signup4 / volC）');
  assert(row.activity_id === 1, '5: activity_id = derived signup.activity_id');
  assert(row.user_id === env.fixture.ids.volC, '6: user_id = authenticated actor');
  assert(row.team_id === env.fixture.ids.teamA, '7: team_id = tenant context team');
  assert(row.slot === '', '8: slot 严格写空字符串');
  assert(row.status === ATTENDANCE_STATUS.CHECKED_IN && row.checkout_at === null, '9: status=1, checkout_at NULL');
  assert(typeof row.checkin_at === 'number' && row.checkin_at > 0, '9: checkin_at epoch set');
  // user-level 全局唯一（uq_active_attendance 语义）：volC 仅 1 条 active。
  const active = env.raw.prepare('SELECT COUNT(*) n FROM attendance_sessions WHERE user_id=? AND status=1 AND checkout_at IS NULL').get(env.fixture.ids.volC);
  assert(Number(active?.n ?? 0) === 1, '9: exactly one active session');
});

// =========================================================================
// B. Participation 活性 / 归属 负面（10-12）
// =========================================================================
section('B. Participation active-state / ownership negatives (10-12)');
await scenario('S10 cancelled participation → 409 attendance_participation_not_active', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pCancelled, null), ConflictReason.ATTENDANCE_PARTICIPATION_NOT_ACTIVE, 'S10');
});

await scenario('S11 signup not REGISTERED → 409 attendance_not_signed_up', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA2, env.fixture.pSignupCancelled, null), ConflictReason.ATTENDANCE_NOT_SIGNED_UP, 'S11');
});

await scenario('S12 route activity mismatch → 404', async (env) => {
  // route=actA1，participation 挂在 actA2 的 signup5 上 → signup 归属不一致 → 404。
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectThrow(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pSignupCancelled, null), ErrorCode.NOT_FOUND, 'S12');
  assert(countRows(env, 'attendance_sessions') === 0, 'S12: zero writes on failure');
});

// =========================================================================
// C. 父级一致性负面（13-19）
// =========================================================================
section('C. Parent-consistency negatives (13-19)');
await scenario('S13 occurrence completed → 409 parent_mismatch', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pOccClosed, null), ConflictReason.PARENT_MISMATCH, 'S13');
});

await scenario('S14 slot deleted → 409 parent_mismatch', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotDeleted, null), ConflictReason.PARENT_MISMATCH, 'S14');
});

await scenario('S15 slot occurrence mismatch → 409 parent_mismatch', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotWrong, null), ConflictReason.PARENT_MISMATCH, 'S15');
});

await scenario('S16 occurrence_position deleted → 409 parent_mismatch', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pOpDeleted, null), ConflictReason.PARENT_MISMATCH, 'S16');
});

await scenario('S17 occurrence_position occurrence mismatch → 409 parent_mismatch', async (env) => {
  // 构造：participation 在 occ2，slot 在 occ2，但 op 指向 occ3 → op.occurrence_id != participation.occurrence_id。
  const run = (sql, params = []) => env.raw.prepare(sql).run(...params);
  run('INSERT INTO activity_participation_slots (id, public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, created_at) VALUES (?,?,?,?,?,?,0,0,?)', [6, generateUlid(), 2, 'slotOcc2', NOW(), NOW() + 3600, NOW()]);
  run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,0,0,?)', [5, generateUlid(), 3, 1, NOW()]);
  const pNew = generateUlid();
  run('INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, slot_id, occurrence_position_id, status, cancelled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,1,NULL,?,?)', [14, pNew, 4, 2, 6, 5, NOW(), NOW()]);
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, pNew, null), ConflictReason.PARENT_MISMATCH, 'S17');
  assert(countRows(env, 'attendance_sessions') === 0, 'S17: zero writes on failure');
});

await scenario('S18a underlying activity_position mismatch (cross-activity) → 409 parent_mismatch', async (env) => {
  // pOpForeign：op(occ1) + posCrossAct(actA2) → ap.activity_id != occurrence.activity_id。
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pOpForeign, null), ConflictReason.PARENT_MISMATCH, 'S18a');
});

await scenario('S18b underlying activity_position deleted → 409 parent_mismatch', async (env) => {
  // 构造：activity_position 软删，但 op 活跃 → opCompatible 因 ap.deleted_at IS NULL 失败。
  const run = (sql, params = []) => env.raw.prepare(sql).run(...params);
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at, deleted_at) VALUES (?,?,1,\'PosDeleted\',0,?,?)', [4, generateUlid(), NOW(), NOW()]);
  run('INSERT INTO activity_participation_slots (id, public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, created_at) VALUES (?,?,?,?,?,?,0,0,?)', [6, generateUlid(), 2, 'slotOcc2', NOW(), NOW() + 3600, NOW()]);
  run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,0,0,?)', [5, generateUlid(), 2, 4, NOW()]);
  const pNew = generateUlid();
  run('INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, slot_id, occurrence_position_id, status, cancelled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,1,NULL,?,?)', [14, pNew, 4, 2, 6, 5, NOW(), NOW()]);
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, pNew, null), ConflictReason.PARENT_MISMATCH, 'S18b');
  assert(countRows(env, 'attendance_sessions') === 0, 'S18b: zero writes on failure');
});

await scenario('S19 slot+op with no active PSP → 409 parent_mismatch', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pNoPsp, null), ConflictReason.PARENT_MISMATCH, 'S19');
});

// =========================================================================
// D. 活跃会话 / UNIQUE（20-21）
// =========================================================================
section('D. Active-session / UNIQUE (20-21)');
await scenario('S20 same participation already active → 409 attendance_already_checked_in', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const v1 = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, null);
  assert(v1.session_id > 0, 'S20: first check-in ok');
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, null), ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN, 'S20');
  assert(countRows(env, 'attendance_sessions') === 1, 'S20: still exactly 1 session');
});

await scenario('S21 same user, another participation active → 409 attendance_already_checked_in', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volB, env.fixture.ids.teamA);
  const v1 = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlot, null);
  assert(v1.session_id > 0, 'S21: first check-in ok');
  await expectConflict(() => svc.checkInOwn(env.fixture.actA1, env.fixture.pOtherUser, null), ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN, 'S21');
  const active = env.raw.prepare('SELECT COUNT(*) n FROM attendance_sessions WHERE user_id=? AND status=1 AND checkout_at IS NULL').get(env.fixture.ids.volB);
  assert(Number(active?.n ?? 0) === 1, 'S21: exactly one active session for user');
});

// =========================================================================
// E. Checkout 回归（22-25）
// =========================================================================
section('E. Checkout regression (22-25)');
await scenario('S22 checkout then re-checkin on same participation → success', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const v1 = await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  const co = await svc.checkOutOwn(env.fixture.actA1);
  assert(co.session_id === v1.session_id && co.status === ATTENDANCE_STATUS.CHECKED_OUT, 'S22: checked out');
  const v2 = await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  assert(v2.session_id !== v1.session_id, 'S22: new session id after checkout');
  const rows = env.raw.prepare('SELECT id, status, checkout_at FROM attendance_sessions ORDER BY id').all();
  assert(rows.length === 2, 'S22: two session rows total');
  assert(rows[0].status === ATTENDANCE_STATUS.CHECKED_OUT && rows[0].checkout_at != null, 'S22: first session checked out');
  assert(rows[1].status === ATTENDANCE_STATUS.CHECKED_IN && rows[1].checkout_at === null, 'S22: second session active');
});

await scenario('S23 legacy participation_id=NULL active attendance can checkout', async (env) => {
  const sid = seedLegacyAttendanceSession(env, {
    signup_id: 1,
    activity_id: 1,
    user_id: env.fixture.ids.volA,
    team_id: env.fixture.ids.teamA,
    status: ATTENDANCE_STATUS.CHECKED_IN,
    service_date: Math.floor(NOW() / 86400),
    slot: '',
    checkin_at: NOW(),
  });
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const v = await svc.checkOutOwn(env.fixture.actA1);
  assert(v.session_id === sid && v.status === ATTENDANCE_STATUS.CHECKED_OUT, 'S23: legacy session checked out');
  const row = env.raw.prepare('SELECT status, checkout_at, participation_id FROM attendance_sessions WHERE id=?').get(sid);
  assert(row.status === ATTENDANCE_STATUS.CHECKED_OUT && row.checkout_at != null, 'S23: row updated');
  assert(row.participation_id === null, 'S23: participation_id stays NULL (legacy)');
});

await scenario('S24 participation cancelled after session started → session still checkoutable', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  const v1 = await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  assert(v1.session_id > 0, 'S24: check-in ok');
  const now = NOW();
  env.raw.prepare('UPDATE activity_participations SET status=2, cancelled_at=?, updated_at=? WHERE id=?').run(now, now, env.fixture.ids.pOccOnly);
  const v = await svc.checkOutOwn(env.fixture.actA1);
  assert(v.session_id === v1.session_id && v.status === ATTENDANCE_STATUS.CHECKED_OUT, 'S24: session still checkoutable after participation cancelled');
});

await scenario('S25 checkout does not require participation_public_id', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  // service 契约：checkOutOwn 仅接受 activityPublicId，无 participation_public_id 参数。
  const v = await svc.checkOutOwn(env.fixture.actA1);
  assert(v.status === ATTENDANCE_STATUS.CHECKED_OUT, 'S25: plain checkout works without participation_public_id');
});

// =========================================================================
// F. Route 层：校验顺序 + HTTP 映射（26-29 + 合法 201/200）
// =========================================================================
section('F. Route layer — validation order & HTTP mapping (26-29)');
{
  const env = makeP16Db();
  try {
    const { Hono } = await import('hono');
    const { authContextMiddleware } = await import('../src/middleware/auth');
    const { tenantContextMiddleware } = await import('../src/middleware/tenant-scope');
    const { csrfGuardMiddleware } = await import('../src/middleware/csrf');
    const { errorHandler } = await import('../src/middleware/error-handler');
    const activities = (await import('../src/routes/activities')).default;

    // 隔离装配：真实中间件链 + 仅 Activities 路由（不拖入 anomaly 等无关模块；前缀与真实 app.ts 一致）。
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', authContextMiddleware);
    app.use('*', tenantContextMiddleware);
    app.use('/api/v2/*', csrfGuardMiddleware);
    const v2 = new Hono();
    v2.route('/activities', activities);
    app.route('/api/v2', v2);

    const baseEnv = { DB: env.db, ENVIRONMENT: 'local' };
    const checkinPath = `/api/v2/activities/${env.fixture.actA1}/attendance/checkin`;
    const checkoutPath = `/api/v2/activities/${env.fixture.actA1}/attendance/checkout`;

    const send = async (path, { body, rawBody, role, user, team } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (role != null) {
        headers['x-test-role'] = role;
        headers['x-test-user'] = String(user);
        headers['x-test-team'] = String(team);
      }
      const res = await app.request(
        path,
        { method: 'POST', headers, body: rawBody ?? JSON.stringify(body ?? {}) },
        baseEnv,
      );
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* ignore */
      }
      return { status: res.status, json };
    };

    // R1 (26)：未认证 + malformed body → 401 AUTH_REQUIRED（不抢跑 400）。
    const r1 = await send(checkinPath, { rawBody: '{oops not json' });
    assert(r1.status === 401 && r1.json?.error?.code === 'AUTH_REQUIRED', `R1: 未认证+malformed body → 401（实=${r1.status}/${r1.json?.error?.code}）`);

    // R2 (27)：有认证但无权限（team_auditor 无 attendance.record.checkin）+ malformed body → 403。
    const r2 = await send(checkinPath, { rawBody: '{oops not json', role: 'team_auditor', user: env.fixture.ids.volA, team: env.fixture.ids.teamA });
    assert(r2.status === 403 && r2.json?.error?.code === 'FORBIDDEN', `R2: 无权限+malformed body → 403（实=${r2.status}/${r2.json?.error?.code}）`);

    // R3 (28)：认证+权限 + 缺 participation_public_id → 400 INVALID_PARAM。
    const r3 = await send(checkinPath, { body: { location: null }, role: 'volunteer', user: env.fixture.ids.volA, team: env.fixture.ids.teamA });
    assert(r3.status === 400 && r3.json?.error?.code === 'INVALID_PARAM', `R3: 缺 participation_public_id → 400（实=${r3.status}/${r3.json?.error?.code}）`);

    // R4 (29)：malformed participation_public_id → 400 INVALID_PARAM。
    const r4 = await send(checkinPath, { body: { participation_public_id: 'not-a-ulid' }, role: 'volunteer', user: env.fixture.ids.volA, team: env.fixture.ids.teamA });
    assert(r4.status === 400 && r4.json?.error?.code === 'INVALID_PARAM', `R4: malformed participation_public_id → 400（实=${r4.status}/${r4.json?.error?.code}）`);

    // R5：合法 check-in → 201（domestic wiring）。
    const r5 = await send(checkinPath, { body: { participation_public_id: env.fixture.pOccOnly, location: { latitude: 30.1, longitude: 120.2 } }, role: 'volunteer', user: env.fixture.ids.volA, team: env.fixture.ids.teamA });
    assert(r5.status === 201 && r5.json?.success === true && r5.json?.data?.attendance?.participation_public_id === env.fixture.pOccOnly, `R5: 合法 check-in → 201（实=${r5.status}）`);

    // R6 (25 route)：checkout 空 body（route 不读 body / 不需要 participation_public_id）→ 200。
    const r6 = await send(checkoutPath, { body: {}, role: 'volunteer', user: env.fixture.ids.volA, team: env.fixture.ids.teamA });
    assert(r6.status === 200 && r6.json?.success === true && r6.json?.data?.attendance?.status === ATTENDANCE_STATUS.CHECKED_OUT, `R6: 空 body checkout → 200（实=${r6.status}）`);
  } catch (e) {
    failCount++;
    failures.push(`Route section: ${e.message}`);
    console.error('  ✗ ROUTE SECTION ERROR:', e.message);
  } finally {
    destroyP16Db(env);
  }
}

// =========================================================================
// G. 并发：DB UNIQUE fallback（30）
// =========================================================================
section('G. Concurrency — DB UNIQUE fallback (30)');
await scenario('K1 duplicate same-participation INSERT → 409, only 1 active session', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volA, env.fixture.ids.teamA);
  // 先走 service 合法签到，制造活跃会话。
  await svc.checkInOwn(env.fixture.actA1, env.fixture.pOccOnly, null);
  const repo = new AttendanceSessionRepository({ db: env.db, ctx: makeCtx(env.fixture.ids.volA, env.fixture.ids.teamA) });
  const now = NOW();
  let accepted = 0;
  let rejected425 = false;
  const attempt = async () => {
    try {
      await repo.insertCheckIn(1, 1, env.fixture.ids.volA, env.fixture.ids.teamA, Math.floor(now / 86400), '', '2026-09-05', now, env.fixture.ids.pOccOnly);
      accepted++;
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.CONFLICT && e.details?.reason === ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN) {
        rejected425 = true;
        return;
      }
      throw e;
    }
  };
  await attempt();
  await attempt();
  assert(rejected425 && accepted === 0, 'K1: 重复同 participation INSERT → 409 attendance_already_checked_in（uq_active_participation / uq_active_attendance fallback）');
  const active = env.raw.prepare('SELECT COUNT(*) n FROM attendance_sessions WHERE user_id=? AND status=1 AND checkout_at IS NULL').get(env.fixture.ids.volA);
  assert(Number(active?.n ?? 0) === 1, 'K1: 最终仅 1 条 active session');
});

await scenario('K2 sequential duplicate check-in via service (precheck path)', async (env) => {
  const svc = makeSvc(env, env.fixture.ids.volC, env.fixture.ids.teamA);
  const a = await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, null);
  assert(a.session_id > 0, 'K2: first ok');
  let c409 = 0;
  try {
    await svc.checkInOwn(env.fixture.actA1, env.fixture.pSlotPos, null);
  } catch (e) {
    if (e instanceof AppError && e.code === ErrorCode.CONFLICT && e.details?.reason === ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN) c409++;
    else throw e;
  }
  assert(c409 === 1, 'K2: second → 409 attendance_already_checked_in');
  assert(countRows(env, 'attendance_sessions') === 1, 'K2: 仅 1 行 attendance_sessions');
});

// =========================================================================
// 汇总
// =========================================================================
console.log(`\n================ P16 Attendance Participation Targeted 结果 ================`);
console.log(`PASS=${pass}  FAIL=${failCount}`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  -', f);
}
if (failCount > 0) {
  process.exit(1);
}
console.log('ALL P16 TARGETED TESTS PASSED');
process.exit(0);