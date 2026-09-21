# P9 WP4-E Dry-run Transform-only Execution — Evidence

- **Execution round**: P9 WP4-E Dry-run Transform-only (只读转换，不写 D1)
- **Date**: 2026-09-21
- **run_id**: `wp4d_authoritative_20260921_120656`
- **Mode**: read-only analysis of WP4-D authoritative snapshot; produced local artifacts only.

---

## 1. Repo Identity Gate

| Item | Value |
|---|---|
| branch | `master` |
| HEAD | `2f5306a` (pre-round) — round produced no commit |
| HEAD == origin/master | YES |
| staged | 0 (本 round 未 commit) |
| parallel changes | 存在但未处理 |

## 2. Snapshot Input (read-only)

Source snapshot on prod host (腾讯云): `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`
Off-host copy (G-2 remediated): `E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/`

| Check | Result |
|---|---|
| 5× `.sql.gz` present | YES |
| `sha256sum -c` (host-side) | PASS (5/5) |
| `sha256sum -c` (off-host copy) | PASS (5/5, ALL_SHA256_PASS=True) |
| gzip integrity | PASS |
| row_counts_before.json | 131/131 tables, total 619,176 rows |
| table_inventory.json | api 128 objects (127 table+1 view) + signup 3 = 131 |
| routines capture (`assign_certificate_id`) | YES |
| snapshot original modified/deleted/overwritten | NO |

Input used for analysis = **off-host copy** (read-only pull); originals untouched.

## 3. Dry-run Workdir

```
E:/D盘备份/miniprogram/.var/migration-dryrun/wp4e_dryrun_20260921/
  input/        <- 解压后的 .sql + manifest/json 副本
  extracted/    <- 解析出的逐表 JSON + 解析脚本
  transformed/  <- 10 个 *_preview.ndjson
  mappings/     <- legacy_id_maps_preview.ndjson
  rejected/     <- rejected_rows.ndjson
  reports/      <- gap_re_1_dual_name_source_decision.md, migration_issues.md, dryrun_reconciliation_report.md, _dryrun_summary.json
  evidence/     <- (本证据文档落盘于 docs/production-audit/)
```

> 注：dry-run 大文件**不提交 Git**（`.var/` 为非跟踪工作目录）。

## 4. GAP-RE-1 Dual-name Source Decision

Full report: `reports/gap_re_1_dual_name_source_decision.md`. Summary:

- **关键业务域 = RESOLVED (high 置信度)**：每域仅一个活动版本，srcKey 明确。
  - `activities` → **jhzy_activities** (72 行, 2026-09-21 live)
  - `activity_signups` → **jhzy_activity_signups** (490 行, live)
  - `attendance_records` → **jhzy_attendance_records** (546 行, live)
  - `volunteers` → **volunteers** (622 行, live; `jhzy_volunteers_old_20260214` 为备份)
  - `certificates` → **certificates** (59 行, live)
  - `users` → **api_jhzyfw_com.users** (54/55 行, live)
- **低风险字典表（两版均非空）**：`welfare_options`(6 vs 9)、`service_areas`(7 vs 9) → 建议 `jhzy_` 前缀版，置信度 low，需人工确认；**不阻断**关键不变式。
- `quick_actions` → jhzy_quick_actions (23 vs 0，非前缀版空)；`notifications` 两版均空。
- 跨数据库同名（`api.events` vs `signup_db.events` 等）**不属 GAP-RE-1**，独立库独立表。

**结论**：GAP-RE-1 不构成进入 staging 的阻塞；真实阻塞见 §7。

## 5. Transform Previews (transformed/*_preview.ndjson)

