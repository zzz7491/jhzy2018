# P9 WP2 — Production Source Snapshot & Backup Plan（生产源快照与备份计划）

> **阶段**：P9 WP2（生产迁移与切换·源快照与备份计划）
> **计划日期**：2026-09-20
> **性质**：**方案与预案阶段（Design / Plan Only）**。设计生产源库 snapshot / hash / 备份 / 恢复 / 漂移控制 / 证据结构；**不执行 mysqldump、不实际备份生产库、不锁表、不停止 1.0、不写 D1、不 import schema、不迁移、不灰度、不 Cutover、不 git commit（除非另行授权）**。
> **层级**：L3（实现层），承接 `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` §4 WP2 定义。
> **纪律**：本轮仅产出计划文档与证据模板；所有实际取快照 / 备份 / 冻结写入 / 恢复演练动作须未来**用户显式授权**后，在 P9 WP2 执行阶段（非本计划阶段）进行。

---

## 0. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `b53c275b9d7e4e2dcbfa8607b3ed769419774574`（`b53c275`，P9 WP1/WP1A Git Closeout，已 `origin/master`） |
| staged | 0 |
| P9 WP1 / WP1A scope clean | ✅（Worker 源码/配置已提交 `b53c275`；仅 `p9-wp1a-worker/.wrangler/` 本地状态未跟踪、未提交、不属计划范围） |
| 其它并行改动 | 290 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），**不在 P9 范围，未处理** |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 1. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 角色 / 用途 |
|---|---|
| `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` | P9 定义门（拓扑 T-1…T-6 / 安全门 MG-01…15、CG-01…12 / 切换契约 §7 / 回滚矩阵 §9 / 证据 §10） |
| `P9_WP1_PRODUCTION_READINESS_AUDIT.md` | 生产就绪审计（源库清单 / binlog OFF / 活跃漂移 / 备份机制 / 维护窗需求） |
| `P9_WP1A_CLOUDFLARE_WORKER_RESOURCE_PREPARATION_GATE.md` | Worker 资源准备（name / version / binding / route 状态） |
| `P8-3_CLOSEOUT.md` | P8-3 收口（131 源对象 / user_favorites EXCLUDED / run_id 贯穿 / 81 tests） |
| `P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` | 回滚方案（CLASS_1/2/3）/ `verifyRecovery()` 7 项 / STOP SC-01…SC-15 / 切换 Runbook C.1–C.3 / operator-evidence/v1 |
| `P8-3_WP6_TEST_MIGRATION_REHEARSAL_REPORT.md` | 演练方法（隔离测试目标 / 恢复验证 / 81 tests） |

> 所有架构/业务/数据判定均引用上述基线，不新增原则、不重述定义。

---

## 2. 当前状态事实（设计依据，来自 P9 WP1 只读审计 2026-09-19）

> 以下为 **P9 WP1 只读审计已确认的生产事实**，本计划据此设计。正式执行前（WP2 执行阶段）必须**就地重测**一次，因 1.0 持续活跃写入，状态可能已变化。

| 项 | 值 | 来源 |
|---|---|---|
| 1.0 authoritative DB | `api_jhzyfw_com`（128 张表，含 `*_old_*` / `*_backup_*` 历史备份表） | WP1 §2.3 |
| 注册/报名源 `signup_db` | 3 张表（users/participants/events），**0 行**，静态 | WP1 §2.3 |
| charset / collation | `utf8mb4`；主 `utf8mb4_general_ci`，部分表 `utf8mb4_unicode_ci`（**混合排序规则**，G-06） | WP1 §2.3 |
| timezone | `SYSTEM` = `CST`（东八区） | WP1 §2.3 |
| read/write 状态 | **ACTIVE**（2026-09-19 15:22 仍有写入） | WP1 §2.5 |
| 数据量 | 全库约 **100–150MB**；`id_pool` 96.78MB / 452,240 行（主体） | WP1 §2.4 |
| binary / media | `uploads` / `avatars` / `certificates` 为文件目录，DB 仅存路径引用 | WP1 §2.3 |
| backup 机制 | `mysqldump 5.7.44`；aaPanel `/www/backup/database` + 每日 NAS cron（`backup_to_nas.sh` / `backup_db_to_nas.sh` / `daily_backup.sh` 02:00） | WP1 §2.3 / §4.1 |
| **binlog** | **`log_bin = OFF`** → 无法 binlog 增量捕获 | WP1 §2.3 / §6 |
| D1 目标 | `jhzy-v2-db`（uuid `ea603f43-d076-4df5-b118-3d8a0c245439`），**num_tables = 0**（空库） | WP1 §2.2 |
| Worker | `jhzy-v2-api`，Version `b10791f8-b8ad-4a6e-963b-c40194af9a12`，binding `DB`→`jhzy-v2-db`，仅 `workers.dev` 可达，无生产 route | WP1A §8 |

