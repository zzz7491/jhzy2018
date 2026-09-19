// WP5 — Rollback Plan + Cutover Runbook (design + machine-checkable helpers).
// 严格遵循 P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE：
//   WP5 = Rollback Plan + Cutover Runbook（只设计与准备）。
//   生产正式迁移 / 生产部署 / 正式切换 / 灰度放量 = OUT OF SCOPE，不属于 P8-3 任何 WP。
// 本文件只产出「可机器判定的规则 + 可勾选的清单 + 回滚方案描述」，不执行生产动作。

import { BATCHES, BATCH_META, tablesForBatch } from './batches.js';
import { TABLE_MAP, EXCLUSIONS, sourceSystemOf } from './tablemap.js';

// ---------------------------------------------------------------- 0. 边界与拓扑
export const PRODUCTION_BOUNDARY = {
  scope: 'P8-3 WP5 = Rollback Plan + Cutover Runbook（设计/准备）',
  outOfScope: [
    '生产正式迁移',
    '生产部署',
    '正式切换（域名/小程序）',
    '灰度放量',
  ],
  productionAccessAllowed: false,
  note: 'WP5 不得执行生产切换；未来生产切换须经独立 Definition Gate + 管理员授权。',
};

// 正式生产拓扑（WP1 §2.4 已冻结，WP5 不得修改）
export const TARGET_TOPOLOGY = [
  '中国大陆用户 / 微信小程序 / 管理端',
  '→ 国内备案域名',
  '→ 腾讯云国内服务器（国内接入 / 网关 / 反向代理）',
  '→ Cloudflare Worker',
  '→ Cloudflare D1（2.0 唯一权威业务数据库）',
  '→ R2 / KV 等 Cloudflare 服务',
];

export const TOPOLOGY_RULES = [
  '腾讯云承担中国大陆对外服务入口。',
  '腾讯云 MySQL 不作为 2.0 正式业务数据库（非 authoritative DB）。',
  'Cloudflare D1 保存 2.0 权威业务数据。',
  '客户端不得因迁移设计而绕过腾讯云国内入口直接改变正式生产访问拓扑。',
  'WP5 仍只设计回滚与切换 Runbook，不实施网络/网关/部署修改。',
];

// ---------------------------------------------------------------- A. Preflight
// 执行前必须确认；任何 critical 失败 → STOP。
export const PREFLIGHT = [
  {
    id: 'PF-01',
    label: 'P8-3 WP1–WP4 Gate 全部 PASS',
    critical: true,
    verify: (c) => {
      const g = c.wpGates || {};
      const missing = ['WP1', 'WP2', 'WP3', 'WP4'].filter((k) => g[k] !== 'PASS');
      return { ok: missing.length === 0, detail: missing.length ? `未 PASS：${missing.join(',')}` : 'WP1/WP2/WP3/WP4 = PASS' };
    },
  },
  {
    id: 'PF-02',
    label: 'Freeze Conflict = 0',
    critical: true,
    verify: (c) => ({ ok: (c.freezeConflict ?? -1) === 0, detail: `freezeConflict=${c.freezeConflict ?? 'undefined'}` }),
  },
  {
    id: 'PF-03',
    label: 'source dump 完整',
    critical: true,
    verify: (c) => {
      const d = c.sourceDump || {};
      return { ok: !!(d.complete && d.tableCount > 0), detail: `complete=${!!d.complete} tableCount=${d.tableCount ?? 0}` };
    },
  },
  {
    id: 'PF-04',
    label: 'source snapshot / hash 可验证',
    critical: true,
    verify: (c) => {
      const s = c.sourceSnapshot || {};
      return { ok: !!s.hashVerified, detail: `hashVerified=${!!s.hashVerified} hash=${s.hash ?? '-'}` };
    },
  },
  {
    id: 'PF-05',
    label: 'target test D1 状态明确',
    critical: true,
    verify: (c) => {
      const t = c.targetState || {};
      return { ok: !!t.known, detail: `known=${!!t.known} env=${t.environment ?? '-'} clean=${t.clean ?? '-'}` };
    },
  },
  {
    id: 'PF-06',
    label: 'migration scripts version 固定',
    critical: true,
    verify: (c) => ({ ok: !!(c.versions || {}).migration, detail: `migration=${(c.versions || {}).migration ?? 'unpinned'}` }),
  },
  {
    id: 'PF-07',
    label: 'reconciliation version 固定',
    critical: true,
    verify: (c) => ({ ok: !!(c.versions || {}).reconciliation, detail: `reconciliation=${(c.versions || {}).reconciliation ?? 'unpinned'}` }),
  },
  {
    id: 'PF-08',
    label: 'user_favorites 明确 EXCLUDED / BCR pending',
    critical: true,
    verify: (c) => {
      const u = c.userFavorites || {};
      return { ok: !!(u.excluded && u.bcrPending), detail: `excluded=${!!u.excluded} bcrPending=${!!u.bcrPending}` };
    },
  },
  {
    id: 'PF-09',
    label: 'rollback point 已建立',
    critical: true,
    verify: (c) => {
      const r = c.rollbackPoint || {};
      return { ok: !!r.established, detail: `established=${!!r.established} ref=${r.ref ?? '-'}` };
    },
  },
  {
    id: 'PF-10',
    label: 'operator / timestamp / batch ID 可记录',
    critical: true,
    verify: (c) => {
      const o = c.operator || {};
      const ok = !!(o.name && o.timestamp && o.batchId);
      return { ok, detail: `operator=${o.name ?? '-'} ts=${o.timestamp ?? '-'} batchId=${o.batchId ?? '-'}` };
    },
  },
];

