// P16 测试 fixture 构建器（离线、零真实 D1 写入）。
// 与 p11db.mjs 同源，但：
//  1) 应用 migrations/0001..0014（使 attendance_sessions.participation_id 列存在）；
//  2) 额外 seed 供 Attendance check-in 测试用的 activity_participations 行；
//  3) 将 attendance.record.checkin 绑定到 volunteer（route 测试需要）。
//
// 仅用于 P16 离线服务层 / 路由层测试，不影响真实迁移或真实库。
//
// P16-FIXTURE-REPAIR（本轮）——按真实 migration schema 修正 seed：
//  - seed 顺序修正为 FK 依赖序：users → teams → activities → signups → occurrences →
//    slots → positions → occurrence_positions → participation_slot_positions → participations。
//  - teams.owner_user_id FK users：users 必须在 teams 之前插入。
//  - activity_signups 无 public_id 列（0001），signup seed 不再插入该列。
//  - participation_slot_positions 固定主键字面量，VALUES 占位符与参数一一对应。
//  - 消除 activity_participations partial UNIQUE 冲突（idx_ap_occ / idx_ap_slot）：
//    每个活跃 Participation 的 (signup_id, occurrence_id, slot_id) 互不相同。
//  - opForeign 改用【同 team 跨 activity 的岗位】建模（position_id=99 会违反 FK）。
//  - 新增 slotWrong（跨 occurrence slot）与 posCrossAct（跨 activity position）支撑边界场景。
//  - 新增 signup5（volA → actA2，status=2 cancelled）+ pSignupCancelled：测试 409 not_signed_up。
//  - 提供 seedLegacyAttendanceSession() 构造 participation_id=NULL 的历史考勤行。
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { readdirSync, readFileSync, mkdtempSync } from 'fs';
import { D1Database, generateUlid } from './d1-shim.mjs';

const MIG_DIR = join(process.cwd(), 'migrations');
const T0 = Math.floor(Date.now() / 1000);

function applyMigrations(raw) {
  const files = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  // 模拟 Wrangler D1 的迁移台账（真实 local/preview/prod D1 均存在该表；离线 fixture 保持一致）。
  raw.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  );
  raw.exec('PRAGMA foreign_keys = OFF;');
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');
    try {
      raw.exec(sql);
      raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
    } catch (e) {
      console.error('MIGRATION FAILED:', f, e.message);
      throw e;
    }
  }
  raw.exec('PRAGMA foreign_keys = ON;');
}

/**
 * 父级链 seed。插入顺序严格遵循 FK 依赖（users → teams → activities → …），
 * 列名与 0001/0006/0008/0009/0011/0012 真实 schema 一致，无多余列。
 */