---

## 3. Source Snapshot Plan（源库快照方案）

### 3.1 Authoritative Source DB
- **`api_jhzyfw_com`**（主权威源，128 张表）
- **`signup_db`**（注册源，3 张表，0 行，静态）
- 二者必须**同一次快照动作**内一并捕获，保证迁移起点一致。

### 3.2 Snapshot Timing（快照时机）
- 采用**两阶段快照**策略：
  1. **预热基线快照（WARM BASELINE）**：在维护窗**之前**，以 `--single-transaction` 取一份运行态基线（不停写），用于提前校验 dump 可用性与耗时估计（§6.5）。
  2. **权威冻结快照（AUTHORITATIVE）**：在**写入冻结窗口开启后**立即执行（§6.3），为迁移唯一权威起点。
- 权威快照的 `timestamp_start` / `timestamp_end` 必须记录（证据字段）。

### 3.3 Snapshot Operator Role
- **Migration Operator**（具名，待 U-07 指派）；执行前需在 evidence 记录 operator 身份（MG-11）。
- 禁止单人既操作又授权回滚（职责分离：Operator ≠ Rollback Authority）。

### 3.4 Maintenance Window Required
- **YES（必须）**。依据 P9 Definition §7.3 与 WP1 §6：因 `binlog = OFF`，无法增量捕获，必须在**维护/只读窗口**内冻结写入后取一致性快照。
- 窗口须规划并书面通知（MG-12 / MG-13）。

### 3.5 Read/Write Freeze Requirement（读写冻结要求）
- 权威快照前，1.0 入口置**维护态**（nginx 返回维护页 / 应用层拒绝写），**停止一切新写入**（P9 Definition §7.3 / P8-3 WP5 §C.2）。
- 冻结持续到「源静止 → 最终增量迁移 → 对账 PASS → 权威切换」完成（§7.5 最终一致性窗口）。

### 3.6 Consistency Requirement（一致性要求）
- 因 binlog OFF 且无法原子停写，**一致性完全依赖「冻结写入 + 单点快照」**：冻结后 `mysqldump --single-transaction` 取得全部表同一时间点视图。
- 快照点之后 1.0 不再接受写，避免快照后与迁移执行间的漂移（P9 Definition §7.2）。

### 3.7 Table Inventory Freeze（表清单冻结）
- 冻结前采集 `SHOW TABLES` + `information_schema.TABLES` 全量清单（预期 `api_jhzyfw_com`=128 + `signup_db`=3），写入 `table_inventory.json`。
- 冻结窗口内禁止任何 DDL；若窗口内出现意外 DDL → 中止（§6.7）。

### 3.8 Charset / Timezone Capture
- 采集：`@@character_set_client/server/connection/database`、`@@collation_*`、`@@system_time_zone`、`@@time_zone`、`version()`。
- 记录于 evidence；目标 D1 设计 collation 统一处理（G-06：源侧混合 collation 不强制改，迁移目标按 D1 设计收敛）。

