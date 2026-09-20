# P9 WP3 — Production Migration Preflight（生产迁移 Preflight）

> **阶段**：P9 WP3（生产迁移与切换·Preflight）
> **Preflight 日期**：2026-09-20
> **性质**：**Preflight only（只读核查 + 设计 Checklist / Evidence Template / Gap Register）**。复用 P8-3 WP5 `PF-01…PF-10` + `SC-01…SC-15`，扩展生产维度；**不执行 mysqldump、不实际备份、不锁表、不停止 1.0、不写 D1、不 import schema、不迁移、不灰度、不 Cutover、不修改 Worker、不 git commit（除非另行授权）**。
> **层级**：L3（实现层），承接 `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` §4 WP3 定义。
> **纪律**：本轮仅读取生产信息（SSH unix_socket 只读 `SELECT`/`SHOW` + Wrangler 只读 `d1 list`/`d1 execute` `SELECT`/`deployments list` + 配置文件 `cat`/`ls` + `git` 只读），未修改任何文件、未写入任何生产系统、未提交 Git。

---

## 0. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `7bb8152b2fc635ee3ab942b04736c4e8c6983d41`（`7bb8152`，P9 WP2 Git Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `7bb8152…`） |
| staged | 0 |
| P9 WP2 scope clean | ✅（WP2 文档已提交 `7bb8152`；仅 `p9-wp1a-worker/.wrangler/` 本地状态未跟踪、未提交、不属范围） |
| 其它并行改动 | 290 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），**不在 P9 范围，未处理** |

**结论：REPO_IDENTITY_GATE = PASS。**

> **本轮 Live Preflight 事实采集方式**（只读，已执行 2026-09-20）：
> - 生产源库：`ssh root@101.43.30.163` → `mysql` unix_socket 只读（`SELECT`/`SHOW`/`information_schema`）。SSH 连通性已验证（`SSH_OK`）。
> - D1 / Worker：`wrangler d1 list` / `wrangler d1 execute … --remote SELECT` / `wrangler deployments list`（Cloudflare API 经沙箱代理可达）。无任何 `INSERT/UPDATE/DELETE/DDL`、无 `wrangler deploy`、无 route 变更。

---

## 1. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 角色 / 用途 |
|---|---|
| `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` | P9 定义门（拓扑 T-1…T-6 / 安全门 MG-01…15、CG-01…12 / 切换契约 §7 / 回滚矩阵 §9 / 证据 §10） |
| `P9_WP1_PRODUCTION_READINESS_AUDIT.md` | 生产就绪审计（源库清单 / binlog OFF / 活跃漂移 / 备份机制 / 维护窗需求） |
| `P9_WP1A_CLOUDFLARE_WORKER_RESOURCE_PREPARATION_GATE.md` | Worker 资源准备（name / version / binding / route 状态；B-01 CLOSED） |
| `P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` | 源快照 / 备份 / 恢复 / 漂移控制 / 证据结构（**本轮发现其 §4.2 D1 空库假设需修正，见 §6 / Gap G-08**） |
| `P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` | 回滚方案（CLASS_1/2/3）/ `verifyRecovery()` 7 项 / STOP `SC-01…SC-15` / 切换 Runbook C.1–C.3 / operator-evidence/v1 |
| `P8-3_WP6_TEST_MIGRATION_REHEARSAL_REPORT.md` | 演练方法（隔离测试目标 / 恢复验证 / 81 tests） |

> 所有架构/业务/数据判定均引用上述基线，不新增原则、不重述定义。

---

## 2. Source Preflight（生产源 · 只读实测，2026-09-20）

