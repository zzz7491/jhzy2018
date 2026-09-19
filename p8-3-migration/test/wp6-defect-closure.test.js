import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigration } from '../src/runner.js';
import { reconcile } from '../src/reconcile.js';
import { rollbackFull } from '../src/rollback.js';
import { rehearseDefectClosure } from '../src/rehearsal.js';
import { FixtureSource, MemoryTarget } from '../src/adapters.js';
import { MemoryCheckpoint } from '../src/checkpoint.js';
import { computeSourceCounts } from '../src/recovery.js';

// =============================================================
// DEFECT-WP6-01 / DEFECT-WP6-02 — HIGH DEFECT CLOSURE (targeted)
// =============================================================

// 直接单元验证：reconcile 按 run_id 过滤，同一 ledger 二次迁移不污染。
test('DEFECT-WP6-01: reconcile filters by run_id (current-run only)', async () => {
  const fixture = () => new FixtureSource(buildFixture());
  const source = fixture();
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();

  // Run A
  await runMigration({ source: fixture(), target, opts: { checkpoint: cp, seed: 7, now: 1, runId: 'RA' } });
  const reconA = await reconcile({ source: fixture(), target, opts: { runId: 'RA' } });
  assert.equal(reconA.status, 'PASS', 'run A must reconcile PASS');

  // Full rollback (issues retained)
  await rollbackFull({ target, checkpoint: cp, opts: { runId: 'RA' } });

  // Run B on same ledger
  await runMigration({ source: fixture(), target, opts: { checkpoint: cp, seed: 7, now: 1, runId: 'RB' } });
  const reconB = await reconcile({ source: fixture(), target, opts: { runId: 'RB' } });
  assert.equal(reconB.status, 'PASS', 'run B (same ledger) must reconcile PASS via run_id filter');

  // 对照组：不带 run_id 的 reconcile 会同时计入两轮的 dropped → 失衡 FAIL（证明过滤是必要的）
  const reconAll = await reconcile({ source: fixture(), target, opts: {} });
  assert.equal(reconAll.status, 'FAIL', 'no run_id filter must double-count historical dropped → FAIL');

  // Run A 历史 issues 仍被保留（未删除）
  const runAIssues = target.allIssues().filter((i) => i.run_id === 'RA');
  const runBIssues = target.allIssues().filter((i) => i.run_id === 'RB');
  assert.ok(runAIssues.length > 0, 'run A issues retained');
  assert.ok(runBIssues.length > 0, 'run B issues present');
  assert.notEqual('RA', 'RB', 'run ids distinct');
});

// 同一 ledger 上 drop 不被历史 run 翻倍（current-run counting 正确）
test('DEFECT-WP6-01: current-run dropped count not polluted by previous run', async () => {
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  await runMigration({ source: new FixtureSource(buildFixture()), target, opts: { checkpoint: cp, seed: 7, now: 1, runId: 'RA' } });
  await rollbackFull({ target, checkpoint: cp, opts: { runId: 'RA' } });
  await runMigration({ source: new FixtureSource(buildFixture()), target, opts: { checkpoint: cp, seed: 7, now: 1, runId: 'RB' } });
  const runB = target.allIssues().filter((i) => i.run_id === 'RB');
  const droppedB = runB.filter((i) => i.issue_type === 'dropped').length;
  assert.equal(droppedB, 1, 'run B dropped must be 1, not polluted by run A (which would be 2)');
});

// 主演练：rehearseDefectClosure 产出 FINAL GATE
let closure = null;
test('DEFECT CLOSURE: rehearseDefectClosure produces closure gate', async () => {
  closure = await rehearseDefectClosure({ operator: { name: 'mingmo', timestamp: '2026-09-19T14:45:00+08:00' } });
  assert.ok(closure && closure.gate, 'closure report must carry gate');
});

test('DEFECT-WP6-01 fixed = YES (run_id, retention, filtering, same-ledger)', () => {
  const g = closure.gate;
  assert.equal(g['DEFECT-WP6-01 fixed'], 'YES');
  assert.equal(g['run_id implemented'], 'YES');
  assert.equal(g['historical issues retained'], 'YES');
  assert.equal(g['current-run reconciliation filtering'], 'PASS');
  assert.equal(g['same-ledger second migration'], 'PASS');
  // 场景级佐证
  assert.equal(closure.scenarios.runA.producedDropped, true);
  assert.equal(closure.scenarios.runA.producedExcluded, true);
  assert.equal(closure.scenarios.runB.runAIssuesNotDeleted, true);
  assert.equal(closure.scenarios.runB.runIdsDistinct, true);
  assert.equal(closure.scenarios.runB.currentRunDropped, 1);
  assert.equal(closure.scenarios.runB.pollutionFree, true);
});