export function runPreflight(ctx = {}) {
  const checks = {};
  let errors = 0;
  let warnings = 0;
  for (const item of PREFLIGHT) {
    let r;
    try {
      r = item.verify(ctx) || { ok: false, detail: 'verify 返回空' };
    } catch (e) {
      r = { ok: false, detail: `verify 抛错：${e.message}` };
    }
    const status = r.ok ? 'PASS' : 'FAIL';
    checks[item.id] = { id: item.id, label: item.label, status, critical: item.critical, detail: r.detail };
    if (!r.ok) (item.critical ? errors++ : warnings++);
  }
  return {
    status: errors > 0 ? 'FAIL' : 'PASS',
    errors,
    warnings,
    checks,
    decision: errors > 0 ? 'STOP' : 'PROCEED',
    note: errors > 0 ? '存在 critical preflight 失败 → 立即 STOP，不得开始迁移。' : 'preflight 全通过，可进入 MIGRATE。',
  };
}

// ---------------------------------------------------------------- D. STOP / Abort
export const STOP_CONDITIONS = [
  { id: 'SC-01', label: 'row conservation FAIL', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.row_conservation?.status === 'FAIL' },
  { id: 'SC-02', label: 'identity duplicate', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.identity_integrity?.status === 'FAIL' },
  { id: 'SC-03', label: 'orphan relation', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.relationship_integrity?.status === 'FAIL' },
  {
    id: 'SC-04',
    label: 'missing legacy mapping',
    severity: 'CRITICAL',
    detect: ({ r }) => /覆盖缺口|悬空/.test(JSON.stringify(r?.checks?.relationship_integrity?.detail ?? '')),
  },
  { id: 'SC-05', label: 'points/growth mismatch', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.points_growth?.status === 'FAIL' },
  { id: 'SC-06', label: 'training/certificate mismatch', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.training_result?.status === 'FAIL' },
  { id: 'SC-07', label: 'media reference critical failure', severity: 'WARNING', detect: ({ r }) => r?.checks?.media_references?.status === 'FAIL' },
  { id: 'SC-08', label: 'audit integrity failure', severity: 'CRITICAL', detect: ({ r }) => r?.checks?.audit_integrity?.status === 'FAIL' },
  {
    id: 'SC-09',
    label: 'unexpected schema',
    severity: 'CRITICAL',
    detect: ({ ctx }) => !!(ctx.expectedSchemaSignature && ctx.schemaSignature && ctx.expectedSchemaSignature !== ctx.schemaSignature),
  },
  {
    id: 'SC-10',
    label: 'migration script version mismatch',
    severity: 'CRITICAL',
    detect: ({ ctx }) => !!(ctx.versions?.expectedMigration && ctx.versions?.migration && ctx.versions.expectedMigration !== ctx.versions.migration),
  },
  {
    id: 'SC-11',
    label: 'source snapshot mismatch',
    severity: 'CRITICAL',
    detect: ({ ctx }) => !!(ctx.sourceSnapshot?.expectedHash && ctx.sourceSnapshot?.hash && ctx.sourceSnapshot.expectedHash !== ctx.sourceSnapshot.hash),
  },
  { id: 'SC-12', label: 'target contamination', severity: 'CRITICAL', detect: ({ ctx }) => ctx.targetState?.clean === false },
  { id: 'SC-13', label: 'Freeze conflict', severity: 'CRITICAL', detect: ({ ctx }) => (ctx.freezeConflict ?? 0) !== 0 },
  { id: 'SC-14', label: 'unauthorized production access', severity: 'CRITICAL', detect: ({ ctx }) => ctx.productionAccess === true },
  {
    id: 'SC-15',
    label: 'open migration error / incomplete batch',
    severity: 'CRITICAL',
    // DEFECT-WP6-02 fix (formal): STOP if the CURRENT migration run still carries an open/unresolved
    // migration issue of error/critical severity, OR the current batch is incomplete but the runner
    // would proceed to the next batch. Open errors / incomplete-batch detection are supplied by the
    // caller scoped to the CURRENT run_id (via ctx.openErrorIssues) so that historical runs' issues
    // can never pollute the current run's STOP decision.
    detect: ({ r, ctx }) => {
      const open = ctx?.openErrorIssues;
      let hasOpenError = false;
      if (Array.isArray(open)) {
        hasOpenError = open.some(
          (i) => (i.severity === 'error' || i.severity === 'critical') && (i.resolution_status === 'open' || i.resolution_status === 'unresolved')
        );
      } else if (typeof open === 'number') {
        hasOpenError = open > 0;
      }
      const incompleteBatch = !!(ctx && ctx.currentBatchIncomplete);
      return hasOpenError || incompleteBatch;
    },
  },
];

