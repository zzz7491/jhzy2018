# P8-3 WP6 — Test Migration Rehearsal + Reconciliation + Rollback Rehearsal

> **阶段定位（严格遵循 `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md`）**
>
> WP6 = **Test Migration Rehearsal + Reconciliation + Rollback Rehearsal**。
> 生产正式迁移 / 生产部署 / 正式切换 / 灰度放量：**OUT OF SCOPE**，不属于 P8-3 任何 WP。
> 本轮只在隔离测试目标（MemoryTarget / 本地 FileCheckpoint）上演练，**未连接任何生产库、未写入任何生产数据、未部署**。

| 项 | 值 |
|---|---|
| 文档层级 | L3（实现层演练报告） |
| 上位 L0 | `PROJECT_CONSTITUTION.md` |
| 上位 L1 | `ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md` |
| 上位 L2 | `ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md` |
| 同级 L3 设计依据 | `P8-3_WP1_*` / `P8-3_WP2_*` / `P8-3_WP3_IMPLEMENTATION.md` / `P8-3_WP4_*` / `P8-3_WP5_*` |
| 演练结果 | **P8-3 WP6 Gate = PASS** |
| Ready for Closeout | **YES**（前置：用户显式授权） |

---

## 1. Rehearsal Environment Gate

| 检查项 | 结果 |
|---|---|
| source 类型 | `FixtureSource`（确定性内存夹具，非生产 dump） |
| target 类型 | `MemoryTarget`（隔离本地目标，无任何外部连接） |
| `sourceIsFixture` | **true** |
| `targetIsolated` | **true** |
| `productionCredentialsAbsent` | **YES**（`detectedProductionEnvKeys = []`） |
| `productionDbEndpointAbsent` | **YES** |
| `productionWriteCapabilityAbsent` | **YES**（target 非 `D1Target`） |
| `fileCheckpointPersistenceVerified` | **true**（save → 新实例 load → reset 全链路可用） |
| Preflight（PF-01…PF-10） | **PASS / decision=PROCEED** |

**固定标识（已写入证据包）**

| 标识 | 值 |
|---|---|
| `batchId` | `WP6-<epoch>`（每次演练唯一） |
| `operator` | `p8-3-rehearsal-harness` + ISO 时间戳 |
| source hash | `sha256 → 53bc525607ffc8d196ac84885f71039e6213b72d3572096d9f4c446b54a9a956` |
| migration version | `p8-3-migration@1.0.0` |
| reconciliation version | `p8-3-reconcile@1.0.0` |
| rollback version | `p8-3-rollback@1.0.0` |
| recovery / runbook / checkpoint version | `p8-3-recovery@1.0.0` / `p8-3-runbook@1.0.0` / `p8-3-checkpoint@1.0.0` |

**环境扫描透明度**：扫描 198 个环境变量，其中 `TENCENT_DOCS_LOCAL_MCP`、`TENCENT_DOCS_LOCAL_SERVER` 为本地工具链变量（WorkBuddy 本地文档 MCP），**不具备本项目生产数据面凭据语义**，故不计入 production write capability，但在证据包 `envScan.observedNonCredentialKeys` 中显式列出。

> 首轮实施时，环境探测器曾因过宽的 `/^TENCENT/i` 模式把上述两个本地变量误判为生产凭据并触发 STOP。该**误报已在本轮收窄为凭据语义模式后消除**，属探测器自身缺陷修正，非环境变化。

---

## 2. Clean Test Migration（完整 B0–B20）

**结果：COMPLETED**

| 指标 | 值 |
|---|---|
| 源总行数（含 EXCLUDED） | **35** |
| 源总行数（参与迁移口径，剔除 EXCLUDED） | **34** |
| 按 kind 分布 | MIGRATE 25 / MERGE 7 / ARCHIVE 1 / DROP 1 / EXCLUDED 1 / TRANSFORM 0 |
| migrated（legacy_id_maps） | **32** |
| archived | **1** |
| dropped | **1** |
| excluded | **1** |
| failed | **0** |
| skippedIdempotent | 0 |
| target 实际写入行数 | 35（MERGE 场景一行源可产出多目标行） |
| `legacy_id_maps` 计数 | 32 |
| `migration_issues` 计数 | 2（excluded 1 / dropped 1） |
| checkpoint | `doneTables=130`，`lastBatch=B18` |

