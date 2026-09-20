# P9 WP4-B — Safety Copy Backup Execution Evidence（安全副本执行·证据）

> **阶段**：P9 WP4-B（Backup Execution — SAFETY_COPY_ONLY local only）
> **执行日期**：2026-09-20（CST）
> **性质**：**执行一份非权威本地安全副本（non-authoritative safety copy）**。本备份**不作迁移输入**、**不作 authoritative snapshot**、**不进入 WP4-C**、**不迁移**、**不 Cutover**、**不断写**、**不锁表**、**不维护窗**；允许 active drift 风险；NAS 不可达 → 记录 `offhost_copy = SKIPPED`。
> **承接**：`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（Authorization Gate PASS，推荐 SAFETY_COPY_ONLY local only）、`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（Readiness Gate PASS）、`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5、`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`（G-10 CLOSED）。
> **纪律**：本轮仅本地 mysqldump + gzip + sha256；未停止 1.0 / 锁表 / 冻结 / 修改 1.0 / 修改腾讯云 nginx / 修改 DNS·route / 写 D1 / import schema / 迁移 / 灰度 / Cutover / 修改 Worker / redeploy / 修改 MySQL 用户或权限；未将本备份标记为 authoritative snapshot 或 migration input；未 git commit（待授权）。
> **本轮不提交 Git**（用户本轮仅授权执行，未授权 commit）。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| P9 WP4-B Authorization Gate | FINAL PASS（commit `369dfbe`，HEAD == origin/master） |
| Recommended mode | **SAFETY_COPY_ONLY local only** |
| Ready for Backup Execution | **CONDITIONAL YES** |
| Ready for AUTHORITATIVE_SNAPSHOT | **NO**（G-4 维护窗+冻结 / G-2 off-host / G-1 closure 未全闭） |
| 最新远端 commit | `369dfbe` |
| 本轮性质 | 执行一份非权威本地安全副本 |

---

## 1. 权威基线确认（已读取）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md` | SAFETY_COPY_ONLY local only 为推荐模式；AUTHORITATIVE_SNAPSHOT=NO；G-1=A（DBA/root 单独捕获 routines）；G-2 NAS down→SAFETY 允许 local-only + offhost SKIPPED；G-4 无维护窗=仅 SAFETY |
| `P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md` | 源库实测 / 命令模板 Tier A·B / 中断规则 AB-01…AB-09 / Gap Register（G-1/G-2/G-3/G-4） |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | §5 备份执行计划 / G-10 CLOSED |
| `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` | G-10 关闭证据（jhzy_mig_ro 最小只读） |

---

## 2. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `369dfbeb816fd0dacb09d22d83d5d45dca9e44f0`（`369dfbe`，P9 WP4-B Authorization Gate Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES** |
| staged | 0 |
| P9 scope clean | ✅（并行改动允许存在，不处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 3. 执行模式与边界（显式声明）

| 维度 | 值 |
|---|---|
| `mode` | **SAFETY_COPY_ONLY** |
| `authoritative_snapshot` | **NO** |
| `migration_input` | **NO** |
| `maintenance_window` | **NO** |
| `write_freeze` | **NO**（不断写、不锁表） |
| `active_drift_allowed` | **YES**（副本可能含漂移期间的新写；不作一致性保证） |
| `offhost_copy_status` | **SKIPPED**（NAS `Host is down`，理由见 §7） |
| 不得基于本备份进入迁移（WP4-E） | ✅ 遵守 |
| 不得进入 Cutover | ✅ 遵守 |
| 不得标记为 authoritative | ✅ 遵守 |

---

## 4. Pre-Execution Check（§3，只读）

| 检查项 | 实测值 | 结果 |
|---|---|---|
| MySQL version | `5.7.44` | PASS |
| `api_jhzyfw_com` 存在 | ✅（128 表） | PASS |
| `signup_db` 存在 | ✅（3 表） | PASS |
| 只读账号 `jhzy_mig_ro@127.0.0.1` | `USAGE ON *.*` + `SELECT ON api_jhzyfw_com.*` + `SELECT ON signup_db.*` | PASS |
| root/DBA 可用（routines 捕获） | `root@localhost`（unix_socket） | PASS |
| `mysqldump` / `gzip` / `sha256sum` / `stat` | 均可用（5.7.44 / 1.12 / 9.4） | PASS |
| 备份目标目录 | `/www/backup/database` 存在 | PASS |
| 磁盘可用空间 | 21G 可用（充足） | PASS |
| NAS/off-host 状态 | `Host is down`（CIFS 定义存在但断连） | 记 G-2 |
| 活跃写入指示 | `training_user_progress` 在 2s 采样窗口行数未变；全局 `Questions` 持续递增 → 源库活跃 | 允许 drift |

