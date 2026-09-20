# P9 WP4-B — Source Backup Execution Readiness Gate

> **阶段**：P9 WP4-B（Readiness Gate only）
> **执行日期**：2026-09-20（CST）
> **性质**：**就绪性门（Readiness Gate）** —— 仅只读核查 + 设计备份执行模板 / 证据 / 中断规则 / Gap Register；**不执行** mysqldump、不实际备份、不锁表、不冻结、不触碰生产数据。
> **承接**：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5（备份执行计划）、`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`（只读账号）、`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 活跃漂移）、`P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md`（备份计划）、`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS 回滚）。
> **纪律**：本轮无任何生产写；未 git commit（待授权）。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| P9 WP4-A | FINAL PASS（commit `f5c606a`，HEAD == origin/master） |
| G-10 | **CLOSED**（`jhzy_mig_ro@127.0.0.1` 仅 `SELECT` 两源库，验证 PASS） |
| 最新远端 commit | `f5c606a` |
| 本轮性质 | Readiness Gate（只读 + 设计） |
| 是否执行备份 | **NO** |

---

## 1. 权威基线（已读取）

| 文档 | 用途 |
|---|---|
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | WP4 定义（§5 备份执行计划 / G-10 CLOSED） |
| `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` | G-10 关闭证据（jhzy_mig_ro 最小只读） |
| `P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md` | binlog OFF / 活跃漂移 / 维护窗必需 / D1 86 表 |
| `P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` | 源快照 / 备份 / 恢复 / 漂移控制计划 |
| `P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` | SC-01…SC-15 STOP 条件 / CLASS_1-3 回滚 / 源库不可触碰 |

**基线确认**：G-10=CLOSED；`jhzy_mig_ro` 可 SELECT 两源库；生产业务数据未修改；schema 临时修改已回滚且无残留；binlog=OFF；active drift exists；maintenance window required；dual-write prohibited。

---

## 2. Source Backup Readiness（只读核查，2026-09-20）

| 检查项 | 实测值 | 就绪 |
|---|---|---|
| MySQL version | `5.7.44` | ✅ |
| CURRENT_USER（核查用） | `root@localhost`（unix_socket，仅只读核查） | ✅ |
| log_bin | `OFF` | ⚠️ 须冻结（见 §5） |
| 只读账号 `jhzy_mig_ro@127.0.0.1` | `USAGE ON *.*` + `SELECT ON api_jhzyfw_com.*` + `SELECT ON signup_db.*` | ✅ |
| `api_jhzyfw_com` 存在 | ✅（128 表 / 120.14 MB） | ✅ |
| `signup_db` 存在 | ✅（3 表 / 0.09 MB） | ✅ |
| 字符集 / 排序规则 | `api_jhzyfw_com`=`utf8mb4`/`utf8mb4_general_ci`；`signup_db`=`utf8mb4`/`utf8mb4_unicode_ci`（**混合 collation**） | ⚠️ 见 G-3 |
| 时区 | `@@global.system_time_zone=CST`（`SYSTEM`） | ✅ |
| routines / triggers / events | routines=**1**（`api_jhzyfw_com.assign_certificate_id` PROCEDURE）/ triggers=0 / events=0 | ⚠️ 见 G-1 |
| `mysqldump` 路径 / 版本 | `/usr/bin/mysqldump` / `Ver 10.13 Distrib 5.7.44` | ✅ |
| `gzip` | `/usr/bin/gzip` 1.12 | ✅ |
| `sha256sum` | `/usr/bin/sha256sum`（coreutils 9.4） | ✅ |
| 备份目标目录 | `/www/backup/database` 存在（`drwx------` root，May 24） | ✅ |
| 真实每日备份路径 | `/www/backup/database/database/mysql/crontab_backup/api_jhzyfw_com/` | ✅ |
| 最新既有备份 | `api_jhzyfw_com_2026-09-20_01-30-42_mysql_data.sql.gz`（当日 cron 安全副本） | ✅（非权威） |
| NAS / off-host 路径 | `//100.119.44.27/nvme16-135XXXX0654` → `/mnt/nas-storage`（CIFS，定义存在） | ⚠️ **当前 Host is down**（见 G-2） |
| 磁盘可用空间 | `/dev/vda1` 40G / 20G 用 / **21G 可用** / 49% | ✅ |

**只读账号备份适用性**：`jhzy_mig_ro` 具备 `SELECT` 两源库 → 可执行 schema-only + data + triggers 的 `--single-transaction` 一致性 dump（无需 LOCK TABLES）。**但** `--routines` 需 `SELECT ON mysql.proc`（mysql 系统库），该账号无此权限 → routines 单独处理（见 G-1 / §4）。`--events` 无需（events=0）。`--triggers` 默认开启且仅需表级 SELECT（具备）。