**user_favorites 状态贯穿全程**：`EXCLUDED` / `BCR pending` / not migrated / not dropped / not archived —— 逐轮都由 `excluded_unknown` 校验确认（见 §3）。

---

## 3. Reconciliation（WP4 对账引擎）

**结果：PASS**（9/9 维度）

| 维度 | 结果 |
|---|---|
| `row_conservation` | **PASS** — `34 === 32 + 1 + 1 + 0`（migrated + archived + dropped + failed） |
| `identity_integrity` | **PASS** — legacy_id_maps 唯一、public_id 唯一、openid/unionid 唯一 |
| `relationship_integrity` | **PASS** — 无孤儿 FK，legacy→target 映射完整 |
| `activity_chain` | **PASS** — activity → signup → attendance → service_record |
| `points_growth` | **PASS** — 无 MERGE/TRANSFORM 重复累计 |
| `training_result` | **PASS** — courses / enrollments / learning / exam / certificates |
| `media_references` | **PASS** — 无缺失/重复资产引用 |
| `audit_integrity` | **PASS** |
| `excluded_unknown` | **PASS** — user_favorites `bcrPending=true` |

**STOP 评估**：`status=PROCEED`、`nextBatchAllowed=true`、`criticals=0`。

> 夹具修正说明：WP6 首版夹具沿用了 `api.activity_signups`、`api.courses` 两个**并非 TABLE_MAP 真实键名**的表，导致活动报名链（B6）与培训链（B11）实际为空、各项链校验是"空集通过"。本轮已改为真实映射键 `api.jhzy_activity_signups`（B6→`activity_signups`）、`api.training_courses` / `api.training_user_course_status` / `api.training_user_progress`（B11→`courses` / `course_enrollments` / `learning_records`），使**活动链与培训链被真实数据覆盖**。

---

## 4. Resume / Idempotency Rehearsal

**结果：PASS**

| 场景 | 观测 |
|---|---|
| A. 同一 `FileCheckpoint` 实例重跑 | `inserted=0`、`tablesProcessed=0`（`doneTables` 命中跳过） |
| B. **新进程/新 FileCheckpoint 实例**读取同一 checkpoint | 读出 `doneTables=130`，跨实例续跑 `inserted=0`、`tablesProcessed=0` |
| C. 重跑副作用 | `legacy_id_maps` 32→32（无重复）；`points_ledger` 1→1（无重复累计）；无额外业务记录 |
| 重跑后对账 | **PASS**（`balanced=true`） |

---

## 5. Failure Injection（6 类）

**结果：PASS（6/6）** —— 全部满足「reconciliation FAIL / STOP 触发 / 不得继续下一 batch / evidence 记录」。

| # | 注入场景 | reconcile | 关键 check | STOP | 判定 |
|---|---|---|---|---|---|
| FI-1 | Batch 中途失败（B6 `api.jhzy_activity_signups` 第 2 行流式抛错） | PASS* | `row_conservation` 记账正确 + 批次不完整 | **STOP**（运行级） | PASS |
| FI-2 | relationship / orphan（删除目标 activities 行） | FAIL | `relationship_integrity=FAIL` | SC-03, SC-04 | PASS |
| FI-3 | row conservation mismatch（迁移后新增源行） | FAIL | `row_conservation=FAIL` | SC-01, SC-03, SC-04 | PASS |
| FI-4 | duplicate identity（重复 legacy_id_maps target） | FAIL | `identity_integrity=FAIL` | SC-01, SC-02, SC-03, SC-04 | PASS |
| FI-5 | missing legacy mapping（移除一条 legacy_id_maps） | FAIL | `row_conservation=FAIL` + `relationship_integrity=FAIL` | SC-01, SC-03, SC-04 | PASS |
| FI-6 | points duplication（重复 points_ledger 行） | FAIL | `points_growth=FAIL` | SC-05 | PASS |

**\* FI-1 的 reconcile 为何仍是 PASS（重要，非漏检）**：
批处理失败被 runner 正确记为 `conflict`（`severity=error`、`resolution_status=open`）issue，而 `row_conservation` 的守恒公式含 **failed** 项，因此该场景"记账正确"而非"数据静默丢失"——守恒保持 PASS 是**正确行为**。
真正必须命中的是「不得继续后续 batch」：该批次 `sourceRows=2 / migrated=0`（不完整），`runnerErrors=1`、`openErrorIssues=1`，演练层触发 **运行级 STOP** 并阻断下一批。

