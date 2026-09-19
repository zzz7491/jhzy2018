# P8-3 WP5 — Rollback Plan + Cutover Runbook

> **Authority（权威层级）**
> - L0：`PROJECT_CONSTITUTION.md`（唯一顶层宪法）
> - L1：`ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md`
> - L2：`ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md`
> - L3：`D1-*` / `D1-RBAC-DESIGN` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / 其它现行设计文档
> - **本文件：`P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md` 下的 WP5 交付物（L3）**

---

## 0. 阶段定位与边界

| 项 | 内容 |
|---|---|
| 阶段 | **P8-3 WP5 = Rollback Plan + Cutover Runbook** |
| 上游 Gate | P8-3 WP1 = PASS / WP2 = FINAL PASS / WP3 = PASS / WP4 = FINAL PASS |
| 本阶段性质 | **只设计与准备**：Runbook、回滚方案、Checklist、STOP 条件、恢复验证工具 |
| OUT OF SCOPE | 生产正式迁移 / 生产部署 / 正式切换（域名·小程序）/ 灰度放量 |
| 生产数据 | **touched = NO**（全程 MemoryTarget 测试适配器，无 D1 binding） |

> **阶段定义纠正（重要）**：此前一度将 WP4 误写为「生产切换/灰度/正式部署」。本文件严格按 `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md` 已冻结的 Work Packages 执行：
> WP1 迁移设计总案 → WP2 表映射与迁移支撑设计 → WP3 迁移脚本实现 → **WP4 数据对账与一致性校验** → **WP5 回滚方案 + 切换 Runbook** → WP6 测试迁移演练 + 对账 + 回滚演练。
> 生产正式迁移/部署/切换/灰度 **不属于 P8-3 任何 WP**。

---

## 1. 交付物清单

| 类型 | 路径 | 说明 |
|---|---|---|
| Runbook 工具 | `p8-3-migration/src/runbook.js` | Preflight 校验、B0–B20 批次 Runbook、STOP 条件、三类回滚方案、操作清单、WP6 契约、证据记录构造器 |
| 回滚执行器 | `p8-3-migration/src/rollback.js` | `rollbackBatch`（CLASS_1）、`rollbackFull`（CLASS_2）、CLASS_3 设计声明 |
| 恢复验证 | `p8-3-migration/src/recovery.js` | `verifyRecovery()` 7 项机器校验，输出 PASS/FAIL |
| 操作清单模板 | `p8-3-migration/templates/operator-checklist.md` | 7 阶段可勾选清单（含 STOP 速查表） |
| 证据记录模板 | `p8-3-migration/templates/operator-evidence.json` | Operator Evidence Record 结构（schema `p8-3-operator-evidence/v1`） |
| 自动测试 | `p8-3-migration/test/wp5.test.js` | 16 项测试 |
| 本文件 | `docs/production-audit/P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` | WP5 正式说明与 Gate |

复用（未修改）：`src/batches.js`（B0–B20）、`src/tablemap.js`、`src/runner.js`、`src/reconcile.js`、`src/adapters.js`、`src/checkpoint.js`。

---

## 2. 正式生产拓扑（冻结，WP5 不得修改）

```
中国大陆用户 / 微信小程序 / 管理端
→ 国内备案域名
→ 腾讯云国内服务器（国内接入 / 网关 / 反向代理）
→ Cloudflare Worker
→ Cloudflare D1（2.0 唯一权威业务数据库）
→ R2 / KV 等 Cloudflare 服务
```

约束（与 WP1 §2.4 一致）：
1. 腾讯云承担中国大陆对外服务入口。
2. **腾讯云 MySQL 不作为 2.0 正式业务数据库**（非 authoritative DB）。
3. Cloudflare D1 保存 2.0 权威业务数据。
4. 客户端不得因迁移设计而绕过腾讯云国内入口直接改变正式生产访问拓扑。
5. WP5 仍只设计回滚与切换 Runbook，不实施网络/网关/部署修改。

---

## A. Preflight（执行前必须确认）

机器校验：`runPreflight(ctx)` → `{ status, errors, warnings, checks, decision }`。
任一 **critical** 失败 → `decision = STOP`，不得开始迁移。

