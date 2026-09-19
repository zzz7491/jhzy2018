// WP6 rehearsal runner: executes the rehearsal against an isolated temp target
// and writes the evidence package to p8-3-migration/evidence/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rehearse } from '../src/rehearsal.js';

const outDir = 'E:/D盘备份/miniprogram/p8-3-migration/evidence';
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p83-wp6-rehearsal-'));

const L = [];
const push = (...a) => L.push(a.join(' '));
const j = (v) => JSON.stringify(v, (k, x) => (k === 'evidence' ? undefined : x), 2);
const st = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v.status]));

try {
  const ev = await rehearse({ tmpDir, batchRollbackBatch: 'B6' });
  fs.writeFileSync(path.join(outDir, 'wp6-evidence.json'), JSON.stringify(ev, null, 2), 'utf8');
  const s = ev.sections || {};

  push('=== P8-3 WP6 REHEARSAL ===');
  push(`status=${ev.status} batchId=${ev.batchId}`);
  push(`sourceHash=${ev.sourceHash}`);
  push('');

  // 1
  push('[1 ENVIRONMENT GATE]');
  push('isolated=' + (s.environmentGate?.isolated ?? 'n/a'));
  push('checks=' + JSON.stringify(s.environmentGate?.checks ?? {}));
  push('preflight=' + JSON.stringify(s.environmentGate?.preflight ?? {}));
  push('envScan=' + JSON.stringify(s.environmentGate?.envScan ?? {}));
  push('detectedProductionEnvKeys=' + JSON.stringify(s.environmentGate?.detectedProductionEnvKeys ?? []));
  push('');

  if (ev.status === 'STOPPED') {
    push('!!! REHEARSAL STOPPED AT ENVIRONMENT GATE — later sections were not executed.');
    push(JSON.stringify(ev.finalGate, null, 2));
    fs.writeFileSync(path.join(outDir, 'wp6-summary.txt'), L.join('\n'), 'utf8');
    process.exit(0);
  }

  // 2
  push('[2 CLEAN TEST MIGRATION] ' + (s.cleanMigration?.status ?? 'n/a'));
  push(j(s.cleanMigration?.summary ?? {}));
  push('');

  // 3
  push('[3 RECONCILIATION] ' + (s.cleanReconciliation?.status ?? 'n/a'));
  push(j(s.cleanReconciliation?.checkSummary ?? {}));
  push('rowConservation=' + JSON.stringify(s.cleanReconciliation?.rowConservation ?? {}));
  push('stop=' + JSON.stringify(s.cleanReconciliation?.stopDecision ?? {}));
  push('');

  // 4
  push('[4 RESUME / IDEMPOTENCY] ' + (s.resumeIdempotency?.status ?? 'n/a'));
  push(j(s.resumeIdempotency ?? {}));
  push('');

  // 5
  push('[5 FAILURE INJECTION] ' + (s.failureInjection?.status ?? 'n/a') + ' count=' + (s.failureInjection?.count ?? 0));
  for (const row of s.failureInjection?.summary ?? []) push('  ' + JSON.stringify(row));
  for (const r of s.failureInjection?.results ?? []) {
    if (r.batchIncomplete) push(`    ${r.id} incomplete=${JSON.stringify(r.batchIncomplete)}`);
    push(`    ${r.id} runnerErrors=${r.runnerErrors} openErrorIssues=${r.openErrorIssues} runLevelStop=${r.runLevelStopTriggered} evidenceRecorded=${r.evidenceRecorded}`);
  }
  push('');

  // 6
  push('[6 BATCH ROLLBACK] ' + (s.batchRollback?.status ?? 'n/a') + ' batch=' + (s.batchRollback?.batch ?? 'n/a'));
  push('reconcileBefore=' + (s.batchRollback?.reconcileBefore ?? 'n/a'));
  push('rollback=' + JSON.stringify({
    rowsRemoved: s.batchRollback?.rollbackResult?.rowsRemoved,
    idmapsRemoved: s.batchRollback?.rollbackResult?.idmapsRemoved,
    archiveRemoved: s.batchRollback?.rollbackResult?.archiveRemoved,
    checkpointHandling: s.batchRollback?.rollbackResult?.checkpointHandling,
    issuesRetained: s.batchRollback?.rollbackResult?.issuesRetained,
  }));
  push('recoveryChecks=' + JSON.stringify(st(s.batchRollback?.recoveryVerification?.checks)));
  push('rerunBatch=' + JSON.stringify(s.batchRollback?.rerunBatch ?? {}));
  push('reconcileAfterRerun=' + (s.batchRollback?.reconcileAfterRerun ?? 'n/a'));
  push('');

  // 7
  push('[7 FULL ROLLBACK] ' + (s.fullRollback?.status ?? 'n/a'));
  push('reconcileBefore=' + (s.fullRollback?.reconcileBefore ?? 'n/a'));
  push('rollback=' + JSON.stringify({
    rowsCleared: s.fullRollback?.rollbackResult?.rowsCleared,
    idmapsCleared: s.fullRollback?.rollbackResult?.idmapsCleared,
    archiveCleared: s.fullRollback?.rollbackResult?.archiveCleared,
    checkpointReset: s.fullRollback?.rollbackResult?.checkpointReset,
    issuesRetained: s.fullRollback?.rollbackResult?.issuesRetained,
  }));
  push('recoveryChecks=' + JSON.stringify(st(s.fullRollback?.recoveryVerification?.checks)));
  push('');

  // 8
  push('[8 SECOND CLEAN RUN] ' + (s.secondCleanRun?.status ?? 'n/a'));
  push('reconcile=' + JSON.stringify(s.secondCleanRun?.reconciliation ?? {}));
  push('comparedToFirstRun=' + JSON.stringify(s.secondCleanRun?.comparedToFirstRun ?? {}));
  push('finalCheckpointDoneTables=' + ((s.secondCleanRun?.finalCheckpointState?.doneTables || []).length));
  push('');

  push('[FINAL GATE]');
  push(JSON.stringify(ev.finalGate, null, 2));

  fs.writeFileSync(path.join(outDir, 'wp6-summary.txt'), L.join('\n'), 'utf8');
} catch (e) {
  L.push('!!! REHEARSAL THREW !!!');
  L.push(e?.stack || String(e));
  fs.writeFileSync(path.join(outDir, 'wp6-summary.txt'), L.join('\n'), 'utf8');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
