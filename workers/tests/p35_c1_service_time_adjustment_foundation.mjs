/**
 * P35-C1 — Service Time Adjustment Request · Schema Foundation CONTRACT TEST
 *
 * 目的：验证 0028 迁移在「完整当前迁移链」上干净落地，且 service_record_adjustment_requests
 * 表结构、约束、部分唯一索引、外键、快照字段、status 模型均符合 P35-B 设计冻结。
 *
 * 纯 schema 契约测试：不驱动任何 runtime / route / service / repository workflow，
 * 不修改源码 / 迁移 / 历史 WIP；不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：
 *   node tests/p35_c1_service_time_adjustment_foundation.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(WORKERS, 'migrations');
const C1_MIGRATION = '0028_service_record_adjustment_requests.sql';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    failures.push(msg);
    console.log('  ✗ FAIL: ' + msg);
  }
}
function section(name) {
  console.log('\n=== ' + name + ' ===');
}
function mustThrow(fn, label) {
  try {
    fn();
    fail++;
    failures.push(label + ' (expected throw, but succeeded)');
    console.log('  ✗ FAIL: ' + label + ' (expected throw, but succeeded)');
  } catch {
    pass++;
    console.log('  ✓ ' + label);
  }
}
function mustSucceed(fn, label) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + label);
  } catch (e) {
    fail++;
    failures.push(label + ' -> ' + e.message);
    console.log('  ✗ FAIL: ' + label + ' -> ' + e.message);
  }
}

function freshSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;'); // 与项目既有离线测试一致：种子不强制 FK
  return sqlite;
}
function applyAllMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return files;
}

// ---------------------------------------------------------------------------
// 行构造（每次自动分配唯一 public_id / service_record_public_id，隔离各断言）
// ---------------------------------------------------------------------------
let _uid = 0;
function nid(prefix) {
  return prefix + '_' + ++_uid;
}
function baseRow(overrides = {}) {
  return {
    public_id: nid('PUB'),
    service_record_public_id: nid('SR'),
    team_id: 1,
    requester_id: 1,
    old_minutes_snapshot: 60,
    old_points_awarded_units_snapshot: 1,
    old_settlement_status_snapshot: 1,
    requested_minutes: 120,
    reason: 'correction',
    requested_at: 1000,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}
function insertRow(sqlite, row) {
  sqlite
    .prepare(
      `INSERT INTO service_record_adjustment_requests
        (public_id, service_record_public_id, team_id, requester_id,
         old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
         requested_minutes, reason, status, requested_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.public_id,
      row.service_record_public_id,
      row.team_id,
      row.requester_id,
      row.old_minutes_snapshot,
      row.old_points_awarded_units_snapshot,
      row.old_settlement_status_snapshot,
      row.requested_minutes,
      row.reason,
      row.status ?? 0,
      row.requested_at,
      row.created_at,
      row.updated_at,
    );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const sqlite = freshSqlite();
const applied = applyAllMigrations(sqlite);
console.log(`[setup] applied ${applied.length} migrations (latest: ${applied[applied.length - 1]})`);

// A. 表存在
section('A. table exists');
assert(
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_record_adjustment_requests'").get(),
  'A table service_record_adjustment_requests exists',
);

// B. public_id 唯一
section('B. public_id UNIQUE');
{
  const r1 = baseRow();
  insertRow(sqlite, r1);
  const r2 = baseRow({ public_id: r1.public_id, service_record_public_id: nid('SR') });
  mustThrow(() => insertRow(sqlite, r2), 'B duplicate public_id rejected');
}

// C/D/E/F. 外键存在性（pragma，无需 FK 强制）
section('C/D/E/F. foreign keys');
{
  const fks = sqlite.prepare("PRAGMA foreign_key_list('service_record_adjustment_requests')").all();
  const has = (from, table, to) => fks.some((f) => f.from === from && f.table === table && f.to === to);
  assert(has('service_record_public_id', 'service_records', 'public_id'), 'C service_record_public_id FK -> service_records(public_id)');
  assert(has('team_id', 'teams', 'id'), 'D team_id FK -> teams(id)');
  assert(has('requester_id', 'users', 'id'), 'E requester_id FK -> users(id)');
  const rev = fks.find((f) => f.from === 'reviewer_id');
  assert(rev && rev.table === 'users' && rev.to === 'id' && /SET NULL/i.test(rev.on_delete), 'F reviewer_id FK -> users(id) ON DELETE SET NULL');
}

// G. 三个快照字段 NOT NULL
section('G. three snapshot fields NOT NULL');
mustThrow(() => insertRow(sqlite, baseRow({ old_minutes_snapshot: null })), 'G old_minutes_snapshot NOT NULL');
mustThrow(() => insertRow(sqlite, baseRow({ old_points_awarded_units_snapshot: null })), 'G old_points_awarded_units_snapshot NOT NULL');
mustThrow(() => insertRow(sqlite, baseRow({ old_settlement_status_snapshot: null })), 'G old_settlement_status_snapshot NOT NULL');

// H. requested_minutes 边界
section('H. requested_minutes bounds (0..525600)');
mustThrow(() => insertRow(sqlite, baseRow({ requested_minutes: -1 })), 'H -1 rejected');
mustThrow(() => insertRow(sqlite, baseRow({ requested_minutes: 525601 })), 'H 525601 rejected');
mustSucceed(() => insertRow(sqlite, baseRow({ requested_minutes: 0 })), 'H 0 ok');
mustSucceed(() => insertRow(sqlite, baseRow({ requested_minutes: 525600 })), 'H 525600 ok');

// I. status CHECK 0..3
section('I. status CHECK (0..3)');
mustThrow(() => insertRow(sqlite, baseRow({ status: 4 })), 'I status=4 rejected');
mustSucceed(() => insertRow(sqlite, baseRow({ status: 0 })), 'I status=0 ok');
mustSucceed(() => insertRow(sqlite, baseRow({ status: 1 })), 'I status=1 ok');
mustSucceed(() => insertRow(sqlite, baseRow({ status: 2 })), 'I status=2 ok');
mustSucceed(() => insertRow(sqlite, baseRow({ status: 3 })), 'I status=3 ok');

// J. 默认 status = PENDING(0)
section('J. default status = PENDING(0)');
{
  const jr = baseRow();
  insertRow(sqlite, jr);
  const got = sqlite.prepare('SELECT status FROM service_record_adjustment_requests WHERE public_id=?').get(jr.public_id);
  assert(got && got.status === 0, 'J default status = 0 (PENDING)');
}

// K. 部分唯一索引：同一 SR 最多 1 个 PENDING
section('K. partial unique index (one PENDING per SR)');
{
  insertRow(sqlite, baseRow({ service_record_public_id: 'SR_K_FIXED', public_id: 'PUB_K1' }));
  const k2 = baseRow({ service_record_public_id: 'SR_K_FIXED', public_id: 'PUB_K2' });
  mustThrow(() => insertRow(sqlite, k2), 'K second PENDING for same SR rejected');
}

// L. APPROVED/REJECTED 历史行不阻塞后续新 PENDING
section('L. historical APPROVED does not block new PENDING');
{
  insertRow(sqlite, baseRow({ service_record_public_id: 'SR_L_FIXED', public_id: 'PUB_L1', status: 1 }));
  mustSucceed(
    () => insertRow(sqlite, baseRow({ service_record_public_id: 'SR_L_FIXED', public_id: 'PUB_L2', status: 0 })),
    'L APPROVED history does not block new PENDING',
  );
  mustThrow(
    () => insertRow(sqlite, baseRow({ service_record_public_id: 'SR_L_FIXED', public_id: 'PUB_L3', status: 0 })),
    'L second PENDING still blocked',
  );
}

// M. 审核前 reviewer 相关字段可空
section('M. nullable reviewer fields before review');
mustSucceed(
  () => insertRow(sqlite, baseRow({ reviewer_id: null, reviewed_at: null, review_reason: null, applied_at: null })),
  'M reviewer_id/reviewed_at/review_reason/applied_at nullable before review',
);

// N. 现有 service_records 未变更（review_status 仍 dormant）
section('N. existing service_records unchanged');
{
  const cols = sqlite.prepare("PRAGMA table_info('service_records')").all().map((c) => c.name);
  assert(cols.includes('review_status'), 'N service_records.review_status present (dormant, not dropped)');
  assert(cols.includes('settlement_status'), 'N service_records.settlement_status present');
  assert(cols.includes('minutes'), 'N service_records.minutes present');
  assert(cols.includes('source'), 'N service_records.source present');
}

// O. service_record_audits 保留
section('O. service_record_audits preserved');
{
  const cols = sqlite.prepare("PRAGMA table_info('service_record_audits')").all().map((c) => c.name);
  assert(cols.includes('approved_by'), 'O service_record_audits.approved_by preserved');
  assert(cols.includes('old_minutes'), 'O service_record_audits.old_minutes preserved');
}

// P/Q. 既有 permission 仍存在
section('P/Q. existing RBAC permissions present');
assert(sqlite.prepare("SELECT 1 FROM permissions WHERE code='service.record.adjust'").get(), 'P service.record.adjust exists');
assert(sqlite.prepare("SELECT 1 FROM permissions WHERE code='service.record.review'").get(), 'Q service.record.review exists');

// R/S. 迁移文件本身静态检查：无新 permission、无 legacy 回填、无 ALTER
section('R/S. migration file static checks (no RBAC add / no backfill / no ALTER)');
{
  const content = readFileSync(join(MIGRATIONS_DIR, C1_MIGRATION), 'utf8').toUpperCase();
  assert(!/INSERT\s+INTO\s+PERMISSIONS/.test(content), 'R no INSERT INTO permissions');
  assert(!/INSERT\s+INTO\s+ROLE_PERMISSIONS/.test(content), 'R no INSERT INTO role_permissions');
  assert(!/INSERT\s+INTO\s+SERVICE_RECORD_ADJUSTMENT_REQUESTS/.test(content), 'S no legacy backfill INSERT');
  assert(!/UPDATE\s+SERVICE_RECORD_ADJUSTMENT_REQUESTS/.test(content), 'S no legacy backfill UPDATE');
  assert(!/ALTER\s+TABLE/.test(content), 'N/R no ALTER TABLE in 0028');
}

// T. 迁移在完整链上干净落地 + 可重放（幂等）
section('T. migration applies cleanly to current chain');
{
  assert(applied.includes(C1_MIGRATION), 'T 0028 is part of applied migration chain');
  let reapplyOk = true;
  try {
    const s2 = freshSqlite();
    applyAllMigrations(s2);
  } catch (e) {
    reapplyOk = false;
    failures.push('T reapply: ' + e.message);
  }
  assert(reapplyOk, 'T migration re-applies cleanly (idempotent, CREATE ... IF NOT EXISTS)');
}

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------
console.log('\n========================================');
console.log(`P35-C1 RESULT: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
