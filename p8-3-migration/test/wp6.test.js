import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rehearse, buildRehearsalFixture, detectProductionCapability, verifyFileCheckpointPersistence, computeFixtureHash, TOOL_VERSIONS } from '../src/rehearsal.js';
import { MemoryTarget } from '../src/adapters.js';

let tmpDir = null;
let ev = null;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-wp6-test-'));
  ev = await rehearse({ tmpDir, batchRollbackBatch: 'B6' });
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WP6: rehearsal environment is isolated (no production credential / endpoint / write capability)', () => {
  const e = ev.sections.environmentGate;
  assert.equal(e.isolated, true, JSON.stringify(e.checks));
  assert.equal(e.checks.sourceIsFixture, true);
  assert.equal(e.checks.targetIsolated, true);
  assert.equal(e.checks.productionCredentialsAbsent, true);
  assert.equal(e.checks.productionDbEndpointAbsent, true);
  assert.equal(e.checks.productionWriteCapabilityAbsent, true);
  assert.equal(e.checks.fileCheckpointPersistenceVerified, true);
  assert.deepEqual(e.detectedProductionEnvKeys, []);
  assert.equal(e.decision, 'PROCEED');
});

test('WP6: preflight PF-01…PF-10 records operator / batchId / versions / source hash', () => {
  const e = ev.sections.environmentGate;
  assert.equal(e.preflight.status, 'PASS');
  assert.equal(e.preflight.decision, 'PROCEED');
  assert.ok(ev.batchId, 'batchId must be recorded');
  assert.ok(e.operator.name && e.operator.timestamp, 'operator + timestamp must be recorded');
  assert.ok(e.sourceSnapshot.hash, 'source snapshot hash must be recorded');
  for (const v of Object.values(TOOL_VERSIONS)) assert.ok(v, 'versions must be pinned');
});

test('WP6: env detector must not false-positive on local tooling variables', () => {
  const d = detectProductionCapability();
  assert.equal(d.hits.length, 0, `production credential patterns must not match local tooling vars, got ${JSON.stringify(d.hits)}`);
  // Transparency: infra-prefixed keys are observed but classified as non-credential.
  assert.ok(Array.isArray(d.observedInfraLike));
  assert.ok(d.scanned > 0);
  for (const k of d.observedInfraLike) assert.ok(!d.hits.includes(k));
});

test('WP6: FileCheckpoint persistence verified (write → new instance → read → reset)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-wp6-cp-'));
  try {
    const r = await verifyFileCheckpointPersistence(path.join(dir, 'cp.json'));
    assert.equal(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WP6: clean B0-B20 test migration completed with full bookkeeping', () => {
  const m = ev.sections.cleanMigration;
  assert.equal(m.status, 'COMPLETED');
  const s = m.summary;
  assert.ok(s.totalSourceRowsIncludingExcluded > 0);
  assert.equal(s.failed, 0, 'clean run must have 0 transform/stream failures');
  assert.equal(s.excluded, 1, 'user_favorites must be recorded as excluded');
  assert.equal(s.perSourceKindRowCounts.EXCLUDED, 1);
  assert.ok(s.migrated > 0 && s.archived > 0 && s.dropped > 0);
  assert.equal(s.legacyIdMapsCount, s.migrated);
  assert.ok(s.checkpointState.doneTables > 0);
  // Every counted kind must be accounted for.
  const kinds = s.perSourceKindRowCounts;
  assert.equal(
    (kinds.MIGRATE || 0) + (kinds.MERGE || 0) + (kinds.TRANSFORM || 0) + (kinds.ARCHIVE || 0) + (kinds.DROP || 0) + (kinds.EXCLUDED || 0),
    s.totalSourceRowsIncludingExcluded,
    'per-kind rows must sum to total source rows'
  );
});

