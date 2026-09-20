# P9 WP4 — Production Migration Execution Definition Gate（生产迁移执行·定义门）

> **阶段**：P9 WP4（生产迁移与切换·执行定义）
> **定义日期**：2026-09-20
> **性质**：**Definition Gate Only（只定义未来执行流程，不执行、不实现、不部署、不迁移）**。在 P9 WP1/WP1A/WP2/WP3 全部 PASS 后，定义 WP4-A…WP4-I 九个执行子阶段的流程、G-10 只读账号关闭方案、生产快照/备份/迁移/回滚/证据流程；**不执行 mysqldump、不实际备份、不创建/修改 MySQL 用户、不锁表、不停止 1.0、不写 D1、不 import schema、不迁移数据、不灰度、不 Cutover、不修改 Worker、不 git commit（除非另行授权）**。
> **层级**：L3（实现层），承接 `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` §4 WP4 定义。
> **纪律**：本轮仅产出定义与证据模板；所有创建/备份/冻结/快照/迁移/回滚动作须用户显式授权后，在 WP4-A…WP4-I 执行阶段（非本定义阶段）进行。

---

## 0. 入口状态（来自 P9 链）

| 项 | 值 |
|---|---|
| P9 WP1 / WP1A / WP2 / WP3 | 全部 FINAL PASS |
| 最新远端 commit | `12c89b4`（HEAD == origin/master） |
| B-01 | CLOSED |
| G-08 | CLOSED（WP3+G08 已修正 WP2 §4.2 D1 假设） |
| G-10 | **CLOSED**（WP4-A 已执行：账号 `jhzy_mig_ro@127.0.0.1` 仅 `SELECT` 两源库；证据见 `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`） |
| Ready for P9 WP4 | CONDITIONAL YES（WP3 前置：① G-08 已提交 ✅ ② G-10 关闭方案已定义、作为 WP4-A 首个执行项 ③ 无独立授权不启动生产迁移） |

**结论**：P9 前置链完整，进入 WP4 执行定义阶段；本门仅定义，不执行。

---

## 1. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `12c89b434df38a7fb4d9d218a3900b3482786f43`（`12c89b4`，P9 WP3+G08 Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `12c89b4…`） |
| staged | 0 |
| P9 scope clean | ✅（仅 `p9-wp1a-worker/.wrangler/` 本地状态未跟踪、未提交、不属范围） |
| 其它并行改动 | 290 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），**不在 P9 范围，未处理** |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 角色 / 用途 |
|---|---|
| `P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` | P9 定义门（拓扑 T-1…T-6 / 安全门 MG-01…15、CG-01…12 / 切换契约 §7 / 回滚矩阵 §9 / 证据 §10） |
| `P9_WP1_PRODUCTION_READINESS_AUDIT.md` | 生产就绪审计（源库 128 表 / binlog OFF / 活跃漂移 / 备份机制 / G-10 只读账号缺口 / 维护窗需求） |
| `P9_WP1A_CLOUDFLARE_WORKER_RESOURCE_PREPARATION_GATE.md` | Worker 资源准备（name `jhzy-v2-api` / version `b10791f8…` / binding `DB`→`jhzy-v2-db` / 无 route；B-01 CLOSED） |
| `P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` | 源快照 / 备份 / 恢复 / 漂移控制 / 证据结构（§4.2 已修正 G-08：D1 86 表 frozen schema+seed） |
| `P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md` | 生产迁移 Preflight（2026-09-20 实测：MySQL 5.7.44 / binlog OFF / 128+3 表 / 活跃漂移 / D1 86 表+seed / Worker `b10791f8` / G-10 缺口） |
| `P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` | 回滚方案（B0–B20 批次 / CLASS_1/2/3 / `verifyRecovery()` 7 项 / STOP `SC-01…SC-15` / operator-evidence/v1） |
| `P8-3_WP6_TEST_MIGRATION_REHEARSAL_REPORT.md` | 演练方法（隔离测试目标 / 81 tests / run_id 隔离 / SC-15 / 二次迁移确定性） |

> 所有架构/业务/数据判定均引用上述基线，不新增原则、不重述定义。

---

## 3. WP4 Scope（执行子阶段拆分 · 仅定义）

WP4 拆为 9 个执行子阶段。**本轮只定义，不执行**。

| 子阶段 | 名称 | 定义态交付物（本轮） | 实际执行（留授权后） |
|---|---|---|---|
| **WP4-A** | G-10 readonly account closure | 只读账号关闭方案（§4） | 创建/授权 `jhzy_mig_ro@127.0.0.1`，仅 SELECT 于两源库 |
| **WP4-B** | source backup execution readiness | 备份执行计划（§5） | 取权威源库 schema+data 备份 + hash + NAS copy + 恢复演练 |
| **WP4-C** | maintenance window / write freeze readiness | 维护窗 / 冻结计划（§6） | 批准窗口、通知、1.0 置维护态、no-write 校验 |
| **WP4-D** | snapshot execution plan | 快照执行计划（§7） | 冻结态下取一致性快照 + 表清单/行数/结构/data hash + 漂移复检 |
| **WP4-E** | migration execution plan | 迁移执行计划（§8） | P8-3 工具链跑 B1–B20（跳 B0 seed，因 D1 已 seed），仅迁业务数据 |
| **WP4-F** | reconciliation gate | 对账 Gate（§9） | 10 维对账 + SC-01…SC-15 全清 → PASS（否则 NO CUTOVER） |
| **WP4-G** | rollback / abort procedure | 回滚/中止流程（§10） | 命中 abort 即回滚，不在生产现场调试 |
| **WP4-H** | execution evidence package | 证据包结构（§11） | 每步留 operator-evidence/v1 + 扩展生产字段 |
| **WP4-I** | WP4 closeout | 收口检查单（§12 关联） | WP4 全阶段 PASS 后收口；Cutover 仍属 P9 WP6，非 WP4 |