### 3.9 Row Count Capture（行数捕获）
- 采集 `information_schema.TABLES.TABLE_ROWS` 全表行数 + 重点表精确 `COUNT(*)`（`id_pool` / `volunteers` / `*_signups` / `exam_*` / `training_*` / `points_*` 等）。
- 输出 `row_count_summary.json`，作为后续对账 / 漂移检查基线。

### 3.10 Schema Dump Capture（结构捕获）
- `mysqldump --no-data --routines --triggers --events --default-character-set=utf8mb4` → `schema-only.sql`。
- 单独保存结构，便于 D1 schema 比对与重建。

### 3.11 Data Dump Capture（数据捕获）
- `mysqldump --single-transaction --routines --triggers --events --hex-blob --opt --default-character-set=utf8mb4` → `data-full.sql`。
- 覆盖业务数据；`*_old_*` / `*_backup_*` 历史表一并纳入（按 P8-3 WP2 裁定 DROP/ARCHIVE，不丢弃于快照）。

### 3.12 Media / Reference Dependency Capture（媒体/引用依赖捕获）
- DB 内仅存路径；真实文件位于 `uploads` / `avatars` / `certificates` 目录。
- 方案：`tar` 打包上述目录 → `sha256` → 记录 `media_manifest.json`（相对路径 + 大小 + hash）。
- 迁移仅搬 DB 路径；文件实体同步策略单列（不在 WP2 范围，归 WP4/WP6 媒体核对）。

### 3.13 Hash Strategy（哈希策略）
- 对每个产物计算 `sha256`：`schema-only.sql`、`data-full.sql`、`table_inventory.json`、`row_count_summary.json`、`media.tar`、`media_manifest.json`。
- 哈希值写入 evidence（§7 字段 `schema_dump_hash` / `data_dump_hash` / `table_inventory_hash` / `media_*`）。
- 哈希用于：SC-11 source snapshot mismatch 判定、恢复验证比对、审计不可抵赖。

### 3.14 Evidence File Naming（证据文件命名）
```
p9-wp2-snapshot-<run_id>-<YYYYMMDDTHHMMSS>.json      # 主证据
p9-wp2-snapshot-<run_id>-schema-only.sql
p9-wp2-snapshot-<run_id>-data-full.sql.gz
p9-wp2-snapshot-<run_id>-table_inventory.json
p9-wp2-snapshot-<run_id>-row_count_summary.json
p9-wp2-snapshot-<run_id>-media.tar
p9-wp2-snapshot-<run_id>-media_manifest.json
p9-wp2-snapshot-<run_id>-*.sha256                       # 各文件哈希清单
```
- `run_id` 沿用 P8-3 DEFECT-WP6-01 的 `run_id` 贯穿机制（issues/reconcile/rollback/evidence）。

---

## 4. Backup Plan（备份方案，不执行）

### 4.1 MySQL Source Backup（源库备份）

| 项 | 方案 |
|---|---|
| schema-only backup | `mysqldump --no-data --routines --triggers --events` → 独立结构备份 |
| data backup | `mysqldump --single-transaction`（InnoDB 一致性）全量数据备份 |
| routines / triggers / events | 若存在则 `--routines --triggers --events` 一并备份；执行前 `SHOW` 确认是否存在 |
| users / privileges | 记录 `mysql.user` 与 `SHOW GRANTS FOR ...`（仅存档，D1 不恢复 MySQL 用户体系） |
| charset / collation | `--default-character-set=utf8mb4`；混合 collation 如实记录（G-06） |
| timezone | 记录 `@@time_zone` / `@@system_time_zone` |
| dump options | `--single-transaction --routines --triggers --events --hex-blob --opt --default-character-set=utf8mb4 --no-tablespaces` |
| compression | `gzip`（或 `zstd`），`.sql.gz` |
| checksum / hash | 每个 `.sql.gz` 计算 `sha256` |
| retention | 主机保留 ≥ 3 代 + 直至 P9 生产 Closeout；NAS 副本同策略；明确书面保留期（MG-12 关联） |
| storage path | `/www/backup/database/`（aaPanel 现有）+ 专用快照子目录 `p9-wp2-snapshot/` |
| off-host copy | `rsync` / `scp` 至 NAS（复用现有 `backup_to_nas.sh` 机制） |
| NAS copy | 现有每日 `daily_backup.sh` 02:00 cron；WP2 执行轮追加 snapshot 专属同步任务 |
| **restore test strategy** | **在隔离测试 MySQL 实例** `mysql < data-full.sql` 载入，校验行数一致 + 抽样对账 → 满足 G-03（source restore drill）。**严禁在生产库做恢复演练** |

