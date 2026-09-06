/**
 * P23-P5 正式测试：Points（P23）集成回归。
 *
 * 覆盖范围（依据 P23-P5 授权）：
 *   SECTION 1 — Migration / schema 正式覆盖（0001→0019，FK=ON）
 *   SECTION 2 — Points mutation 正式覆盖（FK=ON；settlement/adjust/revoke/refinalize/historical/stale/neg/identity）
 *   SECTION 3 — Atomic rollback 正式覆盖（S2 同批 FK 失败 → 全回滚）
 *   SECTION 4 — API 正式覆盖（createApp + app.fetch；SELF / 安全 / 投影 / 分页 / 授权）
 *
 * 复用 P22 正式测试架构：esbuild 运行时打包真实 src + node:sqlite + d1-shim + 真实 Hono app.fetch。
 * 不修改任何源码 / 迁移 / catalog / 历史 WIP；不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：
 *   node tests/p23_points_integration.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { D1Database, generateUlid } from './lib/d1-shim.mjs';
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
export { ServiceRecordRepository, SETTLEMENT_STATUS } from './src/repository/service-records';
export { generateUlid } from './src/utils/crypto';
`;

async function loadImpl() {
  const entryPath = join(WORKERS, '.p23_bundle_entry.ts');
  writeFileSync(entryPath, BUNDLE_ENTRY);
  const bundlePath = join(tmpdir(), `p23_bundle_${process.pid}_${Date.now()}.mjs`);
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
  return mod;
}

// ---------------------------------------------------------------------------
// 2) 基础工具
// ---------------------------------------------------------------------------
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
function assert(cond, msg) {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    FAILURES.push(msg);
    console.error('  ✗ ' + msg);
  }
}
function section(name) {
  console.log('\n=== SECTION ' + name + ' ===');
}
function ulid() {
  return generateUlid();
}

// 应用全部当前 migration（FK OFF 应用，避免应用期 FK 顺序问题）
function applyAllMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  for (const f of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return files.length;
}

// 完整当前 schema DB（0001→0019），FK 开启
function freshCurrentRuntimeDb() {
  const sqlite = new DatabaseSync(':memory:');
  applyAllMigrations(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = new D1Database(sqlite);
  return { sqlite, db };
}

function run(sqlite, sql, params = []) {
  sqlite.prepare(sql).run(...params);
}
function get1(sqlite, sql, params = []) {
  return sqlite.prepare(sql).get(...params);
}
function q(sqlite, sql, params = []) {
  return sqlite.prepare(sql).all(...params);
}
function acct(sqlite, uid) {
  return get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=?', [uid]);
}
function ledgerCount(sqlite, uid) {
  return get1(sqlite, 'SELECT COUNT(*) AS c FROM points_ledger WHERE user_id=?', [uid]).c;
}
function auditCount(sqlite, srid) {
  return get1(sqlite, 'SELECT COUNT(*) AS c FROM service_record_audits WHERE service_record_id=?', [srid]).c;
}
function srBySession(sqlite, sid) {
  return get1(sqlite, 'SELECT * FROM service_records WHERE session_id=?', [sid]);
}

// 完整活动链 + session 种子（FK=ON 安全；复用 P3B probe 实证模式）
function seedChain(sqlite, o) {
  const sid = o.sessionId, uid = o.userId, tid = o.teamId, aid = o.activityId,
    sgid = o.signupId, pid = o.participationId, occ = o.occurrenceId ?? 9001;
  for (const uu of [101, 102, 103, 105, 106, 107, 108, 109, 110, 199]) {
    run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [uu, ulid(), 'u' + uu]);
  }
  run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [uid, ulid(), 'u' + uid]);
  run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [tid, o.teamPublicId ?? ulid(), 'team' + tid, 199]);
  run(sqlite, `INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status, points_multiplier_pct, max_session_minutes, created_by) VALUES (?,?,?,?,0,0,1,?,?,?)`, [aid, o.activityPublicId ?? ulid(), tid, 'a', 100, null, 199]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status) VALUES (?,?,?,0,1,1)', [occ, ulid(), aid]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_signups (id, user_id, activity_id, status) VALUES (?,?,?,1)', [sgid, uid, aid]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) VALUES (?,?,?,?,1,0)', [pid, ulid(), sgid, occ]);
  run(sqlite, `INSERT OR IGNORE INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot, checkin_at, checkout_at, status, review_status, business_service_date, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'',?,?,?,?,?,0,0)`, [
    sid, sgid, aid, uid, tid, pid,
    o.checkinAt !== undefined ? o.checkinAt : 1000,
    o.checkoutAt !== undefined ? o.checkoutAt : 1000 + (o.diffSeconds ?? 2700),
    o.sessionStatus ?? 2,
    o.sessionReview ?? 0,
    o.businessServiceDate ?? '2026-09-01',
  ]);
  return { sid, uid, tid, aid, sgid, pid, occ };
}

// 直接播种 service_records（adjust/revoke 场景；session 已由 seedChain 创建）
function seedSR(sqlite, o) {
  run(sqlite, `INSERT INTO service_records
    (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date,
     settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at, points_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    o.sessionId, o.userId, o.teamId, o.activityId, o.minutes, 'auto', 1, 0, 1,
    o.settlementStatus, o.pointsAwardedUnits, o.publicId, '2026-09-01', o.now, o.now, o.pointsRevision,
  ]);
}

const NOW = Math.floor(Date.now() / 1000);

// 构造 ServiceRecordRepository（TEAM_SCOPED 需要 auth.teamId；USER_SCOPED 需要 auth.userId）
function makeRepo(db, userId, teamId) {
  const { ServiceRecordRepository } = IMPL;
  return new ServiceRecordRepository({
    db,
    ctx: { auth: { authenticated: true, userId, teamId }, tenant: { teamId } },
  });
}

let IMPL;

async function main() {
  IMPL = await loadImpl();
  const { SETTLEMENT_STATUS } = IMPL;

  // =========================================================================
  // SECTION 1 — Migration / schema 正式覆盖
  // =========================================================================
  section('1 — Migration / schema (0001→0019, FK=ON)');
  {
    const { sqlite } = freshCurrentRuntimeDb();
    const fk = q(sqlite, 'PRAGMA foreign_key_check');
    assert(fk.length === 0, `S1: foreign_key_check = 0 (got ${fk.length})`);

    const colsAcct = q(sqlite, "PRAGMA table_info(points_accounts)").map((c) => c.name);
    assert(colsAcct.includes('total_debits'), 'S1: points_accounts.total_debits exists');

    const colsSR = q(sqlite, 'PRAGMA table_info(service_records)').map((c) => c.name);
    assert(colsSR.includes('points_revision'), 'S1: service_records.points_revision exists');

    // points_revision default=0（seed 完整链；session_id FK 需要 attendance_sessions）
    seedChain(sqlite, { sessionId: 5001, userId: 5001, teamId: 5001, activityId: 5001, signupId: 5001, participationId: 5001, diffSeconds: 0 });
    run(sqlite, `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at) VALUES (?,?,?,?,1,'auto',1,0,1,0,0,?, '2026-09-01',0,0)`, [5001, 5001, 5001, 5001, ulid()]);
    const srId1 = get1(sqlite, 'SELECT id FROM service_records WHERE session_id=5001').id;
    const rv = get1(sqlite, 'SELECT points_revision FROM service_records WHERE id=?', [srId1]);
    assert(rv.points_revision === 0, `S1: points_revision default = 0 (got ${rv.points_revision})`);

    // points_revision 负值被拒
    let negRejected = false;
    try {
      run(sqlite, 'UPDATE service_records SET points_revision = -1 WHERE id=?', [srId1]);
    } catch {
      negRejected = true;
    }
    assert(negRejected, 'S1: points_revision negative rejected (CHECK)');

    // type='service' 接受
    let svcOk = false;
    try {
      run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at)
        VALUES (5001,1,10,10,'service','service_record',5001,'svc:sr:seed:svcok', 't', NULL, 0)`, []);
      svcOk = true;
    } catch (e) {
      FAILURES.push('S1 service insert err: ' + e.message);
    }
    assert(svcOk, 'S1: points_ledger.type=\'service\' accepted');

    // duplicate request_id 拒绝
    let dupRejected = false;
    try {
      run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at)
        VALUES (5001,1,10,10,'service','service_record',5001,'svc:sr:seed:svcok', 't', NULL, 0)`, []);
    } catch {
      dupRejected = true;
    }
    assert(dupRejected, 'S1: duplicate request_id rejected (UNIQUE)');

    // 0019 后：service_record_audits.service_record_id → service_records
    let auditOk = true, auditBad = false;
    try {
      run(sqlite, `INSERT INTO service_record_audits (service_record_id, team_id, old_minutes, new_minutes, reason, operator_id, approved_by, trace_id, created_at, old_points_awarded_units, new_points_awarded_units)
        VALUES (?, 5001, 0, 0, 'r', 5001, NULL, NULL, 0, 0, 0)`, [srId1]);
    } catch (e) {
      auditOk = false;
      FAILURES.push('S1 audit ok insert err: ' + e.message);
    }
    assert(auditOk, 'S1: audit with valid service_record_id accepted (0019 FK)');
    try {
      run(sqlite, `INSERT INTO service_record_audits (service_record_id, team_id, old_minutes, new_minutes, reason, operator_id, approved_by, trace_id, created_at, old_points_awarded_units, new_points_awarded_units)
        VALUES (999999, 5001, 0, 0, 'r', 5001, NULL, NULL, 0, 0, 0)`, []);
    } catch {
      auditBad = true;
    }
    assert(auditBad, 'S1: audit with invalid service_record_id rejected (0019 FK)');

    // 全库 dangling FK = 0（再确认）
    const fk2 = q(sqlite, 'PRAGMA foreign_key_check');
    assert(fk2.length === 0, `S1: full-db dangling FK = 0 (got ${fk2.length})`);
  }

  // =========================================================================
  // SECTION 2 — Points mutation 正式覆盖（FK=ON）
  // =========================================================================
  section('2 — Points mutation (FK=ON)');

  // A. first settlement (rev=1, target=75 → account 75, ledger +75)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const c = seedChain(sqlite, { sessionId: 401, userId: 101, teamId: 10, activityId: 2411, signupId: 4411, participationId: 6411, diffSeconds: 2700 });
    const repo = makeRepo(db, 101, 10);
    const pub = ulid();
    const changes = await repo.settleEligibleSessionAtomically({ sessionId: 401, teamId: 10, mode: 'automatic', publicId: pub, now: NOW });
    assert(changes === 1, `A: settlement created SR (got ${changes})`);
    const a = acct(sqlite, 101);
    assert(a && a.balance === 75, `A: account balance = 75 units (got ${a && a.balance})`);
    assert(a.total_earned === 75, `A: total_earned = 75 (got ${a && a.total_earned})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101');
    assert(rows.length === 1, `A: 1 ledger row (got ${rows.length})`);
    assert(rows[0].direction === 1 && rows[0].amount === 75, `A: ledger +75 credit (got dir=${rows[0].direction} amt=${rows[0].amount})`);
    assert(rows[0].request_id === `svc:sr:${pub}:1`, `A: request_id = svc:sr:${pub}:1 (got ${rows[0].request_id})`);
    const sr = srBySession(sqlite, 401);
    assert(sr.points_revision === 1, `A: SR points_revision = 1 (got ${sr.points_revision})`);
  }

  // B. duplicate settlement (0 balance change, 0 new ledger)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedChain(sqlite, { sessionId: 402, userId: 101, teamId: 10, activityId: 2421, signupId: 4421, participationId: 6421, diffSeconds: 2700 });
    const repo = makeRepo(db, 101, 10);
    await repo.settleEligibleSessionAtomically({ sessionId: 402, teamId: 10, mode: 'automatic', publicId: ulid(), now: NOW });
    const before = acct(sqlite, 101).balance;
    const beforeLed = ledgerCount(sqlite, 101);
    const ch2 = await repo.settleEligibleSessionAtomically({ sessionId: 402, teamId: 10, mode: 'automatic', publicId: ulid(), now: NOW });
    assert(ch2 === 0, `B: duplicate settlement = 0 changes (got ${ch2})`);
    assert(acct(sqlite, 101).balance === before, `B: balance unchanged (got ${acct(sqlite, 101).balance}, before ${before})`);
    assert(ledgerCount(sqlite, 101) === beforeLed, `B: ledger count unchanged (got ${ledgerCount(sqlite, 101)}, before ${beforeLed})`);
  }

  // helper：settle then return repo + sessionId + srId
  async function settleOnce(sqlite, db, ids, minutes, pub) {
    const repo = makeRepo(db, ids.uid, ids.tid);
    await repo.settleEligibleSessionAtomically({ sessionId: ids.sid, teamId: ids.tid, mode: 'automatic', publicId: pub, now: NOW });
    const sr = srBySession(sqlite, ids.sid);
    return { repo, srId: sr.id, pub };
  }

  // C. positive adjust (75 → 100 → +25)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 410, userId: 101, teamId: 10, activityId: 2431, signupId: 4431, participationId: 6431, diffSeconds: 2700 });
    const { repo, srId, pub } = await settleOnce(sqlite, db, ids, 2700, ulid());
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    const ch = await repo.adjustAtomically({
      serviceRecordId: srId, teamId: 10, sessionId: 410,
      expectedMinutes: sr.minutes, expectedPoints: sr.points_awarded_units, expectedStatus: SETTLEMENT_STATUS.EFFECTIVE,
      newMinutes: 60, newPoints: 100, reason: 'adj', operatorId: 101, traceId: null, now: NOW,
    });
    assert(ch === 1, `C: adjust applied (got ${ch})`);
    const a = acct(sqlite, 101);
    assert(a.balance === 100, `C: balance = 100 (got ${a.balance})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101 ORDER BY id');
    // 2 rows: +75 (settle) + +25 (adjust)
    const adj = rows[rows.length - 1];
    assert(adj.direction === 1 && adj.amount === 25, `C: adjust ledger +25 (got dir=${adj.direction} amt=${adj.amount})`);
    assert(adj.request_id === `svc:sr:${pub}:2`, `C: adjust request_id = svc:sr:${pub}:2 (got ${adj.request_id})`);
    assert(get1(sqlite, 'SELECT points_revision FROM service_records WHERE id=?', [srId]).points_revision === 2, 'C: SR rev = 2');
  }

  // D. negative adjust (100 → 50 → -50, total_debits += 50)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 420, userId: 101, teamId: 10, activityId: 2441, signupId: 4441, participationId: 6441, diffSeconds: 3600 }); // 60min→100
    const { repo, srId } = await settleOnce(sqlite, db, ids, 3600, ulid());
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    const ch = await repo.adjustAtomically({
      serviceRecordId: srId, teamId: 10, sessionId: 420,
      expectedMinutes: sr.minutes, expectedPoints: sr.points_awarded_units, expectedStatus: SETTLEMENT_STATUS.EFFECTIVE,
      newMinutes: 30, newPoints: 50, reason: 'adj', operatorId: 101, traceId: null, now: NOW,
    });
    assert(ch === 1, `D: adjust applied (got ${ch})`);
    const a = acct(sqlite, 101);
    assert(a.balance === 50, `D: balance = 50 (got ${a.balance})`);
    assert(a.total_debits === 50, `D: total_debits = 50 (got ${a.total_debits})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101 ORDER BY id');
    const adj = rows[rows.length - 1];
    assert(adj.direction === 2 && adj.amount === 50, `D: adjust ledger -50 (got dir=${adj.direction} amt=${adj.amount})`);
  }

  // E. revoke (target → 0 → debit net)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 430, userId: 101, teamId: 10, activityId: 2451, signupId: 4451, participationId: 6451, diffSeconds: 2700 });
    const { repo, srId } = await settleOnce(sqlite, db, ids, 2700, ulid());
    const ch = await repo.revokeAtomically({ serviceRecordId: srId, teamId: 10, sessionId: 430, reason: 'rev', operatorId: 101, traceId: null, now: NOW });
    assert(ch === 1, `E: revoke applied (got ${ch})`);
    const a = acct(sqlite, 101);
    assert(a.balance === 0, `E: balance = 0 after revoke (got ${a.balance})`);
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    assert(sr.settlement_status === SETTLEMENT_STATUS.REVOKED, `E: SR REVOKED (got ${sr.settlement_status})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101 ORDER BY id');
    const rv = rows[rows.length - 1];
    assert(rv.direction === 2 && rv.amount === 75, `E: revoke ledger -75 (got dir=${rv.direction} amt=${rv.amount})`);
  }

  // F. repeat revoke (no-op)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 440, userId: 101, teamId: 10, activityId: 2461, signupId: 4461, participationId: 6461, diffSeconds: 2700 });
    const { repo, srId } = await settleOnce(sqlite, db, ids, 2700, ulid());
    await repo.revokeAtomically({ serviceRecordId: srId, teamId: 10, sessionId: 440, reason: 'rev', operatorId: 101, traceId: null, now: NOW });
    const beforeBal = acct(sqlite, 101).balance;
    const beforeLed = ledgerCount(sqlite, 101);
    const ch2 = await repo.revokeAtomically({ serviceRecordId: srId, teamId: 10, sessionId: 440, reason: 'rev', operatorId: 101, traceId: null, now: NOW });
    assert(ch2 === 0, `F: repeat revoke = 0 changes (got ${ch2})`);
    assert(acct(sqlite, 101).balance === beforeBal, `F: balance unchanged (got ${acct(sqlite, 101).balance})`);
    assert(ledgerCount(sqlite, 101) === beforeLed, `F: ledger count unchanged (got ${ledgerCount(sqlite, 101)})`);
  }

  // G. re-finalize (REVOKED → EFFECTIVE again → re-earn current entitlement)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 450, userId: 101, teamId: 10, activityId: 2471, signupId: 4471, participationId: 6471, diffSeconds: 2700 });
    const { repo, srId } = await settleOnce(sqlite, db, ids, 2700, ulid());
    await repo.revokeAtomically({ serviceRecordId: srId, teamId: 10, sessionId: 450, reason: 'rev', operatorId: 101, traceId: null, now: NOW });
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    const pub2 = ulid();
    const ch = await repo.adjustAtomically({
      serviceRecordId: srId, teamId: 10, sessionId: 450,
      expectedMinutes: sr.minutes, expectedPoints: sr.points_awarded_units, expectedStatus: SETTLEMENT_STATUS.REVOKED,
      newMinutes: 45, newPoints: 75, reason: 'refinalize', operatorId: 101, traceId: null, now: NOW,
    });
    assert(ch === 1, `G: re-finalize applied (got ${ch})`);
    const a = acct(sqlite, 101);
    assert(a.balance === 75, `G: balance re-earned to 75 (got ${a.balance})`);
    const sr2 = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    assert(sr2.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, `G: SR EFFECTIVE again (got ${sr2.settlement_status})`);
    assert(sr2.points_revision === 3, `G: SR rev = 3 (got ${sr2.points_revision})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101 ORDER BY id');
    const last = rows[rows.length - 1];
    assert(last.direction === 1 && last.amount === 75, `G: re-finalize ledger +75 (got dir=${last.direction} amt=${last.amount})`);
  }

  // H. historical rev=0 explicit adjust (target=75/net=0, adjust target=100 → +100, not +25)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 460, userId: 101, teamId: 10, activityId: 2481, signupId: 4481, participationId: 6481, diffSeconds: 2700 });
    const pub = ulid();
    // legacy SR：points_awarded_units=75 但 points_revision=0（从未进入 points pipeline，net ledger=0）
    seedSR(sqlite, { sessionId: 460, userId: 101, teamId: 10, activityId: 2481, minutes: 45, settlementStatus: SETTLEMENT_STATUS.EFFECTIVE, pointsAwardedUnits: 75, publicId: pub, now: NOW, pointsRevision: 0 });
    const srId = srBySession(sqlite, 460).id;
    const repo = makeRepo(db, 101, 10);
    const ch = await repo.adjustAtomically({
      serviceRecordId: srId, teamId: 10, sessionId: 460,
      expectedMinutes: 45, expectedPoints: 75, expectedStatus: SETTLEMENT_STATUS.EFFECTIVE,
      newMinutes: 60, newPoints: 100, reason: 'hist', operatorId: 101, traceId: null, now: NOW,
    });
    assert(ch === 1, `H: historical adjust applied (got ${ch})`);
    const a = acct(sqlite, 101);
    assert(a.balance === 100, `H: balance = 100 (got ${a.balance}) — proves +100 not +25`);
    const sr2 = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    assert(sr2.points_revision === 1, `H: rev 0→1 (got ${sr2.points_revision})`);
    const rows = q(sqlite, 'SELECT * FROM points_ledger WHERE user_id=101 ORDER BY id');
    assert(rows.length === 1 && rows[0].amount === 100, `H: single ledger +100 (got len=${rows.length} amt=${rows[0] && rows[0].amount})`);
    assert(rows[0].request_id === `svc:sr:${pub}:1`, `H: request_id = svc:sr:${pub}:1 (got ${rows[0].request_id})`);
  }

  // I. stale adjust (audit 0, revision unchanged, balance unchanged, ledger 0)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 470, userId: 101, teamId: 10, activityId: 2491, signupId: 4491, participationId: 6491, diffSeconds: 2700 });
    const { repo, srId } = await settleOnce(sqlite, db, ids, 2700, ulid());
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    const beforeRev = sr.points_revision, beforeBal = acct(sqlite, 101).balance, beforeLed = ledgerCount(sqlite, 101), beforeAud = auditCount(sqlite, srId);
    // 传入错误 expected（expectedPoints 不匹配）→ UPDATE 0 行
    const ch = await repo.adjustAtomically({
      serviceRecordId: srId, teamId: 10, sessionId: 470,
      expectedMinutes: sr.minutes, expectedPoints: 999, expectedStatus: SETTLEMENT_STATUS.EFFECTIVE,
      newMinutes: 60, newPoints: 100, reason: 'stale', operatorId: 101, traceId: null, now: NOW,
    });
    assert(ch === 0, `I: stale adjust = 0 changes (got ${ch})`);
    assert(get1(sqlite, 'SELECT points_revision FROM service_records WHERE id=?', [srId]).points_revision === beforeRev, `I: revision unchanged (got ${get1(sqlite, 'SELECT points_revision FROM service_records WHERE id=?', [srId]).points_revision})`);
    assert(acct(sqlite, 101).balance === beforeBal, `I: balance unchanged (got ${acct(sqlite, 101).balance})`);
    assert(ledgerCount(sqlite, 101) === beforeLed, `I: ledger count unchanged (got ${ledgerCount(sqlite, 101)})`);
    assert(auditCount(sqlite, srId) === beforeAud, `I: audit count unchanged (got ${auditCount(sqlite, srId)})`);
  }

  // J. negative balance allowed (schema has no NOT-NEGATIVE CHECK on balance)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedChain(sqlite, { sessionId: 480, userId: 101, teamId: 10, activityId: 2501, signupId: 4501, participationId: 6501, diffSeconds: 2700 });
    run(sqlite, 'INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (101, 75, 75, 0, 0, 0)', []);
    let negOk = false;
    try {
      run(sqlite, 'UPDATE points_accounts SET balance = -50 WHERE user_id=101', []);
      negOk = get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=101').balance === -50;
    } catch (e) {
      FAILURES.push('J negative update err: ' + e.message);
    }
    assert(negOk, 'J: negative balance allowed to land (no NOT-NEGATIVE CHECK)');
  }

  // K. request identity (svc:sr:<public_id>:<points_revision>)
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 490, userId: 101, teamId: 10, activityId: 2511, signupId: 4511, participationId: 6511, diffSeconds: 2700 });
    const pub = ulid();
    const repo = makeRepo(db, 101, 10);
    await repo.settleEligibleSessionAtomically({ sessionId: 490, teamId: 10, mode: 'automatic', publicId: pub, now: NOW });
    const row = get1(sqlite, 'SELECT request_id FROM points_ledger WHERE user_id=101');
    assert(row.request_id === `svc:sr:${pub}:1`, `K: request_id identity svc:sr:${pub}:1 (got ${row.request_id})`);
  }

  // =========================================================================
  // SECTION 3 — Atomic rollback（S2 同批 FK 失败 → 全回滚）
  // =========================================================================
  section('3 — Atomic rollback (FK-failed S2 → full rollback)');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    const ids = seedChain(sqlite, { sessionId: 510, userId: 101, teamId: 10, activityId: 2521, signupId: 4521, participationId: 6521, diffSeconds: 2700 });
    // 已存在账户 balance=75，使 S1 UPDATE 真实执行（rollback 验证对象）
    run(sqlite, 'INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (101, 75, 75, 0, 0, 0)', []);
    const pub = ulid();
    seedSR(sqlite, { sessionId: 510, userId: 101, teamId: 10, activityId: 2521, minutes: 45, settlementStatus: SETTLEMENT_STATUS.EFFECTIVE, pointsAwardedUnits: 75, publicId: pub, now: NOW, pointsRevision: 1 });
    const srId = srBySession(sqlite, 510).id;
    const repo = makeRepo(db, 101, 10);
    let threw = false;
    try {
      // operator_id=99999 不存在的 user → points_ledger.operator_id FK 失败 → 整批回滚
      await repo.revokeAtomically({ serviceRecordId: srId, teamId: 10, sessionId: 510, reason: 'rev', operatorId: 99999, traceId: null, now: NOW });
    } catch (e) {
      threw = true;
    }
    assert(threw, 'R: revoke with bad operator_id threw (FK failure)');
    // 回滚后：SR mutation 撤销
    const sr = get1(sqlite, 'SELECT * FROM service_records WHERE id=?', [srId]);
    assert(sr.settlement_status === SETTLEMENT_STATUS.EFFECTIVE, `R: SR still EFFECTIVE (got ${sr.settlement_status})`);
    assert(sr.points_revision === 1, `R: SR revision unchanged (=1, got ${sr.points_revision})`);
    // account rollback
    assert(acct(sqlite, 101).balance === 75, `R: account balance rollback to 75 (got ${acct(sqlite, 101).balance})`);
    // audit rollback
    assert(auditCount(sqlite, srId) === 0, `R: audit row rolled back (got ${auditCount(sqlite, srId)})`);
    // ledger rollback
    assert(ledgerCount(sqlite, 101) === 0, `R: ledger row rolled back (got ${ledgerCount(sqlite, 101)})`);
  }

  // =========================================================================
  // SECTION 4 — API 正式覆盖（createApp + app.fetch）
  // =========================================================================
  section('4 — API (createApp + app.fetch)');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    // 用户 A=201（volunteer 角色）、B=202、C=203（均无 account 行）
    for (const uu of [201, 202, 203, 199]) {
      run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [uu, ulid(), 'u' + uu]);
    }
    run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [10, ulid(), 'team10', 199]);

    // A 的账户 + 3 条流水（含 1 条 service_record + 1 条 legacy）
    run(sqlite, 'INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (201, 75, 100, 0, 25, ?)', [NOW]);
    // 为 service_records.session_id FK 播种会话链（session 601）
    seedChain(sqlite, { sessionId: 601, userId: 201, teamId: 10, activityId: 3001, signupId: 3001, participationId: 3001, diffSeconds: 2700 });
    const srPub = ulid();
    run(sqlite, `INSERT INTO service_records (session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at, points_revision) VALUES (?,201,10,3001,45,'auto',1,0,1,1,75,?, '2026-09-01',?,?,1)`, [601, srPub, NOW, NOW]);
    const sridA = get1(sqlite, 'SELECT id FROM service_records WHERE public_id=?', [srPub]).id;
    // 流水：同 created_at 用 id DESC 顺序验证；分布 created_at 100/100/200
    run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at) VALUES (201,1,75,75,'service','service_record',?, 'svc:sr:A:srv', 'checkout', NULL, 100)`, [sridA]);
    run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at) VALUES (201,1,20,95,'activity','activity',9001, 'act:A:1', 'train', NULL, 100)`, []);
    run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at) VALUES (201,2,20,75,'service','service_record',?, 'svc:sr:A:srv2', 'revoke', NULL, 200)`, [sridA]);

    // B 的账户 + 1 条流水（用于 SELF 隔离）
    run(sqlite, 'INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (202, 50, 50, 0, 0, ?)', [NOW]);
    run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at) VALUES (202,1,50,50,'service','service_record',9999, 'svc:sr:B:1', 'checkout', NULL, 100)`, []);

    const app = IMPL.createApp();
    const env = { DB: db, ENVIRONMENT: 'local' };
    async function call(method, path, opts = {}) {
      const headers = { 'content-type': 'application/json' };
      if (opts.role) headers['x-test-role'] = opts.role;
      if (opts.user) headers['x-test-user'] = String(opts.user);
      if (opts.team) headers['x-test-team'] = String(opts.team);
      const init = { method, headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const res = await app.fetch(new Request('http://localhost' + path, init), env);
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    }
    const FORBIDDEN_KEYS = ['id', 'user_id', 'source_id', 'operator_id', 'request_id', 'last_ledger_id', 'last_checked_at'];
    function noForbiddenKeys(item) {
      return !FORBIDDEN_KEYS.some((k) => k in (item || {}));
    }

    // 4.1 account existing
    const accA = await call('GET', '/api/v2/points/account', { role: 'volunteer', user: 201, team: 10 });
    assert(accA.status === 200, `4.1: account GET 200 (got ${accA.status})`);
    const ad = accA.json.data;
    assert(ad.balance_units === 75 && ad.total_earned_units === 100 && ad.total_debits_units === 25, `4.1: account projection correct (got ${JSON.stringify(ad)})`);
    assert(!('user_id' in ad) && !('last_ledger_id' in ad), '4.1: account hides internal keys');

    // 4.2 missing account → 0/0/0/0/null；GET 后 DB 仍无 account row
    const accC = await call('GET', '/api/v2/points/account', { role: 'volunteer', user: 203, team: 10 });
    assert(accC.status === 200, `4.2: missing account GET 200 (got ${accC.status})`);
    const cd = accC.json.data;
    assert(cd.balance_units === 0 && cd.total_earned_units === 0 && cd.total_spent_units === 0 && cd.total_debits_units === 0 && cd.updated_at === null, `4.2: missing account zero-object (got ${JSON.stringify(cd)})`);
    const cRow = get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=203');
    assert(cRow === undefined, '4.2: GET missing account did NOT insert account row');

    // 4.3 SELF isolation + ?user_id ignored
    const txA = await call('GET', '/api/v2/points/transactions', { role: 'volunteer', user: 201, team: 10 });
    assert(txA.status === 200, `4.3: tx GET 200 (got ${txA.status})`);
    const itemsA = txA.json.data.items;
    assert(itemsA.length === 3, `4.3: A sees only 3 (got ${itemsA.length})`);
    assert(itemsA.every((i) => noForbiddenKeys(i)), '4.3: A items no forbidden keys');
    const txAOverride = await call('GET', '/api/v2/points/transactions?user_id=202', { role: 'volunteer', user: 201, team: 10 });
    assert(txAOverride.json.data.items.length === 3, `4.3: ?user_id=202 ignored → still 3 (got ${txAOverride.json.data.items.length})`);
    const txB = await call('GET', '/api/v2/points/transactions', { role: 'volunteer', user: 202, team: 10 });
    assert(txB.json.data.items.length === 1, `4.3: B sees only 1 (got ${txB.json.data.items.length})`);

    // 4.4 ordering created_at DESC, id DESC (tiebreak)
    const order = txA.json.data.items.map((i) => i.created_at + ':' + (i.remark));
    // 期望：created_at 200 (revoke) 先；然后 created_at 100 两条按 id DESC → checkout 后于 train？
    // 实际插入顺序：checkout(id) / train(id+1) 同 created_at=100；revoke created_at=200。
    // ORDER BY created_at DESC, id DESC → 200 在前；100 两条 id 大的在前（train 先于 checkout）。
    assert(order[0].startsWith('200'), `4.4: first item created_at=200 (got ${order[0]})`);
    assert(order[1].startsWith('100') && order[2].startsWith('100'), `4.4: next two created_at=100 (got ${order[1]},${order[2]})`);
    assert(order[1].includes('train') && order[2].includes('checkout'), `4.4: id DESC tiebreak within 100 (got ${order[1]},${order[2]})`);

    // 4.5 service_record → source_public_id；legacy → null
    const svcItem = itemsA.find((i) => i.source_type === 'service_record');
    assert(svcItem && svcItem.source_public_id === srPub, `4.5: service_record → source_public_id=${srPub} (got ${svcItem && svcItem.source_public_id})`);
    const legacyItem = itemsA.find((i) => i.source_type === 'activity');
    assert(legacyItem && legacyItem.source_public_id === null, `4.5: legacy → source_public_id=null (got ${legacyItem && legacyItem.source_public_id})`);

    // 4.6 pagination page/page_size
    const p1 = await call('GET', '/api/v2/points/transactions?page=1&page_size=2', { role: 'volunteer', user: 201, team: 10 });
    assert(p1.json.data.items.length === 2, `4.6: page1 size2 → 2 items (got ${p1.json.data.items.length})`);
    assert(p1.json.data.pagination.total === 3 && p1.json.data.pagination.total_pages === 2 && p1.json.data.pagination.page === 1 && p1.json.data.pagination.page_size === 2, `4.6: pagination meta (got ${JSON.stringify(p1.json.data.pagination)})`);
    const p2 = await call('GET', '/api/v2/points/transactions?page=2&page_size=2', { role: 'volunteer', user: 201, team: 10 });
    assert(p2.json.data.items.length === 1, `4.6: page2 → 1 item (got ${p2.json.data.items.length})`);

    // 4.7 page_size cap = 100
    const cap = await call('GET', '/api/v2/points/transactions?page_size=9999', { role: 'volunteer', user: 201, team: 10 });
    assert(cap.json.data.pagination.page_size === 100, `4.7: page_size clamped to 100 (got ${cap.json.data.pagination.page_size})`);
    const neg = await call('GET', '/api/v2/points/transactions?page_size=-3', { role: 'volunteer', user: 201, team: 10 });
    assert(neg.status === 400, `4.7: negative page_size → 400 (got ${neg.status})`);

    // 4.8 projection safety（序列化后无内部字段 key）
    const allItems = [...p1.json.data.items, ...p2.json.data.items];
    assert(allItems.every((i) => noForbiddenKeys(i)), '4.8: no internal keys in any transaction item');

    // 4.9 authorization
    const vol = await call('GET', '/api/v2/points/account', { role: 'volunteer', user: 201, team: 10 });
    assert(vol.status === 200, `4.9: volunteer → 200 (got ${vol.status})`);
    const plat = await call('GET', '/api/v2/points/account', { role: 'platform_super_admin', user: 201, team: 10 });
    assert(plat.status === 200, `4.9: platform_super_admin → 200 (got ${plat.status})`);
    const owner = await call('GET', '/api/v2/points/account', { role: 'team_owner', user: 201, team: 10 });
    assert(owner.status === 403, `4.9: team_owner (no perm) → 403 (got ${owner.status})`);
    const unauth = await call('GET', '/api/v2/points/account', {});
    assert(unauth.status === 401, `4.9: unauthenticated → 401 (got ${unauth.status})`);
  }

  // =========================================================================
  console.log(`\nP23-P5 TEST RESULT: ${FAIL === 0 ? 'PASS' : 'FAIL'}  (pass=${PASS}, fail=${FAIL})`);
  if (FAIL > 0) {
    console.error('FAILURES:');
    for (const f of FAILURES) console.error('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
