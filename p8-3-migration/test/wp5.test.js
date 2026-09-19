import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigration } from '../src/runner.js';
import { FixtureSource, MemoryTarget } from '../src/adapters.js';
import { MemoryCheckpoint } from '../src/checkpoint.js';
import { reconcile } from '../src/reconcile.js';
import {
  PREFLIGHT,
  runPreflight,
  STOP_CONDITIONS,
  evaluateStopConditions,
  currentRunOpenErrorIssues,
  BATCH_RUNBOOK,
  ROLLBACK_PLAN,
  OPERATOR_CHECKLIST,
  WP6_REHEARSAL_CONTRACT,
  TARGET_TOPOLOGY,
  PRODUCTION_BOUNDARY,
  buildEvidenceRecord,
} from '../src/runbook.js';
import { rollbackBatch, rollbackFull, PRODUCTION_ROLLBACK_DESIGN_ONLY } from '../src/rollback.js';
import { verifyRecovery, computeSourceCounts } from '../src/recovery.js';
import { BATCHES } from '../src/batches.js';

// ---------------------------------------------------------------- fixtures
function buildFixture() {
  return {
    'api.users': [
      { id: 1, nickname: 'u1', created_at: '2026-01-01 00:00:00', last_login_at: '2026-02-01 00:00:00' },
      { id: 2, nickname: 'u2', created_at: '2026-01-01 00:00:00' },
    ],
    'api.activities': [
      { id: 100, team_id: 1, title: 'A1', start_time: '2026-03-01 09:00:00', end_time: '2026-03-01 11:00:00', created_at: '2026-02-01 00:00:00' },
    ],
    'api.activity_signups': [
      { id: 1, activity_id: 100, user_id: 1, status: 1, created_at: '2026-02-20 00:00:00' },
    ],
    'api.quick_actions': [
      { id: 1, action_type: 'pickup', title: '随手捡', created_at: '2026-05-01 00:00:00' },
    ],
    'api.qr_codes': [{ id: 1, code: 'abc' }],
    // EXCLUDED（BCR pending）：必须永不迁移 / 不 DROP / 不自动归档
    'api.user_favorites': [{ id: 9, user_id: 1, target_type: 'activity', target_id: 100 }],
  };
}

function newSource(fixture = buildFixture()) {
  return new FixtureSource(fixture);
}

const GOOD_CTX = {
  wpGates: { WP1: 'PASS', WP2: 'PASS', WP3: 'PASS', WP4: 'PASS' },
  freezeConflict: 0,
  sourceDump: { complete: true, tableCount: 131 },
  sourceSnapshot: { hashVerified: true, hash: 'sha256:abc' },
  targetState: { known: true, environment: 'test-d1', clean: true },
  versions: { migration: 'wp3-1.0.0', reconciliation: 'wp4-1.0.0' },
  userFavorites: { excluded: true, bcrPending: true },
  rollbackPoint: { established: true, ref: 'restore-point-001' },
  operator: { name: 'mingmo', timestamp: '2026-09-18T23:00:00+08:00', batchId: 'B0-B20' },
  productionAccess: false,
};

// ---------------------------------------------------------------- A. Preflight
test('WP5: preflight 全部满足 → PASS / PROCEED', () => {
  const r = runPreflight(GOOD_CTX);
  assert.equal(r.status, 'PASS');
  assert.equal(r.decision, 'PROCEED');
  assert.equal(r.errors, 0);
  assert.equal(Object.keys(r.checks).length, PREFLIGHT.length);
});

test('WP5: preflight 关键项缺失 → FAIL / STOP（不得开始迁移）', () => {
  const ctx = { ...GOOD_CTX, freezeConflict: 1, rollbackPoint: { established: false } };
  const r = runPreflight(ctx);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.decision, 'STOP');
  assert.ok(r.errors >= 2, `期望至少 2 个 critical 失败，实际 ${r.errors}`);
  assert.equal(r.checks['PF-02'].status, 'FAIL');
  assert.equal(r.checks['PF-09'].status, 'FAIL');
});

