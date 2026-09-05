/**
 * P11 Participation 离线测试数据库构建器（TEST-ONLY）。
 *
 * 流程：
 *  1) 应用全部迁移 0001–0014 到临时 sqlite（与真实 schema 完全一致，无任何增补）。
 *  2) seed 父表 fixture + 4 个 P11 权限码 + role_permissions 绑定。
 *
 * 注意（P11-TEAM-ASSIGN-IDENTITY-FIX）：真实 schema 的 activity_signups【没有】public_id 列。
 * 旧版本文件曾 ALTER 增补 public_id 以让 `resolveSignup(signup_public_id)` 通过——那会掩盖
 * 真实 D1 上的 `no such column: s.public_id` 缺陷。现已删除该增补；
 * TEAM assign 以 user_public_id + route activity 唯一解析 signup。
 *
 * 返回 { db(D1 shim), raw(node:sqlite), fixture(public_id 映射), path, close() }。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { D1Database, generateUlid } from './d1-shim.mjs';

const T0 = 1756500000; // 固定基准时间戳

export async function buildP11Db() {
  const path = join(tmpdir(), `wb_p11_${Date.now()}_${Math.floor(Math.random() * 1e6)}.sqlite`);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON;');

  // 1) 应用迁移 0001–0014（按文件名排序；与真实迁移基线一致，不增补任何列）
  const migDir = join(process.cwd(), 'migrations');
  const migs = readdirSync(migDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const f of migs) {
    raw.exec(readFileSync(join(migDir, f), 'utf8'));
  }

  const fixture = {};
  const uid = () => generateUlid();

  // 预生成所有 public_id
  fixture.userVolA = uid();
  fixture.userVolB = uid();
  fixture.userAdminA = uid();
  fixture.userOwnerA = uid();
  fixture.userPlat = uid();
  fixture.userVolC = uid();
  fixture.userVolD = uid();
  fixture.userVolE = uid();
  fixture.teamA = uid();
  fixture.teamB = uid();
  fixture.actA1 = uid();
  fixture.actA2 = uid();
  fixture.actB1 = uid();
  fixture.occ1 = uid(); // actA1, status=1
  fixture.occ2 = uid(); // actA1, status=2 (in_progress)
  fixture.occ3 = uid(); // actA2, status=1（同团队跨活动，父级不匹配测试）
  fixture.occB1 = uid(); // actB1, status=1
  fixture.slot1 = uid(); // occ1, capacity=0 (unlimited), morning
  fixture.slot2 = uid(); // occ1, capacity=2, afternoon
  fixture.slotB1 = uid(); // occB1, capacity=0
  fixture.posX = uid(); // actA1
  fixture.posY = uid(); // actA1
  fixture.op1 = uid(); // occ1 + posX
  fixture.op2 = uid(); // occ1 + posY
  fixture.psp1 = uid(); // slot1 + op1
  fixture.psp2 = uid(); // slot1 + op2
  fixture.psp3 = uid(); // slot2 + op1

  const run = (sql, params = []) => raw.prepare(sql).run(...params);

  // users
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [1, fixture.userVolA, 'volA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [2, fixture.userVolB, 'volB']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [3, fixture.userAdminA, 'adminA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [4, fixture.userOwnerA, 'ownerA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [5, fixture.userPlat, 'plat']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [6, fixture.userVolC, 'volC']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [7, fixture.userVolD, 'volD']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [8, fixture.userVolE, 'volE']);

  // teams
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [1, fixture.teamA, 'TeamA', 4]);
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [2, fixture.teamB, 'TeamB', 2]);

  // activities（status=1 报名开放，deleted_at=null）
  const insAct = (id, pub, team, title) =>
    run(
      'INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, quota, status, created_by, need_audit, allow_cancel, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)',
      [id, pub, team, title, T0 + 86400, T0 + 90000, 30, 1, 4, 0, 1],
    );
  insAct(1, fixture.actA1, 1, 'ActA1');
  insAct(2, fixture.actA2, 1, 'ActA2');
  insAct(3, fixture.actB1, 2, 'ActB1');

  // activity_signups（status=1 REGISTERED, review_status=1 APPROVED；真实 schema 无 public_id 列）
  const insSignup = (id, act, user, review = 1) =>
    run(
      'INSERT INTO activity_signups (id, activity_id, user_id, review_status, status, created_at) VALUES (?,?,?,?,?,?)',
      [id, act, user, review, 1, T0],
    );
  insSignup(1, 1, 1);
  insSignup(2, 3, 2);
  insSignup(3, 1, 3);
  insSignup(4, 1, 6); // volC -> actA1 已批准
  insSignup(5, 1, 7, 0); // volD -> actA1 未批准 (review_status=0)
  insSignup(6, 1, 8); // volE -> actA1 已批准（容量边界）

  // activity_occurrences
  const insOcc = (id, pub, act, status) =>
    run(
      'INSERT INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, pub, act, T0 + 1000, T0 + 2000, status, T0],
    );
  insOcc(1, fixture.occ1, 1, 1);
  insOcc(2, fixture.occ2, 1, 2);
  insOcc(3, fixture.occ3, 2, 1); // actA2（同团队跨活动）
  insOcc(4, fixture.occB1, 3, 1);

  // activity_participation_slots（slot1 不限容量 capacity=0；slot2 容量=2；slotB1 不限）
  const insSlot = (id, pub, occ, name, cap) =>
    run(
      'INSERT INTO activity_participation_slots (id, public_id, occurrence_id, name, start_time, end_time, capacity, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, pub, occ, name, T0 + 1100, T0 + 1300, cap, 0, T0],
    );
  insSlot(1, fixture.slot1, 1, 'morning', 0);
  insSlot(2, fixture.slot2, 1, 'afternoon', 2);
  insSlot(3, fixture.slotB1, 3, 'slotB', 0);

  // activity_positions
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at) VALUES (?,?,?,?,?,?)', [1, fixture.posX, 1, 'PosX', 0, T0]);
  run('INSERT INTO activity_positions (id, public_id, activity_id, name, sort_order, created_at) VALUES (?,?,?,?,?,?)', [2, fixture.posY, 1, 'PosY', 0, T0]);

  // occurrence_positions
  run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,?,?,?)', [1, fixture.op1, 1, 1, 0, 0, T0]);
  run('INSERT INTO occurrence_positions (id, public_id, occurrence_id, position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,?,?,?)', [2, fixture.op2, 1, 2, 0, 0, T0]);

  // participation_slot_positions（PSP）：slot1×op1, slot1×op2, slot2×op1
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,?,?,?)', [1, fixture.psp1, 1, 1, 0, 0, T0]);
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,?,?,?)', [2, fixture.psp2, 1, 2, 0, 0, T0]);
  run('INSERT INTO participation_slot_positions (id, public_id, slot_id, occurrence_position_id, required_count, sort_order, created_at) VALUES (?,?,?,?,?,?,?)', [3, fixture.psp3, 2, 1, 0, 0, T0]);

  // ===== P11 权限码 + role_permissions =====
  const P11 = [
    ['participation.assignment.create', '本人报名参与', 'participation', 1],
    ['participation.assignment.cancel', '取消本人参与', 'participation', 1],
    ['participation.assignment.update', '更新本人参与岗位', 'participation', 1],
    ['participation.assignment.manage', '团队协调员代分配/改派/取消', 'participation', 2],
  ];
  for (const [code, name, group, risk] of P11) {
    run('INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES (?,?,?,?)', [code, name, group, risk]);
  }
  const roleId = (code) => raw.prepare('SELECT id FROM roles WHERE code=?').get(code)?.id;
  const permId = (code) => raw.prepare('SELECT id FROM permissions WHERE code=?').get(code)?.id;
  const link = (roleCode, permCode) =>
    run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', [roleId(roleCode), permId(permCode)]);
  for (const p of ['create', 'cancel', 'update']) link('volunteer', `participation.assignment.${p}`);
  for (const p of ['create', 'cancel', 'update', 'manage']) link('team_admin', `participation.assignment.${p}`);
  for (const p of ['create', 'cancel', 'update', 'manage'])
    link('platform_super_admin', `participation.assignment.${p}`);

  const db = new D1Database(raw);
  fixture.ids = { teamA: 1, teamB: 2, volA: 1, volB: 2, adminA: 3, ownerA: 4, plat: 5, volC: 6, volD: 7, volE: 8, actA1: 1, actA2: 2, actB1: 3 };

  function close() {
    try {
      raw.close();
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }

  return { db, raw, fixture, path, close };
}
