// WP5 — Rollback executors (CLASS_1_BATCH / CLASS_2_FULL_TEST).
// 只在 test / MemoryTarget 环境执行；CLASS_3（未来生产切换回滚）= DESIGN_ONLY，不在此实现。
// 铁律：migration_issues 永远保留（审计证据），回滚只新增 rollback 记录，不删除既有 issue。

import { tablesForBatch } from './batches.js';
import { TABLE_MAP } from './tablemap.js';

// ---- helpers ----
export function snapshotTargetCounts(target) {
  const counts = {};
  if (target.tables instanceof Map) {
    for (const [name, t] of target.tables) counts[name] = Array.isArray(t?.rows) ? t.rows.length : 0;
  }
  return {
    tables: counts,
    idmaps: Array.isArray(target.idmaps) ? target.idmaps.length : (target.allIdMaps?.().length ?? 0),
    issues: Array.isArray(target.issues) ? target.issues.length : (target.allIssues?.().length ?? 0),
    archive: Array.isArray(target.archiveStore) ? target.archiveStore.length : (target.allArchive?.().length ?? 0),
  };
}

async function deleteRowsById(target, table, idSet) {
  if (typeof target.deleteRows === 'function') return target.deleteRows(table, [...idSet]);
  const t = target.tables?.get(table);
  if (t && Array.isArray(t.rows)) {
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => !idSet.has(String(r.id)));
    return before - t.rows.length;
  }
  return 0;
}