| ID | 检查项 | Critical | 证据 |
|---|---|---|---|
| PF-01 | P8-3 WP1–WP4 Gate 全部 PASS | ✅ | Gate 记录 |
| PF-02 | Freeze Conflict = 0 | ✅ | 一致性自检 |
| PF-03 | source dump 完整（complete + tableCount>0） | ✅ | dump 清单 |
| PF-04 | source snapshot / hash 可验证 | ✅ | hash |
| PF-05 | target test D1 状态明确 | ✅ | 目标库状态快照 |
| PF-06 | migration scripts version 固定 | ✅ | version 字符串 |
| PF-07 | reconciliation version 固定 | ✅ | version 字符串 |
| PF-08 | user_favorites 明确 EXCLUDED / BCR pending | ✅ | exclusion issue |
| PF-09 | rollback point 已建立 | ✅ | restore point ref |
| PF-10 | operator / timestamp / batch ID 可记录 | ✅ | 证据记录 |

---

## B. Migration Sequence（B0–B20，严格沿用既有批次）

**不得重新设计批次。** 每个 Batch 的 Runbook 由 `BATCH_RUNBOOK` 生成，字段固定为 9 项：
`preconditions` / `input` / `procedure` / `checkpoint` / `reconciliation` / `passCriteria` / `failCriteria` / `rollbackBoundary` / `evidence`。

| Batch | 内容 | 输入源对象 | 回滚边界 |
|---|---|---|---|
| B0 | RBAC 种子 | roles/permissions/role_permissions + user_favorites(EXCLUDED) | CLASS_1_BATCH |
| B1 | 身份与用户档案 | users/volunteers/… | CLASS_1_BATCH |
| B2 | 会话 | user_tokens/admin_tokens | CLASS_1_BATCH |
| B3 | 团队与成员 | teams/team_members | CLASS_1_BATCH |
| B4 | 用户角色 + 临时表归档 | admins/volunteers_temp | CLASS_1_BATCH |
| B5 | 活动中心 | **activities** 等 | CLASS_1_BATCH |
| B6 | 活动报名 | activity_signups/participants | CLASS_1_BATCH |
| B7 | 签到签退 | checkins/geo/device | CLASS_1_BATCH |
| B8 | 服务记录 + quick_actions 归档 | casual_records / **quick_actions(ARCHIVE)** | CLASS_1_BATCH |
| B9 | 积分流水 | points_transactions 等 | CLASS_1_BATCH |
| B10 | 成长等级 | growth/levels/badges/achievements | CLASS_1_BATCH |
| B11 | 培训中心 | courses/lessons/enrollments | CLASS_1_BATCH |
| B12 | 考试中心 | exam questions/sessions/answers | CLASS_1_BATCH |
| B13 | 证书中心 | certificates/templates/id_pools | CLASS_1_BATCH |
| B14 | 商城中心 | mall products/orders + welfare_options | CLASS_1_BATCH |
| B15 | 通知中心 | notifications | CLASS_1_BATCH |
| B16 | 内容中心 | articles/reports/carousel/feedback | CLASS_1_BATCH |
| B17 | 文件中心 | uploads/avatars/images + **qr_codes(DROP)** | CLASS_1_BATCH |
| B18 | 系统管理/审计/安全 | operation_logs/security_events/config | CLASS_1_BATCH |
| B19 | 保留（无 1.0 源） | — | CLASS_1_BATCH |
| B20 | 收尾（idmap/issues 完整性 + checkpoint 关闭） | — | CLASS_1_BATCH |

每批通用：
- **Preconditions**：preflight PROCEED + 上一批 checkpoint 且 reconcile PASS + 无未决 CRITICAL。
- **Procedure**：`runMigration({ source, target, opts:{ batch, checkpoint, logger } })`；`EXCLUSIONS = ['api.user_favorites']` 永不进入任何批次。
- **Checkpoint**：`doneTables += 本批 srcKey`；`migration_batch = 批次号`；支持 resume；单行失败记 `migration_issues` 不中断整批。
- **Reconciliation**：`reconcile({ source, target })` 9 维。

---

## C. Cutover Runbook（未来正式切换 —— **只写不执行**）

> ⚠️ 本节是「未来正式切换时应该执行的 Runbook」。**WP5 不执行，且生产切换本身属 P8-3 OUT OF SCOPE**，须经独立 Definition Gate + 管理员授权。