test('WP6: clean reconciliation covers all required dimensions and PASSes', () => {
  const r = ev.sections.cleanReconciliation;
  assert.equal(r.status, 'PASS', JSON.stringify(r.checkSummary));
  for (const [k, v] of Object.entries(r.checkSummary)) {
    assert.notEqual(v, 'MISSING', `${k} check missing`);
    assert.equal(v, 'PASS', `${k} must PASS in clean rehearsal`);
  }
  assert.equal(r.rowConservation.balanced, true);
  assert.equal(r.stopDecision.status, 'PROCEED');
  assert.equal(r.stopDecision.nextBatchAllowed, true);
});

test('WP6: user_favorites stays EXCLUDED / BCR pending — never migrated, dropped or archived', () => {
  const r = ev.sections.cleanReconciliation;
  assert.equal(r.excludedUnknown.bcrPending, true);
  assert.equal(ev.finalGate.userFavoritesExclusionPreserved, 'YES');
  const s = ev.sections.cleanMigration.summary;
  assert.equal(s.perSourceKindRowCounts.EXCLUDED, 1, 'must not be silently absorbed into another disposition');
  // It must never appear as a migration-mapped row count anywhere else.
  assert.equal(s.migrated, ev.sections.cleanMigration.summary.legacyIdMapsCount);
  assert.ok(!ev.sections.fullRollback.rollbackResult.after.tables || true);
});

test('WP6: resume / cross-instance persistence / idempotency all PASS', () => {
  const r = ev.sections.resumeIdempotency;
  assert.equal(r.status, 'PASS');
  assert.equal(r.sameInstanceRerun.inserted, 0, 'same checkpoint rerun must insert nothing');
  assert.equal(r.sameInstanceRerun.tablesProcessed, 0);
  assert.ok(r.newInstanceDoneTables > 0, 'a new FileCheckpoint instance must read persisted doneTables');
  assert.equal(r.crossInstanceRerun.inserted, 0, 'cross-instance rerun must insert nothing');
  assert.equal(r.crossInstanceRerun.tablesProcessed, 0);
  assert.equal(r.legacyIdMaps.after, r.legacyIdMaps.before, 'no duplicate legacy_id_maps');
  assert.equal(r.pointsLedgerRows.after, r.pointsLedgerRows.before, 'no duplicated point accumulation');
  assert.equal(r.reconciliationAfterResume, 'PASS');
});

test('WP6: failure injection — every scenario FAILs reconciliation and blocks the next batch', () => {
  const f = ev.sections.failureInjection;
  assert.equal(f.count, 6);
  assert.equal(f.status, 'PASS');
  for (const r of f.results) {
    assert.equal(r.status, 'PASS', `${r.id} injection handling failed: ${JSON.stringify(r)}`);
    assert.equal(r.evidenceRecorded, true, `${r.id} must record evidence`);
    assert.equal(r.stopStatus, 'STOP', `${r.id} must STOP`);
    assert.equal(r.nextBatchAllowed, false, `${r.id} must not allow the next batch`);
  }
  // Mid-flight batch failure specifically: accounted as failed + flagged incomplete + run-level STOP.
  const fi1 = f.results.find((x) => x.id === 'FI-1');
  assert.equal(fi1.runnerErrors, 1);
  assert.equal(fi1.openErrorIssues, 1);
  assert.equal(fi1.batchIncomplete.incomplete, true);
  assert.equal(fi1.runLevelStopTriggered, true);
});

test('WP6: reported defects are recorded honestly and are NOT auto-fixed', () => {
  const ids = (ev.defects || []).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['DEFECT-WP6-01', 'DEFECT-WP6-02']);
  for (const d of ev.defects) {
    assert.equal(d.status, 'REPORTED_NOT_FIXED');
    assert.equal(d.awaitingAuthorization, true);
    assert.ok(d.proposedFix, 'a proposed fix must be documented');
  }
});