**Pre-Execution Check = PASS**（无 ABORT 触发）。

---

## 5. Backup Run 元数据（§4/§5）

| 字段 | 值 |
|---|---|
| `backup_run_id` | `wp4b_safety_20260920_130838` |
| `local_backup_path` | `/www/backup/database/p9-wp4b-safety/wp4b_safety_20260920_130838/` |
| `git_sha` | `369dfbeb816fd0dacb09d22d83d5d45dca9e44f0` |
| `source_host` | `101.43.30.163`（生产） |
| `source_databases` | `api_jhzyfw_com`, `signup_db` |
| `mysql_version` | `5.7.44` |
| `binlog_status` | `OFF` |
| `timezone` | `CST/SYSTEM` |
| `charset` / `collation` | `api_jhzyfw_com`=`utf8mb4`/`utf8mb4_general_ci`；`signup_db`=`utf8mb4`/`utf8mb4_unicode_ci`（混合 collation，G-3） |
| `readonly_user` | `jhzy_mig_ro@127.0.0.1`（schema+data dump 用） |
| `routines_captured` | `api_jhzyfw_com.assign_certificate_id`（PROCEDURE，root 单独捕获，G-1=A） |
| `table_inventory` | 131 对象（api_jhzyfw_com 128：127 base table + 1 view；signup_db 3） |
| `row_count_summary`（approx, information_schema TABLE_ROWS） | id_pool≈445920 / id_pool_old_20260214≈155461 / training_user_progress≈2615 / volunteers≈612 / training_user_course_status≈580 / jhzy_attendance_records≈545 / jhzy_activity_signups≈488 / exam_records≈446 / exam_certificates≈409 / exam_questions≈280 …（详见宿主 `evidence.json`） |
| `active_write_indicator` | 全局 `Questions` 持续递增；本副本为漂移窗口内快照，非静止 |
| `NAS/off-host status` | `DOWN(Host is down)` |

> 注：行数为 `information_schema.TABLE_ROWS` 近似值（非精确 COUNT(*)），仅作安全副本清单摘要；精确计数须待隔离恢复演练（G-03）。

---

## 6. Backup Artifacts（§6/§8，文件清单 + 校验）

| 文件 | 用途 | 大小 (bytes) | gzip 完整性 | SHA256 |
|---|---|---|---|---|
| `api_jhzyfw_com_schema.sql.gz` | 仅结构（127 表 + 1 视图；不含 routines/data） | 18,792 | OK | `7096356a42f6db461fffc6e5a7e0aa474fb4fa22fcc80fe8439e3244d0b2d08b` |
| `api_jhzyfw_com_data.sql.gz` | 仅数据（131 INSERT 段；不含结构） | 8,789,565 | OK | `920d564bc9eaf234d4b29fe3ca03cf1fd0b3888baa8aaca1458ebcafd8127679` |
| `api_jhzyfw_com_routines.sql.gz` | 例程（root 捕获 `assign_certificate_id`） | 1,329 | OK | `ae6ca4449a7dc3b54a4478e5f286091e9325c446abe201f200f97208da617ab0` |
| `signup_db_schema.sql.gz` | 仅结构 | 970 | OK | `74f0df1b9c765ce1afe6a9e573878d87648374bd7def4271188b68e49345266f` |
| `signup_db_data.sql.gz` | 仅数据 | 651 | OK | `84bcf46fa89a03711616f988d185d680213eca1e22a29889604f9f99dd333e42` |
| `sha256_manifest.txt` | 上述 5 文件 sha256 清单 | 463 | — | — |
| `evidence.json` | 宿主侧结构化证据（同本表字段） | 1,078 | — | — |

**校验结果**：
- 全部 5 个 `.sql.gz` 文件 `gzip -t` = OK（压缩完整）；
- 全部文件 size > 0；
- routines 文件含 `CREATE DEFINER=... PROCEDURE assign_certificate_id`（例程已入包）；
- 5 个 dump `.err` 文件均为 0 字节（无 WARNING/ERROR，AB-08 未触发）；
- `sha256_manifest.txt` 已生成，可后续离线校验。

**api_jhzyfw_com schema 对象数** = 127 `CREATE TABLE` + 1 `CREATE VIEW` = 128（与信息_schema 128 行一致，含 1 视图）。