### 4.2 D1 Pre-Migration Backup（D1 迁移前备份）

| 项 | 方案 |
|---|---|
| 当前 D1 `jhzy-v2-db` 状态 | **num_tables = 0（空库）**；迁移前「备份」= 记录空态证据 |
| D1 schema/data export plan | 官方 `wrangler d1 export`（`.dump` / `.sql`）导出当前状态；空库导出即最小产物，验证导出路径可用（G-04 / U-11） |
| D1 restore / rebuild plan | `wrangler d1 execute --remote <export.sql>` 重建；或经 `wrangler d1 migrations` 重建（schema 已冻结于 `D1-*`） |
| 空库状态如何记录 | evidence 记录 `num_tables=0`、表清单空、`export.sql` 哈希、D1 uuid |
| Worker / D1 binding 状态 | 记录 binding `DB`→`jhzy-v2-db`（uuid `ea603f43-…`）、Worker version `b10791f8…` |

### 4.3 Worker Config Backup（Worker 配置备份）

| 项 | 值 / 方案 |
|---|---|
| Worker name | `jhzy-v2-api` |
| wrangler.toml | **已纳入 Git（commit `b53c275`，路径 `p9-wp1a-worker/wrangler.toml`）** —— 即配置备份 |
| deployed version | `b10791f8-b8ad-4a6e-963b-c40194af9a12`（记录于 evidence `Worker_version`） |
| D1 binding | `DB` → `jhzy-v2-db`（uuid `ea603f43-d076-4df5-b118-3d8a0c245439`） |
| route state | **无生产 route**（仅 `workers.dev`，符合 WP1A §4） |
| workers.dev state | `https://jhzy-v2-api.lsv3255.workers.dev`（记录 URL） |

---

## 5. Restore Plan（恢复方案，不执行）

| 项 | 方案 |
|---|---|
| source MySQL restore path | 隔离测试 MySQL：`mysql < data-full.sql.gz`；必要时 `schema-only.sql` 先建结构 |
| D1 restore / rebuild path | `wrangler d1 execute --remote <export.sql>` 或经 migrations 重建（§4.2）；须 WP4 执行期凭据 |
| Worker rollback path | `wrangler rollback jhzy-v2-api`（历史版本）/ `wrangler delete`（WP1A §7）；**D1 不受影响** |
| evidence required before restore | operator-evidence/v1 记录齐备；snapshot hash 可比对；source untouched 校验通过（RB-1…RB-9） |
| restore verification | `verifyRecovery()`（P8-3 WP5 §F 7 项）全 PASS + 行数比对 + 源未触碰校验 |
| acceptable data loss | **0**（源在窗口内静止，快照即权威；回滚到切换前状态，源未动） |
| who authorizes restore | **Rollback Authority**（具名，MG-15）；CLASS_3 生产回滚须授权人书面确认（P9 Definition §9 RB-1…RB-9） |
| restore dry-run in test env | **必须**：任何恢复路径先在隔离测试环境 dry-run + `verifyRecovery()` PASS，方可考虑生产（G-03 / P8-3 纪律） |

**原则**：正式 cutover 前，source DB 可恢复性必须可证明（MG-04）；D1 restore/rebuild 路径必须可证明（MG-06）；任何 restore 到生产环境必须另行授权。

---

## 6. Drift Control Plan（漂移控制方案）

> 因 `binlog = OFF`，**不能**依赖 binlog 增量捕获；漂移控制完全依赖「冻结写入窗口 + 静止快照」。