> 阶段门顺序：WP4-A → B → C → D → E → F →（G 为并发可触发）→ H（贯穿）→ I。任一阶段 Gate FAIL → STOP（不进下一阶段）。**Cutover 不在 WP4 内**，须经 P9 WP6 独立授权。

---

## 4. G-10 Readonly Account Closure Plan（只读账号关闭方案）

### 4.1 当前问题（WP3 §2 实测）

- `jhzy20_readonly@127.0.0.1` 用户已存在，但其 grants 仅为 `SELECT ON jhzy20_dev.*`；
- **不含权威源库** `api_jhzyfw_com` 与 `signup_db`；
- 不满足 MG-03「只读源库账号」最小权限要求。

### 4.2 决策：新建专用账号（推荐）

| 项 | 决策 |
|---|---|
| 方案 | **新建专用账号**（而非扩展 dev 只读账号，避免 prod 源混入 dev 语义账号） |
| 推荐账号名 | `jhzy_mig_ro`@`127.0.0.1`（`mig`=migration、`ro`=read-only） |
| 最小权限 | 仅 `SELECT`（无 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/INDEX/LOCK TABLES/GRANT OPTION） |
| host 限制 | `127.0.0.1` 仅（迁移工具链在 production 主机本地运行；不接受 `%` 远程） |
| 目标库 | 仅 `api_jhzyfw_com.*` 与 `signup_db.*`（不含任何其它库、`mysql.*`、全局权限） |
| 密码管理 | **执行时由操作人生成强随机密码，经 secret store / 环境变量注入；绝不写入 Git、绝不出现在聊天/文档明文**（本文仅占位 `<RUNTIME_SECRET>`） |
| 备选方案 | 若坚持复用现有账号：`GRANT SELECT ON api_jhzyfw_com.* , signup_db.* TO 'jhzy20_readonly'@'127.0.0.1'`；回滚为对应 `REVOKE` |

### 4.3 Grant SQL 草案（WP4-A 执行，本轮不执行）

```sql
-- 1) 创建专用只读账号（密码执行时注入，不落盘明文）
CREATE USER 'jhzy_mig_ro'@'127.0.0.1' IDENTIFIED BY '<RUNTIME_SECRET>';

-- 2) 仅授予两源库 SELECT（最小权限）
GRANT SELECT ON `api_jhzyfw_com`.* TO 'jhzy_mig_ro'@'127.0.0.1';
GRANT SELECT ON `signup_db`.*     TO 'jhzy_mig_ro'@'127.0.0.1';

-- 3) 刷新权限
FLUSH PRIVILEGES;
```

### 4.4 Verification SQL（WP4-A 执行）

```sql
-- 权限确认：预期仅 USAGE 于 *.* + SELECT 于两源库，无全局/写权限
SHOW GRANTS FOR 'jhzy_mig_ro'@'127.0.0.1';

-- 正向测试（必须成功）：
mysql -u jhzy_mig_ro -p -h 127.0.0.1 -e "SELECT 1 AS ok; SELECT COUNT(*) FROM api_jhzyfw_com.information_schema.tables;"

-- 负向测试（必须失败，ERROR 1142）：
mysql -u jhzy_mig_ro -p -h 127.0.0.1 -e "INSERT INTO api_jhzyfw_com._mig_probe(t) VALUES(1);"   -- 预期 ERROR 1142 (INSERT command denied)
```

### 4.5 Rollback SQL（若 WP4-A 需撤销）

```sql
DROP USER 'jhzy_mig_ro'@'127.0.0.1';
-- 若采用备选（扩展现有账号），回滚为：
-- REVOKE SELECT ON `api_jhzyfw_com`.* FROM 'jhzy20_readonly'@'127.0.0.1';
-- REVOKE SELECT ON `signup_db`.*     FROM 'jhzy20_readonly'@'127.0.0.1';
```

### 4.6 Evidence Required（WP4-A 收口证据）

- `SHOW GRANTS` 输出（证明仅 SELECT 于两源库）；
- 正向 `SELECT 1` 成功截图/输出；
- 负向 `INSERT` 失败输出（ERROR 1142）；
- 账号创建时间 + 操作人 + run_id；
- 密码未落盘证明（secret store 引用，无明文）。

> **G-10 已由 WP4-A 执行关闭**：账号 `jhzy_mig_ro@127.0.0.1` 已创建，仅 `SELECT` 于 `api_jhzyfw_com` + `signup_db`（无 `*.*` / 写 / GRANT OPTION）；正向 SELECT PASS、负向写操作全拒（1142/1045）。证据见 `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`。

---