test('WP5: preflight 覆盖用户要求的 10 项', () => {
  const ids = PREFLIGHT.map((p) => p.id);
  assert.deepEqual(ids, ['PF-01', 'PF-02', 'PF-03', 'PF-04', 'PF-05', 'PF-06', 'PF-07', 'PF-08', 'PF-09', 'PF-10']);
  assert.ok(PREFLIGHT.every((p) => p.critical === true), '全部 preflight 项为 critical');
});

// ---------------------------------------------------------------- D. STOP / Abort
test('WP5: STOP 条件命中 CRITICAL → STOP，且禁止继续下一 Batch', () => {
  const r = evaluateStopConditions({
    reconcileResult: {
      status: 'FAIL',
      checks: { row_conservation: { status: 'FAIL' }, identity_integrity: { status: 'FAIL' } },
    },
    ctx: GOOD_CTX,
  });
  assert.equal(r.status, 'STOP');
  assert.equal(r.nextBatchAllowed, false);
  assert.ok(r.criticals.some((c) => c.id === 'SC-01'));
  assert.ok(r.criticals.some((c) => c.id === 'SC-02'));
});

test('WP5: 无 CRITICAL → PROCEED（WARNING 不阻断）', () => {
  const r = evaluateStopConditions({
    reconcileResult: { status: 'PASS', checks: { media_references: { status: 'FAIL' } } },
    ctx: GOOD_CTX,
  });
  assert.equal(r.status, 'PROCEED');
  assert.equal(r.nextBatchAllowed, true);
  assert.ok(r.warnings.some((w) => w.id === 'SC-07'));
  assert.equal(r.criticals.length, 0);
});

test('WP5: STOP 条件覆盖 15 项（含 SC-15 open migration error / incomplete batch）', () => {
  const ids = STOP_CONDITIONS.map((s) => s.id);
  assert.deepEqual(ids, ['SC-01', 'SC-02', 'SC-03', 'SC-04', 'SC-05', 'SC-06', 'SC-07', 'SC-08', 'SC-09', 'SC-10', 'SC-11', 'SC-12', 'SC-13', 'SC-14', 'SC-15']);
  const r = evaluateStopConditions({ ctx: { ...GOOD_CTX, productionAccess: true } });
  assert.equal(r.status, 'STOP');
  assert.ok(r.criticals.some((c) => c.id === 'SC-14'));
});

// ---------------------------------------------------------------- D+. SC-15 (DEFECT-WP6-02)
test('WP5: SC-15 — current-run open error migration issue → STOP / nextBatchAllowed=false', () => {
  const ctx = {
    ...GOOD_CTX,
    openErrorIssues: [{ run_id: 'run-X', severity: 'error', resolution_status: 'open' }],
    currentBatchIncomplete: false,
  };
  const r = evaluateStopConditions({ reconcileResult: { status: 'PASS', checks: {} }, ctx });
  assert.equal(r.status, 'STOP');
  assert.equal(r.nextBatchAllowed, false);
  assert.ok(r.criticals.some((c) => c.id === 'SC-15'));
  assert.equal(r.criticals[0].severity, 'CRITICAL');
});

test('WP5: SC-15 — incomplete current batch → STOP / nextBatchAllowed=false', () => {
  const ctx = { ...GOOD_CTX, openErrorIssues: [], currentBatchIncomplete: true };
  const r = evaluateStopConditions({ reconcileResult: { status: 'PASS', checks: {} }, ctx });
  assert.equal(r.status, 'STOP');
  assert.equal(r.nextBatchAllowed, false);
  assert.ok(r.criticals.some((c) => c.id === 'SC-15'));
});