| 项 | 实测值 | 来源 / 说明 |
|---|---|---|
| MySQL version | `5.7.44` | `SELECT VERSION()` |
| binlog status | **`log_bin = 0`（OFF）**；`binlog_format = ROW` | `@@log_bin` / `@@binlog_format` → **无法 binlog 增量捕获**，漂移控制必须依赖「冻结写入 + 静止快照」 |
| timezone | `SYSTEM = CST`（东八区） | `@@system_time_zone` / `@@time_zone` |
| charset / collation（server） | `utf8mb4` / `utf8mb4_general_ci` | `@@character_set_server` / `@@collation_server` |
| **mixed collation（实测确认）** | `system_config` = `utf8_general_ci`（非 utf8mb4！）；另 `certificate_master` / `certificates_preview` / `exchange_orders` / `file_uploads` / `jhzy_activity_signups_old_backup` / `jhzy_admins_old_20260214` / `jhzy_deleted_users` / `jhzy_feedback` / `jhzy_quick_actions` / `password_change_logs` / `points_mall` / `volunteer_deleted_logs` / `volunteer_group_members` / `volunteer_groups` = `utf8mb4_unicode_ci` | `information_schema.tables` → **G-06 升级为实测确认**（源侧混合排序规则，迁移目标按 D1 设计统一收敛，源侧不强制改） |
| authoritative source DB | `api_jhzyfw_com`（**128 张表**） | `information_schema` |
| `signup_db` | 3 张表（`events` / `participants` / `users`），**均 0 行**，静态 | `information_schema` |
| 其它非权威库（不参与迁移） | `abc_jhzyfw_com` / `adc_jhzyfw_com` / `api_jhzyfw_com_dev` / `api_jhzyfw_v2` / `jhzy20_dev` / `jhzy_new_backup` / `jhzy_v2` / `volunteer_exam` | `SHOW DATABASES`（仅盘点，迁移源仅为 `api_jhzyfw_com` + `signup_db`） |
| total size | **131.22 MB**（`api_jhzyfw_com`） | `information_schema` 求和 |
| largest tables | `id_pool` 96.78MB / 452,240 行；`id_pool_old_20260214` 26.09MB / 155,461 行；其余 < 0.5MB | `information_schema` |
| top row counts | `id_pool` 452,240；`id_pool_old_20260214` 155,461；`training_user_progress` 2,580；`volunteers` 609；`training_user_course_status` 572；`jhzy_attendance_records` 545；`jhzy_activity_signups` 488；`exam_records` 442；`exam_certificates` 405；`exam_questions` 280 | `information_schema` |
| **active write indicators（漂移实证）** | `training_user_progress` 最近写入 **`2026-09-20 09:52:46`**；`training_user_course_status` 09:48；`volunteers` 09:47；`id_pool` 09:45；`exam_certificates`/`exam_records` 09:27；`training_signatures` 09:27；`jhzy_activities`/`jhzy_activity_signups`/`jhzy_attendance_records` 08:33；`points_*` 2026-09-19 → **审计时刻源仍在持续写入，活跃漂移确认** | `information_schema.TABLES.UPDATE_TIME` |
| backup user / permission readiness | `jhzy20_readonly@127.0.0.1` 用户**已存在**，但其 grants 仅为 `SELECT ON jhzy20_dev.*` —— **不含 `api_jhzyfw_com`** | `SHOW GRANTS FOR 'jhzy20_readonly'@'127.0.0.1'` → **G-10：需建专用只读账号或沿用 root 只读（MG-03）** |
| mysqldump availability | ✅ `/usr/bin/mysqldump` | `which mysqldump` |
| disk free space | `/dev/vda1` 40G，已用 20G，**剩余 21G（49%）** | `df -h /` |
| off-host backup path | `/www/backup/database/database/mysql/crontab_backup/api_jhzyfw_com/` 存在；**最新备份 `api_jhzyfw_com_2026-09-20_01-30-42_mysql_data.sql.gz`（8,952KB，今日）** | `find /www/backup -name '*.sql*'` |

---

## 3. Drift Preflight（漂移 · 只读实测，2026-09-20）

