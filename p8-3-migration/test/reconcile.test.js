import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigration } from '../src/runner.js';
import { FixtureSource, MemoryTarget } from '../src/adapters.js';
import { reconcile } from '../src/reconcile.js';

// Deterministic fixture exercising the documented chains (identity / activity / points / cert / training / media / audit).
function buildFixture() {
  return {
    'api.users': [
      { id: 1, nickname: 'u1', created_at: '2026-01-01 00:00:00', last_login_at: '2026-02-01 00:00:00' },
      { id: 2, nickname: 'u2', created_at: '2026-01-01 00:00:00' },
      { id: 3, nickname: 'u3', created_at: '2026-01-01 00:00:00' },
    ],
    'api.volunteers': [
      { id: 1, user_id: 1, cert_status: 1, total_times: 5, growth_value: 10, created_at: '2026-01-02 00:00:00' },
      { id: 2, user_id: 2, cert_status: 0, created_at: '2026-01-02 00:00:00' },
      { id: 3, user_id: 3, cert_status: 1, created_at: '2026-01-02 00:00:00' },
    ],
    'api.teams': [
      { id: 10, name: 'T1', owner_user_id: 1, status: 1, created_at: '2026-01-03 00:00:00' },
      { id: 11, name: 'T2', owner_user_id: 2, status: 1, created_at: '2026-01-03 00:00:00' },
    ],
    'api.activities': [
      { id: 100, team_id: 10, title: 'A1', start_time: '2026-03-01 09:00:00', end_time: '2026-03-01 11:00:00', created_at: '2026-02-01 00:00:00' },
      { id: 101, team_id: 11, title: 'A2', start_time: '2026-03-02 09:00:00', end_time: '2026-03-02 11:00:00', created_at: '2026-02-01 00:00:00' },
    ],
    'api.activity_signups': [
      { id: 1, activity_id: 100, user_id: 1, status: 1, created_at: '2026-02-20 00:00:00' },
      { id: 2, activity_id: 101, user_id: 2, status: 1, created_at: '2026-02-21 00:00:00' },
    ],
    'api.jhzy_activity_checkins': [
      { id: 1, activity_id: 100, user_id: 1, checkin_at: '2026-03-01 09:05:00', created_at: '2026-03-01 09:05:00' },
      { id: 2, activity_id: 101, user_id: 2, checkin_at: '2026-03-02 09:05:00', created_at: '2026-03-02 09:05:00' },
    ],
    'api.jhzy_casual_records': [
      { id: 1, user_id: 1, activity_id: 100, minutes: 120, created_at: '2026-03-01 10:00:00' },
    ],
    'api.points_transactions': [
      { id: 1, user_id: 1, direction: 1, amount: 50, balance_after: 50, type: 'signup', request_id: 'r-1', created_at: '2026-02-20 00:00:00' },
    ],
    'api.certificates': [
      { id: 1, user_id: 1, team_id: 10, cert_type: 'activity', cert_no: 'C1', issued_at: '2026-03-10 00:00:00', status: 1 },
    ],
    'api.roles': [{ id: 1, code: 'volunteer', name: '志愿者', scope: 'team', is_system: 1, status: 1 }],
    'api.permissions': [{ id: 1, code: 'act:view', name: '查看活动', perm_group: 'act', risk_level: 1 }],
    'api.role_permissions': [{ id: 1, role_id: 1, permission_id: 1 }],
    'api.user_roles': [{ id: 1, user_id: 1, role_id: 1, scope_team_id: 10, granted_by: 1 }],
    'api.notifications': [{ id: 1, notif_type: 'sys', title: 'hi', content: 'hello', target: 'all' }],
    'api.courses': [{ id: 1, title: 'C1' }],
    'api.exam_sessions': [{ id: 1, user_id: 1, exam_id: 5 }],
    'api.achievements': [{ id: 1, title: '首秀', description: 'd', issued_at: '2026-03-01 00:00:00' }],
    'api.welfare_options': [{ id: 1, name: '福利A', points_cost: 100, price: 100, stock: 10 }],
    'api.mall_products': [{ id: 1, name: '商品A', points_price: 200, stock: 5 }],
    'api.file_uploads': [{ id: 1, storage_path: '/f/a.png', mime_type: 'image/png', checksum: 'x', size: 10, original_name: 'a.png' }],
    'api.quick_actions': [{ id: 1, user_id: 1, action: '随手公益' }], // ARCHIVE (DEFERRED_V2_GAP)
    'api.qr_codes': [{ id: 1, code: 'q', type: 'signup' }], // DROP
    'api.volunteer_approvals': [{ id: 1, reviewer_id: 1, user_id: 1, cert_status: 1 }], // → operation_logs
    'api.user_favorites': [{ id: 1, user_id: 1, target_type: 'activity', target_id: 100 }], // EXCLUDED (BCR)
    'signup_db.users': [{ id: 9, nickname: 'su9', created_at: '2026-01-01 00:00:00' }], // MERGE → users
  };
}