test('WP5: SC-15 — resolved/closed historical error does NOT trigger current run STOP', () => {
  const ctx = {
    ...GOOD_CTX,
    openErrorIssues: [{ run_id: 'run-old', severity: 'error', resolution_status: 'resolved' }],
    currentBatchIncomplete: false,
  };
  const r = evaluateStopConditions({ reconcileResult: { status: 'PASS', checks: {} }, ctx });
  assert.equal(r.status, 'PROCEED', 'resolved historical error must not STOP');
  assert.equal(r.criticals.some((c) => c.id === 'SC-15'), false);
});

test('WP5: SC-15 — previous run open error does NOT pollute a new run (run_id scoping)', () => {
  const ctx = {
    ...GOOD_CTX,
    // 当前 run 作用域的 open errors 为空（历史 run 的 open error 未被传入）
    openErrorIssues: [],
    currentBatchIncomplete: false,
  };
  const r = evaluateStopConditions({ reconcileResult: { status: 'PASS', checks: {} }, ctx });
  assert.equal(r.status, 'PROCEED');
  assert.equal(r.criticals.some((c) => c.id === 'SC-15'), false);
});

test('WP5: currentRunOpenErrorIssues helper scopes by run_id', () => {
  const target = new MemoryTarget();
  target.writeIssue({ run_id: 'A', severity: 'error', resolution_status: 'open', issue_type: 'conflict' });
  target.writeIssue({ run_id: 'B', severity: 'error', resolution_status: 'open', issue_type: 'conflict' });
  target.writeIssue({ run_id: 'A', severity: 'error', resolution_status: 'resolved', issue_type: 'conflict' });
  const a = currentRunOpenErrorIssues(target, 'A');
  const b = currentRunOpenErrorIssues(target, 'B');
  const all = currentRunOpenErrorIssues(target, null);
  assert.equal(a.length, 1, 'only run A open errors');
  assert.equal(b.length, 1, 'only run B open errors');
  assert.equal(all.length, 2, 'null run_id → all open errors');
});

// ---------------------------------------------------------------- B. Batch Runbook
test('WP5: B0–B20 批次 Runbook 完整（含 9 项必填字段）', () => {
  assert.deepEqual(Object.keys(BATCH_RUNBOOK), BATCHES);
  for (const b of BATCHES) {
    const rb = BATCH_RUNBOOK[b];
    for (const f of ['preconditions', 'input', 'procedure', 'checkpoint', 'reconciliation', 'passCriteria', 'failCriteria', 'rollbackBoundary', 'evidence']) {
      assert.ok(rb[f] != null, `${b} 缺少字段 ${f}`);
    }
    assert.equal(rb.rollbackBoundary.class, 'CLASS_1_BATCH');
  }
  // 不得重新设计批次：顺序必须与 BATCHES 一致
  assert.equal(BATCH_RUNBOOK.B5.input.sourceObjects.includes('api.activities'), true);
  assert.equal(BATCH_RUNBOOK.B20.name.includes('收尾'), true);
});

// ---------------------------------------------------------------- E. Rollback — CLASS 1
test('WP5: CLASS_1_BATCH 回滚只影响目标批次，issues 保留', async () => {
  const fixture = buildFixture();
  const source = newSource(fixture);
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  await runMigration({ source, target, opts: { checkpoint: cp } });

  const before = { activities: target.count('activities'), idmaps: target.allIdMaps().length, issues: target.allIssues().length };
  assert.ok(before.activities > 0, '迁移后 activities 应有数据');

  const res = await rollbackBatch({ target, checkpoint: cp, batch: 'B5' });
  assert.equal(res.class, 'CLASS_1_BATCH');
  assert.equal(target.count('activities'), 0, 'B5 回滚后 activities 必须清空');
  assert.equal(target.allIdMaps().filter((m) => m.migration_batch === 'B5').length, 0, 'B5 的 legacy_id_maps 必须清除');
  assert.ok(target.allIdMaps().length > 0, '其它批次的 legacy_id_maps 必须保留');
  assert.ok(target.count('users') > 0, '其它批次目标行必须保留');
  assert.ok(target.allIssues().length >= before.issues + 1, 'issues 只能增加（回滚记录），不得删除');
  assert.ok(target.allIssues().some((i) => i.issue_type === 'rollback'), '必须新增 rollback issue');
  assert.ok(res.checkpointHandling.removed > 0, 'checkpoint 必须移除 B5 代表 srcKey 以便重跑');
  const state = await cp.load();
  assert.equal((state.doneTables || []).includes('api.activities'), false);
});