## 5. Source Backup Execution Plan（源备份执行计划）

> 定义未来 WP4-B 执行时的备份模板；本轮不执行 dump。

### 5.1 备份命令模板

```bash
# 执行宿主：production 主机（root SSH），时间窗内经 jhzy_mig_ro 或 root 只读
TS=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR=/www/backup/database/database/mysql/crontab_backup/api_jhzyfw_com
SNAP_ID="wp4-snapshot-${TS}"

# schema-only dump（两源库）
mysqldump --single-transaction --no-data --routines --triggers --events \
  -u jhzy_mig_ro -p -h 127.0.0.1 \
  --databases api_jhzyfw_com signup_db \
  > ${BACKUP_DIR}/${SNAP_ID}.schema.sql

# data dump（两源库，含 routines/triggers/events；排除备份表由 WP4-E 裁定 ARCHIVE/DROP）
mysqldump --single-transaction --routines --triggers --events \
  --skip-lock-tables --hex-blob --default-character-set=utf8mb4 \
  -u jhzy_mig_ro -p -h 127.0.0.1 \
  --databases api_jhzyfw_com signup_db \
  > ${BACKUP_DIR}/${SNAP_ID}.data.sql

# 压缩 + hash
gzip ${BACKUP_DIR}/${SNAP_ID}.schema.sql
gzip ${BACKUP_DIR}/${SNAP_ID}.data.sql
sha256sum ${BACKUP_DIR}/${SNAP_ID}.*.sql.gz > ${BACKUP_DIR}/${SNAP_ID}.sha256
```

### 5.2 关键参数（来自 WP3 实测）

| 项 | 值 / 说明 |
|---|---|
| MySQL version | `5.7.44`（`mysqldump` 同版本，位于 `/usr/bin/mysqldump`） |
| consistency | `--single-transaction`（InnoDB；**binlog=OFF 故不可增量，必须冻结写入后取静止快照**） |
| charset | `--default-character-set=utf8mb4`（源 server `utf8mb4_general_ci`；含混合 collation：`system_config`=`utf8_general_ci` + 15 表 `utf8mb4_unicode_ci` → dump 原样保留，目标按 D1 设计收敛，源侧不强制改，G-06） |
| timezone | `CST`（dump 不强制 TZ；迁移映射层处理） |
| routines/triggers/events | `--routines --triggers --events`（若源存在；迁移以 D1 设计为权威，源 routines 仅存档） |
| compression | `gzip` |
| hash | `sha256sum` |
| output path | `/www/backup/database/database/mysql/crontab_backup/api_jhzyfw_com/`（已存在） |
| off-host copy | NAS cron 已配（`/opt/backup_db_to_nas.sh` 等）；执行后校验远端 rsync 成功 |
| retention | 沿用 NAS 每日 + 每周代码保留策略；WP4-B 须书面确认保留窗口 ≥ 切换后 30 天 |
| restore dry-run | **必须**在隔离测试 MySQL 实例载入 `*.data.sql` 并执行行数校验（G-03），留 evidence |

### 5.3 备份证据

- 文件名 + 大小 + `*.sha256`；
- NAS off-host copy 成功确认；
- 隔离测试库 restore dry-run 行数比对（源 vs 测试库）PASS；
- 备份执行时间 + 操作人 + run_id。

> 本轮**不执行 dump、不恢复生产备份、不覆盖任何文件**。

---

## 6. Maintenance Window / Write Freeze Plan（维护窗 / 写入冻结计划）

> 定义未来 WP4-C 执行；依 P9 Definition §7.3（binlog OFF → 必须冻结写入后取一致性快照）。

| 项 | 定义 |
|---|---|
| 维护窗开始条件 | WP4-B 备份完成且 hash 校验 PASS + MG-01…MG-15 全满足 + 用户书面授权进入 WP4-C |
| 谁批准 | Cutover Approver（具名，U-10） |
| 如何通知 | 维护公告经沟通通道（U-09）提前 ≥ 24h 发布；用户侧提示「系统维护中」 |
| 1.0 写入冻结方式 | 腾讯云入口（`api.jhzyfw.com` vhost）返回维护页；应用层停止接受新写（P9 Definition §7.3 / P8-3 WP5 §2.C.2） |
| 冻结前检查 | 确认当前活跃写入域（注册/考试/培训/志愿者/考勤/活动/积分，WP3 §3）；采集重点表 `UPDATE_TIME` + `COUNT(*)` 基线 |
| 冻结后 no-write verification | 冻结起点后复采重点表 `UPDATE_TIME`/`COUNT(*)`；预期与基线一致（无新写）SQL： |
| | `SELECT table_name, update_time FROM information_schema.tables WHERE table_schema='api_jhzyfw_com' AND update_time > '<freeze_start>';` → 预期空集 |
| | `SELECT 'id_pool', COUNT(*) FROM api_jhzyfw_com.id_pool;`（与基线比对 delta=0） |
| 若仍有写入 → abort | 检测任一表 `UPDATE_TIME` 变化或 `COUNT(*)` 增加 → **立即 ABORT：NO MIGRATION / NO CUTOVER**（P9 Definition §7.7） |
| 最大允许冻结时间 | ≤ 迁移+对账总耗时 + 缓冲（依数据量定，MG-12 规划；建议 ≤ 2h，超期自动延长须重新授权） |
| 恢复写入条件 | WP4-F 对账 PASS 且未进入 Cutover → 源静止态保持至 Cutover；若回滚 → 入口回指 1.0 恢复写（P9 §7.8） |