> 由此暴露 **DEFECT-WP6-02**（见 §10）：WP5 冻结的 SC-01…SC-14 未覆盖"未决迁移错误 / 不完整批次"，单靠 `evaluateStopConditions` 会返回 PROCEED。

---

## 6. Batch Rollback Rehearsal（CLASS_1_BATCH，选取 B6）

序列：migration → reconciliation(PASS) → injected failure → batch rollback → recovery verification → re-run batch → reconciliation(PASS)

| 项目 | 观测 |
|---|---|
| 回滚前 reconcile | PASS |
| `rowsRemoved` | **2**（仅本批写入的 `activity_signups` 行） |
| `idmapsRemoved` | **2** |
| `archiveRemoved` | 0（B6 无 ARCHIVE 对象） |
| checkpoint 回退 | `removed=7`（B6 的 7 个 srcKey 从 `doneTables` 移除） |
| `issuesRetained` | **3**（含新增 1 条 `issue_type=rollback`） |

**批次级恢复验证 `verifyBatchRecovery`（7/7 PASS）**
`batch_target_rows_removed` / `legacy_id_maps_handled` / `migration_issues_retained` / `checkpoint_rolled_back` / `source_untouched` / `user_favorites_excluded` / `batch_archive_cleared`。

**批次可重跑**：`inserted=2`、`tablesProcessed=7`，重跑后 `reconcile=PASS`。
其中 `batch_target_rows_removed` 采用**精确残差比对**（`预期 = 回滚前行数 − rowsRemovedByTable`），避免"表恰好为空"造成的假通过。

---

## 7. Full Test Rollback（CLASS_2_FULL_TEST）

| 项目 | 观测 |
|---|---|
| 回滚前 reconcile | PASS |
| `rowsCleared` | **35** |
| `idmapsCleared` | **32** |
| `archiveCleared` | **1** |
| `checkpointReset` | `{reset: true, error: null}`（FileCheckpoint.reset 正常工作） |
| `issuesRetained` | **3**（审计证据保留，另追加 rollback 记录） |

**`verifyRecovery`（7/7 PASS）**
`target_state_restored` / `source_untouched` / `no_orphan_migration_rows` / `no_stale_checkpoints` / `no_invalid_legacy_id_maps` / `no_unintended_user_favorites_migration` / `reconciliation_state_valid`。

确认：测试目标回到 rehearsal 起点；无孤儿迁移数据；无 stale checkpoint；无无效 legacy_id_maps；审计证据保留；**user_favorites 未被意外迁移**；源数据未被触碰。

---

## 8. Second Clean Run

**结果：PASS**

| 对比项 | 首次 | 二次 |
|---|---|---|
| migrated | 32 | **32** |
| archived | 1 | **1** |
| dropped | 1 | **1** |
| reconcile | PASS | **PASS** |
| STOP 评估 | PROCEED | **PROCEED** |

证明：**完整回滚后迁移流水线仍可重新执行，且结果与首次完全一致**（确定性）。
`target_d` 已由 §7 的 `verifyRecovery` 证明回到迁移前基线；二次迁移在**全新隔离目标**上执行（原因见 DEFECT-WP6-01）。

---

## 9. Evidence Package

| 产物 | 路径 |
|---|---|
| 机器可读证据包 | `p8-3-migration/evidence/wp6-evidence.json`（schema `p8-3-wp6-rehearsal-evidence/v1`） |
| 可读摘要 | `p8-3-migration/evidence/wp6-summary.txt` |
| 演练编排器 | `p8-3-migration/src/rehearsal.js` |
| 演练执行脚本 | `p8-3-migration/scripts/run-rehearsal.mjs` |
| 自动门禁测试 | `p8-3-migration/test/wp6.test.js`（17 项） |

证据包包含：rehearsal environment / env scan / source hash / code & version identifiers / batchId / operator / preflight result / migration stats / reconciliation result（9 维）/ injected failures（6 类）/ STOP evidence / batch rollback evidence / full rollback evidence / recovery verification（批次级 + 完整级）/ second clean run result / final checkpoint state / **defects**。

复跑方式：`node scripts/run-rehearsal.mjs`（写入 `evidence/`）或 `node --test test/wp6.test.js`（门禁断言）。

---

## 10. 已发现缺陷（本轮登记，未修复，等待授权）

### DEFECT-WP6-01 — migration_issues 缺少 run 维度隔离（HIGH）