// ---------------------------------------------------------------- E. Rollback — CLASS 2
test('WP5: CLASS_2_FULL_TEST 完整回滚 → 目标清空、issues 保留、checkpoint 重置', async () => {
  const fixture = buildFixture();
  const source = newSource(fixture);
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  await runMigration({ source, target, opts: { checkpoint: cp } });
  const issuesBefore = target.allIssues().length;
  assert.ok(issuesBefore > 0);

  const res = await rollbackFull({ target, checkpoint: cp });
  assert.equal(res.class, 'CLASS_2_FULL_TEST');
  assert.ok(res.rowsCleared > 0);
  assert.ok(res.idmapsCleared > 0);
  assert.equal(target.allIdMaps().length, 0);
  assert.equal(target.allArchive().length, 0);
  assert.equal(target.count('users'), 0);
  assert.equal(target.count('activities'), 0);
  assert.ok(target.allIssues().length >= issuesBefore, 'migration_issues 必须保留作为审计证据');
  assert.equal(res.checkpointReset.reset, true);
  const state = await cp.load();
  assert.deepEqual(state, {}, 'checkpoint 必须完全重置');
});

test('WP5: CLASS_3 未来生产回滚 = DESIGN_ONLY，不可执行', () => {
  assert.equal(ROLLBACK_PLAN.CLASS_3_FUTURE_PRODUCTION.executableInWP5, false);
  assert.equal(ROLLBACK_PLAN.CLASS_3_FUTURE_PRODUCTION.status, 'DESIGN_ONLY');
  assert.equal(PRODUCTION_ROLLBACK_DESIGN_ONLY.executable, false);
  assert.ok(ROLLBACK_PLAN.CLASS_3_FUTURE_PRODUCTION.principles.length >= 5);
  assert.equal(ROLLBACK_PLAN.CLASS_1_BATCH.executableInWP5, true);
  assert.equal(ROLLBACK_PLAN.CLASS_2_FULL_TEST.executableInWP5, true);
});

// ---------------------------------------------------------------- F. Recovery Verification
test('WP5: 完整回滚后 verifyRecovery → PASS', async () => {
  const fixture = buildFixture();
  const source = newSource(fixture);
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  const baseline = await computeSourceCounts(source, Object.keys(fixture));

  await runMigration({ source, target, opts: { checkpoint: cp } });
  await rollbackFull({ target, checkpoint: cp });

  const res = await verifyRecovery({ source, target, checkpoint: cp, baseline });
  assert.equal(res.status, 'PASS', JSON.stringify(res.checks));
  for (const k of [
    'target_state_restored',
    'source_untouched',
    'no_orphan_migration_rows',
    'no_stale_checkpoints',
    'no_invalid_legacy_id_maps',
    'no_unintended_user_favorites_migration',
    'reconciliation_state_valid',
  ]) {
    assert.ok(res.checks[k], `缺少校验项 ${k}`);
    assert.equal(res.checks[k].status, 'PASS', `${k} 未通过：${JSON.stringify(res.checks[k].detail)}`);
  }
});

test('WP5: 目标未清空时 verifyRecovery → FAIL（机器可判定）', async () => {
  const fixture = buildFixture();
  const source = newSource(fixture);
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  const baseline = await computeSourceCounts(source, Object.keys(fixture));
  await runMigration({ source, target, opts: { checkpoint: cp } });

  const res = await verifyRecovery({ source, target, checkpoint: cp, baseline });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.checks.target_state_restored.status, 'FAIL');
  assert.equal(res.checks.no_stale_checkpoints.status, 'FAIL');
});

