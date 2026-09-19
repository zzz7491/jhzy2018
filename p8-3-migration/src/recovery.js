// WP5 — Recovery Verification（回滚后机器验证）。
// 回滚后必须能给出机器可判定的 PASS / FAIL：
//   target state restored / source untouched / no orphan migration rows /
//   no stale checkpoints / no invalid legacy_id_maps / no unintended user_favorites migration /
//   reconciliation state valid。

import { reconcile } from './reconcile.js';

const pass = (detail) => ({ status: 'PASS', errors: 0, warnings: 0, detail });
const fail = (detail) => ({ status: 'FAIL', errors: 1, warnings: 0, detail });
const warn = (detail) => ({ status: 'WARN', errors: 0, warnings: 1, detail });

export async function computeSourceCounts(source, keys) {
  const out = {};
  for (const k of keys) {
    let n = 0;
    if (typeof source.streamRows === 'function') {
      for await (const _ of source.streamRows(k)) n++;
    } else if (typeof source.count === 'function') {
      n = await source.count(k);
    }
    out[k] = n;
  }
  return out;
}

function targetTableCounts(target) {
  const counts = {};
  if (target.tables instanceof Map) {
    for (const [name, t] of target.tables) counts[name] = Array.isArray(t?.rows) ? t.rows.length : 0;
  }
  return counts;
}

export async function verifyRecovery({ source = null, target, checkpoint = null, baseline = null, opts = {} } = {}) {
  const checks = {};

  const tableCounts = targetTableCounts(target);
  const idmaps = target.allIdMaps?.() ?? [];
  const archive = target.allArchive?.() ?? [];
  const issues = target.allIssues?.() ?? [];

  // ---- 1. target state restored ----
  {
    const nonEmpty = Object.entries(tableCounts).filter(([, n]) => n > 0);
    // legacy_id_maps / migration_issues 属迁移支撑表：idmaps 必须清空，issues 必须保留（证据）
    checks.target_state_restored = nonEmpty.length === 0
      ? pass({ nonEmptyTables: [], note: '全部业务表行为 0' })
      : fail({ nonEmptyTables: nonEmpty.map(([t, n]) => `${t}=${n}`) });
  }

  // ---- 2. source untouched ----
  {
    if (!source || !baseline) {
      checks.source_untouched = warn({ reason: '未提供 source/baseline，跳过比对' });
    } else {
      const keys = Object.keys(baseline);
      const now = await computeSourceCounts(source, keys);
      const diffs = keys.filter((k) => now[k] !== baseline[k]).map((k) => `${k}: ${baseline[k]}→${now[k]}`);
      checks.source_untouched = diffs.length === 0
        ? pass({ compared: keys.length })
        : fail({ diffs, reason: '源数据与基线不一致（回滚不得触碰源库）' });
    }
  }

  // ---- 3. no orphan migration rows ----
  {
    const orphanIdmaps = idmaps.length;
    const orphanArchive = archive.length;
    checks.no_orphan_migration_rows = orphanIdmaps === 0 && orphanArchive === 0
      ? pass({ legacy_id_maps: 0, migration_archive: 0 })
      : fail({ legacy_id_maps: orphanIdmaps, migration_archive: orphanArchive, reason: '回滚后仍残留迁移行' });
  }

  // ---- 4. no stale checkpoints ----
  {
    if (!checkpoint) {
      checks.no_stale_checkpoints = warn({ reason: '未提供 checkpoint，跳过' });
    } else {
      let state = {};
      let err = null;
      try {
        state = (await checkpoint.load()) || {};
      } catch (e) {
        err = e?.message ?? String(e);
      }
      const done = (state.doneTables || []).length;
      const ok = !err && done === 0;
      checks.no_stale_checkpoints = ok
        ? pass({ doneTables: 0 })
        : fail({ doneTables: done, error: err, reason: 'checkpoint 未完全重置（残留进度会导致重跑被跳过）' });
    }
  }

  // ---- 5. no invalid legacy_id_maps ----
  {
    const invalid = idmaps.filter((m) => !m.target_table || m.target_id == null || m.legacy_id == null).length;
    checks.no_invalid_legacy_id_maps = idmaps.length === 0 && invalid === 0
      ? pass({ total: 0, invalid: 0 })
      : fail({ total: idmaps.length, invalid, reason: '回滚后仍存在 legacy_id_maps 记录' });
  }

  // ---- 6. no unintended user_favorites migration ----
  {
    const favMaps = idmaps.filter((m) => String(m.source_table).includes('user_favorites')).length;
    const favMigratedIssue = issues.filter(
      (i) => String(i.source_object || '').includes('user_favorites') && i.issue_type !== 'excluded' && i.issue_type !== 'rollback'
    ).length;
    const favExcluded = issues.filter((i) => String(i.source_object || '').includes('user_favorites') && i.issue_type === 'excluded').length;
    const ok = favMaps === 0 && favMigratedIssue === 0 && favExcluded > 0;
    checks.no_unintended_user_favorites_migration = ok
      ? pass({ favMaps: 0, favMigratedIssue: 0, favExcluded, bcrPending: true })
      : fail({ favMaps, favMigratedIssue, favExcluded, reason: 'user_favorites 被迁移或未保持 excluded' });
  }

  // ---- 7. reconciliation state valid ----
  {
    if (!source) {
      checks.reconciliation_state_valid = warn({ reason: '未提供 source，跳过 reconcile' });
    } else {
      let res = null;
      let err = null;
      try {
        res = await reconcile({ source, target, opts: {} });
      } catch (e) {
        err = e?.message ?? String(e);
      }
      const migrated = res?.checks?.row_conservation?.detail?.migrated;
      const archived = res?.checks?.row_conservation?.detail?.archived;
      const wellFormed = !!res && typeof res.status === 'string' && !!res.checks;
      const ok = !err && wellFormed && migrated === 0 && archived === 0;
      checks.reconciliation_state_valid = ok
        ? pass({ reconcileStatus: res.status, migrated: 0, archived: 0, note: '回滚态下 reconcile 报告 migrated=0，状态自洽' })
        : fail({ error: err, reconcileStatus: res?.status ?? null, migrated, archived, reason: 'reconcile 不可用或回滚后仍计入迁移量' });
    }
  }

  let errors = 0;
  let warnings = 0;
  for (const c of Object.values(checks)) {
    errors += c.errors || 0;
    warnings += c.warnings || 0;
  }
  return { status: errors > 0 ? 'FAIL' : 'PASS', errors, warnings, checks };
}