// Helper: extract the CURRENT run's open/unresolved migration error issues from a target's issue ledger.
// Scoping by run_id is what guarantees historical runs cannot trigger SC-15 for a new run.
export function currentRunOpenErrorIssues(target, runId = null) {
  return (target.allIssues?.() ?? []).filter(
    (i) =>
      (runId == null || i.run_id === runId) &&
      (i.severity === 'error' || i.severity === 'critical') &&
      (i.resolution_status === 'open' || i.resolution_status === 'unresolved')
  );
}

export function evaluateStopConditions({ reconcileResult = null, ctx = {} } = {}) {
  const criticals = [];
  const warnings = [];
  for (const sc of STOP_CONDITIONS) {
    let hit = false;
    try {
      hit = !!sc.detect({ r: reconcileResult, ctx });
    } catch {
      hit = false;
    }
    if (!hit) continue;
    (sc.severity === 'CRITICAL' ? criticals : warnings).push({ id: sc.id, label: sc.label, severity: sc.severity });
  }
  return {
    status: criticals.length ? 'STOP' : 'PROCEED',
    criticals,
    warnings,
    nextBatchAllowed: criticals.length === 0,
    action: criticals.length
      ? `立即 STOP，不得继续下一 Batch；按 WP5 §E 执行回滚（criticals=${criticals.map((c) => c.id).join(',')}）`
      : '无 critical，可继续下一 Batch（WARNING 需记录证据）。',
  };
}

