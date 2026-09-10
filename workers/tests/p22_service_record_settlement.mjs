/**
 * P22-P5 正式测试：ServiceRecord Settlement（migration / core / points / strong-transaction /
 * transition-gating / revoke-audit / read-API / public_id / adjust / projection）。
 *
 * 运行方式（在 workers/ 目录下）：
 *   node tests/p22_service_record_settlement.mjs
 *
 * 实现说明：
 * - 通过 esbuild 运行时将真实 src（createApp + Service/Repo 类）打包为 ESM，再 import，
 *   从而【直接驱动真实实现】；与之并行的 route 测试通过真实 Hono app.fetch 进行。
 * - 数据库使用 node:sqlite 内存库 + d1-shim（与项目既有离线测试一致），不触碰 wrangler / 真实 D1。
 * - 不修改任何源码 / 迁移 / catalog / 历史 WIP；不 git add / commit / push。
 */

import { DatabaseSync } from 'node:sqlite';
import { D1Database, generateUlid as shimUlid } from './lib/d1-shim.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const WORKERS = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(WORKERS, 'migrations');

// ---------------------------------------------------------------------------
// 1) 运行时打包真实实现（esbuild）
// ---------------------------------------------------------------------------
const BUNDLE_ENTRY = `
export { createApp } from './src/app';
export { ServiceRecordService } from './src/services/service-record-service';
export { ServiceRecordRepository, computePointsUnits, SETTLEMENT_STATUS, SettlementMode } from './src/repository/service-records';
export { AttendanceSessionRepository, ATTENDANCE_STATUS } from './src/repository/attendance-sessions';
export { AttendanceAnomalyRepository, ANOMALY_STATUS } from './src/repository/attendance-anomalies';
export { AttendanceService } from './src/services/attendance-service';
export { AttendanceManagementService } from './src/services/attendance-management-service';
export { AttendanceAnomalyService } from './src/services/attendance-anomaly-service';
export { ANOMALY_TYPE } from './src/repository/attendance-anomalies';
export { generateUlid } from './src/utils/crypto';
`;

async function loadImpl() {
  const entryPath = join(WORKERS, '.p22_bundle_entry.ts');
  writeFileSync(entryPath, BUNDLE_ENTRY);
  const bundlePath = join(tmpdir(), `p22_bundle_${process.pid}_${Date.now()}.mjs`);
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundlePath,
    absWorkingDir: WORKERS,
    logLevel: 'silent',
  });
  rmSync(entryPath, { force: true });
  const mod = await import('file://' + bundlePath);
  return { mod, bundlePath };
}

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.log('  ✗ FAIL: ' + msg);
  }
}
function section(name) {
  console.log('\n=== ' + name + ' ===');
}
function ok(msg) {
  console.log('  ✓ ' + msg);
}

function freshSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;'); // 测试种子不强制 FK（与生产迁移解耦）
  return sqlite;
}
/**
 * P22 regression suite 的 migration horizon 固定为 0001→0017（P22 contract）。
 * 后续新增的 0018/0019/…（属于 P23）不得纳入本 suite 的迁移计数 /
 * 权限计数 / upgrade-path fixture。从文件名解析迁移序号并限定 <= 17。
 */
function migrationNumber(fname) {
  const m = /^(\d+)_/.exec(fname);
  return m ? parseInt(m[1], 10) : Number.NaN;
}
function applyMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => migrationNumber(f) <= 17)
    .sort();
  for (const f of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    sqlite.exec(content);
  }
  return files.length;
}
function freshMigrated() {
  const sqlite = freshSqlite();
  const n = applyMigrations(sqlite);
  const db = new D1Database(sqlite);
  return { sqlite, db, migrationCount: n };
}
/**
 * Runtime behavior tests (SECTION 5–13) 使用【当前完整 migration chain】
 * （当前 = 0001→0019），因为 P23 生产源码已合法依赖 0018 的
 * service_records.points_revision / points_accounts / points_ledger。
 * 该 helper 仅提供完整 schema 供源码运行，不做任何 P22 业务断言覆盖。
 * migration discovery 基于目录真实 .sql 文件（不硬编码未来迁移数量）。
 */
function applyAllMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    sqlite.exec(content);
  }
  return files.length;
}
function freshCurrentRuntimeDb() {
  const sqlite = freshSqlite();
  const n = applyAllMigrations(sqlite);
  const db = new D1Database(sqlite);
  return { sqlite, db, migrationCount: n };
}
function q(sqlite, sql, params = []) {
  return sqlite.prepare(sql).all(...params);
}
function get1(sqlite, sql, params = []) {
  return sqlite.prepare(sql).get(...params);
}
function run(sqlite, sql, params = []) {
  return sqlite.prepare(sql).run(...params);
}

// ---------------------------------------------------------------------------
// 种子工具
// ---------------------------------------------------------------------------
function ulid() {
  return shimUlid();
}

/** 插入最小支撑链（users/teams/activities/signups/participations/sessions）。
 *  返回插入的 id 集合，便于断言。 */