| 项 | 定义 |
|---|---|
| active write domains | 注册（`id_pool`）/ 考试（`exam_*`）/ 培训（`training_*`）/ 志愿者（`volunteers`）/ 考勤（`jhzy_attendance_records`）/ 活动（`jhzy_activity_signups`、`jhzy_activities`）/ 积分（`points_*`） |
| affected tables | 上述业务域全部表 + `id_pool`（45 万行 ID 池） |
| maintenance window start | 由 Cutover Approver 规划时间（U-08），Migration Operator 在窗口起点触发冻结 |
| write freeze method | ① nginx 返回维护页；② 应用层拒绝写请求；③ 确认入口不再转发写至 PHP-FPM |
| verification of no new writes | 冻结起点前/后比对 `information_schema.TABLES.UPDATE_TIME` 与重点表 `COUNT(*)`；预期一致（无新写） |
| snapshot duration estimate method | 预热基线快照（§3.2）实测 dump 耗时 + 网络/压缩开销，加 50% 缓冲作为窗口下限 |
| post-snapshot drift check | 快照完成后再次比对 `UPDATE_TIME` / 行数；确认窗口内源静止 |
| abort condition | 若冻结后**仍检测到新写入** → **立即 ABORT**：NO MIGRATION / NO CUTOVER（P9 Definition §7.7） |
| communication requirement | 维护窗前按 MG-13 经定义通道（U-09）公告；窗口起止均留痕 |
| if writes continue | **NO MIGRATION / NO CUTOVER**（硬约束，不协商） |
| dual-write | **默认禁止**（P9 Definition §7.7）；若确需 dual-write（灰度期）→ 视为 **Architecture Change**，STOP → 走 `ARCHITECTURE_FREEZE.md §5` + 用户显式批准，并登记失效条件与收敛计划 |

---

## 7. Snapshot Evidence Schema（快照证据结构）

未来正式执行（WP2 执行阶段）必须生成如下 evidence（schema 沿用 `p8-3-operator-evidence/v1` 扩展生产字段，P9 Definition §10）：

| # | 字段 | 说明 |
|---|---|---|
| 1 | `run_id` | 本次快照执行 run_id（贯穿 issues/reconcile/rollback/evidence） |
| 2 | `operator` | 操作人身份 |
| 3 | `timestamp_start` | 快照开始（UTC+8） |
| 4 | `timestamp_end` | 快照结束（UTC+8） |
| 5 | `git_sha` | 迁移/对账/回滚代码 SHA（`b53c275` 起 P9 链；P8-3 工具链 `811155c`） |
| 6 | `source_host` | 源主机标识（腾讯云 `101.43.30.163`） |
| 7 | `source_databases` | 快照库列表（`api_jhzyfw_com`, `signup_db`） |
| 8 | `source_mysql_version` | `5.7.44` |
| 9 | `source_timezone` | `CST`（东八区） |
| 10 | `source_charset` | `utf8mb4`（含混合 collation 明细） |
| 11 | `table_inventory_hash` | `table_inventory.json` 的 sha256 |
| 12 | `schema_dump_hash` | `schema-only.sql` 的 sha256 |
| 13 | `data_dump_hash` | `data-full.sql.gz` 的 sha256 |
| 14 | `row_count_summary` | 各表行数汇总（JSON 内联或引用） |
| 15 | `backup_file_paths` | 备份文件绝对路径列表 |
| 16 | `backup_file_hashes` | 各备份文件 sha256 |
| 17 | `offhost_copy_status` | NAS / 异地副本状态（OK / PENDING / FAIL） |
| 18 | `D1_database_id` | `ea603f43-d076-4df5-b118-3d8a0c245439` |
| 19 | `D1_pre_state_hash` | 迁移前 D1 导出哈希（空库态） |
| 20 | `Worker_version` | `b10791f8-b8ad-4a6e-963b-c40194af9a12` |
| 21 | `maintenance_window_id` | 维护窗标识 |
| 22 | `write_freeze_status` | FROZEN / VERIFIED / ABORTED |
| 23 | `drift_check_status` | PASS / FAIL（源静止校验） |
| 24 | `abort_conditions` | 触发中止的条件清单（见 §6.7） |
| 25 | `notes` | 备注 |
| 26 | `media_manifest_hash` | `media_manifest.json` 哈希 |
| 27 | `media_tar_hash` | `media.tar` 哈希 |
| 28 | `snapshot_type` | WARM_BASELINE / AUTHORITATIVE |
| 29 | `reconcile_baseline_ref` | 行数基线引用（供 WP5 对账） |
| 30 | `freeze_method` | 冻结实施方式（nginx 维护页 / 应用层） |
| 31 | `authorization_ref` | 授权人书面确认引用（MG-14/15） |