// ---------------------------------------------------------------- B. Migration Sequence (B0-B20)
function buildBatchRunbook() {
  const out = {};
  for (const b of BATCHES) {
    const srcKeys = tablesForBatch(TABLE_MAP, b);
    const targets = [...new Set(srcKeys.map((k) => TABLE_MAP[k].target).filter(Boolean))];
    const kinds = srcKeys.reduce((m, k) => {
      const kind = TABLE_MAP[k].kind || 'MIGRATE';
      m[kind] = (m[kind] || 0) + 1;
      return m;
    }, {});
    out[b] = {
      batch: b,
      name: BATCH_META[b] || '',
      preconditions: [
        `Preflight 全通过（PF-01…PF-10），decision=PROCEED`,
        `上一 Batch 已 checkpoint 且 reconciliation PASS（首个批次为 B0，无前置批次）`,
        `无未决 CRITICAL STOP 条件（SC-01…SC-15）`,
      ],
      input: {
        sourceObjects: srcKeys,
        sourceObjectCount: srcKeys.length,
        kindDistribution: kinds,
        targetTables: targets,
      },
      procedure: srcKeys.length
        ? `runMigration({ source, target, opts: { batch: '${b}', checkpoint, logger } }) —— 按 TABLE_MAP 插入顺序逐表 ETL；EXCLUSIONS(${EXCLUSIONS.join(',')}) 永不进入任何批次。`
        : `本批次为保留批次（无 1.0 源对象），仅执行 checkpoint 推进与证据记录。`,
      checkpoint: {
        writes: `doneTables += 本批次已完成的 srcKey；migration_batch='${b}'`,
        resume: '重跑时跳过 doneTables 内已完成表（resumable）',
        failureIsolation: '单表/单行失败记 migration_issues，不中断整批',
      },
      reconciliation: {
        tool: 'src/reconcile.js → reconcile({ source, target })',
        requiredChecks: [
          'row_conservation',
          'identity_integrity',
          'relationship_integrity',
          'activity_chain',
          'points_growth',
          'training_result',
          'media_references',
          'audit_integrity',
          'excluded_unknown',
        ],
      },
      passCriteria: [
        '本批次目标行全部写入且 legacy_id_maps 覆盖完整',
        'reconcile 对应维度无 FAIL',
        'evaluateStopConditions → status=PROCEED',
      ],
      failCriteria: [
        'row conservation FAIL / identity duplicate / orphan relation / missing legacy mapping',
        'points/growth、training/certificate、audit 任一 FAIL',
        '出现 SC-01…SC-15 任一 CRITICAL',
      ],
      rollbackBoundary: {
        scope: `仅回滚 ${b} 批次写入的目标行（按 legacy_id_maps.migration_batch='${b}' 定位）`,
        class: 'CLASS_1_BATCH',
        command: `rollbackBatch({ target, checkpoint, batch: '${b}' })`,
        after: '回滚后必须执行 verifyRecovery 或批次级重跑',
      },
      evidence: [
        `batch=${b} 的 migration_issues 记录`,
        'checkpoint.doneTables 快照',
        'reconcile 输出（status/errors/warnings/checks）',
        'operator + timestamp + batchId',
      ],
    };
  }
  return out;
}

export const BATCH_RUNBOOK = buildBatchRunbook();

// ---------------------------------------------------------------- E. Rollback Plan
export const ROLLBACK_PLAN = {
  CLASS_1_BATCH: {
    id: 'CLASS_1_BATCH',
    name: 'Batch Rollback（单批次回滚）',
    executableInWP5: true,
    environment: 'test',
    trigger: [
      '本批次 reconciliation FAIL',
      '本批次触发任一 CRITICAL STOP 条件',
      '本批次目标数据污染 / 写入异常',
    ],
    scope: `仅回滚指定 Batch 写入的目标行（按 legacy_id_maps.migration_batch 定位），不影响其它批次`,
    restorePoint: '该 Batch 开始前的 checkpoint 快照（doneTables 不含本批代表）',
    checkpointHandling: '从 doneTables 移除本批代表 srcKey，使本批可重跑（resumable）',
    legacyIdMapsHandling: '删除本批 legacy_id_maps 记录（其余批次保留，保证 ID 映射链完整）',
    migrationIssuesHandling: '**不得删除**；新增一条 issue_type=rollback 记录（证据保留）',
    archiveHandling: '删除本批产生的 migration_archive 冷存条目',
    verification: 'rollbackBatch 后执行 verifyRecovery 的批次子集检查 + 重跑本批',
    evidenceRetention: '保留 migration_issues 全量 + checkpoint 快照 + reconcile 输出',
    command: "rollbackBatch({ target, checkpoint, batch: 'Bxx' })",
  },
  CLASS_2_FULL_TEST: {
    id: 'CLASS_2_FULL_TEST',
    name: 'Full Test Migration Rollback（完整测试迁移回滚）',
    executableInWP5: true,
    environment: 'test',
    trigger: [
      '多批次连续 FAIL 且无法定位到单一批次',
      '测试库目标污染（target contamination）',
      'WP6 演练需要回到迁移前基线状态',
    ],
    scope: '清空测试目标全部迁移产物（业务表行 + legacy_id_maps + migration_archive），回到迁移前基线',
    restorePoint: '迁移前测试库快照 / 空库基线',
    checkpointHandling: 'checkpoint.reset() —— 清除 doneTables 等全部进度',
    legacyIdMapsHandling: '全部清除（目标库回到无映射状态）',
    migrationIssuesHandling: '**保留**（审计证据不可删）；追加 issue_type=rollback 记录',
    archiveHandling: '清除 migration_archive（冷存条目随回滚失效）',
    verification: 'verifyRecovery({ source, target, checkpoint, baseline }) → 必须 PASS',
    evidenceRetention: 'migration_issues 全量保留；checkpoint 快照归档',
    command: 'rollbackFull({ target, checkpoint })',
  },
  CLASS_3_FUTURE_PRODUCTION: {
    id: 'CLASS_3_FUTURE_PRODUCTION',
    name: 'Future Production Cutover Rollback（未来生产切换回滚）',
    executableInWP5: false,
    status: 'DESIGN_ONLY',
    environment: 'production',
    note: 'WP5 只设计，不执行。生产切换本身属 OUT OF SCOPE，须经独立 Definition Gate + 管理员授权后方可实施。',
    trigger: [
      '切换后核心业务链路不可用（登录/报名/签到/积分）',
      '切换后对账不守恒或身份冲突',
      '切换后权威数据污染',
    ],
    scope: '未设计到可执行粒度 —— 仅定义原则',
    principles: [
      '回滚判定优先于继续排障：达到 trigger 即回滚，不在生产现场调试。',
      '回滚必须恢复到「切换前生产状态」：腾讯云入口回指 1.0，D1 不作为唯一权威源前不得对外。',
      'D1 侧回滚依靠切换前快照 / 时间点恢复（restore point），不得依赖逐行 DELETE。',
      'legacy_id_maps / migration_issues 全量保留作为审计证据，不得随回滚清除。',
      '回滚后必须执行 Recovery Verification 并留存 Operator Evidence Record。',
      '腾讯云 MySQL 在回滚态下仍不得被当作 2.0 authoritative DB。',
    ],
    topologyConstraint: TARGET_TOPOLOGY.join(' '),
  },
};