| 维度 | 结论 |
|---|---|
| most recent write | **`2026-09-20 09:52:46`**（`training_user_progress`）—— 审计进行中源仍在写 |
| active write tables | `training_user_progress` / `training_user_course_status` / `volunteers` / `id_pool` / `exam_certificates` / `exam_records` / `training_signatures` / `jhzy_activities` / `jhzy_activity_signups` / `jhzy_attendance_records` / `points_exchange_records` / `points_transactions` / `points_mall` |
| 新增注册/报名/签到/积分/培训/证书/日志 | **YES**（上述域均有当日写入） |
| updated_at / created_at 可用性 | InnoDB 每表 `information_schema.TABLES.UPDATE_TIME` 可用；精确漂移用重点表 `COUNT(*)` 前后比对（部分表可能缺 per-row 时间戳，但表级 `UPDATE_TIME` + 行数 delta 足以验证冻结） |
| 无时间戳表 | 个别表可能无 `created_at`/`updated_at` 列；漂移校验以「表级 `UPDATE_TIME` + 重点表 `COUNT(*)` delta」为准，不依赖 per-row 时间戳 |
| maintenance window required | **YES**（依 P9 Definition §7.3；`binlog = OFF` → 必须冻结写入后取一致性快照） |
| no-write verification method | 冻结起点前/后比对重点表 `UPDATE_TIME` 与 `COUNT(*)`；预期一致（无新写） |
| drift check SQL plan | ① 冻结前采集重点表 `UPDATE_TIME` + `COUNT(*)` 基线（见 Evidence Template `row_count_summary`）；② 冻结后复采；③ 任一表 `UPDATE_TIME` 变化或 `COUNT(*)` 增加 → 判定仍有写入 |
| abort condition | 冻结后仍检测到新写入 → **立即 ABORT：NO MIGRATION / NO CUTOVER**（P9 Definition §7.7） |
| dual-write | **默认禁止**（P9 Definition §7.7）；若确需 → Architecture Change |

---

## 4. Backup Preflight（备份 · 只读核查，2026-09-20）

| 项 | 状态 | 证据 |
|---|---|---|
| NAS cron 存在 | ✅ READY | crontab：`0 2 * * * /opt/backup_to_nas.sh`、`0 2 * * * /opt/backup_db_to_nas.sh`、`* * * * * /opt/sync_to_nas.sh`、`0 2 * * * /opt/backup_scripts/daily_backup.sh`、`0 3 * * 0 /opt/backup_scripts/code_backup.sh` |
| backup path 存在 | ✅ | `/www/backup/database/database/mysql/crontab_backup/api_jhzyfw_com/` |
| 最近一次备份时间 | ✅ **2026-09-20 01:30**（当日，最新） | `find` 结果 `api_jhzyfw_com_2026-09-20_01-30-42_mysql_data.sql.gz` |
| 最近备份文件大小 | ✅ 8,952KB（`.sql.gz`） | 同上 |
| 最近备份是否可读 | ⚠️ PARTIAL | 文件存在且当日生成；**未做恢复演练**（禁止 WP3 执行；属 G-03，留 WP2/WP4 执行轮） |
| off-host copy | ✅ | rsync 推远端 NAS（cron 已配；`df -h` 无本地 NAS mount，属远程推送） |
| hash strategy 可执行 | ✅ | `sha256sum` 可用 |
| restore dry-run 环境 | ❌ UNKNOWN | 隔离测试 MySQL 实例**尚未建立**；需在 WP2/WP4 执行轮搭建并演练（G-03 / P8-3 WP6 纪律） |

> 本轮**未恢复生产备份、未覆盖任何文件**。

---

## 5. D1 / Worker Preflight（只读实测，2026-09-20）

| 项 | 状态 | 实测值 / 说明 |
|---|---|---|
| D1 `jhzy-v2-db` exists | ✅ | uuid `ea603f43-d076-4df5-b118-3d8a0c245439`；version = production（`wrangler d1 list`） |
| D1 table count | ⚠️ **86（非 0）** | `SELECT count(*) FROM sqlite_master WHERE type='table'` → **86**；`wrangler d1 list` 显示 `num_tables=0` 为**滞后元数据字段**（G-09，监控陷阱） |
| D1 schema state | **frozen V2 design schema** | 表含 `activities` / `activity_signups` / `attendance_*` / `certificates` / `courses` / `exam_*` / `content_*` / `d1_migrations` / `_cf_KV` 等；`d1_migrations` 记录 `0001_initial_schema.sql`…`0005_attendance_time_policy.sql` 等，applied_at `2026-09-18 08:52` |
| D1 **business data** | ✅ **EMPTY（clean target）** | `activities=0` / `courses=0` / `exam_questions=0` / `certificates=0` / `content_articles=0` / `attendance_events=0` |
| D1 RBAC seed | 已载入（预期内） | `permissions=104` / `roles=6` / `role_permissions=295`（来自 `0003_seed_permissions.sql`） |
| Worker `jhzy-v2-api` exists | ✅ | `wrangler deployments list` → Version `b10791f8-b8ad-4a6e-963b-c40194af9a12`，Created `2026-09-19T14:10:38`，Author `lsv3255@gmail.com`（与 WP1A 一致，**未重部署**） |
| D1 binding `DB`→`jhzy-v2-db` | ✅ | WP1A §8 验证；`/health/d1` 返回 `ok:1` |
| `/health` / `/version` / `/health/d1` | ✅ | WP1A 执行验证（200） |
| route state | ✅ **无生产 route** | wrangler.toml 无 `routes`/`route` 块；从未部署生产 route；仅 `workers.dev` 可达（`wrangler routes list` 在 4.124.0 非合法子命令，建议 WP4 执行轮在 Dashboard 复核 route 绑定） |