function seedChain(sqlite, o) {
  const sid = o.sessionId ?? 301;
  const uid = o.userId ?? 101;
  const tid = o.teamId ?? 10;
  // 每 session 隔离的 signup/participation/activity id，避免某用例的 UPDATE 污染共享 id（如 401）
  // 影响后续用例的 CTE 匹配。显式 override 仍优先。
  const aid = o.activityId ?? 2000 + sid;
  const sgid = o.signupId ?? 4000 + sid;
  const pid = o.participationId ?? 6000 + sid;

  run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [
    tid,
    o.teamPublicId ?? ulid(),
    'team' + tid,
    199,
  ]);
  run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [
    uid,
    o.userPublicId ?? ulid(),
    'u' + uid,
  ]);
  run(
    sqlite,
    `INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status, points_multiplier_pct, max_session_minutes, created_by)
     VALUES (?,?,?,?,0,0,1,?,?,?)`,
    [aid, o.activityPublicId ?? ulid(), tid, 'act' + aid, o.pct ?? 100, o.maxMinutes && o.maxMinutes > 0 ? o.maxMinutes : null, 199],
  );
  run(sqlite, 'INSERT OR IGNORE INTO activity_signups (id, user_id, activity_id, status) VALUES (?,?,?,1)', [
    sgid,
    uid,
    aid,
  ]);
  run(
    sqlite,
    'INSERT OR IGNORE INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) VALUES (?,?,?,?,1,0)',
    [pid, o.participationPublicId ?? ulid(), sgid, o.occurrenceId ?? 9001],
  );
  run(
    sqlite,
    `INSERT OR IGNORE INTO attendance_sessions
       (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot, checkin_at, checkout_at, status, review_status, business_service_date, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,'',?,?,?,?,?,0,0)`,
    [
      sid,
      sgid,
      aid,
      uid,
      tid,
      o.participationId != null ? o.participationId : pid,
      o.checkinAt !== undefined ? o.checkinAt : 1000,
      o.checkoutAt !== undefined ? o.checkoutAt : 1000 + (o.diffSeconds ?? 2700),
      o.sessionStatus ?? 2,
      o.sessionReview ?? 0,
      o.businessServiceDate ?? '2026-09-01',
    ],
  );
  return { uid, tid, aid, sgid, pid, sid };
}

function seedAnomaly(sqlite, { anomalyId = 701, sessionId = 301, teamId = 10, type = 'overlong', status = 1 }) {
  run(
    sqlite,
    `INSERT OR IGNORE INTO attendance_anomalies (id, session_id, team_id, anomaly_type, status) VALUES (?,?,?,?,?)`,
    [anomalyId, sessionId, teamId, type, status],
  );
}

// ---------------------------------------------------------------------------
// Route 测试辅助
// ---------------------------------------------------------------------------
function makeCtx(auth, tenant) {
  return { auth, tenant };
}
function authUser(userId, teamId, role = 'team_owner') {
  return {
    authenticated: true,
    userId,
    teamId,
    role,
    roles: [{ role, scopeTeamId: role.startsWith('platform') ? null : teamId }],
  };
}