- **现象**：`migration_issues` 永不删除是 WP5 冻结规则（正确）。但完整回滚后若**在同一 ledger** 上二次迁移，runner 会再次写入 per-row `dropped` 与 per-run `excluded` issue，而 `reconcile` 以**全量 issues** 计数 → dropped 翻倍（1→2）、excluded 翻倍 → `row_conservation` 守恒被打破（34 ≠ 32+1+2）。
- **影响**：`rollbackFull → 同目标二次迁移` 这条路径当前不可用。
- **本轮处置**：未修改已冻结的 WP3 `runner.js` / WP4 `reconcile.js`；二次迁移改在全新隔离目标上执行并如实标注方法。
- **PROPOSED（未实施）**：为 `migration_issues` 增加 `run_id`（或 migration run uid），`reconcile` 按当前 run 过滤计数；issues 仍全量保留作为审计证据。

### DEFECT-WP6-02 — STOP 条件未覆盖「未决迁移错误 / 不完整批次」（HIGH）

- **现象**：FI-1 证明批处理失败会被记为 `conflict`(severity=error / open) issue，但 WP5 冻结的 `SC-01…SC-14` **没有任何一条**检查 runner errors 或 open error issue → `evaluateStopConditions` 返回 `PROCEED / nextBatchAllowed=true`，运行可带着半成品批次继续。
- **影响**：违反 WP5 §D「任何 Critical：立即 STOP，不得继续下一 Batch」。
- **本轮处置**：`rehearsal.js` 在演练层补充 `runLevelStop`（`stats.errors > 0` 或存在 open error issue），**未修改 `runbook.js`**。
- **PROPOSED（未实施）**：在 `runbook.js` 增列 **SC-15「unresolved migration error / incomplete batch」（CRITICAL）**。

---

## FINAL GATE

| Gate 项 | 结果 |
|---|---|
| Rehearsal environment isolated | **YES** |
| Production credentials absent | **YES** |
| Full B0-B20 migration completed | **YES** |
| Clean reconciliation | **PASS** |
| Resume persistence | **PASS** |
| Idempotency | **PASS** |
| Failure injection | **PASS**（6/6） |
| STOP conditions triggered correctly | **YES** |
| Batch rollback | **PASS** |
| Batch recovery verification | **PASS** |
| Full rollback | **PASS** |
| Full recovery verification | **PASS** |
| Second clean migration | **PASS** |
| user_favorites exclusion preserved | **YES**（EXCLUDED / BCR pending / 未迁移 / 未 DROP / 未归档） |
| Evidence package complete | **YES** |
| Freeze Conflict Count | **0** |
| Production data touched | **NO** |
| Production deployment performed | **NO** |
| Tests | **68 passed / 0 failed**（WP3 19 + WP4 8 + WP5 16 + checkpoint 8 + WP6 17） |

### P8-3 WP6 Gate = **PASS**
### P8-3 Ready for Closeout = **YES**（前置：用户显式授权）

---

## 边界重申

即使 WP6 PASS，也**不得自行进入生产迁移、部署、灰度或正式切换**。
P8-3 完成后**只允许进入 P8-3 Closeout**；任何未来生产切换阶段必须重新经过**独立 Definition Gate** 和**用户显式授权**。

---

## 11. HIGH DEFECT CLOSURE（用户授权：P8-3 WP6 — HIGH DEFECT CLOSURE ONLY）

> 授权范围：仅修复 DEFECT-WP6-01 / DEFECT-WP6-02，不重做 WP6，不扩大 Scope，不进入生产。
> 本轮未修改 Definition Freeze / Constitution / Core Domain / 数据治理冻结规则。
> 历史演练事实（第 1–10 节、第 10 节缺陷登记状态）保持不变；本节仅追加闭环结果。

### 11.1 DEFECT-WP6-01 — 已修复（YES）

- **根因**：`migration_issues` 永不删除是正确的审计规则；但缺少 run 维度，导致同 ledger 二次迁移时历史 issue 污染当前 run 的对账守恒。
- **修复**：
  - `runner.js` 为每次 `runMigration` 生成稳定唯一 `run_id`（显式 `opts.runId` 优先，否则由 `rng/now` 推导的 ULID），并写入**全部** issue 记录（excluded / dropped / dirty / conflict）。
  - `reconcile.js` 接受 `opts.runId`；提供时只对**当前 run** 的 issue 计数（row_conservation / excluded_unknown）。`migration_issues` 仍**全量保留**，不删除、不改造为业务工单。
  - `rollback.js` 回滚证据 issue 也写入 `run_id`（贯穿 Runner → migration_issues → reconciliation → rollback evidence → rehearsal evidence）。