### C.1 前置（未来）
- WP6 测试演练全通过（迁移 → 对账 → 故障注入 → 回滚 → 恢复验证）。
- 生产切换 Definition Gate PASS；管理员书面授权。
- 生产回滚点（restore point）已建立并验证可恢复。

### C.2 切换步骤（未来）
1. **冻结写入**：1.0 侧置维护态，停止新写入（腾讯云入口返回维护页）。
2. **最终增量迁移**：执行增量批次，并对账。
3. **对账 Gate**：`reconcile` 全维 PASS + `evaluateStopConditions = PROCEED`。
4. **权威切换**：Cloudflare Worker 指向 D1 为唯一权威源；腾讯云入口/域名保持为唯一对外入口，回源指向 Worker。
5. **冒烟验证**：登录 / 报名 / 签到 / 积分 / 证书 核心链路。
6. **放量**：灰度 → 全量（**灰度放量属 OUT OF SCOPE，需另行授权**）。

### C.3 拓扑红线
- 腾讯云国内入口**保持不变**，Worker 与 D1 位于入口之后，客户端不得绕过。
- **腾讯云 MySQL 不得成为 2.0 authoritative DB**（任何阶段）。

---

## D. STOP / Abort Conditions

机器校验：`evaluateStopConditions({ reconcileResult, ctx })` → `{ status: STOP|PROCEED, criticals, warnings, nextBatchAllowed }`。
**任一 CRITICAL 命中 → 立即 STOP，不得继续下一 Batch。**

| ID | 条件 | 级别 | 检测来源 |
|---|---|---|---|
| SC-01 | row conservation FAIL | CRITICAL | `reconcile.row_conservation` |
| SC-02 | identity duplicate | CRITICAL | `reconcile.identity_integrity` |
| SC-03 | orphan relation | CRITICAL | `reconcile.relationship_integrity` |
| SC-04 | missing legacy mapping | CRITICAL | `relationship_integrity.detail`（覆盖缺口/悬空） |
| SC-05 | points/growth mismatch | CRITICAL | `reconcile.points_growth` |
| SC-06 | training/certificate mismatch | CRITICAL | `reconcile.training_result` |
| SC-07 | media reference critical failure | WARNING | `reconcile.media_references` |
| SC-08 | audit integrity failure | CRITICAL | `reconcile.audit_integrity` |
| SC-09 | unexpected schema | CRITICAL | schema signature 比对 |
| SC-10 | migration script version mismatch | CRITICAL | versions 比对 |
| SC-11 | source snapshot mismatch | CRITICAL | snapshot hash 比对 |
| SC-12 | target contamination | CRITICAL | `targetState.clean === false` |
| SC-13 | Freeze conflict | CRITICAL | `freezeConflict !== 0` |
| SC-14 | unauthorized production access | CRITICAL | `productionAccess === true` |
| SC-15 | open migration error / incomplete batch | CRITICAL | 当前 run 存在 `severity=error/critical && status=open/unresolved` 的 migration issue，或当前批次未完成却准备继续（依据 `ctx.openErrorIssues` / `ctx.currentBatchIncomplete`，按 `run_id` 作用域隔离，历史 run 不污染） |

---

## E. Rollback Plan（三类，严格区分）

| 类 | 名称 | WP5 可执行 | 环境 |
|---|---|---|---|
| CLASS 1 | Batch Rollback（单批次回滚） | ✅ | test |
| CLASS 2 | Full Test Migration Rollback（完整测试回滚） | ✅ | test |
| CLASS 3 | Future Production Cutover Rollback（未来生产切换回滚） | ❌ **DESIGN ONLY** | production |

### E.1 CLASS_1_BATCH
- **Trigger**：本批 reconcile FAIL / 触发任一 CRITICAL / 本批目标污染。
- **Scope**：仅回滚指定 Batch 写入的目标行（按 `legacy_id_maps.migration_batch` 定位），其它批次不受影响。
- **Restore point**：该 Batch 开始前 checkpoint 快照。
- **Checkpoint**：从 `doneTables` 移除本批 srcKey，使本批可重跑。
- **legacy_id_maps**：删除本批记录，其余批次保留（保证映射链完整）。
- **migration_issues**：**不得删除**；新增 `issue_type=rollback` 记录（证据保留）。
- **Archive**：删除本批产生的 `migration_archive` 冷存条目。
- **Verification**：批次级检查 + 重跑本批。
- **命令**：`rollbackBatch({ target, checkpoint, batch: 'Bxx' })`。