---

## 3. Backup Command Template（仅定义，不执行）

> 以下为未来正式执行命令模板。`<REDACTED>` 表示密码不落文档/聊天；`<RUN_ID>` 由执行轮生成；`<AUTH_DUMP_ACCOUNT>` 为具 DBA 授权的备份账号（**非** jhzy_mig_ro，不得临时提权）。

### 3.1 备份根目录与命名
```
BACKUP_ROOT=/www/backup/database/migration/wp4b/<RUN_ID>/
NAS_ROOT=/mnt/nas-storage/jhzy-migration/wp4b/<RUN_ID>/   # 须 NAS 可达（见 G-2）
FILE_PREFIX=<DB>_<YYYYMMDD_HHMMSS>_mig_snapshot
# 例：api_jhzyfw_com_20260920_143000_mig_snapshot_schema.sql.gz
```

### 3.2 Tier A — 只读账号 dump（schema + data + triggers，两源库）
```bash
# schema-only（含 triggers DDL，不含 routines/events）
mysqldump -u jhzy_mig_ro -p<REDACTED> -h 127.0.0.1 \
  --single-transaction --no-data --triggers --events=FALSE --routines=FALSE \
  --default-character-set=utf8mb4 --set-gtid-purged=OFF \
  <DB> | gzip -9 > ${BACKUP_ROOT}/${FILE_PREFIX}_schema.sql.gz

# data-only（不含 triggers 重复）
mysqldump -u jhzy_mig_ro -p<REDACTED> -h 127.0.0.1 \
  --single-transaction --no-create-info --skip-triggers \
  --default-character-set=utf8mb4 --set-gtid-purged=OFF \
  <DB> | gzip -9 > ${BACKUP_ROOT}/${FILE_PREFIX}_data.sql.gz
```
- `<DB>` ∈ {`api_jhzyfw_com`, `signup_db`}。
- `--single-transaction` 提供 InnoDB 一致性快照，无需表锁（binlog OFF 下仍为唯一一致手段）。
- `--default-character-set=utf8mb4` 保字符集；各库原生 collation 随 dump 保留，恢复时按库匹配（G-3）。

### 3.3 Tier B — routines 单独捕获（授权账号，非 jhzy_mig_ro）
```bash
# 仅 1 个例程：api_jhzyfw_com.assign_certificate_id（PROCEDURE）
mysql -u <AUTH_DUMP_ACCOUNT> -p<REDACTED> -h 127.0.0.1 \
  -e "SHOW CREATE PROCEDURE api_jhzyfw_com.assign_certificate_id" \
  > ${BACKUP_ROOT}/api_jhzyfw_com_routines.sql
# 或等价：mysqldump -u <AUTH_DUMP_ACCOUNT> --no-data --routines --no-create-info --triggers=FALSE api_jhzyfw_com
```
- **不得**为 jhzy_mig_ro 临时授予 `mysql.*` SELECT（违反最小权限 MG-03）。routines 捕获缺口见 G-1。

### 3.4 压缩 + 哈希 + 落盘 + off-host 拷贝
```bash
sha256sum ${BACKUP_ROOT}/*.sql.gz > ${BACKUP_ROOT}/sha256_manifest.txt
# off-host copy（须 G-2 关闭后）
mkdir -p ${NAS_ROOT}
cp -a ${BACKUP_ROOT}/. ${NAS_ROOT}/
sha256sum -c ${NAS_ROOT}/sha256_manifest.txt   # 校验 NAS 副本一致
```

### 3.5 时区与 binlog 捕获（证据）
```bash
mysql -N -e "SELECT @@global.system_time_zone, @@global.time_zone;"   # 记录 CST
# binlog=OFF → 快照须配合维护窗冻结（见 §5）
```

---

## 4. Maintenance Window Position（维护窗定位）

1. **备份就绪性现在即可核查**（本门已完成）→ READY。
2. **权威快照备份（authoritative snapshot）必须处于维护窗 + 写入冻结（write-freeze）内执行**。
3. **无写入验证（no-write verification）必须在权威快照前完成**：冻结后、dump 前，校验 `UPDATE_TIME` 与行数在窗口内无新增写入；若仍有写入 → **ABORT** 实际备份/快照。
4. **无冻结的备份只能视为「非权威安全副本」（non-authoritative safety copy）**，不得标记为迁移权威快照（与 WP3 §6 / WP2 §6 一致）。
5. 双写默认禁止（架构约束）；任何双写方案属 Architecture Change，不在 WP4-B 范围。

---

## 5. Backup Evidence Template（未来正式备份执行须产出）