> **双写默认禁止**（P9 §7.7）。若运营要求源静止后仍处理写入 → 视为 dual-write 诉求 → **STOP → Architecture Change**，不得默认。

---

## 7. Snapshot Execution Plan（快照执行计划）

> 定义未来 WP4-D 执行；冻结态下取一致性快照。

| 项 | 定义 |
|---|---|
| snapshot_run_id | `wp4-snapshot-${TS}`（贯穿 issues/reconcile/rollback/evidence，run_id 隔离） |
| source DBs | `api_jhzyfw_com`（128 表）+ `signup_db`（3 表，0 行，静态） |
| table inventory capture | `information_schema.tables` 导出两库全表清单 + 行数（`COUNT(*)` 逐表或 `TABLE_ROWS` 近似 + 重点表精确） |
| row count capture | 重点表精确 `COUNT(*)`（id_pool=452,240 / training_user_progress / volunteers / activities / jhzy_activity_signups / exam_* / certificates / points_* 等） |
| schema dump | §5.1 schema-only dump（gzip + sha256） |
| data dump | §5.1 data dump（gzip + sha256） |
| hash | `sha256sum` 全产物；snapshot hash 钉死（MG-05） |
| evidence directory | 执行宿主 `/www/backup/.../wp4-snapshot-*/` + 本地 `docs/production-audit/evidence/wp4/<run_id>/`（operator-evidence/v1） |
| static snapshot decision | 维护窗冻结成功后取 `--single-transaction` 静止快照；**禁止依赖 binlog 增量**（log_bin=0） |
| drift recheck after snapshot | 快照完成后复采重点表 `UPDATE_TIME`/`COUNT(*)`；若变化 → ABORT（SC-11 source snapshot mismatch） |
| abort criteria | 冻结失败 / 快照中检测到新写 / hash 校验失败 / 磁盘不足（剩余 21G，充足） |

> 本轮**不执行 snapshot**。

---

## 8. Migration Execution Plan（迁移执行计划）

> 定义未来 WP4-E 执行；复用 P8-3 工具链（`p8-3-migration/`，81 tests，run_id 隔离 + SC-15 已闭环）。

### 8.1 执行约束（硬）

| 约束 | 说明 |
|---|---|
| 工具链 | `p8-3-migration`（runner/reconcile/rollback/runbook/recovery），git SHA 钉死 `811155c`（MG-08/09/10） |
| run_id | 每次 `runMigration` 生成稳定唯一 `run_id`，贯穿 legacy_id_maps / migration_issues / reconcile / rollback / evidence（P8-3 WP6 §11 已闭环） |
| source snapshot input | WP4-D 静止快照（hash 钉死）作为迁移输入；源静止态 |
| target D1 | `jhzy-v2-db`（uuid `ea603f43-…`）；**86 表 frozen V2 schema + RBAC seed（permissions=104/roles=6/role_permissions=295），业务表空**（WP3 §5，G-08 修正后） |
| **WP4 不得重建 schema** | D1 schema 已冻结于 `d1_migrations`（applied 2026-09-18）；**不执行 `wrangler d1 migrations apply` / 任何 DDL** |
| **WP4 不得覆盖 seed** | `permissions`/`roles`/`role_permissions` 已由 seed 载入；**B0（RBAC seed）在 WP4 生产执行中 SKIP**（源 D1 已 seed，避免重复插入） |
| **migrate business data only** | 仅插入业务域数据（B1–B20）； |
| preserve `d1_migrations` | 不触碰 `d1_migrations` 表 |
| preserve RBAC seed | 不触碰 permissions/roles/role_permissions（B0 skip） |
| `user_favorites` remains EXCLUDED / BCR pending | 永不进入任何批次（`EXCLUSIONS = ['api.user_favorites']` 恒成立） |
| fresh checkpoint | 生产 D1 为新目标，checkpoint `doneTables` 必须起始为空（不得因历史 checkpoint 跳过批次） |
| D1Target adapter | 迁移写入走 Cloudflare D1 生产写 token（MG-03）；**P8-3 演练用 MemoryTarget，生产 D1Target 写路径须 WP4-B/执行轮验证（W4-01）** |

### 8.2 批次顺序（B0–B20，严格沿用 P8-3 WP5 §B，不重设计）

| Batch | 内容 | WP4 生产处理 |
|---|---|---|
| B0 | RBAC 种子 | **SKIP**（D1 已 seed；仅 user_favorites 维持 EXCLUDED） |
| B1 | 身份与用户档案 | 执行 |
| B2 | 会话 | 执行 |
| B3 | 团队与成员 | 执行 |
| B4 | 用户角色 + 临时表归档 | 执行 |
| B5 | 活动中心 | 执行 |
| B6 | 活动报名 | 执行 |
| B7 | 签到签退 | 执行 |
| B8 | 服务记录 + quick_actions 归档 | 执行 |
| B9 | 积分流水 | 执行 |
| B10 | 成长等级 | 执行 |
| B11 | 培训中心 | 执行 |
| B12 | 考试中心 | 执行 |
| B13 | 证书中心 | 执行 |
| B14 | 商城中心 | 执行 |
| B15 | 通知中心 | 执行 |
| B16 | 内容中心 | 执行 |
| B17 | 文件中心 | 执行 |
| B18 | 系统管理/审计/安全 | 执行 |
| B19 | 保留（无 1.0 源） | 执行（空） |
| B20 | 收尾（idmap/issues 完整性 + checkpoint 关闭） | 执行 |