> **⚠️ 关键修正（G-08）**：P9 WP2 §4.2 假设「D1 `num_tables = 0`（空库），迁移前备份=记录空态」**已过时**。实测 D1 已有 86 表 frozen schema + RBAC seed，业务表为空。含义：
> 1. WP4 数据迁移**面向已存在 schema**（无需建表），仅插入业务数据，**必须保留 RBAC seed**（不重复 seed、不重建 schema）；
> 2. WP2 §4.2「D1 迁移前备份」须修正为**导出 86 表 schema+seed 状态**（非空库），并记录 `d1_migrations` 应用版本；
> 3. 此状态**对迁移有利**（目标 schema 已就绪、业务数据空白），不构成 BLOCKER，但须在 WP2/WP4 执行轮前修正文档假设。

---

## 6. Preflight Checklist（PF-01…PF-15）

状态：PASS / PARTIAL / FAIL / UNKNOWN / BLOCKER

| # | 检查项 | 状态 | 证据 / 说明 |
|---|---|---|---|
| PF-01 | repo / git SHA | **PASS** | HEAD=`7bb8152`，origin/master 一致 |
| PF-02 | source DB connectivity | **PASS** | SSH unix_socket 只读连通；MySQL 5.7.44 |
| PF-03 | source table inventory | **PASS** | `api_jhzyfw_com`=128 表；`signup_db`=3 表（0 行），live 计数 |
| PF-04 | source backup readiness | **PARTIAL** | NAS cron + 当日备份存在；恢复演练未执行（G-03） |
| PF-05 | restore dry-run readiness | **UNKNOWN** | 隔离测试 MySQL 未建立 |
| PF-06 | D1 readiness | **PARTIAL** | D1 存在、86 表 frozen schema+seed、业务空=clean target；`wrangler d1 list` num_tables 滞后（G-09）；D1 export/restore 路径未实测（G-04） |
| PF-07 | Worker readiness | **PASS** | 部署 `b10791f8…`；binding `DB`；`/health` OK；无生产 route |
| PF-08 | no production route change | **PASS** | 无 route 绑定；WP1A 设计未变 |
| PF-09 | maintenance window readiness | **UNKNOWN** | 窗口时间/时长未规划（U-08） |
| PF-10 | write-freeze procedure readiness | **PARTIAL** | 方法已定义（WP2 §6）；未演练（W2-02） |
| PF-11 | drift-check procedure readiness | **PARTIAL** | SQL plan 已定义；未演练 |
| PF-12 | operator roles | **UNKNOWN** | 6 角色仅 ROLE 占位，未具名（U-07） |
| PF-13 | evidence directory | **PARTIAL** | 证据 schema 已定义（WP2 §7）；执行宿主目录未建 |
| PF-14 | rollback authority | **UNKNOWN** | 未具名（U-10） |
| PF-15 | STOP conditions SC-01…SC-15 acknowledged | **PASS** | P8-3 WP5 §D 全 15 项已复核 |

---

## 7. Evidence Template（未来正式执行模板 · 仅字段，禁填伪造结果）

> 沿用 `p8-3-operator-evidence/v1` schema，扩展生产字段（P9 Definition §10）。以下为**模板字段**，正式执行轮填入真实值。

