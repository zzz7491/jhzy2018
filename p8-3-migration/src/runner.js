// Migration runner: orchestrates B0-B20 ETL with idempotency / resume / failure isolation /
// batch-awareness / dry-run / deterministic logging / legacy_id_maps + migration_issues.
import { applyTransform } from './transforms.js';
import { BATCHES, tablesForBatch } from './batches.js';
import { TABLE_MAP, EXCLUSIONS, sourceSystemOf } from './tablemap.js';
import { createLogger } from './logger.js';
import { makeRng, makeUlid } from './ulid.js';

function getLegacyId(row) {
  if (row.id != null) return String(row.id);
  if (row.user_id != null) return `u:${row.user_id}`;
  return 'h:' + JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
}

// opts: { dryRun, batch (single), seed, now, logger, checkpoint, sourceSystemFallback }
export async function runMigration({ source, target, opts = {} } = {}) {
  const dryRun = !!opts.dryRun;
  const singleBatch = opts.batch || null;
  const now = opts.now ?? Date.now();
  const rng = makeRng(opts.seed ?? 1);
  // run_id: stable identity of ONE migration execution. Scoped to this run so that migration_issues
  // can be filtered per-run during reconciliation (DEFECT-WP6-01). Explicit runId wins; otherwise a
  // deterministic ULID derived from the same rng/now is used (ad-hoc callers never filter by runId).
  const runId = opts.runId ?? makeUlid({ time: now, rng });
  const logger = opts.logger ?? createLogger({ sink: [], now: () => now });
  const checkpoint = opts.checkpoint ?? null;
  const idMap = opts.idMap ?? { record: (r) => target.writeIdMap(r), lookup: (s, t, l) => target.lookupIdMap(s, t, l) };
  const issues = opts.issues ?? { record: (r) => target.writeIssue(r) };

  const stats = {
    inserted: 0,
    archived: 0,
    dropped: 0,
    skippedIdempotent: 0,
    errors: 0,
    issues: 0,
    tablesProcessed: 0,
  };

  logger.info('migration_start', { dryRun, batches: BATCHES.length });

  // 1) Record EXCLUSIONS explicitly (user_favorites must never be migrated/dropped/auto-archived).
  for (const ex of EXCLUSIONS) {
    const [db, table] = ex.split('.');
    const ss = sourceSystemOf(ex);
    await issues.record({
      run_id: runId,
      batch: 'B0',
      source_object: ex,
      source_id: null,
      issue_type: 'excluded',
      severity: 'info',
      reason: 'REMAIN UNKNOWN / BCR pending — explicitly excluded: not migrated, not dropped, not auto-archived, not guessed. Awaiting BCR result.',
      resolution_status: 'excluded',
      evidence: 'P8-3 WP2 §3 / P8-3 Definition Freeze',
    });
    stats.issues++;
    logger.warn('excluded_object', { source: ex, system: ss });
  }

  const cp = checkpoint ? await checkpoint.load() : {};
  const doneTables = new Set(cp.doneTables || []);

  // 2) Iterate batches.
  for (const batch of BATCHES) {
    if (singleBatch && batch !== singleBatch) continue;
    const tables = tablesForBatch(TABLE_MAP, batch).filter((k) => !EXCLUSIONS.includes(k));
    if (tables.length === 0) {
      logger.debug('batch_empty', { batch });
      continue;
    }
    logger.info('batch_start', { batch, tables: tables.length });
    for (const srcKey of tables) {
      if (doneTables.has(srcKey)) {
        logger.debug('table_skip_resume', { srcKey });
        continue;
      }
      const spec = TABLE_MAP[srcKey];
      const sourceSystem = sourceSystemOf(srcKey);
      const sourceTable = srcKey.split('.').slice(1).join('.');
      const ctx = { makeUlid: (o) => makeUlid({ ...o, rng }), sourceSystem, sourceTable, now, batch, publicId: false };

      try {
        let rowCount = 0;
        for await (const row of source.streamRows(srcKey)) {
          rowCount++;
          const legacyId = getLegacyId(row);
          if (spec.kind === 'ARCHIVE') {
            if (!dryRun) await target.archive(sourceSystem, sourceTable, legacyId, row);
            stats.archived++;
            continue;
          }
          if (spec.kind === 'DROP') {
            await issues.record({
              run_id: runId,
              batch,
              source_object: srcKey,
              source_id: legacyId,
              issue_type: 'dropped',
              severity: 'info',
              reason: `DROP / DO NOT MIGRATE (${spec.note || ''})`,
              resolution_status: 'resolved',
              evidence: 'P8-3 WP2 §2',
            });
            stats.issues++;
            stats.dropped++;
            continue;
          }
          // MIGRATE / TRANSFORM / MERGE -> idempotency check
          const existing = await idMap.lookup(sourceSystem, sourceTable, legacyId);
          if (existing) {
            stats.skippedIdempotent++;
            logger.debug('idempotent_skip', { srcKey, legacyId });
            continue;
          }
          let out;
          try {
            out = applyTransform(spec, row, ctx);
          } catch (e) {
            stats.errors++;
            await issues.record({
              run_id: runId,
              batch,
              source_object: srcKey,
              source_id: legacyId,
              issue_type: 'dirty',
              severity: 'error',
              reason: `transform failed: ${e.message}`,
              resolution_status: 'open',
              evidence: e.stack?.split('\n')[0] || '',
            });
            stats.issues++;
            logger.error('transform_error', { srcKey, legacyId, error: e.message });
            continue; // failure isolation
          }
          const outs = Array.isArray(out) ? out : out ? [out] : [];
          for (let i = 0; i < outs.length; i++) {
            const { table, row: trow } = outs[i];
            if (dryRun) {
              logger.info('dry_run_insert', { target: table, srcKey, legacyId });
            } else {
              const res = await target.insert(table, trow);
              // Record legacy_id_maps for the primary (first) emitted target row only.
              if (i === 0) {
                await idMap.record({
                  source_system: sourceSystem,
                  source_table: sourceTable,
                  legacy_id: legacyId,
                  target_table: table,
                  target_id: res?.id ?? null,
                  migration_batch: batch,
                  migrated_at: now,
                });
              }
              stats.inserted++;
            }
          }
        }
        logger.info('table_done', { srcKey, rows: rowCount, kind: spec.kind });
        stats.tablesProcessed++;
        doneTables.add(srcKey);
        if (checkpoint) await checkpoint.save({ doneTables: [...doneTables], lastBatch: batch });
      } catch (e) {
        stats.errors++;
        await issues.record({
          run_id: runId,
          batch,
          source_object: srcKey,
          source_id: null,
          issue_type: 'conflict',
          severity: 'error',
          reason: `batch stream failed: ${e.message}`,
          resolution_status: 'open',
          evidence: e.stack?.split('\n')[0] || '',
        });
        stats.issues++;
        logger.error('batch_error', { srcKey, error: e.message });
        // failure isolation: continue to next table
      }
    }
  }

  logger.info('migration_end', { ...stats, dryRun, runId });
  return { stats, logger, runId };
}