### E.2 CLASS_2_FULL_TEST
- **Trigger**：多批连续 FAIL 无法定位 / 测试库污染 / WP6 需回到迁移前基线。
- **Scope**：清空测试目标全部迁移产物（业务表行 + `legacy_id_maps` + `migration_archive`）。
- **Checkpoint**：`checkpoint.reset()` 全清。
- **legacy_id_maps / archive**：全部清除。
- **migration_issues**：**保留**（审计证据不可删），追加 rollback 记录。
- **Verification**：`verifyRecovery()` → 必须 PASS。
- **命令**：`rollbackFull({ target, checkpoint })`。

### E.3 CLASS_3_FUTURE_PRODUCTION（DESIGN ONLY，WP5 不执行）
原则：
1. 达到 rollback trigger 即回滚，**不在生产现场调试**。
2. 回滚恢复到「切换前生产状态」：腾讯云入口回指 1.0；D1 未确认前不作为对外权威源。
3. D1 侧依赖切换前 **快照 / 时间点恢复（restore point）**，不做逐行 DELETE。
4. `legacy_id_maps` / `migration_issues` **全量保留**作为审计证据。
5. 回滚后必须执行 Recovery Verification 并留存 Operator Evidence Record。
6. 腾讯云 MySQL 在回滚态下仍不得被当作 2.0 authoritative DB。

---

## F. Recovery Verification（回滚后机器验证）

`verifyRecovery({ source, target, checkpoint, baseline })` → `{ status: PASS|FAIL, errors, warnings, checks }`

| 校验项 | 判据 | FAIL 语义 |
|---|---|---|
| `target_state_restored` | 全部业务表行 = 0 | 回滚后仍有残留目标行 |
| `source_untouched` | 当前源行数 == baseline | 回滚触碰了源库（禁止） |
| `no_orphan_migration_rows` | `legacy_id_maps` = 0 且 `migration_archive` = 0 | 残留迁移行 |
| `no_stale_checkpoints` | `doneTables` = 0 | 残留进度会导致重跑被跳过 |
| `no_invalid_legacy_id_maps` | 无映射记录、无残缺记录 | 映射链污染 |
| `no_unintended_user_favorites_migration` | user_favorites 无映射、无迁移类 issue、且保留 excluded 记录 | user_favorites 被迁移或丢失 excluded 状态 |
| `reconciliation_state_valid` | `reconcile()` 可运行且 `migrated=0 && archived=0` | 回滚态不自洽 |

---

## G. Operator Checklist（禁止凭经验判断）

7 个阶段、27 项，每项都有 ID / blocking / evidence。模板：`templates/operator-checklist.md`。

```
PRE-FLIGHT (OC-01…OC-09) → MIGRATE (OC-10…OC-13) → RECONCILE (OC-14…OC-16)
→ DECISION (OC-17…OC-18) → ROLLBACK / CONTINUE (OC-19…OC-21)
→ EVIDENCE (OC-22…OC-24) → CLOSEOUT (OC-25…OC-27)
```

**Operator Evidence Record**（`templates/operator-evidence.json`，schema `p8-3-operator-evidence/v1`）：
operator / timestamp / batchId / phase / result / versions / preflight / reconcile / stopConditions / rollback / recovery / topology / productionBoundary / userFavorites。
构造器：`buildEvidenceRecord({ operator, phase, batchId, result, extras })`，其中 `productionBoundary.productionDataTouched` 恒为 `false`、`userFavorites.migrated` 恒为 `false`。

---

## H. WP6 Rehearsal Contract（WP5 只定义，不演练）

`WP6_REHEARSAL_CONTRACT.executedBy = 'WP6'`、`executedNow = false`。

| 步骤 | 动作 | 验证 |
|---|---|---|
| RS-1 | Test Migration | runMigration 完成 + checkpoint 记录 |
| RS-2 | Reconciliation | reconcile.status 与预期一致 |
| RS-3 | Failure Injection | reconcile 与 STOP 条件必须 FAIL 并阻断 |
| RS-4 | Rollback | CLASS_1 / CLASS_2 回滚统计 + rollback issue |
| RS-5 | Recovery Verification | `verifyRecovery()` = PASS |