function removeFromArray(arr, predicate) {
  if (!Array.isArray(arr)) return 0;
  let removed = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) {
      arr.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

async function resetCheckpoint(checkpoint) {
  if (!checkpoint) return { reset: false, error: null, skipped: true };
  try {
    await checkpoint.reset();
    return { reset: true, error: null, skipped: false };
  } catch (e) {
    // 不得静默吞错：回滚必须知道 checkpoint 是否真的被清掉。
    return { reset: false, error: e?.message ?? String(e), skipped: false };
  }
}

// ---------------------------------------------------------------- CLASS 1: Batch rollback
// 回滚单个批次写入的目标行；其余批次保持不动。
export async function rollbackBatch({ target, checkpoint = null, batch, opts = {} } = {}) {
  if (!batch) throw new Error('rollbackBatch: batch 必填');
  const srcKeys = tablesForBatch(TABLE_MAP, batch);
  const bareTables = new Set(srcKeys.map((k) => k.split('.').slice(1).join('.')));

  const idmaps = target.allIdMaps?.() ?? [];
  const mine = idmaps.filter((m) => m.migration_batch === batch);

  // 1) 收集待删目标行（按 legacy_id_maps 定位，保证只删本批写入的行）
  const byTable = new Map();
  for (const m of mine) {
    if (!m.target_table || m.target_id == null) continue;
    if (!byTable.has(m.target_table)) byTable.set(m.target_table, new Set());
    byTable.get(m.target_table).add(String(m.target_id));
  }

  // 2) 删除目标行
  let rowsRemoved = 0;
  const rowsRemovedByTable = {};
  for (const [table, idSet] of byTable) {
    const n = await deleteRowsById(target, table, idSet);
    rowsRemoved += n;
    rowsRemovedByTable[table] = n;
  }

  // 3) 删除本批 legacy_id_maps
  const idmapsRemoved = removeFromArray(target.idmaps, (m) => m.migration_batch === batch);

  // 4) 删除本批产生的 migration_archive 冷存条目
  const archiveRemoved = removeFromArray(target.archiveStore, (a) => bareTables.has(String(a.source_table)));

  // 5) checkpoint：移除本批代表 srcKey，使本批可重跑
  let checkpointHandling = { removed: 0, error: null };
  if (checkpoint) {
    try {
      const state = (await checkpoint.load()) || {};
      const done = new Set(state.doneTables || []);
      let removed = 0;
      for (const k of srcKeys) if (done.delete(k)) removed++;
      await checkpoint.save({ ...state, doneTables: [...done] });
      checkpointHandling = { removed, error: null };
    } catch (e) {
      checkpointHandling = { removed: 0, error: e?.message ?? String(e) };
    }
  }

  // 6) 记录回滚证据（migration_issues 只新增，不删除）
  const rec = {
    run_id: opts.runId ?? null,
    batch,
    source_object: `batch:${batch}`,
    source_id: null,
    issue_type: 'rollback',
    severity: 'info',
    reason: `CLASS_1_BATCH rollback：回滚批次 ${batch}（${srcKeys.length} 个源对象）`,
    resolution_status: 'rolled_back',
    evidence: JSON.stringify({ rowsRemoved, rowsRemovedByTable, idmapsRemoved, archiveRemoved, checkpointHandling }),
  };
  if (typeof target.writeIssue === 'function') await target.writeIssue(rec);

  return {
    class: 'CLASS_1_BATCH',
    batch,
    sourceObjects: srcKeys,
    rowsRemoved,
    rowsRemovedByTable,
    idmapsRemoved,
    archiveRemoved,
    checkpointHandling,
    issuesRetained: (target.allIssues?.() ?? []).length,
    issue: rec,
  };
}

// ---------------------------------------------------------------- CLASS 2: Full test rollback
// 清空测试目标全部迁移产物，回到迁移前基线。保留 migration_issues。
export async function rollbackFull({ target, checkpoint = null, opts = {} } = {}) {
  const before = snapshotTargetCounts(target);

  // 1) 清空业务表行
  let rowsCleared = 0;
  if (target.tables instanceof Map) {
    for (const [, t] of target.tables) {
      if (Array.isArray(t?.rows)) {
        rowsCleared += t.rows.length;
        t.rows.length = 0;
      }
    }
  } else if (typeof target.reset === 'function') {
    await target.reset({ keepIssues: true });
  }

  // 2) 清空 legacy_id_maps / migration_archive（issues 保留）
  const idmapsCleared = removeFromArray(target.idmaps, () => true);
  const archiveCleared = removeFromArray(target.archiveStore, () => true);

  // 3) checkpoint reset
  const checkpointReset = await resetCheckpoint(checkpoint);

  // 4) 记录回滚证据
  const rec = {
    run_id: opts.runId ?? null,
    batch: 'ALL',
    source_object: 'target:full',
    source_id: null,
    issue_type: 'rollback',
    severity: 'info',
    reason: 'CLASS_2_FULL_TEST rollback：清空测试目标全部迁移产物，回到迁移前基线',
    resolution_status: 'rolled_back',
    evidence: JSON.stringify({ before, rowsCleared, idmapsCleared, archiveCleared, checkpointReset }),
  };
  if (typeof target.writeIssue === 'function') await target.writeIssue(rec);

  const after = snapshotTargetCounts(target);
  return {
    class: 'CLASS_2_FULL_TEST',
    before,
    after,
    rowsCleared,
    idmapsCleared,
    archiveCleared,
    checkpointReset,
    issuesRetained: after.issues,
    issue: rec,
  };
}

// ---------------------------------------------------------------- CLASS 3: production (design only)
export const PRODUCTION_ROLLBACK_DESIGN_ONLY = {
  class: 'CLASS_3_FUTURE_PRODUCTION',
  executable: false,
  reason: '生产正式切换属 P8-3 OUT OF SCOPE；WP5 只设计原则，不提供执行器。',
  principles: [
    '达到 rollback trigger 即回滚，不在生产现场调试。',
    '回滚恢复到切换前生产状态：腾讯云入口回指 1.0，D1 未确认前不作为对外权威源。',
    'D1 侧依赖切换前快照/时间点恢复，不做逐行 DELETE。',
    'legacy_id_maps / migration_issues 全量保留作为审计证据。',
    '回滚后执行 Recovery Verification 并留存 Operator Evidence Record。',
  ],
};