| # | 字段 | 说明 |
|---|---|---|
| 1 | `preflight_run_id` | 本次 preflight 执行 run_id（贯穿 issues/reconcile/rollback/evidence） |
| 2 | `operator` | 操作人身份 |
| 3 | `timestamp` | 执行时间（UTC+8） |
| 4 | `git_sha` | 迁移/对账/回滚代码 SHA（`7bb8152` 起 P9 链；P8-3 工具链 `811155c`） |
| 5 | `source_host` | 源主机 `101.43.30.163` |
| 6 | `source_databases` | `api_jhzyfw_com`, `signup_db` |
| 7 | `mysql_version` | `5.7.44` |
| 8 | `binlog_status` | `log_bin=0 (OFF)` / `binlog_format=ROW` |
| 9 | `timezone` | `CST` |
| 10 | `charset` | `utf8mb4`（含混合 collation 明细：server `utf8mb4_general_ci`；`system_config`=`utf8_general_ci`；15 表 `utf8mb4_unicode_ci`） |
| 11 | `table_inventory` | `api_jhzyfw_com`=128 表 + `signup_db`=3 表（0 行）清单 |
| 12 | `row_count_summary` | 各表行数（基线，供 WP5 对账；重点表 `id_pool`=452,240 等） |
| 13 | `backup_readiness` | NAS cron=YES；最新备份 `2026-09-20 01:30` 8,952KB `.sql.gz`；恢复演练=待执行 |
| 14 | `restore_readiness` | 隔离测试 MySQL=待建；`verifyRecovery()` dry-run=待执行 |
| 15 | `D1_state` | `jhzy-v2-db`（uuid `ea603f43-…`）；**86 表 frozen schema + RBAC seed（permissions=104/roles=6/role_permissions=295）；业务表=0**；`d1_migrations` applied `2026-09-18` |
| 16 | `Worker_state` | `jhzy-v2-api` Version `b10791f8-…`；binding `DB`→`jhzy-v2-db`；route=workers.dev only |
| 17 | `maintenance_window` | 窗口 ID / 起止 / 时长（待规划 U-08） |
| 18 | `drift_control` | 冻结方法 + `UPDATE_TIME`/`COUNT(*)` 比对结果 + abort 标记 |
| 19 | `STOP_conditions` | `SC-01…SC-15` 全 15 项判定（P8-3 WP5 §D） |
| 20 | `final_preflight_decision` | PROCEED / STOP（依 PF-01…PF-15 与 SC 判定） |

---

## 8. Gap Register（WP3 缺口登记）

分类：READY / PARTIAL / MISSING / UNKNOWN / BLOCKER