// ---------------------------------------------------------------- G. Operator Checklist
export const OPERATOR_CHECKLIST = {
  name: 'P8-3 Operator Checklist',
  rule: '禁止依赖操作者“凭经验判断”——每一项必须可勾选且有证据。',
  phases: [
    {
      id: 'PRE-FLIGHT',
      label: 'PRE-FLIGHT',
      steps: [
        { id: 'OC-01', label: '核对 WP1–WP4 Gate 全 PASS（PF-01）', blocking: true, evidence: 'Gate 记录' },
        { id: 'OC-02', label: '核对 Freeze Conflict = 0（PF-02）', blocking: true, evidence: '一致性自检' },
        { id: 'OC-03', label: '核对 source dump 完整 + snapshot hash（PF-03/PF-04）', blocking: true, evidence: 'dump 清单 + hash' },
        { id: 'OC-04', label: '确认 target test D1 状态（PF-05）', blocking: true, evidence: '目标库状态快照' },
        { id: 'OC-05', label: '固定 migration / reconciliation 版本（PF-06/PF-07）', blocking: true, evidence: 'version 字符串' },
        { id: 'OC-06', label: '确认 user_favorites EXCLUDED + BCR pending（PF-08）', blocking: true, evidence: 'exclusion issue' },
        { id: 'OC-07', label: '建立 rollback point（PF-09）', blocking: true, evidence: 'restore point ref' },
        { id: 'OC-08', label: '登记 operator / timestamp / batchId（PF-10）', blocking: true, evidence: '证据记录' },
        { id: 'OC-09', label: 'runPreflight → decision=PROCEED', blocking: true, evidence: 'preflight JSON' },
      ],
    },
    {
      id: 'MIGRATE',
      label: 'MIGRATE',
      steps: [
        { id: 'OC-10', label: '按 B0–B20 顺序执行，不跳批、不重排', blocking: true, evidence: 'batch 日志' },
        { id: 'OC-11', label: '每批完成后立即 checkpoint', blocking: true, evidence: 'doneTables 快照' },
        { id: 'OC-12', label: 'user_favorites 未进入任何批次', blocking: true, evidence: 'exclusion report' },
        { id: 'OC-13', label: '任一 CRITICAL STOP → 立即停批', blocking: true, evidence: 'STOP 记录' },
      ],
    },
    {
      id: 'RECONCILE',
      label: 'RECONCILE',
      steps: [
        { id: 'OC-14', label: '执行 reconcile（9 维）', blocking: true, evidence: 'reconcile JSON' },
        { id: 'OC-15', label: '核对 row conservation 守恒', blocking: true, evidence: 'row_conservation detail' },
        { id: 'OC-16', label: '核对 excluded_unknown：user_favorites 未被迁移/DROP/归档', blocking: true, evidence: 'excluded_unknown detail' },
      ],
    },
    {
      id: 'DECISION',
      label: 'DECISION',
      steps: [
        { id: 'OC-17', label: 'evaluateStopConditions → PROCEED / STOP', blocking: true, evidence: 'STOP 评估 JSON' },
        { id: 'OC-18', label: 'WARNING 项记录并指派', blocking: false, evidence: 'warning 列表' },
      ],
    },
    {
      id: 'ROLLBACK / CONTINUE',
      label: 'ROLLBACK / CONTINUE',
      steps: [
        { id: 'OC-19', label: 'PROCEED → 继续下一 Batch', blocking: false, evidence: '批次日志' },
        { id: 'OC-20', label: 'STOP → 执行 CLASS_1_BATCH 或 CLASS_2_FULL_TEST 回滚', blocking: true, evidence: '回滚记录' },
        { id: 'OC-21', label: '回滚后执行 verifyRecovery → 必须 PASS', blocking: true, evidence: 'recovery JSON' },
      ],
    },
    {
      id: 'EVIDENCE',
      label: 'EVIDENCE',
      steps: [
        { id: 'OC-22', label: '生成 Operator Evidence Record（operator/ts/batchId/结果）', blocking: true, evidence: 'evidence JSON' },
        { id: 'OC-23', label: '保留 migration_issues 全量（不得删除）', blocking: true, evidence: 'issues 导出' },
        { id: 'OC-24', label: '归档 checkpoint 快照', blocking: true, evidence: 'checkpoint JSON' },
      ],
    },
    {
      id: 'CLOSEOUT',
      label: 'CLOSEOUT',
      steps: [
        { id: 'OC-25', label: '确认未触碰生产数据（production data touched = NO）', blocking: true, evidence: '边界声明' },
        { id: 'OC-26', label: '确认目标拓扑未被修改', blocking: true, evidence: '拓扑核对' },
        { id: 'OC-27', label: '输出 WP5 Gate 结论', blocking: true, evidence: 'Gate 记录' },
      ],
    },
  ],
};