| File | Rows (preview cap) | Note |
|---|---|---|
| users_preview | 55 | full |
| volunteers_preview | 200 | capped |
| activities_preview | 72 | full |
| occurrences_preview | 72 | 1 activity→1 occurrence |
| participations_preview | 200 | capped |
| attendance_preview | 200 | capped |
| points_preview | 143 | full |
| certificates_preview | 576 | certificates+master+exam merged |
| training_exam_preview | 400 | capped |
| dynamic_forms_preview | 0 | `jhzy_activity_signups` 无 `form_data` 字段(37 列)，空，已记录原因 |

## 6. Legacy ID Maps Preview (mappings/legacy_id_maps_preview.ndjson)

- 条目数: **2504**
- 冲突 (collision): **73** → 进入 rejected_rows 复核
- `public_id_preview` 由 `sha256(src_table:pk)` 派生，稳定可重跑；同一 legacy key 不映射多 target。

## 7. Rejected Rows / Issues

- 总 rejected: **816**
  - ORPHAN_FOREIGN_KEY: 716 (`signup_activity` 118 / `attendance_activity` 113 / `attendance_volunteer` 485 + cert/other)
  - DUPLICATE_ACTIVE_CHECKIN: 50 (sample of 91 pairs)
  - CERTIFICATE_ID_COLLISION: 50 (sample of 62)
- SHADOW/LEGACY excluded tables: 14 (`*_old_*`/`*_backup*`/`*_bak*` 等，仅归档不迁入)
- 详情见 `rejected/rejected_rows.ndjson` + `reports/migration_issues.md`

## 8. Reconciliation Report (reports/dryrun_reconciliation_report.md)

Business-invariant checks (必须 =0 才能进入 staging)：

| Invariant | Value | Gate |
|---|---|---|
| duplicate active check-in pairs | **91** | ❌ FAIL |
| certificate number duplicates | **62** | ❌ FAIL |
| orphan FK (signup_activity) | 118 | ❌ FAIL |
| orphan FK (attendance_activity) | 113 | ❌ FAIL |
| orphan FK (attendance_volunteer) | 485 | ❌ FAIL |
| orphan FK (signup_user) | 0 | ✅ |
| orphan FK (certificate_volunteer) | 0 | ✅ |
| id-map collisions | 73 | ⚠️ review |

critical_blockers = `ORPHAN_FK_PRESENT`, `CERT_NO_DUP_PRESENT`, `DUP_ACTIVE_CHECKIN_PRESENT`

## 9. Final Decision

```
Dry-run transform-only = PARTIAL
Ready for Staging D1 Import = NO   (存在 critical_blockers)
Ready for Production D1 Import = NO
Cutover authorized = NO
```

**阻塞消解路径（进入 staging 前必须完成）**：
1. ORPHAN_FK_PRESENT — 孤儿报名/考勤记录补链有效 activity/user 或归档。
2. CERT_NO_DUP_PRESENT — 62 个证书号重复，按权威源去重（`certificates`/`certificate_master`/`exam_certificates` 择一）。
3. DUP_ACTIVE_CHECKIN_PRESENT — 91 个 (志愿者,活动) 多考勤记录，裁定保留规则（如仅保留最近签到）。
4. GAP-RE-1 — 关键域已裁定 (srcKey high)；welfare_options/service_areas 字典表建议 jhzy_，待人工确认（非阻塞）。

## 10. Prohibitions Observed (all = NO)

| Item | Status |
|---|---|
| D1 import executed | NO |
| D1 modified | NO |
| Migration executed | NO |
| Cutover executed | NO |
| Source data modified | NO |
| Source schema modified | NO |
| Source snapshot original modified/deleted/overwritten | NO |
| Worker modified | NO |
| DNS / route changed | NO |
| MySQL / 源库 modified | NO |
| Re-mysqldump / re-snapshot | NO |
| Git commit / push | NO |

---

**STOP** — 不得进入 D1 import / 不得迁移 / 不得 Cutover / 不得 commit。
下一步须另行显式授权：① 阻塞消解执行轮（去重/补链/裁定签到保留）；② 创建 staging D1 后执行 Staging Import；或 ③ 本证据文档的 Git Closeout。