每批通用（沿用 WP5 §B）：Preconditions = preflight PROCEED + 上一批 checkpoint 且 reconcile PASS + 无未决 CRITICAL；Procedure = `runMigration({source, target, opts:{batch, checkpoint, runId, logger}})`；Checkpoint = `doneTables += 本批 srcKey`；单行失败记 `migration_issues` 不中断整批；Reconciliation = `reconcile` 9 维。

### 8.3 STOP Conditions（SC-01…SC-15，机器判定）

沿用 P8-3 WP5 §D（含 WP6 新增 SC-15「open migration error / incomplete batch」CRITICAL）。**任一 CRITICAL 命中 → 立即 STOP，不得继续下一 Batch**：

SC-01 row conservation FAIL / SC-02 identity duplicate / SC-03 orphan relation / SC-04 missing legacy mapping / SC-05 points/growth mismatch / SC-06 training/certificate mismatch / SC-07 media reference critical（WARNING）/ SC-08 audit integrity FAIL / SC-09 unexpected schema / SC-10 script version mismatch / SC-11 source snapshot mismatch / SC-12 target contamination / SC-13 Freeze conflict / SC-14 unauthorized production access / SC-15 open migration error / incomplete batch。

### 8.4 Failure Handling

- 批内失败 → runner 记 `conflict`(severity=error, status=open) issue；命中 SC-15 → 运行级 STOP（不继续下批）；
- 对账 FAIL → 触发 WP4-G 回滚（CLASS_1 单批 / CLASS_2 全量）；
- 任何 Critical → 不在生产现场调试，按 §10 回滚。

> 本轮**不执行迁移、不写 D1、不 import schema**。

---

## 9. Reconciliation Gate（对账 Gate）

> 定义未来 WP4-F 执行；复用 P8-3 WP4 对账引擎（9 维）+ P9 Definition CG-01…12（10 维口径）。

### 9.1 对账维度（PASS 判定）

| # | 维度 | 判据（对应 P9 Definition / P8-3 WP4） |
|---|---|---|
| 1 | row conservation（行守恒） | `源参与迁移行 = migrated + archived + dropped + failed`（剔除 EXCLUDED） |
| 2 | identity integrity（身份） | legacy_id_maps 唯一、public_id 唯一、openid/unionid 唯一 |
| 3 | relationship integrity（关系） | 无孤儿 FK，legacy→target 映射完整 |
| 4 | activity chain（活动链） | activity → signup → attendance → service_record 连续 |
| 5 | points/growth（积分成长） | 无 MERGE/TRANSFORM 重复累计 |
| 6 | training/result（培训结果） | courses / enrollments / learning / exam / certificates 一致 |
| 7 | media references（媒体引用） | 无缺失/重复资产引用（DB 内路径/引用核对） |
| 8 | audit integrity（审计） | operation_logs / security_events / config 完整 |
| 9 | user_favorites exclusion（排除项） | `user_favorites` EXCLUDED / `bcrPending=true` / 未迁移 / 未 DROP / 未归档 |
| 10 | schema/version/snapshot 一致性 | SC-09/SC-10/SC-11 全清（schema 签名 / 代码版本 / 源快照 hash） |

### 9.2 通过标准

- 10 维全 PASS + SC-01…SC-15 全清（无 CRITICAL）→ **Reconciliation Gate = PASS**；
- `user_favorites` 维持 EXCLUDED（CG-10）；无 CRITICAL issue（CG-11）；SC 全清（CG-12）；
- **NO CUTOVER unless PASS**（P9 Definition §6.2）：对账 PASS 仅为进入 P9 WP6 Cutover 的必要条件之一，切换决策须经授权人书面确认（CG-01…CG-12 全满足 + 用户显式授权）。

### 9.3 current-run issue filtering

`reconcile({ opts.runId })` 仅对当前 run 的 issue 计数（P8-3 WP6 §11 DEFECT-WP6-01 已闭环）；历史 run issue 全量保留作审计证据，不污染当前 run。

---

## 10. Rollback / Abort Procedure（回滚 / 中止流程）

> 定义未来 WP4-G 触发时执行；原则沿用 P9 Definition §9（RB-1…RB-9）+ P8-3 WP5 §E（CLASS_1/2/3）。

### 10.1 Abort Triggers 与 Scope

