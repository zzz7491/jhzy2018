# P8-3 WP4 — Data Reconciliation & Consistency Validation（数据对账与一致性校验）

> **阶段**：P8-3 Migration & Cutover Design（迁移与切换实施设计冻结）
> **Work Package**：WP4（P8-3 Definition Freeze §7：WP1 设计总案 / WP2 表映射 / WP3 脚本 / **WP4 对账校验** / WP5 回滚 Runbook / WP6 测试演练）
> **冻结日期**：2026-09-18
> **性质**：为 WP3 迁移工具链建立**独立、可重复、机器可判定**的数据对账与一致性验证体系。
> **层级**：L3（实现层），接入既有 L0→L1→L2 链，不覆盖上层。

> ⚠ **阶段定义纠正**：WP4 = **数据对账与一致性校验**。**生产正式迁移 / 生产部署 / 正式切换 / 灰度放量**不属于 P8-3 任何 WP（P8-3 Definition Freeze §4 Out of Scope），须另行通过 Definition Gate 后才能执行。本文件不创建 P8-4 等未定义阶段编号。

---

## Authority（权威层级）

| 层级 | 文档 | 角色 |
|---|---|---|
| **L0** | `PROJECT_CONSTITUTION.md` | 唯一顶层宪法 |
| **L1** | `ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md` | 冻结层 |
| **L2** | `ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md` | 设计层 |
| **L3** | `D1-*` / `D1-RBAC-DESIGN.md` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / WP1–WP6 文档 | 实现层 |
| **L3** | 本文件 `P8-3_WP4_DATA_RECONCILIATION_AND_CONSISTENCY_VALIDATION.md` | 实现层：对账与一致性校验 |

---

## 1. Purpose（目的）

在 WP3 迁移脚本产出目标库（D1 / MemoryTarget 测试态）后，独立验证：
- 源数据**不丢失、不重复、不误删**（行数守恒）；
- 身份 / 关系 / 业务链一致（无孤儿、无重复累计）；
- `user_favorites` 等 UNKNOWN 对象**显式排除、不污染成功数**；
- 输出**机器可判定**的 `PASS / FAIL` 结果，作为 WP6 测试库演练的核心证据。

---

## 2. Scope（范围）

- 对账与一致性校验工具：`src/reconcile.js`。
- 单元测试：`test/reconcile.test.js`（8 项，含完全一致 PASS 与 7 个负向/边界用例）。
- 复用 WP3 `runMigration` 的输出（`target` / `legacy_id_maps` / `migration_issues` / `migration_archive`）。
- 仅运行于**测试态**（fixture / dump / MemoryTarget / 测试 D1），不触碰生产数据。

### Out of Scope（明确排除）
- 生产迁移执行、生产部署、正式切换、灰度放量（P8-3 Definition Freeze §4）。
- 修改 Freeze / Constitution / Core Domain / 业务代码逻辑 / 生产 schema。
- 进入 WP5（回滚预案 + Cutover Runbook）。

---

## 3. Reconciliation Checks（校验维度）

| # | 校验 | 失败条件（→ Gate FAIL） | 严重度 |
|---|---|---|---|
| 1 | Row Count Reconciliation | `sourceTotal ≠ migrated + archived + dropped + failed` | 硬失败 |
| 2 | Identity Integrity | `legacy_id_maps` 重复 target 映射 / `public_id` 重复 / `users.openid`·`unionid` 重复 | 硬失败 |
| 3 | Relationship Integrity | 孤儿 FK（经 `legacy_id_maps` 间接解析后仍无父）/ `legacy_id_maps` 悬空 / 覆盖缺口 | 硬失败 |
| 4 | Activity Chain | `activity_signups` / `attendance_*` / `service_records` 关联活动孤儿 | 硬失败 |
| 5 | Points / Growth | `points_ledger.request_id` 或 `growth_records.request_id` 重复（MERGE/TRANSFORM 重复累计） | 硬失败 |
| 6 | Training / Result / Cert | `certificates` / `course_enrollments` / `learning_records` / `exam_sessions` 用户孤儿 | 硬失败 |
| 7 | Media References | 空媒体引用 / 重复引用 | **警告（不阻断 Gate）** |
| 8 | Audit / Operation Logs | 迁移后 `operation_logs` 为空（审计关系缺失） | 硬失败 |
| 9 | EXCLUDED / UNKNOWN | `user_favorites` 未排除 / 被自动归档 / 被 DROP / 进入迁移批次 | 硬失败 |
| 10 | Deterministic Gate | 任一硬失败 → `status:"FAIL"`，否则 `"PASS"` | 机器可判定 |

### 关键设计：经 `legacy_id_maps` 间接解析 FK
WP3 的变换将**源 id** 写入子表 FK 列（如 `attendance_sessions.activity_id = 源活动 id`），而目标父表 `activities.id` 为 D1 自增 id。`legacy_id_maps` 是源→目标 id 的桥。关系/活动链/用户 校验均先尝试直接匹配目标 id，再经 `legacy_id_maps(legacy_id → target_id)` 间接解析；间接解析仍无父记录才判孤儿。这样既兼容「WP3 已重映射 FK」也兼容「WP3 暂存源 id」两种实现，确保对账语义正确。