---

## 8. Gap Register（WP2 缺口登记）

分类：READY / PARTIAL / MISSING / UNKNOWN / BLOCKER

| ID | Area | Finding | Evidence | Severity | Blocking Stage | Required Closure | Owner Role |
|---|---|---|---|---|---|---|---|
| G-03 | Source 恢复演练 | 计划已定义（隔离测试库载入 + 行数校验），未执行 | 本计划 §4.1 / WP1 §4.1 | PARTIAL | WP2 执行 | WP2 执行轮在测试环境完成恢复演练并留 evidence | Migration Operator |
| G-04 | D1 备份/恢复 | 空库导出路径需执行轮验证（`wrangler d1 export` 可用性） | WP1 §4.2 / U-11 | PARTIAL | WP4 执行 | WP2/WP4 执行轮验证 D1 export/restore 官方路径 | Migration Operator |
| G-05 | 版本钉死（Worker/快照） | Worker version 已知（`b10791f8…`）；source snapshot hash 待执行生成 | WP1A §8 / U-02 | PARTIAL | WP2 执行 | WP2 执行轮钉死 snapshot hash（MG-05） | Migration Operator |
| G-06 | 混合 collation | 部分表 `utf8mb4_unicode_ci`，主 `utf8mb4_general_ci` | WP1 §2.3 | LOW | WP2 | 源侧不强制改；迁移目标按 D1 设计收敛 | Migration Operator |
| G-07 | 备份表冗余 | `*_old_*` / `*_backup_*` 历史表 | WP1 §2.4 | LOW | WP4 | 按 P8-3 WP2 裁定 DROP/ARCHIVE（快照保留，不丢） | Migration Operator |
| U-02 | source snapshot hash | 未取（执行轮生成） | WP1 §5 | UNKNOWN | WP2 执行 | WP2 执行轮取 snapshot+hash | Migration Operator |
| U-08 | 维护窗时间 | 窗口时长/时段未定 | WP1 §8 | UNKNOWN | WP2 | WP2 规划窗口（MG-12） | Cutover Approver |
| U-09 | 沟通/事件通道 | 未定义 | WP1 §8 | UNKNOWN | WP2 | WP2 定义（MG-13） | Cutover Approver |
| U-10 | STOP/回滚授权人 | 仅 ROLE | WP1 §8 | UNKNOWN | WP2 | 具名（MG-14/15） | Cutover Approver |
| U-07 | 具名操作人 | 6 角色仅 ROLE 占位 | WP1 §8 | UNKNOWN | WP2+ | 指派具名人员 | Cutover Approver |
| W2-01 | 媒体依赖捕获 | 文件目录 tar+hash 方案已定义，未实测打包 | 本计划 §3.12 | UNKNOWN | WP2 执行 | WP2 执行轮打包 media 并校验 | Migration Operator |
| W2-02 | 冻结写入验证 | 比对 UPDATE_TIME/行数方法已定义，未实测 | 本计划 §6 | UNKNOWN | WP2 执行 | WP2 执行轮实测冻结校验 | Migration Operator |

> 注：B-01 已 CLOSED（P9 WP1A），本计划阶段**无 BLOCKER**。上述缺口均为 PARTIAL / UNKNOWN（执行轮收口，不阻断本计划定义完成）。user_favorites 维持 EXCLUDED / BCR pending（P8-3 §7 / P9 Definition §5）。