---

## 7. Off-Host / NAS Handling（§7）

- NAS 挂载 `/mnt/nas-storage` → `Host is down`（与 Readiness G-2 一致）。
- 本模式为 **SAFETY_COPY_ONLY local only**（Authorization Gate G-2/B 明确允许）：
  - `offhost_copy_status` = **SKIPPED**
  - reason = `NAS Host is down；SAFETY_COPY_ONLY 模式允许仅本地副本，但须标记风险`
- 本轮仍可 PASS（作为本地安全副本）；**但不得升级为 authoritative snapshot**（AB-05 安全副本分支）。

---

## 8. Abort / Discipline（§7/纪律）

| 项 | 状态 |
|---|---|
| 磁盘不足 / 工具缺失 / 源库不存在 | ❌ 无（Pre-Exec PASS） |
| dump WARNING/ERROR（AB-08） | ❌ 无（5 个 .err 全 0 字节） |
| 写入冻结 / 锁表 / 停止 1.0 | ❌ 无（SAFETY_COPY_ONLY 允许不断写） |
| 修改 1.0 / 腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 修改 MySQL 用户或权限 / 提权 jhzy_mig_ro | ❌ 无（G-1 选项 C 永久排除；routines 由 root 单独捕获） |
| 生产业务数据修改 | ❌ **NO** |
| 生产结构修改 | ❌ **NO**（本次仅向自建备份目录写文件，未触碰生产库任何表） |
| 标记为 authoritative snapshot / migration input | ❌ 明确禁止（本副本非权威） |
| Git 提交 | ❌ 无（待用户授权后提交） |

---

## 9. FINAL GATE（P9 WP4-B Safety Copy Backup Execution）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `369dfbe` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（Authorization Gate / Readiness / WP4 Definition / WP4-A 全读） |
| Mode | **SAFETY_COPY_ONLY** |
| Authoritative snapshot | **NO** |
| Migration input | **NO** |
| Maintenance window used | **NO** |
| Write freeze executed | **NO** |
| Active drift allowed | **YES** |
| Pre-execution check | **PASS** |
| Backup run id | `wp4b_safety_20260920_130838` |
| Local backup path | `/www/backup/database/p9-wp4b-safety/wp4b_safety_20260920_130838/` |
| api_jhzyfw_com schema dump | **PASS**（18,792 B / 127 表+1 视图 / gzip OK） |
| api_jhzyfw_com data dump | **PASS**（8,789,565 B / 131 INSERT 段 / gzip OK） |
| api_jhzyfw_com routines dump | **PASS**（1,329 B / `assign_certificate_id` PROCEDURE / root 捕获） |
| signup_db schema dump | **PASS**（970 B / gzip OK） |
| signup_db data dump | **PASS**（651 B / gzip OK） |
| gzip integrity | **PASS**（5/5 OK） |
| sha256 hashes | **PASS**（5 文件 + manifest） |
| Off-host copy | **SKIPPED**（NAS down，已记录理由） |
| Evidence document created | **YES**（本文件；宿主 `evidence.json` 同步生成） |
| Production write freeze executed | **NO** |
| Production data modified | **NO** |
| Production schema modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4-B Safety Copy Backup Execution = PASS**

### **Ready for Git Closeout = YES**（提交 `P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`，须用户授权；宿主产物已落盘于生产 `/www/backup/database/p9-wp4b-safety/wp4b_safety_20260920_130838/`）

---

## 10. 后续与限制

- 本副本**仅作非权威安全副本**，不得作为 WP4-E 迁移输入、不得作为 WP4-D authoritative snapshot。
- 若需权威快照：须先关闭 G-4（维护窗+写入冻结）、G-2（NAS 重连或备用 off-host）、G-1 closure 确认 → 进入 AUTHORITATIVE_SNAPSHOT 执行轮（独立授权）。
- 恢复演练（G-03）：须在隔离测试 MySQL 实例载入本副本并做行数校验，留 evidence；当前未执行。
- D1 备份/恢复（G-04/W4-04）：`wrangler d1 export` 恢复路径未实测，留 WP4-B/E 执行轮。

---

## 引用

- Authorization Gate：`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（SAFETY_COPY_ONLY / G-1=A / G-2=B / G-4=A）。
- Readiness Gate：`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（G-1/G-2/G-3/G-4 / AB-01…AB-09 / Tier A·B）。
- 备份计划：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5。
- G-10 关闭：`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