---

## 4. Machine-Readable Gate（输出契约）

```json
{
  "status": "PASS | FAIL",
  "errors": 0,
  "warnings": 0,
  "checks": {
    "row_conservation":        { "status": "PASS", "detail": { "sourceRowsTotal": 29, "migrated": 27, "archived": 1, "dropped": 1, "failed": 0, "balanced": true } },
    "identity_integrity":      { "status": "PASS", "detail": { "legacy_id_maps_unique": true, "public_id_unique": true } },
    "relationship_integrity":  { "status": "PASS", "detail": { "orphans": 0, "mappingComplete": true } },
    "activity_chain":          { "status": "PASS", "detail": { "activities": 2, "signups": 2, "attendance_sessions": 2, "attendance_events": 2, "service_records": 1 } },
    "points_growth":           { "status": "PASS", "detail": { "ledgerRows": 1, "totalAmount": 50, "growthRows": 0, "noDuplication": true } },
    "training_result":         { "status": "PASS", "detail": { "courses": 1, "enrollments": 0, "learning": 0, "certificates": 1, "exam_sessions": 1 } },
    "media_references":        { "status": "PASS", "detail": { "scanned": 6, "missing": 0, "duplicates": 0 } },
    "audit_integrity":         { "status": "PASS", "detail": { "operation_logs": 1, "security_events": 0 } },
    "excluded_unknown":        { "status": "PASS", "detail": { "excludedObjects": ["api.user_favorites"], "bcrPending": true, "user_favorites_excluded": true } }
  }
}
```

`status === "FAIL"` 的充要条件是任一 `checks[*].status === "FAIL"`（errors > 0）。`media_references` 仅产生 warning，不阻断 Gate。

---

## 5. 使用方式

```js
import { runMigration } from './src/runner.js';
import { FixtureSource, MemoryTarget } from './src/adapters.js';
import { reconcile, humanReport } from './src/reconcile.js';

const source = new FixtureSource(dump /* 1.0 导出 JSON */);
const target = new MemoryTarget();          // 或 D1Target(db)（测试库）
await runMigration({ source, target, opts: { dryRun: false } });
const result = await reconcile({ source, target });
console.log(result.status);                 // PASS | FAIL
console.log(humanReport(result));
```

- `opts.sourceCounts`（Map srcKey→count）可避免对生产源重复流式计数，直接提供预计算源行数。
- 支持 `target.allIdMaps()` / `allIssues()` / `allArchive()`（MemoryTarget）；生产 D1 自动回退到 `target.query('legacy_id_maps'|'migration_issues'|'migration_archive')`。

---

## 6. 测试结果（node --test）

| 用例 | 期望 | 结果 |
|---|---|---|
| 完全一致迁移 → PASS | PASS | ✅ PASS |
| 行数不一致 → FAIL | FAIL | ✅ FAIL |
| 重复身份（legacy_id_maps target 重复）→ FAIL | FAIL | ✅ FAIL |
| 孤儿关系（缺失活动）→ FAIL | FAIL | ✅ FAIL |
| 积分重复（request_id 重复）→ FAIL | FAIL | ✅ FAIL |
| 缺失映射（idmap 移除）→ FAIL | FAIL | ✅ FAIL |
| user_favorites 排除 → PASS | PASS | ✅ PASS |
| 重跑/幂等（共享 checkpoint resume）→ PASS | PASS | ✅ PASS |

**总：27 项通过（WP3 既有 19 + WP4 8），0 失败。**

---

## 7. 一致性声明（与冻结体系）

- 与 L0 `PROJECT_CONSTITUTION` / L1 三 Freeze / L2（ADR-001 / P5_FINAL_FREEZE / ARCHITECTURE_TARGET）**零冲突**。
- 未新增架构规则 / 业务域 / 数据治理规则（仅消费既有 `legacy_id_maps` / `migration_issues` / 冻结目标模型）。
- 未修改 WP1/WP2/WP3 任何设计或脚本（仅新增 `src/reconcile.js` 与 `test/reconcile.test.js`）。
- 未触碰生产数据、未部署、未进入 WP5。

---

## 引用与依据

- P8-3 Definition Freeze §7（WP4 = 数据对账与一致性校验）、§4（生产切换 OUT OF SCOPE）。
- WP1 §2.4 目标部署拓扑（对账不改生产访问拓扑）。
- WP2 §4 / §5（`legacy_id_maps` / `migration_issues` 迁移支撑表语义）。
- D1-DATABASE-DESIGN（INTEGER PK + ULID public_id + epoch 冻结目标模型）。
- ARCHITECTURE_FREEZE F-DB-1 / F-API-1（单一 DB / 单一 API，对账不引入第二组件）。