| 字段 | 说明 |
|---|---|
| `backup_run_id` | 执行轮唯一 ID |
| `operator` | 具名操作员（U-07 占位） |
| `timestamp_start` / `timestamp_end` | 起止时间戳（CST） |
| `git_sha` | 当前仓库 HEAD |
| `source_host` | `101.43.30.163`（生产） |
| `source_databases` | `api_jhzyfw_com`, `signup_db` |
| `mysql_version` | `5.7.44` |
| `binlog_status` | `OFF`（须配合冻结） |
| `timezone` | `CST` |
| `charset` | `utf8mb4`（各库 collation 见 §2） |
| `readonly_user` | `jhzy_mig_ro@127.0.0.1` |
| `backup_mode` | `authoritative_snapshot` / `non_authoritative_safety_copy` |
| `maintenance_window_id` | 维护窗 ID（权威快照必填） |
| `write_freeze_status` | `frozen` / `not_frozen`（权威须 frozen） |
| `table_inventory_hash` | 两库表清单 SHA256（128 + 3） |
| `schema_dump_files` | Tier A schema 文件清单 |
| `data_dump_files` | Tier A data 文件清单 |
| `compressed_files` | `.sql.gz` 清单 |
| `sha256_hashes` | 各文件 SHA256 |
| `file_sizes` | 字节数 |
| `local_path` | `BACKUP_ROOT` |
| `NAS_path` | `NAS_ROOT`（G-2 关闭后） |
| `offhost_copy_status` | `verified` / `skipped`（理由） |
| `restore_test_required` | `TRUE`（隔离测试库载入 + 行数校验，见 WP2 §4.1 / G-3） |
| `abort_conditions` | 见 §6 |
| `final_decision` | `AUTHORITATIVE_READY` / `SAFETY_COPY_ONLY` / `ABORTED` |

---

## 6. Abort Rules（中断规则）

| ID | 条件 | 级别 | 动作 |
|---|---|---|---|
| AB-01 | 磁盘空间不足（目标 < 2×dump 预估 ~250MB） | CRITICAL | **ABORT** |
| AB-02 | 只读账号无法 dump 所需数据（权限不足且拒绝临时提权） | CRITICAL | **ABORT**（记录 G-1） |
| AB-03 | 备份目标目录不可写 / 不存在 | CRITICAL | **ABORT** |
| AB-04 | 任一压缩/哈希失败（sha256 不匹配） | CRITICAL | **ABORT** |
| AB-05 | NAS / off-host 拷贝失败 | 按模式 | 权威快照 → **ABORT**；安全副本 → `SAFETY_COPY_ONLY`（记 G-2） |
| AB-06 | 权威快照期间检测到活跃写入（no-write 验证失败） | CRITICAL | **ABORT**（不冻结不快照） |
| AB-07 | schema 漂移（dump 表清单/签名与基线不符） | CRITICAL | **ABORT**（对齐 SC-09 / SC-11） |
| AB-08 | dump 过程 WARNING/ERROR（非显式分类安全） | CRITICAL | **ABORT** |
| AB-09 | 冻结冲突（freezeConflict ≠ 0） | CRITICAL | **ABORT**（对齐 SC-13） |

> 与 P8-3 WP5 对齐：SC-11 source snapshot mismatch、SC-13 freeze conflict 命中即 STOP。

---

## 7. Gap Register（WP4-B Readiness）