| 触发 | 类别 | Scope | Recovery Target | Max Data Loss |
|---|---|---|---|---|
| preflight FAIL（MG-01…15 任一） | RB-1 pre-migration | 不开始迁移 | 源库原状 | 0（未动） |
| WP4-B 备份失败 / hash 不符 | backup failure | 重取备份 | 源库原状 | 0 |
| WP4-C 冻结失败 / 仍有写入 | write-freeze failure | ABORT，不进快照 | 源库原状 | 0 |
| WP4-D 快照失败 / 漂移复检失败 | snapshot failure | ABORT（SC-11） | 源库原状 | 0 |
| WP4-E 批 reconcile FAIL / SC 命中 | migration failure | CLASS_1 单批 / CLASS_2 全量 | 该批/全量目标行清除，源未动 | 0（按 legacy_id_maps 定位） |
| WP4-F 对账 FAIL 且无法定位 | reconciliation failure | CLASS_2 / CLASS_3 | 切换前生产状态（D1 未权威） | 0（源静止） |
| D1 失败 / 数据损坏 | D1 failure | 回指 1.0 + D1 时间点恢复（restore point） | 1.0 服务 + D1 恢复点 | ≤ 快照点后增量（源静止≈0） |
| Worker 失败 | Worker failure | fallback route / 回指 1.0 | 1.0 服务 | 0 |

### 10.2 回滚原则（硬）

| 原则 | 说明 |
|---|---|
| source DB 保持权威至显式 Cutover | 迁移/回滚阶段源 `api_jhzyfw_com` 始终为权威；D1 在 Cutover 前不作为对外权威 |
| D1 回滚不触碰源 | CLASS_3 依赖切换前快照/时间点恢复（restore point），**不做逐行 DELETE**；`legacy_id_maps`/`migration_issues` 全量保留 |
| 不在生产现场调试 | 达 rollback trigger 即回滚，恢复后复测 |
| 回滚必须留证据 | 每类回滚追加 `issue_type=rollback` 记录 + Operator Evidence Record |
| Cutover 不在 WP4 | 回滚恢复到「切换前生产状态」（入口回指 1.0）；正式 Cutover 属 P9 WP6，须独立授权 |

### 10.3 D1 Rollback 路径（CLASS_3，设计）

- 恢复点：WP4-B 备份 + WP4-D 快照 hash + D1 `wrangler d1 export` 导出（G-04/W4-04，执行轮验证）；
- 回滚命令草案（执行轮）：`wrangler d1 execute jhzy-v2-db --remote <restore.sql>` 或经时间点恢复；**不逐行 DELETE 业务表**；
- 验证：`verifyRecovery()` 7 项（target_state_restored / source_untouched / no_orphan_migration_rows / no_stale_checkpoints / no_invalid_legacy_id_maps / no_unintended_user_favorites_migration / reconciliation_state_valid）。

---

## 11. Evidence Package（执行证据包）

> 定义未来 WP4-H 每步须生成；**禁止只用聊天记录作为生产证据**（P9 Definition §10）。

沿用 `p8-3-operator-evidence/v1` schema，扩展生产字段：

| # | 证据 | 生成阶段 |
|---|---|---|
| 1 | Operator Evidence JSON（operator/timestamp/git_sha/Worker_version/run_id/source_snapshot_id/backup_id/migration_stats/reconciliation_JSON/STOP_result/routing_state/rollback_evidence/final_verification） | 贯穿 |
| 2 | Preflight evidence | WP4 入口（PF-01…PF-15 + SC 判定） |
| 3 | Readonly account evidence | WP4-A（§4.6） |
| 4 | Backup evidence | WP4-B（§5.3） |
| 5 | Freeze evidence | WP4-C（维护窗 ID / 起止 / no-write 校验输出） |
| 6 | Snapshot evidence | WP4-D（run_id / 表清单 / 行数 / schema+data hash / 漂移复检） |
| 7 | Migration evidence | WP4-E（每批 run_id / batchId / inserted / issues / checkpoint） |
| 8 | Reconciliation evidence | WP4-F（10 维 JSON + SC 判定） |
| 9 | Rollback/abort evidence | WP4-G（若触发：类别 / scope / recovery JSON / verifyRecovery） |
| 10 | Final WP4 decision | WP4-I（Gate 结论 + 进入 WP6 建议） |

证据目录：`docs/production-audit/evidence/wp4/<run_id>/`（本地） + production 宿主 `/www/backup/.../wp4-*/`。

---

## 12. Gap Register（WP4 Definition 缺口登记）

分类：READY / PARTIAL / MISSING / UNKNOWN / BLOCKER