test('WP5: 回滚后 user_favorites 仍保持 excluded / BCR pending', async () => {
  const fixture = buildFixture();
  const source = newSource(fixture);
  const target = new MemoryTarget();
  const cp = new MemoryCheckpoint();
  await runMigration({ source, target, opts: { checkpoint: cp } });
  await rollbackFull({ target, checkpoint: cp });

  const issues = target.allIssues();
  const favExcluded = issues.filter((i) => String(i.source_object).includes('user_favorites') && i.issue_type === 'excluded');
  assert.ok(favExcluded.length > 0, 'user_favorites exclusion 记录必须保留');
  assert.equal(favExcluded[0].resolution_status, 'excluded');
  assert.equal(target.allIdMaps().filter((m) => String(m.source_table).includes('user_favorites')).length, 0);
  // 回滚态下 reconcile 的 excluded_unknown 仍必须 PASS（未迁移/未 DROP/未归档）
  const rec = await reconcile({ source, target, opts: {} });
  assert.equal(rec.checks.excluded_unknown.status, 'PASS');
});

// ---------------------------------------------------------------- C. Cutover / topology
test('WP5: 正式生产拓扑被保留且腾讯云 MySQL 非权威库', () => {
  const joined = TARGET_TOPOLOGY.join(' | ');
  assert.ok(joined.includes('国内备案域名'));
  assert.ok(joined.includes('腾讯云国内服务器'));
  assert.ok(joined.includes('Cloudflare Worker'));
  assert.ok(joined.includes('Cloudflare D1（2.0 唯一权威业务数据库）'));
  assert.ok(joined.includes('R2 / KV'));
  for (const oos of ['生产正式迁移', '生产部署', '正式切换（域名/小程序）', '灰度放量']) {
    assert.ok(PRODUCTION_BOUNDARY.outOfScope.includes(oos), `OUT OF SCOPE 缺少 ${oos}`);
  }
  assert.equal(PRODUCTION_BOUNDARY.productionAccessAllowed, false);
});

// ---------------------------------------------------------------- G. Operator checklist
test('WP5: Operator Checklist 覆盖 7 阶段且 blocking 项可勾选', () => {
  const phases = OPERATOR_CHECKLIST.phases.map((p) => p.id);
  assert.deepEqual(phases, ['PRE-FLIGHT', 'MIGRATE', 'RECONCILE', 'DECISION', 'ROLLBACK / CONTINUE', 'EVIDENCE', 'CLOSEOUT']);
  const all = OPERATOR_CHECKLIST.phases.flatMap((p) => p.steps);
  assert.ok(all.length >= 20);
  assert.ok(all.every((s) => !!s.id && !!s.label && typeof s.blocking === 'boolean' && !!s.evidence));
  const ev = buildEvidenceRecord({ operator: { name: 'mingmo', timestamp: 'T' }, phase: 'CLOSEOUT', batchId: 'B20', result: 'PASS' });
  assert.equal(ev.productionBoundary.productionDataTouched, false);
  assert.equal(ev.userFavorites.migrated, false);
  assert.equal(ev.userFavorites.bcrPending, true);
});

// ---------------------------------------------------------------- H. WP6 Rehearsal Contract
test('WP5: WP6 演练契约已定义且 WP5 不执行演练', () => {
  assert.equal(WP6_REHEARSAL_CONTRACT.executedBy, 'WP6');
  assert.equal(WP6_REHEARSAL_CONTRACT.executedNow, false);
  const actions = WP6_REHEARSAL_CONTRACT.steps.map((s) => s.action);
  assert.deepEqual(actions, ['Test Migration', 'Reconciliation', 'Failure Injection', 'Rollback', 'Recovery Verification']);
  assert.ok(WP6_REHEARSAL_CONTRACT.entryGates.length >= 4);
  assert.ok(WP6_REHEARSAL_CONTRACT.exitEvidence.length >= 4);
});