- **验证（同 ledger 不换新目标）**：Run A 迁移 + 全量对账 PASS → Full Rollback（issues 保留）→ Run B 同 ledger 二次迁移 + 对账 PASS；Run A 历史 issue 仍存在（3 条，含 rollback 证据），Run B 当前 run `dropped=1`（未被历史翻倍为 2）；`current-run reconciliation filtering = PASS`。

### 11.2 DEFECT-WP6-02 — 已修复（YES）

- **根因**：FI-1 证明批处理失败会记为 open error issue，但 `SC-01…SC-14` 不覆盖「未决迁移错误 / 不完整批次」，导致可带着半成品批次继续。
- **修复**：`runbook.js` 正式新增 **SC-15「open migration error / incomplete batch」（CRITICAL）**，`evaluateStopConditions` 据此判定 `STOP / nextBatchAllowed=false`；open error 经 `ctx.openErrorIssues`（由 `currentRunOpenErrorIssues(target, runId)` 按 `run_id` 作用域提取）传入，历史 run 的 open error **不污染**当前 run。原 `rehearsal.js` 私有 `runLevelStop` 兜底已移除，改为正式调用 SC-15。
- **验证**：① 当前 run open error issue → `STOP`、命中 `SC-15`、`nextBatchAllowed=false`；② 当前批次 incomplete（无 open error）→ `STOP`、命中 `SC-15`；③ resolved/closed 历史 error → 不触发；④ 历史 run 的 open error（ledger 上仍保留）→ 评估新 run 时 `PROCEED`，不触发 `SC-15`。

### 11.3 FINAL GATE（本轮 HIGH DEFECT CLOSURE）

| Gate 项 | 结果 |
|---|---|
| DEFECT-WP6-01 fixed | **YES** |
| run_id implemented | **YES** |
| historical issues retained | **YES** |
| current-run reconciliation filtering | **PASS** |
| same-ledger second migration | **PASS** |
| DEFECT-WP6-02 fixed | **YES** |
| SC-15 implemented | **YES** |
| open current-run migration error triggers STOP | **YES** |
| incomplete batch triggers STOP | **YES** |
| historical run error isolation | **PASS** |
| nextBatchAllowed false on SC-15 | **YES** |
| Targeted rehearsal — Run A reconciliation | **PASS** |
| Targeted rehearsal — Full rollback | **PASS** |
| Targeted rehearsal — Recovery verification | **PASS** |
| Targeted rehearsal — Same-ledger Run B reconciliation | **PASS** |
| Targeted rehearsal — SC-15 injection | **PASS** |
| Freeze Conflict Count | **0** |
| Production data touched | **NO** |
| Production deployment performed | **NO** |
| **P8-3 WP6 HIGH DEFECT CLOSURE** | **PASS** |
| **P8-3 WP6 FINAL Gate** | **PASS** |
| **P8-3 Ready for Closeout** | **YES** |

### 11.4 测试

- 全量套件：**81 passed / 0 failed**（`node --test`）。
- 新增 `test/wp6-defect-closure.test.js`（8 项）覆盖 D1–D13 与 R1–R5；`test/wp5.test.js` 增补 SC-15 单元（5 项）；既有 68 项全部保持通过。
- 复跑方式：`node --test test/wp6-defect-closure.test.js` 或全量 `node --test`。

### 11.5 边界重申（本轮）

- 仅修复两个 HIGH 缺陷；**未进入 P8-3 Closeout**、**未执行任何生产迁移 / 部署 / 灰度 / 正式切换**。
- 代码改动限定于：`src/runner.js`、`src/reconcile.js`、`src/runbook.js`、`src/rollback.js`、`src/rehearsal.js`（新增 `rehearseDefectClosure` + 移除私有兜底）；文档仅追加本节并对 WP5 Runbook 文档做最小 SC-15 一致性更新。
- 仓库改动未 `git add` / `commit` / `push`（遵循工作纪律，待用户显式授权）。
本轮未修改 `PROJECT_CONSTITUTION` / 任何 Freeze / Core Domain / 业务代码 / 生产库，未执行 Git 操作（staged=0）。