| ID | Area | Finding | Evidence | Severity | Blocking Stage | Required Closure | Owner Role |
|---|---|---|---|---|---|---|---|
| G-03 | Source 恢复演练 | 备份文件当日存在；恢复演练未执行 | §4 / WP2 §4.1 | PARTIAL | WP2/WP4 执行 | 隔离测试 MySQL 载入 + 行数校验留 evidence | Migration Operator |
| G-04 | D1 备份/恢复 | D1 现 86 表 schema+seed，export/restore 官方路径未实测 | §5 / U-11 | PARTIAL | WP4 执行 | `wrangler d1 export` 验证 + 恢复演练 | Migration Operator |
| G-05 | 版本钉死（Worker/快照） | Worker version 已知 `b10791f8…`；source snapshot hash 待执行生成 | WP1A §8 / U-02 | PARTIAL | WP2 执行 | WP2 执行轮钉死 snapshot hash（MG-05） | Migration Operator |
| G-06 | 混合 collation | **实测确认**：`system_config`=`utf8_general_ci` + 15 表 `utf8mb4_unicode_ci` | §2 information_schema | LOW | WP2 | 源侧不强制改；迁移目标按 D1 设计收敛 | Migration Operator |
| G-07 | 备份表冗余 | `*_old_*` / `*_backup_*` / `id_pool_old_*` 历史表（含 `id_pool_old_20260214` 155,461 行） | §2 | LOW | WP4 | 按 P8-3 WP2 裁定 DROP/ARCHIVE（快照保留，不丢） | Migration Operator |
| **G-08** | **D1 空库假设过时** | **WP2 §4.2「D1 num_tables=0 空库」与实测 86 表 frozen schema+seed 不符**（因 `wrangler d1 list` num_tables 滞后）；D1 业务表为空=clean target，对迁移有利 | §5 / `d1_migrations` | **MEDIUM** | WP2/WP4 | **修正 WP2 §4.2**：D1 迁移前备份改导 86 表 schema+seed；WP4 迁移计划须视 schema 为已存在、保留 RBAC seed、仅插业务数据 | Migration Operator |
| **G-09** | D1 num_tables 元数据滞后 | `wrangler d1 list` `num_tables=0` 但引擎实际 86 表 → 监控陷阱 | §5 | LOW | WP3+ | 后续 D1 状态核查一律以 `sqlite_master` `count(*)` 为准，不采信 `wrangler d1 list` num_tables | Migration Operator |
| **G-10** | 只读账号权限缺口 | `jhzy20_readonly@127.0.0.1` grants 仅 `SELECT ON jhzy20_dev.*`，**不含 `api_jhzyfw_com`** | §2 `SHOW GRANTS` | **MEDIUM** | WP3/WP4 执行 | 建专用只读账号（`SELECT` on `api_jhzyfw_com`+`signup_db`）或沿用 root 只读（MG-03 最小权限） | Infra Operator / Migration Operator |
| U-02 | source snapshot hash | 未取（执行轮生成） | WP1 §5 | UNKNOWN | WP2 执行 | WP2 执行轮取 snapshot+hash | Migration Operator |
| U-04 | DNS 托管方 | `jhzyfw.com` DNS 权威未知 | WP1 §7 | UNKNOWN | WP6 | WP3/WP6 确认 DNS 提供方与改记录权限 | Infra Operator |
| U-05 | Host/IP 透传 | client IP / X-Forwarded 配置未读 | WP1 §7 | UNKNOWN | WP6 | WP3/WP6 读 nginx 透传配置 | Infra Operator |
| U-06 | 超时/重试/健康/回退 | Worker 未部署生产 route，链路参数未定义 | WP1 §7 | UNKNOWN | WP6 | WP3/WP6 定义并验证 | Infra Operator |
| U-07 | 具名操作人 | 6 角色仅 ROLE 占位 | WP1 §8 | UNKNOWN | WP2+ | 指派具名人员 | Cutover Approver |
| U-08 | 维护窗时间 | 窗口时长/时段未定 | WP1 §8 | UNKNOWN | WP2 | WP2 规划窗口（MG-12） | Cutover Approver |
| U-09 | 沟通/事件通道 | 未定义 | WP1 §8 | UNKNOWN | WP2 | WP2 定义（MG-13） | Cutover Approver |
| U-10 | STOP/回滚授权人 | 仅 ROLE | WP1 §8 | UNKNOWN | WP2 | 具名（MG-14/15） | Cutover Approver |
| U-11 | D1 备份能力 | D1 export/恢复官方路径未实测 | WP1 §4.2 | UNKNOWN | WP4 | 确认 export 路径（G-04） | Migration Operator |
| U-12 | R2/KV 权威态角色 | R2/KV 是否承载权威态未知 | WP1 §2.2 | UNKNOWN | WP3 | 确认状态归属（D1 唯一权威，R2/KV 仅辅助） | Platform Operator |
| W2-01 | 媒体依赖捕获 | 文件目录 tar+hash 方案已定义，未实测打包 | WP2 §3.12 | UNKNOWN | WP2 执行 | WP2 执行轮打包 media 并校验 | Migration Operator |
| W2-02 | 冻结写入验证 | 比对 UPDATE_TIME/行数方法已定义，未实测 | WP2 §6 | UNKNOWN | WP2 执行 | WP2 执行轮实测冻结校验 | Migration Operator |

> **BLOCKER = 0**（B-01 已 CLOSED；G-08/G-09/G-10 为 MEDIUM/LOW 修正项，不阻断 WP3 Preflight 完成，但 G-08 须在 WP4 执行前修正 WP2 文档假设）。user_favorites 维持 EXCLUDED / BCR pending（P8-3 §7 / P9 Definition §5）。

---