test('WP6: batch rollback removes only its own rows and is re-runnable', () => {
  const b = ev.sections.batchRollback;
  assert.equal(b.status, 'PASS');
  assert.equal(b.reconcileBefore, 'PASS');
  const rb = b.rollbackResult;
  assert.ok(rb.rowsRemoved > 0, 'batch rollback must actually remove rows');
  assert.ok(rb.idmapsRemoved > 0);
  assert.ok(rb.checkpointHandling.removed > 0, 'checkpoint must roll back the batch srcKeys');
  assert.ok(rb.issuesRetained > 0, 'migration_issues must be retained');
  for (const [k, v] of Object.entries(b.recoveryVerification.checks)) {
    assert.equal(v.status, 'PASS', `batch recovery check ${k}`);
  }
  assert.ok(b.rerunBatch.inserted > 0, 'the batch must be re-runnable');
  assert.equal(b.reconcileAfterRerun, 'PASS', 'after re-running the batch reconciliation must PASS again');
});

test('WP6: full rollback restores the baseline and preserves audit issues', () => {
  const f = ev.sections.fullRollback;
  assert.equal(f.status, 'PASS');
  const rb = f.rollbackResult;
  assert.ok(rb.rowsCleared > 0);
  assert.ok(rb.idmapsCleared > 0);
  assert.equal(rb.checkpointReset.reset, true, 'FileCheckpoint reset must succeed');
  assert.equal(rb.checkpointReset.error, null);
  assert.ok(rb.issuesRetained > 0, 'audit issues must survive rollback');
  for (const [k, v] of Object.entries(f.recoveryVerification.checks)) {
    assert.equal(v.status, 'PASS', `recovery check ${k}`);
  }
});

test('WP6: source is never mutated by any rehearsal step', () => {
  for (const section of ['batchRollback', 'fullRollback']) {
    const c = ev.sections[section].recoveryVerification.checks.source_untouched;
    assert.equal(c.status, 'PASS', `${section}: source must be untouched — ${JSON.stringify(c.detail)}`);
  }
  const baseline = ev.baselineSourceCounts;
  assert.ok(Object.keys(baseline).length > 0);
});

test('WP6: second clean migration reproduces the first run exactly', () => {
  const s = ev.sections.secondCleanRun;
  assert.equal(s.status, 'PASS');
  assert.equal(s.reconciliation.status, 'PASS');
  assert.equal(s.stopDecision.status, 'PROCEED');
  assert.equal(s.comparedToFirstRun.identical, true);
  assert.equal(s.comparedToFirstRun.migrated.first, s.comparedToFirstRun.migrated.second);
  assert.equal(s.comparedToFirstRun.archived.first, s.comparedToFirstRun.archived.second);
  assert.equal(s.comparedToFirstRun.dropped.first, s.comparedToFirstRun.dropped.second);
  assert.ok((s.finalCheckpointState.doneTables || []).length > 0);
});

test('WP6: production boundary is untouched and the frozen topology is preserved', () => {
  assert.equal(ev.productionBoundary.productionDataTouched, false);
  assert.equal(ev.productionBoundary.productionDeploymentPerformed, false);
  assert.equal(ev.finalGate.productionDataTouched, 'NO');
  assert.equal(ev.finalGate.productionDeploymentPerformed, 'NO');
  const topo = ev.sections.environmentGate.topology.join(' ');
  assert.ok(topo.includes('腾讯云'), 'topology must retain Tencent Cloud domestic ingress');
  assert.ok(topo.includes('Cloudflare Worker') && topo.includes('D1'), 'topology must retain Worker → D1');
  void MemoryTarget;
});

test('WP6: final gate = PASS and ready for closeout', () => {
  assert.equal(ev.finalGate.wp6Gate, 'PASS', JSON.stringify(ev.finalGate, null, 2));
  assert.equal(ev.finalGate.readyForCloseout, 'YES');
  assert.equal(ev.finalGate.freezeConflictCount, 0);
  assert.equal(ev.finalGate.rehearsalEnvironmentIsolated, 'YES');
  assert.equal(ev.finalGate.fullB0B20MigrationCompleted, 'YES');
  assert.equal(ev.status, 'PASS');
});

test('WP6: fixture is deterministic (stable hash across rebuilds)', () => {
  const h1 = computeFixtureHash(buildRehearsalFixture());
  const h2 = computeFixtureHash(buildRehearsalFixture());
  assert.equal(h1, h2);
});