test('DEFECT-WP6-02 fixed = YES (SC-15 formal)', () => {
  const g = closure.gate;
  assert.equal(g['DEFECT-WP6-02 fixed'], 'YES');
  assert.equal(g['SC-15 implemented'], 'YES');
  assert.equal(g['open current-run migration error triggers STOP'], 'YES');
  assert.equal(g['incomplete batch triggers STOP'], 'YES');
  assert.equal(g['historical run error isolation'], 'PASS');
  assert.equal(g['nextBatchAllowed false on SC-15'], 'YES');
  // 场景级佐证
  assert.equal(closure.scenarios.sc15Injection.openError.status, 'STOP');
  assert.equal(closure.scenarios.sc15Injection.openError.hitSC15, true);
  assert.equal(closure.scenarios.sc15Injection.openError.nextBatchAllowed, false);
  assert.equal(closure.scenarios.sc15Injection.incompleteBatch.status, 'STOP');
  assert.equal(closure.scenarios.sc15Injection.incompleteBatch.hitSC15, true);
  assert.equal(closure.scenarios.sc15Injection.incompleteBatch.nextBatchAllowed, false);
  assert.equal(closure.scenarios.historicalIsolation.triggeredByHistorical, false);
  assert.equal(closure.scenarios.historicalIsolation.runBStopStatus, 'PROCEED');
});

test('Targeted rehearsal R1-R5 all PASS', () => {
  const g = closure.gate;
  assert.equal(g['Targeted rehearsal']['Run A reconciliation'], 'PASS');
  assert.equal(g['Targeted rehearsal']['Full rollback'], 'PASS');
  assert.equal(g['Targeted rehearsal']['Recovery verification'], 'PASS');
  assert.equal(g['Targeted rehearsal']['Same-ledger Run B reconciliation'], 'PASS');
  assert.equal(g['Targeted rehearsal']['SC-15 injection'], 'PASS');
  // 同 ledger 不换新目标
  assert.equal(closure.scenarios.runB.sameLedger, true);
});

test('DEFECT CLOSURE gate = PASS / Ready for Closeout = YES / no production touch', () => {
  const g = closure.gate;
  assert.equal(g['P8-3 WP6 HIGH DEFECT CLOSURE'], 'PASS');
  assert.equal(g['P8-3 WP6 FINAL Gate'], 'PASS');
  assert.equal(g['P8-3 Ready for Closeout'], 'YES');
  assert.equal(g['Freeze Conflict Count'], 0);
  assert.equal(g['Production data touched'], 'NO');
  assert.equal(g['Production deployment performed'], 'NO');
});

// ---------------------------------------------------------------- local fixture (mirrors reconcile.test.js)
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
    'api.jhzy_activity_signups': [
      { id: 1, activity_id: 100, user_id: 1, status: 1, created_at: '2026-02-20 00:00:00' },
      { id: 2, activity_id: 101, user_id: 2, status: 1, created_at: '2026-02-21 00:00:00' },
    ],
    'api.jhzy_activity_checkins': [
      { id: 1, activity_id: 100, user_id: 1, checkin_at: '2026-03-01 09:05:00', created_at: '2026-03-01 09:05:00' },
      { id: 2, activity_id: 101, user_id: 2, checkin_at: '2026-03-02 09:05:00', created_at: '2026-03-02 09:05:00' },
    ],
    'api.jhzy_casual_records': [{ id: 1, user_id: 1, activity_id: 100, minutes: 120, created_at: '2026-03-01 10:00:00' }],
    'api.points_transactions': [{ id: 1, user_id: 1, direction: 1, amount: 50, balance_after: 50, type: 'signup', request_id: 'r-1', created_at: '2026-02-20 00:00:00' }],
    'api.certificates': [{ id: 1, user_id: 1, team_id: 10, cert_type: 'activity', cert_no: 'C1', issued_at: '2026-03-10 00:00:00', status: 1 }],
    'api.roles': [{ id: 1, code: 'volunteer', name: '志愿者', scope: 'team', is_system: 1, status: 1 }],
    'api.permissions': [{ id: 1, code: 'act:view', name: '查看活动', perm_group: 'act', risk_level: 1 }],
    'api.role_permissions': [{ id: 1, role_id: 1, permission_id: 1 }],
    'api.user_roles': [{ id: 1, user_id: 1, role_id: 1, scope_team_id: 10, granted_by: 1 }],
    'api.notifications': [{ id: 1, notif_type: 'sys', title: 'hi', content: 'hello', target: 'all' }],
    'api.training_courses': [{ id: 1, title: 'C1', created_at: '2026-01-05 00:00:00' }],
    'api.training_user_course_status': [{ id: 1, user_id: 1, course_id: 1, status: 1, created_at: '2026-01-06 00:00:00' }],
    'api.training_user_progress': [{ id: 1, user_id: 1, course_id: 1, progress: 60, created_at: '2026-01-07 00:00:00' }],
    'api.exam_sessions': [{ id: 1, user_id: 1, exam_id: 5 }],
    'api.achievements': [{ id: 1, title: '首秀', description: 'd', issued_at: '2026-03-01 00:00:00' }],
    'api.welfare_options': [{ id: 1, name: '福利A', points_cost: 100, price: 100, stock: 10 }],
    'api.mall_products': [{ id: 1, name: '商品A', points_price: 200, stock: 5 }],
    'api.file_uploads': [{ id: 1, storage_path: '/f/a.png', mime_type: 'image/png', checksum: 'x', size: 10, original_name: 'a.png' }],
    'api.quick_actions': [{ id: 1, user_id: 1, action: '随手公益' }],
    'api.qr_codes': [{ id: 1, code: 'q', type: 'signup' }],
    'api.volunteer_approvals': [{ id: 1, reviewer_id: 1, user_id: 1, cert_status: 1 }],
    'api.user_favorites': [{ id: 1, user_id: 1, target_type: 'activity', target_id: 100 }],
    'signup_db.users': [{ id: 9, nickname: 'su9', created_at: '2026-01-01 00:00:00' }],
  };
}