| ID | Area | Finding | Evidence | Severity | Blocking Stage | Required Closure | Owner Role |
|---|---|---|---|---|---|---|---|
| G-1 | routines 权限 | `jhzy_mig_ro` 仅 SELECT 两源库；`--routines` 需 `SELECT ON mysql.proc`；源库含 1 例程 `api_jhzyfw_com.assign_certificate_id` PROCEDURE | §2 routines=1 | **MEDIUM** | WP4-B 执行（routines 部分） | 用授权 DBA 账号（`<AUTH_DUMP_ACCOUNT>`）捕获例程 DDL；或论证 D1 无需该过程并显式排除；**不得**临时提权 jhzy_mig_ro | Infra Operator / DBA |
| G-2 | NAS off-host | `/mnt/nas-storage` 当前 `Host is down`（CIFS 挂载定义存在但断连） | §2 `ls` 报错 | **MEDIUM** | off-host 拷贝验证 | 重新挂载 NAS + 可达性 + 非破坏写测试；执行前确认 `NAS_path` 可写 | Infra Operator |
| G-3 | 混合 collation | `api_jhzyfw_com`=`utf8mb4_general_ci`、`signup_db`=`utf8mb4_unicode_ci` | §2 | **LOW** | 恢复验证 | 模板已含 `--default-character-set=utf8mb4` + 按库原生 collation；恢复时逐库校验 | Migration Operator |
| G-4 | 维护窗 + 冻结 | binlog=OFF + 活跃漂移 → 权威快照必须维护窗 + 写入冻结；当前未排期 | WP3 §6 | **CONTROL（前置）** | 实际权威快照 | 排定维护窗 + 冻结 + no-write 验证（用户书面授权进入执行轮） | Migration Operator / 管理员 |
| G-5 | 既有备份性质 | 当日 cron 备份 `api_jhzyfw_com_2026-09-20_01-30-42...sql.gz` 存在但无冻结 → 非权威安全副本 | WP3 §4 | **INFO** | — | 仅作安全副本基线；不替代权威快照 | — |
| G-6 | 磁盘空间 | 21G 可用，充足 | §2 df | **READY** | — | — | — |
| G-7 | 双写禁令 | 架构约束：双写默认禁止 | WP4 Def | **READY** | — | — | — |
| U-01 | 既有 cron 备份内容 | 未知是否含 routines/triggers | 未解析 `.sql.gz` | **UNKNOWN** | — | 执行轮抽样校验既有备份完整性 | Migration Operator |
| U-02 | NAS 重连稳定性 | 断连是否偶发 / 重连后是否保持 | 仅本次探测 | **UNKNOWN** | — | 执行前复测可达性 | Infra Operator |
| U-03 | 例程迁移必要性 | D1 无存储过程；`assign_certificate_id` 是否需迁移语义 | 待设计确认 | **UNKNOWN** | — | 迁移设计轮确认（B13 证书中心） | Migration Operator |

**分类统计**：READY=2（G-6/G-7）；PARTIAL=0；MISSING=0；UNKNOWN=3（U-01/U-02/U-03）；BLOCKER=**0**（G-1/G-2 为 MEDIUM 且有明确 closure，不阻断就绪性设计；G-4 为执行前置控制）。

---

## 8. FINAL GATE（P9 WP4-B Readiness）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `f5c606a` / HEAD==origin/master / staged=0） |
| Authoritative baseline read | **YES**（WP4 Def / WP4-A / WP3 / WP2 / P8-3 WP5 全读） |
| G-10 closed confirmed | **YES**（jhzy_mig_ro 仅 SELECT 两源库） |
| Source backup readiness checked | **YES**（§2 只读核查全项） |
| Backup destination checked | **YES**（`/www/backup/database` 存在；真实路径定位） |
| NAS/off-host path checked | **YES（当前 DOWN，记 G-2）** |
| Disk space checked | **YES**（21G 可用） |
| mysqldump availability checked | **YES**（5.7.44） |
| Readonly account backup suitability checked | **YES**（data/schema/triggers 可；routines 缺口 G-1） |
| Backup command template defined | **YES**（§3 Tier A/B + 压缩/哈希/off-host） |
| Maintenance window position defined | **YES**（§4：就绪可查、权威须冻结、无冻结=非权威） |
| Evidence template defined | **YES**（§5，25 字段） |
| Abort rules defined | **YES**（§6 AB-01…AB-09，对齐 SC-09/11/13） |
| Gap Register complete | **YES**（§7：READY=2 / UNKNOWN=3 / BLOCKER=0） |
| **BLOCKER count** | **0** |
| **UNKNOWN count** | **3**（U-01/U-02/U-03） |
| **Freeze Conflict Count** | **0** |
| Production dump executed | **NO** |
| Production backup executed | **NO** |
| Production write freeze executed | **NO** |
| Production data modified | **NO** |
| Production schema modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4-B Readiness Gate = PASS**

### **Ready for P9 WP4-B Backup Execution = YES（CONDITIONAL）**
> 进入正式备份执行轮须同时满足：① G-2 关闭（NAS 重连可达）或明确以 `SAFETY_COPY_ONLY` 模式执行；② G-1 closure（授权账号捕获 routines 或显式排除）；③ 维护窗 + 写入冻结排定（G-4）；④ 用户书面授权进入 WP4-B 执行轮。无冻结的备份仅可作非权威安全副本。

---

## 9. 纪律声明（P9 WP4-B Readiness Gate）

| 项 | 状态 |
|---|---|
| 执行 mysqldump / 实际备份生产库 | ❌ **无**（仅模板定义） |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 修改 MySQL 用户或权限 / 临时提权 jhzy_mig_ro | ❌ **无**（G-1 明确不临时提权） |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git 提交 | ❌ 无（待用户授权后提交） |

**STOP — 未执行备份，未进入 WP4-C。** 等待下一步显式授权（WP4-B 执行轮 / Git Closeout / 其它）。

---

## 引用

- G-10 关闭：`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`。
- 备份计划：`P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` §3–§4。
- Preflight：`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 漂移 / D1 86 表）。
- WP4 定义：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