// ---------------------------------------------------------------- H. WP6 Rehearsal Contract
export const WP6_REHEARSAL_CONTRACT = {
  name: 'P8-3 WP6 Rehearsal Contract',
  executedBy: 'WP6',
  executedNow: false,
  note: 'WP5 只定义契约，WP6 才实际演练；WP5 不执行任何演练步骤。',
  entryGates: [
    'P8-3 WP5 Gate = PASS',
    'Preflight（PF-01…PF-10）在测试环境全通过',
    'CLASS_1_BATCH / CLASS_2_FULL_TEST 回滚工具可用',
    'verifyRecovery 可用且基线 source counts 已采集',
  ],
  steps: [
    { id: 'RS-1', action: 'Test Migration', desc: '在测试库执行完整 B0–B20 迁移', verify: 'runMigration 完成 + checkpoint 记录' },
    { id: 'RS-2', action: 'Reconciliation', desc: '执行 reconcile 9 维校验', verify: 'reconcile.status 与预期一致' },
    { id: 'RS-3', action: 'Failure Injection', desc: '注入行数缺失/身份重复/孤儿/积分重复等故障', verify: 'reconcile 与 STOP 条件必须 FAIL 并阻断' },
    { id: 'RS-4', action: 'Rollback', desc: '执行 CLASS_1_BATCH 与 CLASS_2_FULL_TEST 回滚', verify: '回滚返回统计与 issues rollback 记录' },
    { id: 'RS-5', action: 'Recovery Verification', desc: '执行 verifyRecovery', verify: 'status = PASS' },
  ],
  exitEvidence: [
    '每步的 JSON 输出（迁移/对账/回滚/恢复）',
    'Operator Evidence Record',
    'migration_issues 全量导出',
    'WP6 Gate 结论',
  ],
};

// ---------------------------------------------------------------- Operator Evidence Record
export function buildEvidenceRecord({ operator, phase, batchId, result, extras = {} } = {}) {
  return {
    schema: 'p8-3-operator-evidence/v1',
    operator: operator?.name ?? null,
    timestamp: operator?.timestamp ?? null,
    batchId: batchId ?? null,
    phase: phase ?? null,
    result: result ?? null,
    topology: TARGET_TOPOLOGY,
    productionBoundary: {
      productionDataTouched: false,
      productionCutoverExecuted: false,
      outOfScope: PRODUCTION_BOUNDARY.outOfScope,
    },
    userFavorites: { excluded: true, bcrPending: true, migrated: false },
    extras,
  };
}