| ID | Area | Finding | Evidence | Severity | Blocking Stage | Required Closure | Owner Role |
|---|---|---|---|---|---|---|---|
| G-03 | Source 恢复演练 | 备份文件当日存在；恢复演练未执行 | WP3 §4 / WP2 §4.1 | PARTIAL | WP4-B | 隔离测试 MySQL 载入 + 行数校验留 evidence | Migration Operator |
| G-04 | D1 备份/恢复 | D1 现 86 表 schema+seed，export/restore 官方路径未实测 | WP3 §5 / U-11 | PARTIAL | WP4-B/E | `wrangler d1 export` 验证 + 恢复演练 | Migration Operator |
| G-05 | 版本钉死 | Worker version 已知 `b10791f8…`；source snapshot hash 待执行 | WP1A §8 / U-02 | PARTIAL | WP4-B/D | WP4 执行轮钉死 snapshot hash（MG-05） | Migration Operator |
| G-06 | 混合 collation | 源 `system_config`=`utf8_general_ci` + 15 表 `utf8mb4_unicode_ci` | WP3 §2 | LOW | WP4-E | 源侧不强制改；目标按 D1 设计收敛 | Migration Operator |
| G-07 | 备份表冗余 | `*_old_*`/`*_backup_*` 历史表（含 `id_pool_old_20260214` 155,461 行） | WP3 §2 | LOW | WP4-E | 按 P8-3 WP2 裁定 DROP/ARCHIVE（快照保留，不丢） | Migration Operator |
| G-09 | D1 num_tables 元数据滞后 | `wrangler d1 list` num_tables=0 但引擎 86 表（监控陷阱） | WP3 §5 | LOW | WP4+ | 后续 D1 状态核查以 `sqlite_master` count(*) 为准 | Migration Operator |
| **G-10** | 只读账号权限缺口 | `jhzy20_readonly` 不含权威源库；**WP4-A 已执行关闭**：`jhzy_mig_ro@127.0.0.1` 仅 `SELECT` 两源库，验证 PASS | WP3 §2 / 本门 §4 / `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` | **CLOSED** | — | 已关闭（证据见 WP4-A 文档） | Infra Operator / Migration Operator |
| W4-01 | D1Target 生产写适配器 | P8-3 演练用 MemoryTarget；生产 D1 写路径（Cloudflare 生产 token）未验证 | P8-3 WP6 §1 / 本门 §8.1 | UNKNOWN | WP4-B/E | WP4 执行轮以最小写验证 D1 写入（如先写 1 行测试表后 rollback） | Migration Operator |
| W4-02 | B0 seed skip 模式 | 生产 D1 已 seed，WP4 须 SKIP B0 避免重复插入 | 本门 §8.1/§8.2 | PARTIAL | WP4-E | 工具链确认 B0 在 production-mode 跳过 seed 插入，仅留 user_favorites EXCLUDED | Migration Operator |
| W4-03 | 生产 D1 新 checkpoint | 生产 D1 为新目标，checkpoint `doneTables` 须起始空 | 本门 §8.1 | PARTIAL | WP4-E | 执行轮确认 checkpoint 重置/隔离，不跳过批次 | Migration Operator |
| W4-04 | D1 restore point 机制 | CLASS_3 依赖 D1 时间点恢复；`wrangler d1 export` 恢复路径未实测 | G-04 / U-03 | UNKNOWN | WP4-G | WP4 执行轮验证 D1 export + 恢复演练 | Migration Operator |
| U-02 | source snapshot hash | 未取（执行轮生成） | WP1 §5 | UNKNOWN | WP4-D | WP4-D 取 snapshot+hash | Migration Operator |
| U-04 | DNS 托管方 | `jhzyfw.com` DNS 权威未知 | WP1 §7 | UNKNOWN | WP6 | WP6 确认 DNS 提供方与改记录权限 | Infra Operator |
| U-05 | Host/IP 透传 | client IP / X-Forwarded 配置未读 | WP1 §7 | UNKNOWN | WP6 | WP6 读 nginx 透传配置 | Infra Operator |
| U-06 | 超时/重试/健康/回退 | Worker 未部署生产 route，链路参数未定义 | WP1 §7 | UNKNOWN | WP6 | WP6 定义并验证 | Infra Operator |
| U-07 | 具名操作人 | 6 角色仅 ROLE 占位 | WP1 §8 | UNKNOWN | WP4-A+ | 指派具名人员 | Cutover Approver |
| U-08 | 维护窗时间 | 窗口时长/时段未定 | WP1 §8 | UNKNOWN | WP4-C | WP4-C 规划窗口（MG-12） | Cutover Approver |
| U-09 | 沟通/事件通道 | 未定义 | WP1 §8 | UNKNOWN | WP4-C | WP4-C 定义（MG-13） | Cutover Approver |
| U-10 | STOP/回滚授权人 | 仅 ROLE | WP1 §8 | UNKNOWN | WP4-A+ | 具名（MG-14/15） | Cutover Approver |
| U-11 | D1 备份能力 | D1 export/恢复官方路径未实测 | WP1 §4.2 | UNKNOWN | WP4-B | 确认 export 路径（G-04） | Migration Operator |
| U-12 | R2/KV 权威态角色 | R2/KV 是否承载权威态未知 | WP1 §2.2 | UNKNOWN | WP4+ | 确认状态归属（D1 唯一权威，R2/KV 仅辅助） | Platform Operator |
| W2-01 | 媒体依赖捕获 | 文件目录 tar+hash 方案已定义，未实测打包 | WP2 §3.12 | UNKNOWN | WP4-B | WP4-B 执行轮打包 media 并校验 | Migration Operator |
| W2-02 | 冻结写入验证 | 比对 UPDATE_TIME/行数方法已定义，未实测 | WP2 §6 | UNKNOWN | WP4-C | WP4-C 执行轮实测冻结校验 | Migration Operator |

> **BLOCKER = 0**（B-01 CLOSED、G-08 CLOSED；G-10 为 OPEN 但已有定义方案、执行留 WP4-A，不构成 Definition 阶段 BLOCKER）。user_favorites 维持 EXCLUDED / BCR pending。Freeze Conflict = 0。

---