function seedParents(raw, fixture) {
  const run = (sql, params = []) => raw.prepare(sql).run(...params);

  // users（0001）：PLATFORM_GLOBAL，无 team_id。
  const users = [
    [1, fixture.userVolA, 'volA'],
    [2, fixture.userVolB, 'volB'],
    [3, fixture.userAdminA, 'adminA'],
    [4, fixture.userOwnerA, 'ownerA'],
    [5, fixture.userPlat, 'plat'],
    [6, fixture.userVolC, 'volC'],
  ];
  for (const [id, pub, nick] of users) {
    run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [id, pub, nick]);
  }

  // teams（0001）：owner_user_id FK users —— 必须在 users 之后。
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [1, fixture.teamA, 'A', 1]);
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [2, fixture.teamB, 'B', 2]);

  // activities（0001）：team_id / created_by FK。
  const t0s = T0;
  const t1s = T0 + 3600;
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)', [1, fixture.actA1, 1, 'actA1', 1, t0s, t1s]);
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)', [2, fixture.actA2, 1, 'actA2', 1, t0s, t1s]);
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)', [3, fixture.actB1, 2, 'actB1', 1, t0s, t1s]);

  // activity_signups（0001）：无 public_id 列；UNIQUE(user_id, activity_id)。
  const insSignup = (id, act, user, review = 1, status = 1) =>
    run('INSERT INTO activity_signups (id, activity_id, user_id, review_status, status, created_at) VALUES (?,?,?,?,?,?)', [id, act, user, review, status, T0]);
  insSignup(1, 1, 1);       // volA -> actA1（happy，approved）
  insSignup(2, 1, 2);       // volB -> actA1（happy，approved）
  insSignup(3, 3, 3);       // adminA -> actB1（Team B）
  insSignup(4, 1, 6);       // volC -> actA1（happy，approved）
  insSignup(5, 2, 1, 1, 2); // volA -> actA2，status=2 CANCELLED（signup 不活性用例）

  // activity_occurrences（0006）。
  const insOcc = (id, pub, act, status) =>
    run('INSERT INTO activity_occurrences (id, public_id, activity_id, status, start_time, end_time, created_at) VALUES (?,?,?,?,?,?,?)', [id, pub, act, status, t0s, t1s, T0]);
  insOcc(1, fixture.occ1, 1, 1);     // scheduled
  insOcc(2, fixture.occ2, 1, 2);     // in_progress
  insOcc(3, fixture.occ3, 2, 1);     // actA2 scheduled
  insOcc(4, fixture.occB1, 3, 1);    // Team B
  insOcc(5, fixture.occClosed, 1, 3); // completed（occurrence 不可用性用例）

  // activity_participation_slots（0009）：CHECK(start_time < end_time)。name NOT NULL。
  const insSlot = (id, pub, occ, name, cap, deleted = null) =>
    run('INSERT INTO activity_participation_slots (id, public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, deleted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, pub, occ, name, t0s, t1s, cap, 0, deleted, T0]);
  insSlot(1, fixture.slot1, 1, 'morning', 0);
  insSlot(2, fixture.slot2, 1, 'afternoon', 2);
  insSlot(3, fixture.slotB1, 4, 'slotB', 0);
  insSlot(4, fixture.slotDel, 1, 'deleted', 0, T0);      // 已软删
  insSlot(5, fixture.slotWrong, 3, 'wrongOcc', 0);        // occ3（actA2），用于 slot 跨 occurrence 用例

  // activity_positions（0008）。
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at) VALUES (1, ?, 1, \'PosX\', 0, ?)', [fixture.posX, T0]);
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at) VALUES (2, ?, 1, \'PosY\', 0, ?)', [fixture.posY, T0]);
  // posCrossAct：actA2 的岗位，供「occurrence(actA1) × position(actA2) 不一致」用例（FK 合法）。
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at) VALUES (3, ?, 2, \'PosCrossAct\', 0, ?)', [fixture.posCrossAct, T0]);

  // occurrence_positions（0011）：partial UNIQUE (occurrence_id, position_id) WHERE deleted_at IS NULL。
  const insOp = (id, pub, occ, pos, deleted = null) =>
    run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, deleted_at, created_at) VALUES (?,?,?,?,?,?,?,?)', [id, pub, occ, pos, 0, 0, deleted, T0]);
  insOp(1, fixture.op1, 1, 1);        // occ1 + PosX（活跃）
  insOp(2, fixture.op2, 1, 2);        // occ1 + PosY（活跃）
  insOp(3, fixture.opForeign, 1, 3);  // occ1(actA1) + posCrossAct(actA2) → 跨 activity 不一致
  insOp(4, fixture.opDel, 1, 1, T0);  // occ1 + PosX（已软删）—— 与 op1 不同生命周期行

  // participation_slot_positions（0012）：partial UNIQUE (slot_id, occurrence_position_id) WHERE deleted_at IS NULL。
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (1, ?, 1, 1, 0, 0, ?)', [fixture.psp1, T0]);
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (2, ?, 1, 2, 0, 0, ?)', [fixture.psp2, T0]);
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (3, ?, 2, 1, 0, 0, ?)', [fixture.psp3, T0]);
}

/**
 * Participation seed。所有活跃行的 (signup_id, occurrence_id, slot_id) 三元组互不相同，
 * 满足 0013 的 idx_ap_occ（occurrence-level）与 idx_ap_slot（slot-level）partial UNIQUE。
 * CHECK：status=1 时 cancelled_at 必须 NULL；status=2 时 cancelled_at 必须非 NULL。
 */