**Entry Gates**：WP5 Gate PASS / Preflight 测试环境全通过 / 回滚工具可用 / baseline source counts 已采集。
**Exit Evidence**：各步 JSON 输出 + Operator Evidence Record + migration_issues 全量 + WP6 Gate 结论。

---

## 9. 一致性自检

| 检查项 | 结果 |
|---|---|
| 与 `PROJECT_CONSTITUTION`（L0）冲突 | 0（仅引用，未新增原则） |
| 与 `ARCHITECTURE_FREEZE` 冲突 | 0（单一 DB/单一 API；腾讯云仅入口） |
| 与 `BUSINESS_BOUNDARY` 冲突 | 0（未新增业务域） |
| 与 `DATA_GOVERNANCE_FREEZE` 冲突 | 0（未新增治理规则；支撑表不演化业务表） |
| 与 `ARCHITECTURE_TARGET` / ADR-001 冲突 | 0 |
| New Architecture Rule | 0 |
| New Business Rule | 0 |
| New Data Governance Rule | 0 |
| Scope Expansion | 0（生产切换/部署/灰度列出但标为 OUT OF SCOPE 且 DESIGN ONLY） |
| 目标拓扑修改 | 0（沿用 WP1 §2.4） |

---

## 10. 已发现缺陷（WP3 产物，本轮**未修改**，需后续授权修复）

**DEFECT-WP3-01 — `FileCheckpoint` 方法被构造器字段遮蔽**
- 位置：`p8-3-migration/src/checkpoint.js`：`constructor` 中 `this._fs = null` 遮蔽了原型方法 `async _fs()`。
- 影响：`FileCheckpoint.load()/save()/reset()` 调用 `await this._fs()` 时 `this._fs` 为 `null` → `TypeError`。`MemoryCheckpoint`（测试用）不受影响，故现有 43 项测试全绿。
- WP5 处置：不修改 WP3 代码；`rollback.js` 的 `resetCheckpoint()` 捕获该错误并返回 `{ reset:false, error }`，`rollbackFull` 将其写入 rollback issue 的 evidence，**不静默吞错**。
- 建议：在明确授权的修复轮中将该字段重命名（与 `MemoryTarget.archiveStore` 同类问题的相同修法）。

---

## 11. WP5 Gate

| Gate 项 | 结果 |
|---|---|
| Migration Runbook complete | **YES**（B0–B20，9 字段齐备） |
| Rollback Runbook complete | **YES**（CLASS 1/2/3） |
| Cutover Checklist complete | **YES**（`templates/operator-checklist.md`，27 项） |
| STOP Conditions defined | **YES**（SC-01…SC-15，机器判定） |
| Batch rollback defined | **YES**（CLASS_1_BATCH + `rollbackBatch`） |
| Full rollback defined | **YES**（CLASS_2_FULL_TEST + `rollbackFull`） |
| Future production rollback designed | **YES**（CLASS_3，DESIGN_ONLY，不可执行） |
| Recovery verification implemented | **YES**（`verifyRecovery`，7 项，机器 PASS/FAIL） |
| Operator evidence template complete | **YES**（`templates/operator-evidence.json` + `buildEvidenceRecord`） |
| WP6 rehearsal contract defined | **YES**（5 步 + entry gates + exit evidence，`executedNow=false`） |
| Target topology preserved | **YES**（腾讯云入口 → Worker → D1 → R2/KV；腾讯云 MySQL 非权威库） |
| user_favorites exclusion preserved | **YES**（永不迁移/不 DROP/不归档；回滚后仍 excluded + BCR pending） |
| Tests | **43 passed / 0 failed**（WP3 19 + WP4 8 + WP5 16） |
| Freeze Conflict Count | **0** |
| Production data touched | **NO** |

### P8-3 WP5 Gate = **PASS**
### Ready for WP6 = **YES**（前置：用户显式授权进入 WP6）

---

## 12. 纪律确认

- 未修改 Freeze / Constitution / Core Domain / 业务代码逻辑 / schema ✅
- 未连接/写入生产数据库，未正式迁移，未部署，未灰度，未正式切换 ✅
- 未擅自处理 `user_favorites` BCR（保持 EXCLUDED + BCR pending）✅
- 未 Git add / commit / push（staged = 0，新建文件在未跟踪树内）✅
- 未进入 WP6 ✅

**STOP。未进入 WP6，未碰生产数据，未部署。**
