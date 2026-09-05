/**
 * P20 动态表单引擎测试 fixture（TEST-ONLY）。
 * 应用真实 migrations 0001–0015（含 0003 permission seed：92 permissions / 266 role_permissions），
 * seed 双团队 base 数据，供 service/route/并发测试。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { D1Database, generateUlid } from './d1-shim.mjs';

const T0 = Math.floor(Date.now() / 1000);

export async function buildFormDb() {
  const path = join(tmpdir(), `wb_p20_${Date.now()}_${Math.floor(Math.random() * 1e6)}.sqlite`);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON;');

  const migDir = join(process.cwd(), 'migrations');
  const migs = readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of migs) raw.exec(readFileSync(join(migDir, f), 'utf8'));

  const fixture = {
    teamA: generateUlid(), teamB: generateUlid(),
    userVolA: generateUlid(), userVolB: generateUlid(),
    userOwnerA: generateUlid(), userAdminA: generateUlid(), userAuditorA: generateUlid(),
    actA1: generateUlid(), actB1: generateUlid(),
    ids: { teamA: 1, teamB: 2, volA: 1, volB: 2, ownerA: 3, adminA: 4, auditorA: 5, actA1: 1, actB1: 2 },
  };
  const run = (sql, p = []) => raw.prepare(sql).run(...p);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [1, fixture.userVolA, 'volA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [2, fixture.userVolB, 'volB']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [3, fixture.userOwnerA, 'ownerA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [4, fixture.userAdminA, 'adminA']);
  run('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', [5, fixture.userAuditorA, 'auditorA']);
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [1, fixture.teamA, 'A', 3]);
  run('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [2, fixture.teamB, 'B', 2]);
  const t0 = T0;
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)', [1, fixture.actA1, 1, 'actA1', 3, t0, t0 + 3600]);
  run('INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time) VALUES (?,?,?,?,1,?,?,?)', [2, fixture.actB1, 2, 'actB1', 2, t0, t0 + 3600]);

  const db = new D1Database(raw);
  return {
    db, raw, fixture,
    path,
    close() {
      try { raw.close(); } catch {}
      try { unlinkSync(path); } catch {}
    },
  };
}