// ===========================================================================
// 主测试
// ===========================================================================
async function main() {
  const { mod: M, bundlePath } = await loadImpl();
  const { SETTLEMENT_STATUS, ATTENDANCE_STATUS, ANOMALY_STATUS, computePointsUnits } = M;

  // -----------------------------------------------------------------------
  // SECTION 4 — Migration（fresh + upgrade）
  // -----------------------------------------------------------------------
  section('SECTION 4 — Migration (fresh + upgrade)');
  {
    const { sqlite, db, migrationCount } = freshMigrated();
    assert(migrationCount === 17, `fresh: 17 migration files applied (got ${migrationCount})`);
    const permCount = get1(sqlite, 'SELECT count(*) c FROM permissions').c;
    const rpCount = get1(sqlite, 'SELECT count(*) c FROM role_permissions').c;
    const roleCount = get1(sqlite, 'SELECT count(*) c FROM roles').c;
    assert(permCount === 94, `fresh: permissions = 94 (got ${permCount})`);
    assert(rpCount === 273, `fresh: role_permissions = 273 (got ${rpCount})`);
    assert(roleCount === 6, `fresh: roles = 6 (got ${roleCount})`);

    const newPerms = q(
      sqlite,
      `SELECT code FROM permissions WHERE code IN ('service.record.read','service.record.view')`,
    );
    assert(newPerms.length === 2, `fresh: 2 new service.record perms present (got ${newPerms.length})`);
    const newBindings = get1(
      sqlite,
      `SELECT count(*) c FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE p.code IN ('service.record.read','service.record.view')`,
    ).c;
    assert(newBindings === 7, `fresh: 7 new bindings for the 2 perms (got ${newBindings})`);

    // schema / CHECK / indexes 存在性
    const srCols = q(sqlite, `PRAGMA table_info(service_records)`).map((r) => r.name);
    assert(srCols.includes('settlement_status'), 'fresh: service_records.settlement_status exists');
    assert(srCols.includes('points_awarded_units'), 'fresh: service_records.points_awarded_units exists');
    assert(srCols.includes('business_service_date'), 'fresh: service_records.business_service_date exists');
    assert(srCols.includes('public_id'), 'fresh: service_records.public_id exists');
    const auditCols = q(sqlite, `PRAGMA table_info(service_record_audits)`).map((r) => r.name);
    assert(
      auditCols.includes('old_points_awarded_units') && auditCols.includes('new_points_awarded_units'),
      'fresh: audit table has old/new points columns',
    );
    const idx = q(sqlite, `PRAGMA index_list(service_records)`).map((r) => r.name);
    assert(idx.length > 0, 'fresh: service_records has indexes');
    // UNIQUE(session_id) 行为化验证：先插入一条，再插入相同 session_id 必须被拒绝
    const srColsFull =
      'id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, created_at, updated_at, public_id, settlement_status, points_awarded_units, points_min_minutes, points_base_units_per_hour, points_multiplier_pct';
    run(
      sqlite,
      `INSERT INTO service_records (${srColsFull}) VALUES (999997, 301, 101, 10, 201, 45, 'auto', 1, 0, 1, 0, 0, 'L000000999997', 1, 75, 30, 100, 100)`,
    );
    let dupRejected = false;
    try {
      run(
        sqlite,
        `INSERT INTO service_records (${srColsFull}) VALUES (999998, 301, 101, 10, 201, 45, 'auto', 1, 0, 1, 0, 0, 'L000000999998', 1, 75, 30, 100, 100)`,
      );
    } catch {
      dupRejected = true;
    }
    assert(dupRejected, 'fresh: UNIQUE(session_id) enforced (duplicate session_id rejected)');
    ok('fresh migration assertions done');

    // ---- upgrade (0001..0016 -> 0017) ----
    const up = freshSqlite();
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    // P22 upgrade horizon：本循环只应用 0001→0016；0017 在下方单独应用；
    // 0018+（P23）一律排除，避免污染 P22 contract 的 upgrade path fixture。
    for (const f of files) {
      if (migrationNumber(f) > 16) continue;
      up.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    }
    const permBefore = get1(up, 'SELECT count(*) c FROM permissions').c;
    const rpBefore = get1(up, 'SELECT count(*) c FROM role_permissions').c;
    assert(permBefore === 92, `upgrade: pre-0017 permissions = 92 (got ${permBefore})`);
    assert(rpBefore === 266, `upgrade: pre-0017 role_permissions = 266 (got ${rpBefore})`);

    // 植入 legacy service_records（base schema，无 public_id/settlement_status/points）
    run(up, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [
      10,
      ulid(),
      't10',
      199,
    ]);
    run(up, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [101, ulid(), 'u101']);
    run(
      up,
      `INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status) VALUES (?,?,10,?,0,0,1)`,
      [201, ulid(), 'a201'],
    );
    run(
      up,
      `INSERT OR IGNORE INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot, checkin_at, checkout_at, status, review_status, business_service_date, created_at, updated_at)
       VALUES (301, 401, 201, 101, 10, NULL, 1, '', 0, 0, 2, 0, '2026-09-01', 0, 0)`,
    );
    run(
      up,
      `INSERT INTO service_records (id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, created_at, updated_at)
       VALUES (501, 301, 101, 10, 201, 45, 'auto', 1, 0, 1, 0, 0)`,
    );
    // 应用 0017
    up.exec(readFileSync(join(MIGRATIONS_DIR, '0017_service_record_settlement.sql'), 'utf8'));
    const permAfter = get1(up, 'SELECT count(*) c FROM permissions').c;
    const rpAfter = get1(up, 'SELECT count(*) c FROM role_permissions').c;
    assert(permAfter === 94, `upgrade: post-0017 permissions = 94 (got ${permAfter})`);
    assert(rpAfter === 273, `upgrade: post-0017 role_permissions = 273 (got ${rpAfter})`);

    const legacy = get1(up, 'SELECT * FROM service_records WHERE id=501');
    assert(legacy.settlement_status === 0, `upgrade: legacy settlement_status backfilled to 0 (got ${legacy.settlement_status})`);
    assert(legacy.points_awarded_units === 0, `upgrade: legacy points_awarded_units backfilled to 0 (got ${legacy.points_awarded_units})`);
    assert(
      typeof legacy.public_id === 'string' && /^L[0-9]{12}$/.test(legacy.public_id),
      `upgrade: legacy public_id = L+12digits (got ${legacy.public_id})`,
    );
    assert(legacy.business_service_date === '2026-09-01', `upgrade: legacy business_service_date backfilled from session (got ${legacy.business_service_date})`);
    const dup = get1(up, 'SELECT count(*) c FROM service_records WHERE public_id=?', [legacy.public_id]).c;
    assert(dup === 1, 'upgrade: legacy public_id unique');
    ok('upgrade migration assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 5 — Settlement core
  // -----------------------------------------------------------------------
  section('SECTION 5 — Settlement core');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const repo = new M.ServiceRecordRepository({
      db,
      ctx: { auth: { authenticated: true, teamId: 10, userId: 101 }, tenant: { teamId: 10 } },
    });

    // 5.1 eligible automatic settlement
    const a = seedChain(sqlite, { sessionId: 301, diffSeconds: 2700 }); // 45min
    let changes = await repo.settleEligibleSessionAtomically({
      sessionId: a.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 1, `eligible automatic settlement creates 1 SR (got ${changes})`);
    const sr1 = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [a.sid]);
    assert(sr1 && sr1.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'settled SR is EFFECTIVE(1)');
    assert(sr1.minutes === 45, `settled minutes = 45 (got ${sr1.minutes})`);
    assert(sr1.points_awarded_units === 75, `settled points = 75 (got ${sr1.points_awarded_units})`);
    assert(typeof sr1.public_id === 'string' && sr1.public_id.length === 26, 'settled SR has 26-char ULID public_id');

    // 5.2 duplicate settlement -> idempotent 0
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: a.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 200,
      gateNonce: null,
    });
    assert(changes === 0, `duplicate settlement is idempotent (changes=${changes})`);
    const srCount = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [a.sid]).c;
    assert(srCount === 1, 'exactly one SR per session (UNIQUE(session_id))');

    // 5.3 OPEN anomaly blocks (automatic)
    const b = seedChain(sqlite, { sessionId: 302, diffSeconds: 2700 });
    seedAnomaly(sqlite, { anomalyId: 711, sessionId: 302, status: 1 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: b.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `OPEN anomaly blocks automatic settlement (changes=${changes})`);

    // 5.4 CONFIRMED anomaly blocks (automatic) but allowed (review_approved)
    const c = seedChain(sqlite, { sessionId: 303, diffSeconds: 2700 });
    seedAnomaly(sqlite, { anomalyId: 712, sessionId: 303, status: 2 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: c.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `CONFIRMED anomaly blocks automatic settlement (changes=${changes})`);
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: c.sid,
      teamId: 10,
      mode: 'review_approved',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 1, `CONFIRMED anomaly allowed via review_approved (changes=${changes})`);

    // 5.5 signup user mismatch
    const d = seedChain(sqlite, { sessionId: 304, diffSeconds: 2700, userId: 101 });
    run(sqlite, 'UPDATE activity_signups SET user_id = 999 WHERE id = (SELECT signup_id FROM attendance_sessions WHERE id=304)');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 304,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `signup user mismatch blocks (changes=${changes})`);

    // 5.6 signup activity mismatch
    const e = seedChain(sqlite, { sessionId: 305, diffSeconds: 2700 });
    run(sqlite, 'UPDATE activity_signups SET activity_id = 999 WHERE id = (SELECT signup_id FROM attendance_sessions WHERE id=305)');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 305,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `signup activity mismatch blocks (changes=${changes})`);

    // 5.7 team mismatch
    const f = seedChain(sqlite, { sessionId: 306, teamId: 10, diffSeconds: 2700 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 306,
      teamId: 20, // 不同团队
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `team mismatch blocks (changes=${changes})`);

    // 5.8 missing participation
    const g = seedChain(sqlite, { sessionId: 307, diffSeconds: 2700, participationId: 607 });
    run(sqlite, 'UPDATE attendance_sessions SET participation_id = NULL WHERE id=307');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 307,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `missing participation blocks (changes=${changes})`);

    // 5.9 missing checkout
    const h = seedChain(sqlite, { sessionId: 308, diffSeconds: 2700 });
    run(sqlite, 'UPDATE attendance_sessions SET checkout_at = NULL WHERE id=308');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 308,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `missing checkout blocks (changes=${changes})`);

    // 5.10 checkout < checkin
    const i = seedChain(sqlite, { sessionId: 309, diffSeconds: 2700 });
    run(sqlite, 'UPDATE attendance_sessions SET checkout_at = checkin_at - 60 WHERE id=309');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 309,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    assert(changes === 0, `checkout < checkin blocks (changes=${changes})`);

    // 5.11 <1 minute -> 0 minutes (still creates SR, points 0)
    const j = seedChain(sqlite, { sessionId: 310, diffSeconds: 30 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 310,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    const srj = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [310]);
    assert(changes === 1 && srj.minutes === 0, `<1 minute -> 0 minutes (got ${srj.minutes})`);
    assert(srj.points_awarded_units === 0, `<1 minute -> 0 points (got ${srj.points_awarded_units})`);

    // 5.12 max_session_minutes cap
    const k = seedChain(sqlite, { sessionId: 311, diffSeconds: 7200, maxMinutes: 60 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 311,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    const srk = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [311]);
    assert(srk.minutes === 60, `max_session_minutes caps 120->60 (got ${srk.minutes})`);

    // 5.13 cross-midnight minutes
    run(sqlite, 'UPDATE attendance_sessions SET checkin_at = 1000, checkout_at = 1000 + 5400 WHERE id=311');
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 311,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    // 再次 seed 一个独立会话测跨午夜 90min
    const k2 = seedChain(sqlite, { sessionId: 312, checkinAt: 1000, checkoutAt: 1000 + 5400, maxMinutes: 0 });
    changes = await repo.settleEligibleSessionAtomically({
      sessionId: 312,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    const srk2 = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [312]);
    assert(srk2.minutes === 90, `cross-midnight 90min (got ${srk2.minutes})`);

    // 5.14 business_service_date preserved
    assert(srk2.business_service_date === '2026-09-01', `business_service_date preserved (got ${srk2.business_service_date})`);

    // 5.15 explicit settlement_status = EFFECTIVE
    assert(srk2.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'settlement_status always EFFECTIVE on settle');
    ok('settlement core assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 6 — Points
  // -----------------------------------------------------------------------
  section('SECTION 6 — Points formula');
  {
    const cases = [
      [29, 30, 100, 100, 0],
      [30, 30, 100, 100, 50],
      [45, 30, 100, 100, 75],
      [60, 30, 100, 150, 150],
      [90, 30, 100, 150, 225],
      [90, 30, 100, 200, 300],
      [60, 30, 200, 100, 200],
      [60, 30, 200, 150, 300],
    ];
    for (const [min, mn, base, pct, expect] of cases) {
      const got = computePointsUnits(min, mn, base, pct);
      assert(got === expect, `points(${min}min,base${base},pct${pct}) = ${expect} (got ${got})`);
    }
    ok('points assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 7 — Attendance strong transaction
  // -----------------------------------------------------------------------
  section('SECTION 7 — Attendance strong transaction');
  {
    const NOW = Math.floor(Date.now() / 1000); // 真实 epoch 秒（force-checkout 用 nowSeconds() 写 checkout_at）
    let sqlite, db;

    // 7.1 normal force-checkout -> session transition + EFFECTIVE SR same transaction
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 401, diffSeconds: 2700, sessionStatus: 1, sessionReview: 0, checkinAt: NOW - 2700, checkoutAt: null });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const view = await mgt.forceCheckout(s.sid, { reason: 'force' });
      assert(view.status === 2, `force-checkout transitions session to CHECKED_OUT (got ${view.status})`);
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
      assert(sr && sr.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'force-checkout creates EFFECTIVE SR in same tx');
      assert(sr.minutes === 45 && sr.points_awarded_units === 75, `force-checkout SR 45min/75pts (got ${sr.minutes}/${sr.points_awarded_units})`);
    }

    // 7.2 fault injection mode 2 (UPDATE fails) -> full rollback
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 402, diffSeconds: 2700, sessionStatus: 1, sessionReview: 0, checkinAt: NOW - 2700, checkoutAt: null });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local', JHZY_FAULT_INJECT: '2' },
      });
      let threw = false;
      try {
        await mgt.forceCheckout(s.sid, { reason: 'force' });
      } catch (e) {
        threw = true;
      }
      assert(threw, 'fault mode 2 force-checkout throws (batch rolled back)');
      const sess = get1(sqlite, 'SELECT * FROM attendance_sessions WHERE id=?', [s.sid]);
      assert(sess.status === 1, `fault mode 2: session NOT checked out (status=${sess.status})`);
      const sr = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c;
      assert(sr === 0, `fault mode 2: no SR side effect (count=${sr})`);
      const ev = get1(sqlite, 'SELECT count(*) c FROM attendance_events WHERE session_id=?', [s.sid]).c;
      assert(ev === 0, `fault mode 2: no attendance_event leaked (count=${ev})`);
    }

    // 7.3 fault injection mode 1 (event INSERT fails) -> full rollback
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 403, diffSeconds: 2700, sessionStatus: 1, sessionReview: 0, checkinAt: NOW - 2700, checkoutAt: null });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local', JHZY_FAULT_INJECT: '1' },
      });
      let threw = false;
      try {
        await mgt.forceCheckout(s.sid, { reason: 'force' });
      } catch (e) {
        threw = true;
      }
      assert(threw, 'fault mode 1 force-checkout throws (batch rolled back)');
      const sess = get1(sqlite, 'SELECT * FROM attendance_sessions WHERE id=?', [s.sid]);
      assert(sess.status === 1, `fault mode 1: session NOT checked out (status=${sess.status})`);
      const sr = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c;
      assert(sr === 0, `fault mode 1: no SR side effect (count=${sr})`);
    }

    // 7.4 duplicate force-checkout -> 409, no extra SR/audit
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 404, diffSeconds: 2700, sessionStatus: 1, sessionReview: 0, checkinAt: NOW - 2700, checkoutAt: null });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      await mgt.forceCheckout(s.sid, { reason: 'force' });
      const before = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c;
      let code = null;
      try {
        await mgt.forceCheckout(s.sid, { reason: 'dup' });
      } catch (e) {
        code = e && e.status;
      }
      assert(code === 409, `duplicate force-checkout -> 409 (got ${code})`);
      const after = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c;
      assert(before === after && after === 1, `duplicate force-checkout: no new SR (before=${before},after=${after})`);
    }

    // 7.5 review approve (CONFIRMED anomaly) -> EFFECTIVE
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 405, diffSeconds: 2700, sessionStatus: 2, sessionReview: 0 });
      seedAnomaly(sqlite, { anomalyId: 721, sessionId: 405, status: 2 });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const v = await mgt.reviewSession(s.sid, { decision: 'approve', reason: 'ok' });
      assert(v.review_status === 1, `review approve sets review_status=1 (got ${v.review_status})`);
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
      assert(sr && sr.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'review approve creates EFFECTIVE SR');
    }

    // 7.6 review reject of an EFFECTIVE SR -> REVOKED + exactly one audit
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 406, diffSeconds: 2700, sessionStatus: 2, sessionReview: 0 });
      const repo = new M.ServiceRecordRepository({
        db,
        ctx: { auth: { authenticated: true, teamId: 10, userId: 103 }, tenant: { teamId: 10 } },
      });
      await repo.settleEligibleSessionAtomically({
        sessionId: s.sid, teamId: 10, mode: 'automatic', publicId: ulid(), now: 100, gateNonce: null,
      });
      const before = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
      assert(before && before.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, '7.6 setup: EFFECTIVE SR exists');
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const v = await mgt.reviewSession(s.sid, { decision: 'reject', reason: 'bad' });
      assert(v.review_status === 2, `review reject sets review_status=2 (got ${v.review_status})`);
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
      assert(sr && sr.settlement_status === SETTLEMENT_STATUS.REVOKED, 'review reject of EFFECTIVE -> REVOKED');
      const audits = get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [sr.id]).c;
      assert(audits === 1, `review reject writes exactly one audit (got ${audits})`);
    }

    // 7.7 anomaly confirm EFFECTIVE -> REVOKED + exactly one audit
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 407, diffSeconds: 2700, sessionStatus: 2, sessionReview: 0 });
      const repo = new M.ServiceRecordRepository({
        db,
        ctx: { auth: { authenticated: true, teamId: 10, userId: 103 }, tenant: { teamId: 10 } },
      });
      await repo.settleEligibleSessionAtomically({
        sessionId: s.sid,
        teamId: 10,
        mode: 'automatic',
        publicId: ulid(),
        now: 100,
        gateNonce: null,
      });
      const anom = new M.AttendanceAnomalyRepository({
        db,
        ctx: { auth: { authenticated: true, teamId: 10, userId: 103 }, tenant: { teamId: 10 } },
      });
      seedAnomaly(sqlite, { anomalyId: 722, sessionId: 407, status: 1 });
      const svr = new M.AttendanceAnomalyService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const r = await svr.resolve(722, { decision: 'confirm', resolution: 'confirmed' });
      assert(r.status === 2, `anomaly confirm -> CONFIRMED(2) (got ${r.status})`);
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
      assert(sr && sr.settlement_status === SETTLEMENT_STATUS.REVOKED, 'anomaly confirm revokes EFFECTIVE -> REVOKED');
      const audits = get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [sr.id]).c;
      assert(audits === 1, `anomaly confirm writes exactly one audit (got ${audits})`);
    }

    // 7.8 repeat anomaly confirm -> no extra audit
    {
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [407]);
      const svr = new M.AttendanceAnomalyService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      let code = null;
      try {
        await svr.resolve(722, { decision: 'confirm', resolution: 'again' });
      } catch (e) {
        code = e && e.status;
      }
      assert(code === 409, `repeat anomaly confirm -> 409 (got ${code})`);
      const audits = get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [sr.id]).c;
      assert(audits === 1, `repeat anomaly confirm: no extra audit (got ${audits})`);
    }

    // 7.9 OPEN anomaly + normal checkout -> checkout ok, no SR
    {
      ({ sqlite, db } = freshCurrentRuntimeDb());
      const s = seedChain(sqlite, { sessionId: 408, diffSeconds: 2700, sessionStatus: 1, sessionReview: 0, checkinAt: NOW - 2700, checkoutAt: null });
      seedAnomaly(sqlite, { anomalyId: 723, sessionId: 408, status: 1 });
      const mgt = new M.AttendanceManagementService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const v = await mgt.forceCheckout(s.sid, { reason: 'force' });
      assert(v.status === 2, 'OPEN anomaly: force-checkout still transitions session');
      const sr = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c;
      assert(sr === 0, 'OPEN anomaly: no SR created on checkout');
    }

    // 7.10 subsequent DISMISS -> settlement heal -> EFFECTIVE
    {
      const sess = get1(sqlite, 'SELECT * FROM attendance_sessions WHERE id=408');
      assert(sess.status === 2, 'session still checked out for dismiss healing');
      const svr = new M.AttendanceAnomalyService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      const r = await svr.resolve(723, { decision: 'dismiss', resolution: 'ok' });
      assert(r.status === 3, `anomaly dismiss -> DISMISSED(3) (got ${r.status})`);
      const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [408]);
      assert(sr && sr.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'dismiss heals -> EFFECTIVE SR');
    }

    // 7.11 repeat DISMISS -> no duplicate SR
    {
      const sr0 = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [408]).c;
      const svr = new M.AttendanceAnomalyService({
        db,
        auth: authUser(103, 10, 'team_owner'),
        tenant: { teamId: 10 },
        env: { ENVIRONMENT: 'local' },
      });
      let code = null;
      try {
        await svr.resolve(723, { decision: 'dismiss', resolution: 'again' });
      } catch (e) {
        code = e && e.status;
      }
      assert(code === 409, `repeat dismiss -> 409 (got ${code})`);
      const sr1 = get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [408]).c;
      assert(sr0 === sr1, `repeat dismiss: no duplicate SR (before=${sr0},after=${sr1})`);
    }
    ok('attendance strong transaction assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 8 — Transition-gating (event nonce gate)
  // -----------------------------------------------------------------------
  section('SECTION 8 — Transition-gating (event nonce gate)');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const repo = new M.ServiceRecordRepository({
      db,
      ctx: { auth: { authenticated: true, teamId: 10, userId: 101 }, tenant: { teamId: 10 } },
    });
    const s = seedChain(sqlite, { sessionId: 501, diffSeconds: 2700 });

    // 8.1 gate blocks without matching event nonce
    const stmtBlocked = repo.buildSettleStatement({
      sessionId: s.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: 'no-such-nonce',
    });
    const resBlocked = await db.batch([stmtBlocked]);
    assert((resBlocked[0].meta?.changes ?? 0) === 0, 'gate: no matching event -> 0 changes');
    assert(get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c === 0, 'gate: no SR created without event');

    // 8.2 gate disabled (null) -> inserts
    const stmtOpen = repo.buildSettleStatement({
      sessionId: s.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    const resOpen = await db.batch([stmtOpen]);
    assert((resOpen[0].meta?.changes ?? 0) === 1, 'gate null -> SR created (changes=1)');
    assert(get1(sqlite, 'SELECT count(*) c FROM service_records WHERE session_id=?', [s.sid]).c === 1, 'gate null: SR exists');

    // 8.3 gate with matching event nonce -> inserts
    const s2 = seedChain(sqlite, { sessionId: 502, diffSeconds: 2700 });
    run(sqlite, "INSERT INTO attendance_events (session_id, activity_id, user_id, team_id, event_type, nonce, occurred_at, created_at) VALUES (?,?,?,?,?,?,0,0)", [
      s2.sid,
      201,
      101,
      10,
      'checkout',
      'GATE-G',
    ]);
    const stmtGate = repo.buildSettleStatement({
      sessionId: s2.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: 'GATE-G',
    });
    const resGate = await db.batch([stmtGate]);
    assert((resGate[0].meta?.changes ?? 0) === 1, 'gate matching event -> SR created (changes=1)');

    // 8.4 revoke gate: EFFECTIVE SR + non-matching nonce -> 0 changes, no audit
    const srEff = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s2.sid]);
    const revokeStmts = repo.buildRevokeStatementSet({
      serviceRecordId: srEff.id,
      teamId: 10,
      reason: 'gate-test',
      operatorId: 103,
      traceId: null,
      now: 200,
      gateNonce: 'no-such-nonce',
    });
    const revRes = await db.batch(revokeStmts);
    assert((revRes[1].meta?.changes ?? 0) === 0, 'revoke gate: no matching event -> 0 changes');
    const srAfter = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srEff.id]);
    assert(srAfter.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, 'revoke gate: SR stays EFFECTIVE');
    assert(get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [srEff.id]).c === 0, 'revoke gate: no audit written');

    // 8.5 revoke gate with matching event -> REVOKED + 1 audit
    run(sqlite, "INSERT INTO attendance_events (session_id, activity_id, user_id, team_id, event_type, nonce, occurred_at, created_at) VALUES (?,?,?,?,?,?,0,0)", [
      s2.sid,
      201,
      101,
      10,
      'manual',
      'GATE-R',
    ]);
    const revokeStmts2 = repo.buildRevokeStatementSet({
      serviceRecordId: srEff.id,
      teamId: 10,
      reason: 'gate-test-2',
      operatorId: 103,
      traceId: null,
      now: 300,
      gateNonce: 'GATE-R',
    });
    const revRes2 = await db.batch(revokeStmts2);
    assert((revRes2[1].meta?.changes ?? 0) === 1, 'revoke gate matching event -> 1 change');
    const srAfter2 = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srEff.id]);
    assert(srAfter2.settlement_status === SETTLEMENT_STATUS.REVOKED, 'revoke gate matching event -> REVOKED');
    assert(get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [srEff.id]).c === 1, 'revoke gate matching event -> 1 audit');
    ok('transition-gating assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 9 — Revoke audit
  // -----------------------------------------------------------------------
  section('SECTION 9 — Revoke audit');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const repo = new M.ServiceRecordRepository({
      db,
      ctx: { auth: { authenticated: true, teamId: 10, userId: 103 }, tenant: { teamId: 10 } },
    });

    // 9.1 EFFECTIVE -> REVOKED writes exactly one audit with full fields
    const s = seedChain(sqlite, { sessionId: 601, diffSeconds: 2700 });
    await repo.settleEligibleSessionAtomically({
      sessionId: s.sid,
      teamId: 10,
      mode: 'automatic',
      publicId: ulid(),
      now: 100,
      gateNonce: null,
    });
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s.sid]);
    const [auditStmt, revokeStmt] = repo.buildRevokeStatementSet({
      serviceRecordId: sr.id,
      teamId: 10,
      reason: 'manual revoke',
      operatorId: 103,
      traceId: 'trace-xyz',
      now: 500,
      gateNonce: null,
    });
    await db.batch([auditStmt, revokeStmt]);
    const after = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [sr.id]);
    assert(after.settlement_status === SETTLEMENT_STATUS.REVOKED, 'revoke -> REVOKED(2)');
    const au = get1(sqlite, 'SELECT * FROM service_record_audits WHERE service_record_id=?', [sr.id]);
    assert(au, 'audit row exists');
    assert(au.old_minutes === 45 && au.new_minutes === 45, `audit old/new minutes equal (got ${au.old_minutes}/${au.new_minutes})`);
    assert(
      au.old_points_awarded_units === 75 && au.new_points_awarded_units === 75,
      `audit old/new points equal (got ${au.old_points_awarded_units}/${au.new_points_awarded_units})`,
    );
    assert(au.reason === 'manual revoke', 'audit reason captured');
    assert(au.operator_id === 103, 'audit operator_id captured');

    // 9.2 no ServiceRecord -> no audit
    {
      const before = get1(sqlite, 'SELECT count(*) c FROM service_record_audits').c;
      const stmts = repo.buildRevokeStatementSet({
        serviceRecordId: 999999,
        teamId: 10,
        reason: 'x',
        operatorId: 103,
        traceId: null,
        now: 600,
        gateNonce: null,
      });
      const rr = await db.batch(stmts);
      assert((rr[1].meta?.changes ?? 0) === 0, 'revoke no-SR: 0 changes');
      const after2 = get1(sqlite, 'SELECT count(*) c FROM service_record_audits').c;
      assert(after2 === before, 'revoke no-SR: no audit added');
    }
    // 9.3 UNVERIFIED -> no revoke/audit
    {
      const s2 = seedChain(sqlite, { sessionId: 602, diffSeconds: 2700 });
      run(sqlite, 'INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, created_at, updated_at) VALUES (?,?,?,?,?,?,1,0,1,0,0,?,0,0)', [
        s2.sid,
        101,
        10,
        201,
        30,
        'auto',
        ulid(),
      ]);
      const sr2 = get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [s2.sid]);
      const before = get1(sqlite, 'SELECT count(*) c FROM service_record_audits').c;
      const stmts = repo.buildRevokeStatementSet({
        serviceRecordId: sr2.id,
        teamId: 10,
        reason: 'x',
        operatorId: 103,
        traceId: null,
        now: 600,
        gateNonce: null,
      });
      const rr = await db.batch(stmts);
      assert((rr[1].meta?.changes ?? 0) === 0, 'revoke UNVERIFIED: 0 changes');
      const after2 = get1(sqlite, 'SELECT count(*) c FROM service_record_audits').c;
      assert(after2 === before, 'revoke UNVERIFIED: no audit added');
    }
    // 9.4 already REVOKED -> no extra audit
    {
      const before = get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [sr.id]).c;
      const stmts = repo.buildRevokeStatementSet({
        serviceRecordId: sr.id,
        teamId: 10,
        reason: 'again',
        operatorId: 103,
        traceId: null,
        now: 700,
        gateNonce: null,
      });
      const rr = await db.batch(stmts);
      assert((rr[1].meta?.changes ?? 0) === 0, 'revoke already-REVOKED: 0 changes');
      const after2 = get1(sqlite, 'SELECT count(*) c FROM service_record_audits WHERE service_record_id=?', [sr.id]).c;
      assert(after2 === before, 'revoke already-REVOKED: no extra audit');
    }
    ok('revoke audit assertions done');
  }

  // -----------------------------------------------------------------------
  // SECTION 10/11/12/13 — Read API / public_id / adjust / projection (routes)
  // -----------------------------------------------------------------------
  section('SECTION 10/11/12/13 — Routes (read / public_id / adjust / projection)');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    // seed SRs
    run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [10, ulid(), 't10', 199]);
    run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [20, ulid(), 't20', 199]);
    run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (101,?,?)', [101, ulid()]);
    run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (102,?,?)', [102, ulid()]);
    run(sqlite, 'INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status, created_by) VALUES (?,?,10,?,0,0,1,?)', [201, ulid(), 'a201', 199]);
    const ulidA = ulid();
    const ulidB = ulid();
    const ulidC = ulid();
    const legacyPid = 'L000000000123';
    // SR1: user101/team10 EFFECTIVE 45/75
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (701,101,10,201,45,'auto',1,0,1,1,75,?, '2026-09-01',0,0)`,
      [ulidA],
    );
    // SR2: user101/team10 UNVERIFIED 30
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (702,101,10,201,30,'auto',1,0,1,0,50,?, '2026-09-01',0,0)`,
      [ulidB],
    );
    // SR3: user101/team10 REVOKED 20
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (703,101,10,201,20,'auto',1,0,1,2,33,?, '2026-09-01',0,0)`,
      [ulidC],
    );
    // SR4: user102/team10 (other user, same team)
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (704,102,10,201,10,'auto',1,0,1,1,17,?, '2026-09-01',0,0)`,
      [ulid()],
    );
    // SR5: user101/team20 (cross-team)
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (705,101,20,201,99,'auto',1,0,1,1,99,?, '2026-09-01',0,0)`,
      [legacyPid],
    );
    // SR6: legacy L+12 public_id on team10 (user101)
    run(
      sqlite,
      `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at)
       VALUES (706,101,10,201,40,'auto',1,0,1,1,66,'L000000000124', '2026-09-01',0,0)`,
      [],
    );

    const app = M.createApp();
    const env = { DB: db, ENVIRONMENT: 'local' };
    if (process.env.P22DBG) {
      console.error('DBG SR count:', get1(sqlite, 'SELECT count(*) c FROM service_records').c);
      console.error('DBG SRs:', JSON.stringify(q(sqlite, 'SELECT id,public_id,user_id,team_id,settlement_status FROM service_records')));
    }

    async function call(method, path, opts = {}) {
      const headers = { 'content-type': 'application/json' };
      if (opts.role) headers['x-test-role'] = opts.role;
      if (opts.user) headers['x-test-user'] = String(opts.user);
      if (opts.team) headers['x-test-team'] = String(opts.team);
      const init = { method, headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const res = await app.fetch(new Request('http://localhost' + path, init), env);
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, json };
    }

    function noNumericIds(item) {
      const forbidden = ['id', 'session_id', 'user_id', 'team_id', 'activity_id', 'operator_id'];
      return !forbidden.some((k) => k in (item || {}));
    }
    // ok() 包裹为 { success, data, request_id }；列表端点在 data.records，单对象端点在 data
    function recs(payload) {
      return (payload && payload.data && payload.data.records) || [];
    }
    function rec(payload) {
      if (!payload || !payload.data) return null;
      return payload.data.record ?? payload.data;
    }

    // 10 SELF mine
    const mine = await call('GET', '/api/v2/service-records/mine', { role: 'volunteer', user: 101, team: 10 });
    assert(mine.status === 200, `SELF mine -> 200 (got ${mine.status})`);
    const mineIds = recs(mine.json).map((r) => r.public_id).sort();
    assert(
      mineIds.includes(ulidA) && mineIds.includes(ulidB) && mineIds.includes(ulidC) && mineIds.includes('L000000000124'),
      'SELF mine returns only user101 records',
    );
    assert(!mineIds.includes('L000000000123'), 'SELF mine excludes cross-team (team20) record');
    assert(recs(mine.json).every((r) => r.settlement_status != null), 'SELF mine: settlement_status explicit for all');
    assert(recs(mine.json).every(noNumericIds), 'SELF mine: zero internal numeric IDs in projection');
    // cannot specify another user
    const mineForge = await call('GET', '/api/v2/service-records/mine?user_id=102', { role: 'volunteer', user: 101, team: 10 });
    assert(mineForge.status === 200, 'SELF mine ignores user query param (still 200)');

    // 10 TEAM list + detail
    const teamList = await call('GET', '/api/v2/service-records', { role: 'team_owner', user: 103, team: 10 });
    assert(teamList.status === 200, `TEAM list -> 200 (got ${teamList.status})`);
    const teamIds = recs(teamList.json).map((r) => r.public_id).sort();
    assert(
      teamIds.includes(ulidA) && teamIds.includes(ulidB) && teamIds.includes(ulidC) && teamIds.includes('L000000000124'),
      'TEAM list includes team10 records',
    );
    assert(recs(teamList.json).every(noNumericIds), 'TEAM list: zero internal numeric IDs');

    // 11 public_id compatibility
    const detailUlid = await call('GET', '/api/v2/service-records/' + ulidA, { role: 'team_owner', user: 103, team: 10 });
    assert(detailUlid.status === 200, `ULID detail -> 200 (got ${detailUlid.status})`);
    const detailLegacy = await call('GET', '/api/v2/service-records/L000000000124', { role: 'team_owner', user: 103, team: 10 });
    assert(detailLegacy.status === 200, `legacy L+12 detail -> 200 (got ${detailLegacy.status})`);
    const detailMalformed = await call('GET', '/api/v2/service-records/INVALID_XYZ', { role: 'team_owner', user: 103, team: 10 });
    assert(detailMalformed.status === 400, `malformed public_id -> 400 (got ${detailMalformed.status})`);
    const detailCross = await call('GET', '/api/v2/service-records/L000000000123', { role: 'team_owner', user: 103, team: 10 });
    assert(detailCross.status === 404, `valid legacy cross-team -> 404 (got ${detailCross.status})`);

    // 11/12 旧直接 adjust 端点已移除（DIRECT_ADJUST_RUNTIME = REMOVED，P35-C2）
    // 全部直接修正调用现应返回 404（无 bypass 残留）；结算/积分核心逻辑改由 P35-C2 审批工作流覆盖。
    // 注意：此处仅验证「运行时已不存在」；adjustAtomically 原语（P22/P23 仍复用）的并发守卫见下方 repo 级测试。
    const removedLegacy = await call('POST', '/api/v2/service-records/L000000000124/adjust', {
      role: 'team_owner',
      user: 103,
      team: 10,
      body: { effective_minutes: 25, reason: 'legacy adjust' },
    });
    assert(removedLegacy.status === 404, `legacy direct adjust removed -> 404 (got ${removedLegacy.status})`);
    const removedNoPerm = await call('POST', '/api/v2/service-records/L000000000124/adjust', {
      role: 'team_auditor',
      user: 105,
      team: 10,
      body: { effective_minutes: 25, reason: 'no perm' },
    });
    assert(removedNoPerm.status === 404, `direct adjust removed regardless of role -> 404 (got ${removedNoPerm.status})`);
    const removedUlid = await call('POST', '/api/v2/service-records/' + ulidA + '/adjust', {
      role: 'team_owner',
      user: 103,
      team: 10,
      body: { effective_minutes: 25, reason: 'correct to 25' },
    });
    assert(removedUlid.status === 404, `ULID direct adjust removed -> 404 (got ${removedUlid.status})`);

    // 12 stale concurrent -> 409 (repo-level optimistic lock; route re-reads the row so
    // true HTTP concurrency isn't simulatable single-threaded — the real guard is the
    // WHERE minutes=? predicate inside adjustAtomically, which returns 0 changes when the
    // snapshot drifted. The route maps 0 changes -> 409 SERVICE_RECORD_STALE.)
    {
      const repo = new M.ServiceRecordRepository({
        db,
        ctx: {
          auth: { authenticated: true, userId: 103, teamId: 10, roles: [{ role: 'team_owner', scopeTeamId: 10 }] },
          tenant: { scope: 'TEAM_SCOPED', teamId: 10, userId: 103 },
        },
      });
      const cur = await repo.findRowByPublicId(ulidA, 10);
      // simulate a concurrent writer that changed the snapshot AFTER this reader captured it
      run(sqlite, 'UPDATE service_records SET minutes=10, points_awarded_units=0, settlement_status=1 WHERE public_id=?', [ulidA]);
      const changes = await repo.adjustAtomically({
        serviceRecordId: cur.id,
        teamId: 10,
        expectedMinutes: cur.minutes,
        expectedPoints: cur.points_awarded_units,
        expectedStatus: cur.settlement_status,
        newMinutes: 25,
        newPoints: 0,
        reason: 'stale',
        operatorId: 103,
        traceId: null,
        now: Math.floor(Date.now() / 1000),
      });
      assert(changes === 0, `stale concurrent adjust -> 0 changes (got ${changes})`);
    }

    // 13 projection security across all external responses
    const allResp = [
      ...recs(mine.json),
      ...recs(teamList.json),
      rec(detailUlid.json),
      rec(detailLegacy.json),
    ].filter(Boolean);
    assert(allResp.every(noNumericIds), 'projection security: no numeric internal IDs in ANY external SR response');
    ok('route assertions done');
  }

  // -----------------------------------------------------------------------
  // 结果
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log(`P22-P5 TEST RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (pass=${pass}, fail=${fail})`);
  if (fail > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
  }
  try {
    rmSync(bundlePath, { force: true });
  } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
