// WP4 — Data Reconciliation & Consistency Validation.
// Independent, repeatable, machine-decidable reconciliation of a WP3 migration run.
// Operates on: source (1.0) + target (2.0 D1) + legacy_id_maps + migration_issues + migration_archive.
// Frozen target model (INTEGER PK + ULID public_id + epoch) is assumed; no production writes.

import { TABLE_MAP, EXCLUSIONS, sourceSystemOf } from './tablemap.js';

// Tables that must carry a ULID public_id per D1-DATABASE-DESIGN (transforms.js HAS_PUBLIC_ID).
const PUBLIC_ID_TABLES = ['users', 'teams', 'activities', 'content_articles'];

// FK integrity expectations within the 2.0 target (parent-child). Null FK is allowed (skipped).
const RELATIONS = [
  { table: 'activity_signups', fk: 'activity_id', ref: 'activities', pk: 'id' },
  { table: 'attendance_sessions', fk: 'activity_id', ref: 'activities', pk: 'id' },
  { table: 'attendance_events', fk: 'activity_id', ref: 'activities', pk: 'id' },
  { table: 'service_records', fk: 'activity_id', ref: 'activities', pk: 'id' },
  { table: 'team_members', fk: 'team_id', ref: 'teams', pk: 'id' },
  { table: 'team_members', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'user_roles', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'points_ledger', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'certificates', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'course_enrollments', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'learning_records', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'exam_sessions', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'notification_recipients', fk: 'user_id', ref: 'users', pk: 'id' },
  { table: 'operation_logs', fk: 'operator_id', ref: 'users', pk: 'id' },
  { table: 'certificate_logs', fk: 'cert_id', ref: 'certificates', pk: 'id' },
  { table: 'attendance_anomalies', fk: 'activity_id', ref: 'activities', pk: 'id' },
];

// Media/asset reference columns to scan for missing / duplicate references.
const MEDIA_COL_RE = /(url|path|image|avatar|cover|file|media|resource|storage|thumbnail|banner|logo)/i;

function normalizeRows(maybe) {
  if (Array.isArray(maybe)) return maybe;
  if (maybe && Array.isArray(maybe.results)) return maybe.results;
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows;
  return maybe ? [maybe] : [];
}

async function bulk(target, table, method) {
  if (typeof target[method] === 'function') return target[method]();
  return normalizeRows(await target.query(table, {}));
}

async function streamCount(source, srcKey) {
  let n = 0;
  for await (const _ of source.streamRows(srcKey)) n++;
  return n;
}

// Total source rows across all non-excluded TABLE_MAP keys present in the source.
async function computeSourceTotal(source, srcKeys) {
  let total = 0;
  for (const k of srcKeys) total += await streamCount(source, k);
  return total;
}

function uniqCount(arr, keyFn) {
  const seen = new Set();
  for (const x of arr) {
    const v = keyFn(x);
    if (v != null) seen.add(String(v));
  }
  return seen.size;
}

const pass = (detail) => ({ status: 'PASS', errors: 0, warnings: 0, detail });
const fail = (detail) => ({ status: 'FAIL', errors: 1, warnings: 0, detail });
const warn = (detail) => ({ status: 'WARN', errors: 0, warnings: 1, detail });