---

## 9. FINAL GATE（P9 WP2）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `b53c275` / staged=0） |
| Authoritative baseline read | **YES**（P9 Definition / WP1 / WP1A / P8-3 CLOSEOUT / WP5 / WP6 全读） |
| Source snapshot plan defined | **YES**（§3：双库 / 时机 / 算子 / 维护窗 / 冻结 / 一致 / 清单 / 字符集时区 / 行数 / 结构 / 数据 / 媒体 / 哈希 / 命名） |
| Backup plan defined | **YES**（§4：MySQL 源 / D1 迁移前 / Worker 配置 三类） |
| Restore plan defined | **YES**（§5：源 MySQL / D1 / Worker 回滚 / 验证 / 授权 / 测试环境 dry-run） |
| Drift control plan defined | **YES**（§6：活跃域 / 冻结 / 无新写校验 / 中止 / 双写禁止） |
| Evidence schema defined | **YES**（§7：31 字段） |
| Gap Register complete | **YES**（12 项：0 BLOCKER + 5 PARTIAL + 6 UNKNOWN + 1 LOW 等） |
| Maintenance window required | **YES**（MG-12 / P9 Definition §7.3） |
| Dual-write prohibited | **YES**（P9 Definition §7.7；默认禁止，dual-write=Architecture Change） |
| BLOCKER count | **0** |
| UNKNOWN count | **6**（U-02 / U-07 / U-08 / U-09 / U-10 / W2-01 / W2-02 中 UNKNOWN 项） |
| Freeze Conflict Count | **0**（与 Constitution / Architecture Freeze / Data Governance Freeze 无冲突） |
| Production backup executed | **NO**（计划阶段） |
| Production dump executed | **NO** |
| Production write freeze executed | **NO** |
| Production data modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Entered WP3 | **NO** |

### **P9 WP2 Gate = PASS**（计划完整、可审计、可回滚、安全边界明确、无 Freeze 冲突、无 BLOCKER）

### **Ready for P9 WP3 = YES**（进入 WP3 仍需用户显式授权）

---

## 纪律声明（P9 WP2）

| 项 | 状态 |
|---|---|
| 修改 Freeze / Constitution / Core Domain | ❌ 无 |
| 执行 mysqldump / 实际备份生产库 | ❌ 无（仅设计） |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| user_favorites BCR | ❌ 无（保持 EXCLUDED / BCR pending） |
| Git 提交 | ❌ 无（本轮仅 WP2 计划文档，待授权后提交） |
| 生产数据修改 | ❌ NO |
| 生产配置修改 | ❌ NO |
| Deployment performed | ❌ NO |
| Routing changed | ❌ NO |

> **本计划阶段完成条件**：§3–§8 全部定义完成、FINAL GATE = PASS。完成后 STOP，未进入 P9 WP3，除非用户显式授权。

---

## 引用与依据

- 切换契约（维护窗 / 双写禁止 / 回滚回 1.0）：P9 Definition §7。
- 安全门 MG-01…15 / CG-01…12：P9 Definition §6。
- 回滚矩阵 RB-1…RB-9：P9 Definition §9。
- 生产证据 13 字段（含 migration run_id）：P9 Definition §10；P8-3 WP5 `operator-evidence/v1`。
- SC-01…SC-15 机器判定 STOP：P8-3 WP5 §D。
- `verifyRecovery()` 7 项恢复验证：P8-3 WP5 §F。
- 切换 Runbook C.1–C.3：P8-3 WP5 §C。
- 测试库演练与回滚框架：P8-3 WP6（81 tests）。
- 源现状（128 表 / 活跃写入 / binlog off / mysqldump 5.7.44 / NAS cron）：P9 WP1 §2。
- Worker 配置（name / version / binding / 无 route）：P9 WP1A §8。
- user_favorites EXCLUDED / BCR pending：P8-3 §7；P9 Definition §5。