## 9. FINAL GATE（P9 WP3）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `7bb8152` / HEAD==origin/master / staged=0） |
| Authoritative baseline read | **YES**（P9 Definition / WP1 / WP1A / WP2 / P8-3 WP5 / P8-3 WP6 全读） |
| Source preflight complete | **YES**（§2：version/binlog/tz/charset/128+3 表/131MB/活跃漂移/只读账号缺口/mysqldump/磁盘/备份路径 全部实测） |
| Drift preflight complete | **YES**（§3：活跃漂移实证 + 维护窗必须 + no-write 校验法 + drift SQL + abort） |
| Backup preflight complete | **YES**（§4：NAS cron/路径/当日备份/hash/off-host 核查；恢复演练留 WP2/WP4） |
| D1 preflight complete | **YES**（§5：86 表 frozen schema+seed、业务空=clean target、binding OK、route 无） |
| Worker preflight complete | **YES**（§5：部署 `b10791f8…`/binding/health/无 route） |
| Preflight checklist complete | **YES**（§6：PF-01…PF-15 全定义并赋状态） |
| Evidence template complete | **YES**（§7：20 字段模板） |
| Gap Register complete | **YES**（§8：0 BLOCKER + 3 MEDIUM/LOW + 多 PARTIAL/UNKNOWN） |
| Maintenance window required | **YES**（MG-12 / P9 Definition §7.3 / binlog OFF） |
| BLOCKER count | **0** |
| UNKNOWN count | **12**（U-02 / U-04 / U-05 / U-06 / U-07 / U-08 / U-09 / U-10 / U-11 / U-12 / W2-01 / W2-02） |
| Freeze Conflict Count | **0**（与 Constitution / Architecture Freeze / Data Governance Freeze 无冲突） |
| Production dump executed | **NO**（仅只读核查） |
| Production backup executed | **NO** |
| Production write freeze executed | **NO** |
| Production data modified | **NO** |
| D1 modified | **NO**（仅只读 `SELECT`；未写、未 import schema） |
| Worker modified | **NO**（未 redeploy、未改 route） |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP3 Gate = PASS**（Preflight 完整、只读纪律严守、生产事实实测、Checklist/Evidence/Gap 齐备、无 BLOCKER）

### **Ready for P9 WP4 = CONDITIONAL YES**（进入 WP4 仍需用户显式授权；前置条件见下方「进入 WP4 前必须修正」）

> **进入 WP4 前必须修正（非阻塞，但须先处理）**：
> 1. **G-08**：修正 `P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` §4.2「D1 空库」假设 → D1 已有 86 表 frozen schema + RBAC seed，迁移前备份须导出该状态；WP4 迁移须保留 seed、不重建 schema。
> 2. **G-10**：建专用只读账号（`SELECT` on `api_jhzyfw_com` + `signup_db`）以满足 MG-03 最小权限（当前 `jhzy20_readonly` 不含权威源库）。
> 3. **G-09**：后续 D1 状态核查一律以 `sqlite_master` `count(*)` 为准，不采信 `wrangler d1 list` `num_tables`。

---

## 10. 纪律声明（P9 WP3）

| 项 | 状态 |
|---|---|
| 修改 Freeze / Constitution / Core Domain | ❌ 无 |
| 执行 mysqldump / 实际备份生产库 | ❌ 无（仅只读核查 + `which mysqldump`） |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无（D1 仅只读 `SELECT`） |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无（仅 `wrangler deployments list` 只读） |
| user_favorites BCR | ❌ 无（保持 EXCLUDED / BCR pending） |
| Git 提交 | ❌ 无（本轮仅 WP3 文档，待授权后提交） |
| 生产数据修改 | ❌ NO |
| 生产配置修改 | ❌ NO |
| Deployment performed | ❌ NO |
| Routing changed | ❌ NO |

> **本 Preflight 阶段完成条件**：§2–§8 全部定义 + 生产事实实测 + FINAL GATE = PASS。完成后 STOP，未进入 P9 WP4，除非用户显式授权。

---

## 引用与依据

- 切换契约（维护窗 / 双写禁止 / 回滚回 1.0）：P9 Definition §7。
- 安全门 MG-01…15 / CG-01…12：P9 Definition §6。
- 回滚矩阵 RB-1…RB-9：P9 Definition §9。
- 生产证据 13 字段（含 migration run_id）：P9 Definition §10；P8-3 WP5 `operator-evidence/v1`。
- SC-01…SC-15 机器判定 STOP：P8-3 WP5 §D。
- `verifyRecovery()` 7 项恢复验证：P8-3 WP5 §F。
- 源现状（128 表 / 活跃写入 / binlog off / mysqldump 5.7.44 / NAS cron）：P9 WP1 §2（本轮 2026-09-20 实测复核一致，并补 mixed collation 实测、只读账号缺口、D1 86 表实测）。
- Worker 配置（name / version / binding / 无 route）：P9 WP1A §8（本轮 2026-09-20 复核 version 未变）。
- 源快照/备份计划（须修正 D1 空库假设）：P9 WP2 §3–§7（G-08）。
- user_favorites EXCLUDED / BCR pending：P8-3 §7；P9 Definition §5。
