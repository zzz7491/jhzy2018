# P8-3 Operator Checklist（可逐项勾选）

> 规则：禁止依赖操作者"凭经验判断"——每一项必须可勾选，且必须附带证据。
> 来源：`src/runbook.js → OPERATOR_CHECKLIST`（机器可读版本为此文件的唯一真源）。
> 边界：本清单仅用于 **测试环境** 迁移 / 对账 / 回滚演练。生产正式迁移、部署、正式切换、灰度放量 = OUT OF SCOPE。

---

## 0. 固定信息（每次执行前填写）

- Operator：________________
- Timestamp：________________
- Batch ID：________________
- Migration scripts version：________________
- Reconciliation version：________________
- Source snapshot hash：________________
- Rollback point ref：________________

---

## PRE-FLIGHT

- [ ] OC-01 核对 WP1–WP4 Gate 全 PASS（PF-01） ｜ blocking ｜ 证据：Gate 记录
- [ ] OC-02 核对 Freeze Conflict = 0（PF-02） ｜ blocking ｜ 证据：一致性自检
- [ ] OC-03 核对 source dump 完整 + snapshot hash（PF-03 / PF-04） ｜ blocking ｜ 证据：dump 清单 + hash
- [ ] OC-04 确认 target test D1 状态（PF-05） ｜ blocking ｜ 证据：目标库状态快照
- [ ] OC-05 固定 migration / reconciliation 版本（PF-06 / PF-07） ｜ blocking ｜ 证据：version 字符串
- [ ] OC-06 确认 user_favorites EXCLUDED + BCR pending（PF-08） ｜ blocking ｜ 证据：exclusion issue
- [ ] OC-07 建立 rollback point（PF-09） ｜ blocking ｜ 证据：restore point ref
- [ ] OC-08 登记 operator / timestamp / batchId（PF-10） ｜ blocking ｜ 证据：证据记录
- [ ] OC-09 `runPreflight()` → decision = PROCEED ｜ blocking ｜ 证据：preflight JSON

> 任一 blocking 未勾选 → **STOP**，不得进入 MIGRATE。

---

## MIGRATE

- [ ] OC-10 按 B0–B20 顺序执行，不跳批、不重排 ｜ blocking ｜ 证据：batch 日志
- [ ] OC-11 每批完成后立即 checkpoint ｜ blocking ｜ 证据：doneTables 快照
- [ ] OC-12 user_favorites 未进入任何批次 ｜ blocking ｜ 证据：exclusion report
- [ ] OC-13 任一 CRITICAL STOP → 立即停批 ｜ blocking ｜ 证据：STOP 记录

---

## RECONCILE

- [ ] OC-14 执行 reconcile（9 维） ｜ blocking ｜ 证据：reconcile JSON
- [ ] OC-15 核对 row conservation 守恒 ｜ blocking ｜ 证据：row_conservation detail
- [ ] OC-16 核对 excluded_unknown：user_favorites 未被迁移 / DROP / 归档 ｜ blocking ｜ 证据：excluded_unknown detail

---

## DECISION

- [ ] OC-17 `evaluateStopConditions()` → PROCEED / STOP ｜ blocking ｜ 证据：STOP 评估 JSON
- [ ] OC-18 WARNING 项记录并指派 ｜ non-blocking ｜ 证据：warning 列表

---

## ROLLBACK / CONTINUE

- [ ] OC-19 PROCEED → 继续下一 Batch ｜ non-blocking ｜ 证据：批次日志
- [ ] OC-20 STOP → 执行 CLASS_1_BATCH 或 CLASS_2_FULL_TEST 回滚 ｜ blocking ｜ 证据：回滚记录
- [ ] OC-21 回滚后执行 `verifyRecovery()` → 必须 PASS ｜ blocking ｜ 证据：recovery JSON

---

## EVIDENCE

- [ ] OC-22 生成 Operator Evidence Record ｜ blocking ｜ 证据：evidence JSON
- [ ] OC-23 保留 migration_issues 全量（**不得删除**） ｜ blocking ｜ 证据：issues 导出
- [ ] OC-24 归档 checkpoint 快照 ｜ blocking ｜ 证据：checkpoint JSON

---

## CLOSEOUT

- [ ] OC-25 确认未触碰生产数据（production data touched = NO） ｜ blocking ｜ 证据：边界声明
- [ ] OC-26 确认目标拓扑未被修改 ｜ blocking ｜ 证据：拓扑核对
- [ ] OC-27 输出 WP5 Gate 结论 ｜ blocking ｜ 证据：Gate 记录

---

## 附：STOP / Abort 速查（SC-01…SC-14）

| ID | 条件 | 级别 |
|---|---|---|
| SC-01 | row conservation FAIL | CRITICAL |
| SC-02 | identity duplicate | CRITICAL |
| SC-03 | orphan relation | CRITICAL |
| SC-04 | missing legacy mapping | CRITICAL |
| SC-05 | points/growth mismatch | CRITICAL |
| SC-06 | training/certificate mismatch | CRITICAL |
| SC-07 | media reference critical failure | WARNING |
| SC-08 | audit integrity failure | CRITICAL |
| SC-09 | unexpected schema | CRITICAL |
| SC-10 | migration script version mismatch | CRITICAL |
| SC-11 | source snapshot mismatch | CRITICAL |
| SC-12 | target contamination | CRITICAL |
| SC-13 | Freeze conflict | CRITICAL |
| SC-14 | unauthorized production access | CRITICAL |

> 任一 CRITICAL 命中 → **立即 STOP**，不得继续下一 Batch，按 §E 回滚。