## 13. FINAL GATE（P9 WP4 Definition）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `12c89b4` / HEAD==origin/master / staged=0） |
| Authoritative baseline read | **YES**（P9 Definition / WP1 / WP1A / WP2 / WP3 / P8-3 WP5 / P8-3 WP6 全读） |
| WP4 scope defined | **YES**（§3：A–I 九子阶段） |
| G-10 closure plan defined | **YES**（§4：新建 `jhzy_mig_ro@127.0.0.1`、最小 SELECT、host 限制、密码管理、Grant/Verify/Rollback SQL、evidence） |
| Source backup execution plan defined | **YES**（§5：schema+data dump 模板 / 参数 / hash / NAS / 恢复演练） |
| Maintenance/write-freeze plan defined | **YES**（§6：开始条件 / 批准 / 通知 / 冻结方式 / no-write 校验 / abort / 最大冻结时间） |
| Snapshot execution plan defined | **YES**（§7：run_id / 双库 / 表清单 / 行数 / schema+data / hash / 漂移复检 / abort） |
| Migration execution plan defined | **YES**（§8：P8-3 工具链 / run_id / 86 表 frozen schema+seed / 跳 B0 / 仅迁业务 / SC-01…15 / failure） |
| Reconciliation gate defined | **YES**（§9：10 维 + SC 全清 + current-run filtering + NO CUTOVER unless PASS） |
| Rollback/abort procedure defined | **YES**（§10：RB-1…9 / CLASS_1-3 / 源保持权威 / D1 不触碰源 / 留证据 / Cutover 不在 WP4） |
| Evidence package defined | **YES**（§11：10 类证据 / operator-evidence/v1 扩展 / 禁只靠聊天） |
| Gap Register complete | **YES**（§12：0 BLOCKER + G-10 OPEN(plan) + 多 PARTIAL/UNKNOWN） |
| G-10 still open | **NO**（WP4-A 已执行关闭：账号 `jhzy_mig_ro@127.0.0.1` 仅 `SELECT` 两源库，验证 PASS；证据见 `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`） |
| BLOCKER count | **0** |
| UNKNOWN count | **14**（W4-01 / W4-04 / U-02 / U-04 / U-05 / U-06 / U-07 / U-08 / U-09 / U-10 / U-11 / U-12 / W2-01 / W2-02） |
| Freeze Conflict Count | **0**（与 Constitution / Architecture Freeze / Data Governance Freeze 无冲突） |
| Production dump executed | **NO**（仅定义） |
| Production backup executed | **NO** |
| Production write freeze executed | **NO** |
| MySQL user modified | **NO**（未执行 GRANT/CREATE USER） |
| Production data modified | **NO** |
| D1 modified | **NO**（未写、未 import schema） |
| Worker modified | **NO**（未 redeploy、未改 route） |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4 Definition Gate = PASS**

### **P9 WP4-A = EXECUTED（G-10 CLOSED）**（账号 `jhzy_mig_ro@127.0.0.1` 已创建并验证；证据见 `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`；WP4-A 文档待授权后 Git Closeout）

---

## 14. 纪律声明（P9 WP4 Definition）

| 项 | 状态 |
|---|---|
| 修改 Freeze / Constitution / Core Domain | ❌ 无 |
| 执行 mysqldump / 实际备份生产库 | ❌ 无（仅定义模板） |
| 创建/修改 MySQL 用户（GRANT/CREATE USER） | ❌ 无（仅定义方案，留 WP4-A） |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无（D1 仅只读核查历史） |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| user_favorites BCR | ❌ 无（保持 EXCLUDED / BCR pending） |
| Git 提交 | ❌ 无（本轮仅 WP4 文档，待授权后提交） |
| 生产数据修改 | ❌ NO |
| 生产配置修改 | ❌ NO |
| Deployment performed | ❌ NO |
| Routing changed | ❌ NO |

> **本 Definition Gate 完成条件**：§3–§12 全部定义完成、FINAL GATE = PASS。完成后 STOP，未进入 P9 WP4-A，除非用户显式授权。

---

## 引用与依据

- 拓扑与硬规则（T-1…T-6 / 单一权威库 / 双写禁止）：P9 Definition §3 / §7；ARCHITECTURE_FREEZE §6；ADR-001。
- 安全门 MG-01…15 / CG-01…12：P9 Definition §6。
- 回滚矩阵 RB-1…RB-9：P9 Definition §9。
- 生产证据 13 字段（含 migration run_id）：P9 Definition §10；P8-3 WP5 `operator-evidence/v1`。
- SC-01…SC-15 机器判定 STOP：P8-3 WP5 §D（SC-15 由 P8-3 WP6 §11 闭环）。
- `verifyRecovery()` 7 项：P8-3 WP5 §F。
- B0–B20 批次 / CLASS_1-3 回滚：P8-3 WP5 §B / §E。
- 源现状（128 表 / 131MB / 活跃写入 / binlog off / mysqldump 5.7.44 / NAS cron / 只读账号缺口）：P9 WP1 §2–§3 / WP3 §2–§3（2026-09-20 实测）。
- D1 86 表 frozen schema+RBAC seed / Worker `b10791f8` / 无 route：P9 WP3 §5（G-08 修正后）；P9 WP1A §8。
- 源快照/备份计划（须修正 D1 空库假设）：P9 WP2 §3–§7（G-08 已修正）。
- user_favorites EXCLUDED / BCR pending：P8-3 §7；P9 Definition §5。