function seedParticipations(raw, fixture) {
  const run = (sql, params = []) => raw.prepare(sql).run(...params);
  const mk = (id, pub, signup, occ, slot, op, status = 1, cancelledAt = null) =>
    run(
      `INSERT INTO activity_participations
        (id, public_id, signup_id, occurrence_id, slot_id, occurrence_position_id, status, cancelled_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, pub, signup, occ, slot, op, status, cancelledAt, T0, T0],
    );

  // —— Team A happy path ——
  mk(1, fixture.pOccOnly, 1, 1, null, null);        // volA occurrence-only
  mk(2, fixture.pSlot, 2, 1, 1, null);              // volB slot-only（slot1）
  mk(3, fixture.pSlotPos, 4, 1, 2, 1);              // volC slot+position（slot2+op1，PSP psp3）
  // —— 负面用例 ——
  mk(4, fixture.pCancelled, 1, 1, null, null, 2, T0); // 已取消 -> 409 NOT_ACTIVE
  mk(5, fixture.pOtherUser, 2, 1, null, null);      // 他人报名（volB）-> 404
  mk(6, fixture.pCrossTeam, 3, 4, null, null);      // Team B -> 404（跨团队）
  mk(7, fixture.pOccClosed, 1, 5, null, null);      // occurrence 已关闭 -> 409 parent_mismatch
  mk(8, fixture.pSlotWrong, 1, 1, 5, null);         // slot(occ3) 跨 occurrence 不一致 -> 409 parent_mismatch
  mk(9, fixture.pSlotDeleted, 2, 1, 4, null);       // slot 已软删 -> 409 parent_mismatch
  mk(10, fixture.pOpForeign, 4, 1, 1, 3);           // op 指向跨 activity 岗位 -> 409 parent_mismatch
  mk(11, fixture.pOpDeleted, 1, 1, 2, 4);           // op 已软删 -> 409 parent_mismatch
  mk(12, fixture.pNoPsp, 2, 1, 2, 2);               // slot+op 但无活跃 PSP -> 409 parent_mismatch
  mk(13, fixture.pSignupCancelled, 5, 3, null, null); // signup 已取消 -> 409 not_signed_up
}

/** 将 attendance.record.checkin 绑定到 volunteer（route 层测试需要；0002/0003 后执行）。 */
function bindAttendancePermission(raw) {
  const permId = raw.prepare("SELECT id FROM permissions WHERE code='attendance.record.checkin'").get();
  const volId = raw.prepare("SELECT id FROM roles WHERE code='volunteer'").get();
  if (permId && volId) {
    raw.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)').run(volId.id, permId.id);
  }
}

export function makeP16Db() {
  const dir = mkdtempSync(join(tmpdir(), 'wb_p16_'));
  const path = join(dir, 'p16.sqlite');
  const raw = new DatabaseSync(path);
  applyMigrations(raw);

  const fixture = {
    teamA: generateUlid(),
    teamB: generateUlid(),
    userVolA: generateUlid(),
    userVolB: generateUlid(),
    userAdminA: generateUlid(),
    userOwnerA: generateUlid(),
    userPlat: generateUlid(),
    userVolC: generateUlid(),
    actA1: generateUlid(),
    actA2: generateUlid(),
    actB1: generateUlid(),
    occ1: generateUlid(),
    occ2: generateUlid(),
    occ3: generateUlid(),
    occB1: generateUlid(),
    occClosed: generateUlid(),
    slot1: generateUlid(),
    slot2: generateUlid(),
    slotB1: generateUlid(),
    slotDel: generateUlid(),
    slotWrong: generateUlid(),
    posX: generateUlid(),
    posY: generateUlid(),
    posCrossAct: generateUlid(),
    op1: generateUlid(),
    op2: generateUlid(),
    opForeign: generateUlid(),
    opDel: generateUlid(),
    psp1: generateUlid(),
    psp2: generateUlid(),
    psp3: generateUlid(),
    pOccOnly: generateUlid(),
    pSlot: generateUlid(),
    pSlotPos: generateUlid(),
    pCancelled: generateUlid(),
    pOtherUser: generateUlid(),
    pCrossTeam: generateUlid(),
    pOccClosed: generateUlid(),
    pSlotWrong: generateUlid(),
    pSlotDeleted: generateUlid(),
    pOpForeign: generateUlid(),
    pOpDeleted: generateUlid(),
    pNoPsp: generateUlid(),
    pSignupCancelled: generateUlid(),
    ids: {
      teamA: 1,
      teamB: 2,
      volA: 1,
      volB: 2,
      adminA: 3,
      ownerA: 4,
      plat: 5,
      volC: 6,
      actA1: 1,
      actA2: 2,
      actB1: 3,
      occ1: 1,
      occ2: 2,
      occ3: 3,
      occB1: 4,
      occClosed: 5,
      slot1: 1,
      slot2: 2,
      slotB1: 3,
      slotDel: 4,
      slotWrong: 5,
      posX: 1,
      posY: 2,
      posCrossAct: 3,
      op1: 1,
      op2: 2,
      opForeign: 3,
      opDel: 4,
      psp1: 1,
      psp2: 2,
      psp3: 3,
      pOccOnly: 1,
      pSlot: 2,
      pSlotPos: 3,
      pCancelled: 4,
      pOtherUser: 5,
      pCrossTeam: 6,
      pOccClosed: 7,
      pSlotWrong: 8,
      pSlotDeleted: 9,
      pOpForeign: 10,
      pOpDeleted: 11,
      pNoPsp: 12,
      pSignupCancelled: 13,
    },
  };

  seedParents(raw, fixture);
  seedParticipations(raw, fixture);
  bindAttendancePermission(raw);

  const db = new D1Database(raw);
  return { db, fixture, raw };
}

/**
 * 构造 participation_id = NULL 的历史考勤行（0014 前 legacy；只读/签退/异常用例）。
 * 默认生成一条活跃（status=1, checkout_at NULL）会话；调用方可用 status/checkout_at 覆盖。
 * @returns 新行 id
 */
export function seedLegacyAttendanceSession(handle, opts) {
  const {
    signup_id,
    activity_id,
    user_id,
    team_id,
    status = 1,
    service_date = 0,
    slot = '',
    checkin_at = T0,
    checkout_at = null,
  } = opts;
  const now = Math.floor(Date.now() / 1000);
  const res = handle.raw
    .prepare(
      `INSERT INTO attendance_sessions
         (signup_id, activity_id, user_id, team_id, status, service_date, slot,
          checkin_at, checkout_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(signup_id, activity_id, user_id, team_id, status, service_date, slot, checkin_at, checkout_at, now, now);
  return Number(res.lastInsertRowid);
}

/** 只读行数查询（自检用）。 */
export function countRows(handle, table) {
  const row = handle.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? 0);
}

export function destroyP16Db(handle) {
  try {
    handle.raw?.close?.();
  } catch {
    /* ignore */
  }
}