// ---------------------------------------------------------------- main
// opts: { source, target, sourceCounts? (Map srcKey->count), now, logger }
export async function reconcile({ source, target, opts = {} } = {}) {
  const logger = opts.logger ?? null;
  const log = (m, d) => logger && logger.info(m, d);

  const allKeys = Object.keys(TABLE_MAP);
  const nonExcludedKeys = allKeys.filter((k) => !EXCLUSIONS.includes(k));
  const presentKeys = new Set(await source.listTables());
  const srcKeys = nonExcludedKeys.filter((k) => presentKeys.has(k));

  // 1) Source total (use provided counts if given, else stream).
  let sourceTotal;
  if (opts.sourceCounts && opts.sourceCounts instanceof Map) {
    sourceTotal = [...opts.sourceCounts.entries()]
      .filter(([k]) => srcKeys.includes(k))
      .reduce((s, [, c]) => s + c, 0);
  } else {
    sourceTotal = await computeSourceTotal(source, srcKeys);
  }

  const idmaps = normalizeRows(await bulk(target, 'legacy_id_maps', 'allIdMaps'));
  const allIssuesRaw = normalizeRows(await bulk(target, 'migration_issues', 'allIssues'));
  // DEFECT-WP6-01 fix: when a run_id is supplied, only the CURRENT run's issues count toward
  // row conservation / excluded_unknown. Historical issues (other run_ids) are retained as audit
  // evidence but never pollute the current run's reconciliation. Without runId, all issues count
  // (backward-compatible: recovery.js / legacy callers that do not scope a run).
  const runId = opts.runId ?? null;
  const issues = runId ? allIssuesRaw.filter((i) => i.run_id === runId) : allIssuesRaw;
  const archive = normalizeRows(await bulk(target, 'migration_archive', 'allArchive'));

  const dropped = issues.filter((i) => i.issue_type === 'dropped');
  const failed = issues.filter((i) => i.issue_type === 'dirty' || i.issue_type === 'conflict');
  const excluded = issues.filter((i) => i.issue_type === 'excluded');
  const archivedCount = archive.length;
  const migratedCount = idmaps.length; // one primary idmap per migrated source row

  const expectedMigrated = sourceTotal - archivedCount - dropped.length - failed.length;

  const checks = {};

  // ---- 1. Row Count Reconciliation (conservation) ----
  log('recon_rowcount', { sourceTotal, migratedCount, archivedCount, dropped: dropped.length, failed: failed.length, excluded: excluded.length });
  if (sourceTotal === migratedCount + archivedCount + dropped.length + failed.length) {
    checks.row_conservation = pass({
      sourceRowsTotal: sourceTotal,
      migrated: migratedCount,
      archived: archivedCount,
      dropped: dropped.length,
      excluded: excluded.length,
      failed: failed.length,
      idempotentSkipped: null,
      formula: 'sourceTotal === migrated + archived + dropped + failed',
      balanced: true,
    });
  } else {
    checks.row_conservation = fail({
      sourceRowsTotal: sourceTotal,
      migrated: migratedCount,
      archived: archivedCount,
      dropped: dropped.length,
      excluded: excluded.length,
      failed: failed.length,
      expectedMigrated,
      mismatch: expectedMigrated - migratedCount,
      formula: 'sourceTotal === migrated + archived + dropped + failed',
    });
  }

  // ---- 2. Identity Integrity ----
  {
    const problems = [];
    // legacy_id_maps uniqueness
    const lmKey = new Set();
    let lmDup = 0;
    for (const m of idmaps) {
      const a = `${m.source_system}|${m.source_table}|${String(m.legacy_id)}`;
      const b = `${m.target_table}|${String(m.target_id)}`;
      if (lmKey.has(b)) lmDup++;
      lmKey.add(a);
      lmKey.add(b);
    }
    if (lmDup > 0) problems.push(`legacy_id_maps 含 ${lmDup} 个重复 target 映射`);
    // public_id uniqueness per table
    for (const t of PUBLIC_ID_TABLES) {
      const rows = normalizeRows(await target.query(t, {}));
      const n = rows.length;
      const u = uniqCount(rows, (r) => r.public_id);
      if (n > 0 && u !== n) problems.push(`${t}.public_id 重复：${n} 行 / ${u} 唯一`);
    }
    // users.openid / unionid uniqueness (if columns present)
    const users = normalizeRows(await target.query('users', {}));
    for (const col of ['openid', 'unionid']) {
      const vals = users.map((r) => r[col]).filter((v) => v != null && v !== '');
      const u = new Set(vals.map(String)).size;
      if (vals.length > 0 && u !== vals.length) problems.push(`users.${col} 重复：${vals.length} 值 / ${u} 唯一`);
    }
    checks.identity_integrity = problems.length ? fail(problems) : pass({ legacy_id_maps_unique: true, public_id_unique: true });
  }

  // ---- 3. Relationship Integrity (FK / orphan) ----
  {
    const problems = [];
    // Direct ref id sets + indirect resolution via legacy_id_maps (source FK -> target id).
    // WP3 may copy source ids into child FK columns; legacy_id_maps is the bridge to target ids.
    const refSets = {};
    const refLegacy = {};
    const buildRef = async (ref) => {
      if (refSets[ref]) return;
      const rows = normalizeRows(await target.query(ref, {}));
      const pk = RELATIONS.find((r) => r.ref === ref).pk;
      refSets[ref] = new Set(rows.map((r) => String(r[pk])).filter((v) => v != null));
      refLegacy[ref] = new Map();
      for (const m of idmaps) {
        if (m.target_table === ref && m.legacy_id != null) refLegacy[ref].set(String(m.legacy_id), m.target_id);
      }
    };
    for (const rel of RELATIONS) await buildRef(rel.ref);
    const isValidRef = (ref, v) => {
      if (v == null || v === '') return true; // null FK allowed
      if (refSets[ref].has(String(v))) return true;
      const tid = refLegacy[ref].get(String(v));
      return tid != null && refSets[ref].has(String(tid));
    };
    for (const rel of RELATIONS) {
      const rows = normalizeRows(await target.query(rel.table, {}));
      let orphans = 0;
      for (const r of rows) {
        if (!isValidRef(rel.ref, r[rel.fk])) orphans++;
      }
      if (orphans > 0) problems.push(`${rel.table}.${rel.fk} → ${rel.ref}.${rel.pk} 孤儿 ${orphans} 条`);
    }
    // legacy → target mapping completeness: every idmap target row exists
    const tableRowSets = {};
    let dangling = 0;
    for (const m of idmaps) {
      if (!tableRowSets[m.target_table]) tableRowSets[m.target_table] = new Set(normalizeRows(await target.query(m.target_table, {})).map((r) => String(r.id)));
      if (!tableRowSets[m.target_table].has(String(m.target_id))) dangling++;
    }
    if (dangling > 0) problems.push(`legacy_id_maps 悬空 ${dangling} 条（target 不存在）`);
    // mapping coverage: idmaps must equal expected migrated
    if (migratedCount !== expectedMigrated) problems.push(`legacy_id_maps 覆盖缺口：${migratedCount} ≠ 期望 ${expectedMigrated}`);
    checks.relationship_integrity = problems.length ? fail(problems) : pass({ orphans: 0, mappingComplete: true });
  }

  // ---- 4. Activity Chain ----
  {
    const activities = normalizeRows(await target.query('activities', {}));
    const signups = normalizeRows(await target.query('activity_signups', {}));
    const attSessions = normalizeRows(await target.query('attendance_sessions', {}));
    const attEvents = normalizeRows(await target.query('attendance_events', {}));
    const service = normalizeRows(await target.query('service_records', {}));
    const actIds = new Set(activities.map((a) => String(a.id)).filter((v) => v != null));
    const actLegacy = new Map();
    for (const m of idmaps) if (m.target_table === 'activities' && m.legacy_id != null) actLegacy.set(String(m.legacy_id), m.target_id);
    const validAct = (v) => {
      if (v == null || v === '') return true;
      if (actIds.has(String(v))) return true;
      const tid = actLegacy.get(String(v));
      return tid != null && actIds.has(String(tid));
    };
    const signupOrphans = signups.filter((s) => !validAct(s.activity_id)).length;
    const attOrphans = attSessions.filter((s) => !validAct(s.activity_id)).length;
    const svcOrphans = service.filter((s) => !validAct(s.activity_id)).length;
    const ok = signupOrphans === 0 && attOrphans === 0 && svcOrphans === 0;
    checks.activity_chain = ok
      ? pass({ activities: activities.length, signups: signups.length, attendance_sessions: attSessions.length, attendance_events: attEvents.length, service_records: service.length })
      : fail({ signupOrphans, attOrphans, svcOrphans });
  }

  // ---- 5. Points / Growth ----
  {
    const ledger = normalizeRows(await target.query('points_ledger', {}));
    const growth = normalizeRows(await target.query('growth_records', {}));
    const ledgerReq = new Set();
    let ledgerDup = 0;
    for (const r of ledger) {
      const k = String(r.request_id);
      if (ledgerReq.has(k)) ledgerDup++;
      ledgerReq.add(k);
    }
    const growthReq = new Set();
    let growthDup = 0;
    for (const r of growth) {
      const k = String(r.request_id);
      if (growthReq.has(k)) growthDup++;
      growthReq.add(k);
    }
    const problems = [];
    if (ledgerDup > 0) problems.push(`points_ledger.request_id 重复 ${ledgerDup}（MERGE/TRANSFORM 重复累计风险）`);
    if (growthDup > 0) problems.push(`growth_records.request_id 重复 ${growthDup}`);
    const totalPoints = ledger.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    checks.points_growth = problems.length
      ? fail(problems)
      : pass({ ledgerRows: ledger.length, totalAmount: totalPoints, growthRows: growth.length, noDuplication: true });
  }

  // ---- 6. Training / Result / Certificate ----
  {
    const certs = normalizeRows(await target.query('certificates', {}));
    const courses = normalizeRows(await target.query('courses', {}));
    const enroll = normalizeRows(await target.query('course_enrollments', {}));
    const learn = normalizeRows(await target.query('learning_records', {}));
    const exams = normalizeRows(await target.query('exam_sessions', {}));
    const users = normalizeRows(await target.query('users', {}));
    const userIds = new Set(users.map((u) => String(u.id)).filter((v) => v != null));
    const userLegacy = new Map();
    for (const m of idmaps) if (m.target_table === 'users' && m.legacy_id != null) userLegacy.set(String(m.legacy_id), m.target_id);
    const validUser = (v) => {
      if (v == null || v === '') return true;
      if (userIds.has(String(v))) return true;
      const tid = userLegacy.get(String(v));
      return tid != null && userIds.has(String(tid));
    };
    const problems = [];
    const chk = (label, rows, fk) => {
      const o = rows.filter((r) => !validUser(r[fk])).length;
      if (o > 0) problems.push(`${label}.${fk} 孤儿 ${o} 条`);
    };
    chk('certificates', certs, 'user_id');
    chk('course_enrollments', enroll, 'user_id');
    chk('learning_records', learn, 'user_id');
    chk('exam_sessions', exams, 'user_id');
    checks.training_result = problems.length
      ? fail(problems)
      : pass({ courses: courses.length, enrollments: enroll.length, learning: learn.length, certificates: certs.length, exam_sessions: exams.length });
  }

  // ---- 7. Media References ----
  {
    const problems = [];
    const seen = {};
    const tablesToScan = ['files', 'content_attachments', 'activity_service_points', 'notifications', 'content_articles', 'badges'];
    for (const t of tablesToScan) {
      const rows = normalizeRows(await target.query(t, {}));
      for (const r of rows) {
        for (const [col, v] of Object.entries(r)) {
          if (!MEDIA_COL_RE.test(col)) continue;
          if (v == null || v === '') {
            problems.push(`${t}.${col} 空媒体引用（缺失）`);
            continue;
          }
          seen[v] = (seen[v] || 0) + 1;
        }
      }
    }
    const dups = Object.entries(seen).filter(([, c]) => c > 1).map(([v, c]) => `${v}(${c})`);
    if (dups.length) problems.push(`重复媒体引用 ${dups.length} 项`);
    checks.media_references = problems.length ? warn(problems) : pass({ scanned: tablesToScan.length, missing: 0, duplicates: 0 });
  }

  // ---- 8. Audit / Operation Logs ----
  {
    const opLogs = normalizeRows(await target.query('operation_logs', {}));
    const secEvents = normalizeRows(await target.query('security_events', {}));
    const ok = opLogs.length > 0; // migration must have produced audit relations
    checks.audit_integrity = ok
      ? pass({ operation_logs: opLogs.length, security_events: secEvents.length })
      : fail({ operation_logs: 0, reason: '迁移后无审计日志，audit 关系缺失' });
  }

  // ---- 9. EXCLUDED / UNKNOWN (user_favorites) ----
  {
    const favIssues = excluded.filter((i) => i.source_object === 'api.user_favorites');
    const favInTarget = srcKeys.includes('api.user_favorites'); // should be false (excluded from batches)
    // user_favorites must not appear in any migrated target row (cannot verify directly; assert it is excluded + not migrated/dropped/archived)
    const favArchived = archive.filter((a) => a.source_table === 'user_favorites').length;
    const favDropped = dropped.filter((i) => i.source_object === 'api.user_favorites').length;
    const problems = [];
    if (favIssues.length === 0) problems.push('api.user_favorites 未出现在 exclusion report');
    else if (favIssues[0].resolution_status !== 'excluded') problems.push('api.user_favorites resolution_status 非 excluded');
    if (favArchived > 0) problems.push('api.user_favorites 被自动归档（禁止）');
    if (favDropped > 0) problems.push('api.user_favorites 被 DROP（禁止）');
    if (favInTarget) problems.push('api.user_favorites 进入了迁移批次（禁止）');
    checks.excluded_unknown = problems.length
      ? fail(problems)
      : pass({ excludedObjects: excluded.map((i) => i.source_object), bcrPending: favIssues.length > 0, user_favorites_excluded: true });
  }

  // ---- Aggregate ----
  let errors = 0;
  let warnings = 0;
  for (const c of Object.values(checks)) {
    errors += c.errors || 0;
    warnings += c.warnings || 0;
  }
  const status = errors > 0 ? 'FAIL' : 'PASS';
  const result = { status, errors, warnings, checks };
  log('recon_end', { status, errors, warnings });
  return result;
}

export function humanReport(result) {
  const lines = [`STATUS: ${result.status}`, `errors=${result.errors} warnings=${result.warnings}`];
  for (const [name, c] of Object.entries(result.checks)) {
    lines.push(`- ${name}: ${c.status}`);
    const d = c.detail;
    if (Array.isArray(d)) lines.push('    ' + d.join('; '));
    else if (d && typeof d === 'object') lines.push('    ' + JSON.stringify(d));
  }
  return lines.join('\n');
}