function makeCheckpoint() {
  let store = {};
  return {
    async load() { return store; },
    async save(s) { store = { doneTables: [...s.doneTables], lastBatch: s.lastBatch }; },
  };
}

async function migrate(fixture, { checkpoint } = {}) {
  const target = new MemoryTarget();
  await runMigration({ source: new FixtureSource(fixture), target, opts: { checkpoint } });
  return target;
}

test('WP4: fully consistent migration reconciles PASS', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'PASS', 'expected PASS, got FAIL: ' + JSON.stringify(res.checks, null, 2));
  assert.equal(res.checks.row_conservation.status, 'PASS');
  assert.equal(res.checks.identity_integrity.status, 'PASS');
  assert.equal(res.checks.relationship_integrity.status, 'PASS');
  assert.equal(res.checks.activity_chain.status, 'PASS');
  assert.equal(res.checks.points_growth.status, 'PASS');
  assert.equal(res.checks.training_result.status, 'PASS');
  assert.equal(res.checks.audit_integrity.status, 'PASS');
  assert.equal(res.checks.excluded_unknown.status, 'PASS');
});

test('WP4: row count mismatch → FAIL', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  // Inject an extra unmigrated source row after migration.
  fixture['api.users'].push({ id: 99, nickname: 'extra', created_at: '2026-04-01 00:00:00' });
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.row_conservation.status, 'FAIL');
});

test('WP4: duplicate identity (legacy_id_maps target dup) → FAIL', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  const last = target.idmaps[target.idmaps.length - 1];
  target.idmaps.push({ ...last, source_system: 'x', source_table: 'y', legacy_id: '999' }); // same target_table/target_id
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.identity_integrity.status, 'FAIL');
});

test('WP4: orphan relation (missing activity) → FAIL', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  // Remove the target activity row that source activity 101 maps to (resolved via legacy_id_maps).
  const tId = target.idmaps.find((m) => m.target_table === 'activities' && String(m.legacy_id) === '101')?.target_id;
  const t = target.tables.get('activities');
  t.rows = t.rows.filter((r) => r.id !== tId);
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.relationship_integrity.status, 'FAIL');
  assert.equal(res.checks.activity_chain.status, 'FAIL');
});

test('WP4: points duplication (duplicate request_id) → FAIL', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  const ledger = target.tables.get('points_ledger');
  const dup = { ...ledger.rows[0], id: 9999 };
  ledger.rows.push(dup);
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.points_growth.status, 'FAIL');
});

test('WP4: missing legacy mapping (idmap removed) → FAIL', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  target.idmaps.pop(); // remove one mapping
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.row_conservation.status, 'FAIL');
  assert.equal(res.checks.relationship_integrity.status, 'FAIL');
});

test('WP4: user_favorites exclusion → PASS', async () => {
  const fixture = buildFixture();
  const target = await migrate(fixture);
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.checks.excluded_unknown.status, 'PASS');
  // user_favorites must NOT be a migrated target row anywhere
  for (const [, tbl] of target.tables) {
    assert.ok(!tbl.rows.some((r) => r.source_object === 'api.user_favorites'), 'user_favorites leaked into target');
  }
  assert.equal(res.checks.excluded_unknown.detail.bcrPending, true);
});

test('WP4: rerun / idempotency → PASS (shared checkpoint resume)', async () => {
  const fixture = buildFixture();
  const target = new MemoryTarget();
  const cp = makeCheckpoint();
  const r1 = await runMigration({ source: new FixtureSource(fixture), target, opts: { checkpoint: cp } });
  const r2 = await runMigration({ source: new FixtureSource(fixture), target, opts: { checkpoint: cp } });
  assert.ok(r2.stats.inserted === 0, 'checkpoint resume must insert 0 (idempotent)');
  assert.ok(r2.stats.tablesProcessed === 0, 'checkpoint resume must skip all done tables');
  const res = await reconcile({ source: new FixtureSource(fixture), target });
  assert.equal(res.status, 'PASS', 'idempotent rerun must still reconcile PASS');
  assert.equal(res.checks.row_conservation.status, 'PASS');
  assert.equal(res.checks.row_conservation.detail.balanced, true);
});
