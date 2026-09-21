# P9 WP4-D — Authoritative Snapshot Execution Authorization Gate（执行授权门）

> **阶段**：P9 WP4-D（AUTHORITATIVE_SNAPSHOT 执行授权门）
> **创建**：2026-09-21 12:41 CST
> **性质**：**Execution Authorization Gate only（仅确认是否允许进入 WP4-D authoritative snapshot 执行轮，不实际执行快照）**。
> **本轮禁止**：执行 mysqldump / 执行 authoritative snapshot / 生成 `.sql.gz` / 执行 schema·data·routines dump / 写 D1 / import schema / 迁移数据 / Cutover / 删除源库数据 / 清空源库表 / 移动 1.0 文件 / 覆盖 1.0 生产代码 / 停止 1.0 / 锁表 / 修改 Worker / 修改 DNS·route / 修改 MySQL 用户或权限 / git commit（除非用户另行授权）。
> **本轮允许**：读取前序 evidence / definition；确认 WP4-D 执行前置；确认 snapshot 目录；确认 G-2 residual；确认 COUNT(*) caveat 修复要求；创建 Authorization Gate 文档。
> **承接**：`P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_20260921_114716.md`（Execution = PASS / Ready for WP4-D = YES）、`P9_WP4D_FREEZE_COVERAGE_CLOSURE_EXECUTION.md`、`P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md`、`P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md`、`P9_WP4C_EXECUTION.md`。
> **纪律**：本门仅给出授权裁定与执行轮约束；任何 mysqldump / 实际快照动作须由用户显式授权的独立执行轮进行。

---

## 1. REPO IDENTITY

| 项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| branch | master | `master` | ✅ |
| HEAD | `544fa21` | `544fa2178b5eb9a7f22990e18c925e5847ec420f` | ✅ |
| HEAD == origin/master | YES | `git ls-remote origin master` = `544fa21…` | ✅ |
| staged | 0 | `git diff --cached --name-only` = 空 | ✅ |
| 并行改动 | 允许存在、不得处理 | 工作区存在大量并行改动（miniprogram/workers 等），全程未 touched / 未 add / 未 commit | ✅ |
| remote | — | `origin` = `https://github.com/zzz7491/jhzy2018.git` | ✅ |

**REPO_IDENTITY_GATE = PASS。**

---

## 2. BASELINE（已读取并确认）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_20260921_114716.md` | Freeze Coverage Closure Execution = **PASS**；Ready for WP4-D Execution = **YES**；C-1~C-10 = **PASS**；Freeze removed / service resumed = **PASS**；Root crontab restored = **PASS**；Authoritative snapshot = **NO**；Production dump = **NO**；Migration = **NO**；Cutover = **NO**；Entered WP4-D = **NO**；C-8 caveat：per-table COUNT(*) hash SKIPPED（No database selected）；G-2 residual：Cutover 前须补 off-host copy，否则 ABORT Cutover |
| `P9_WP4D_FREEZE_COVERAGE_CLOSURE_EXECUTION.md` | execution summary；immediate maintenance authorization；C-1~C-10 status；vhost freeze/restore；crontab freeze/restore；C-7 Option C residual；C-8 no-write PASS；C-9 dir = `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656`；Ready for WP4-D = YES；snapshot/migration/Cutover = NO |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md` | §4 ENTRY CRITERIA 11 项；§5 run structure（12 产物）；§6 command design（schema/data/routines 三层分离，root 单独捕 routines）；§7 validation；§8 migration input 裁定；§9 abort/resume；§10 evidence 17 字段 |
| `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md` | Boundary decision = `MUST_FREEZE`；Required closure before WP4-D = C-1..C-10；**该 closure 已在 Freeze Coverage Closure 轮执行并 PASS**；Ready for WP4-D = CONDITIONAL_NO → 现已解除（closure 完成） |
| `P9_WP4C_EXECUTION.md` | WP4-C Execution = **PASS**；fresh T0 → freeze → 120s → T2 → no-write PASS → resume；Ready for WP4-D Execution = **YES**；Entered WP4-D = NO |

**基线确认结论：**

- Freeze Coverage Closure Execution = **PASS**
- Ready for WP4-D Execution = **YES**
- C-1 ～ C-10 = **PASS**
- service resumed = **PASS**
- root crontab restored = **PASS**
- authoritative snapshot = **NOT executed**
- dump = **NOT executed**
- migration = **NOT executed**
- Cutover = **NOT executed**
- G-2 = **WAIVED**（residual：Cutover 前须补 off-host copy，否则 ABORT Cutover）
- C-8 caveat：per-table COUNT(*) hash **SKIPPED** due to `No database selected`

> 说明：WP4-D ENTRY CRITERIA（定义 §4）原 #2/#3 为未满足；经 Freeze Coverage Closure 轮（C-1~C-10 全 PASS）后，#1 维护窗（immediate，已授权）、#2 冻结、#3 no-write、#4 角色具名、#5 G-1 策略、#6 G-2 waiver、#8 目录就绪、#9 磁盘、#10 工具、#11 abort 权限 **均已满足**。进入 WP4-D 执行轮的前置条件齐备。

---

## 3. COPY-NOT-CUT MIGRATION PRINCIPLE（迁移硬约束）

```text
迁移 = 复制式迁移，不是剪切。
源端 1.0 原库、原文件、原服务必须保留不动。
WP4-D 只允许从源库复制生成权威快照。
禁止删除、清空、移动、覆盖、破坏 1.0 源数据。
```

- WP4-D 是**复制式**生成权威快照，所有导出为 `SELECT` / `mysqldump --single-transaction` 只读抽取。
- 源库 `api_jhzyfw_com` / `signup_db` 原库、原文件、原服务**全程保留不动**。
- 任何会修改、删除、清空、移动、覆盖源端数据的操作 → **ABORT**。

---

## 4. WP4-D EXECUTION SCOPE（下一执行轮只允许）

### 允许（复制式生成 authoritative snapshot）

- 使用已有 C-9 目录或新建唯一 run 目录（见 §5）；
- 从源库导出：
  - `api_jhzyfw_com` schema（`--no-data`）
  - `api_jhzyfw_com` data（`--no-create-info`）
  - `api_jhzyfw_com` routines（**root 单独捕获**，G-1=A，绝不经 `jhzy_mig_ro`）
  - `signup_db` schema
  - `signup_db` data
- gzip 压缩（5×`.sql.gz`）；
- sha256 manifest（`sha256_manifest.txt`）；
- gzip 完整性校验（`gzip -t`，`gzip_check.log`）；
- row count evidence（`row_counts_before.json`，逐表 `COUNT(*)`）；
- table inventory evidence（`table_inventory.json`）；
- snapshot manifest（`snapshot_manifest.json`）；
- `evidence.json`；
- final gate（执行轮产出 evidence 文档）。

### 明确禁止

- D1 import
- schema import
- data migration
- Worker / DNS / route changes
- Cutover
- delete / truncate / drop source
- any destructive source operation

---

## 5. SOURCE DATABASE PROTECTION（源库保护确认）

```text
source_delete_allowed = NO
source_truncate_allowed = NO
source_drop_allowed = NO
source_move_allowed = NO
source_overwrite_allowed = NO
source_data_modification_allowed = NO
source_schema_modification_allowed = NO
```

- WP4-D **只能读取源库**（SELECT / mysqldump 一致性快照）。
- 除 snapshot 目录写文件外，不得修改生产源库。
- 若任何命令含 `DROP` / `TRUNCATE` / `DELETE` source / destructive source action → **ABORT**。

---

## 6. SNAPSHOT RUN DECISION

优先沿用 C-9 已准备目录：

```text
run_id = wp4d_authoritative_20260921_120656
directory = /www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/
```

依据（来自 `P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_20260921_114716.md` §10 / EXECUTION 文档）：

- C-9 已创建该目录，mode `0700`，内容为空（mkdir only，**无** mysqldump / `.sql` / snapshot）；
- 执行轮启动时须再次确认：
  - 目录存在；
  - 权限 `0700`；
  - 当前为空或仅含允许的 evidence placeholder；
  - 不覆盖已有 `.sql.gz`；
  - 如目录已有 dump 文件 → **ABORT** 或新建唯一 run_id（不复用污染目录）。

---

## 7. C-8 COUNT(*) CAVEAT FIX REQUIREMENT

- 上轮 C-8 caveat **不阻止**进入 WP4-D；
- 但 WP4-D 执行轮**必须修复** per-table `COUNT(*)` 采集；
- 不得再用导致 `No database selected` 的 union 查询；
- 推荐逐表带库名执行：
  - `SELECT COUNT(*) FROM \`db\`.\`table\`;`
- 输出 `row_counts_before.json`；
- 若 row count 采集失败：
  - authoritative snapshot validation = **FAIL**
  - `migration_input = NO`

---

## 8. G-2 RESIDUAL ACKNOWLEDGEMENT

```text
G-2 status = WAIVED
authoritative snapshot may be created locally
off-host copy before Cutover = REQUIRED
if off-host copy cannot be completed before Cutover = ABORT Cutover
```

- G-2 **不阻止** WP4-D snapshot；
- G-2 **会阻止** Cutover；
- snapshot evidence 必须记录该 residual risk（off-host copy 须在 Cutover 前补齐，否则 ABORT Cutover）。

---

## 9. ABORT RULES（下一执行轮触发任一即 ABORT）

- source DB unreachable
- snapshot directory polluted or not writable
- disk insufficient
- mysqldump fails
- gzip check fails
- sha256 missing
- routines capture fails（`assign_certificate_id` 未捕获）
- table inventory mismatch
- row count collection fails
- any source write or destructive operation attempted
- evidence incomplete

**ABORT 后：**

- 不使用该 snapshot；
- `migration_input = NO`；
- 不进入 WP4-E；
- 不导入 D1；
- 保留或隔离失败产物（quarantine `wp4d_authoritative_<run_id>/`，不删除以留审计）；
- 记录原因。

---

## 10. AUTHORIZATION MATRIX

| 项 | 裁定 |
|---|---|
| WP4-D authoritative snapshot execution | **AUTHORIZED** |
| Source read-only dump | **AUTHORIZED** |
| api_jhzyfw_com schema dump | **AUTHORIZED** |
| api_jhzyfw_com data dump | **AUTHORIZED** |
| api_jhzyfw_com routines dump | **AUTHORIZED**（root 单独捕获，G-1=A） |
| signup_db schema dump | **AUTHORIZED** |
| signup_db data dump | **AUTHORIZED** |
| sha256 / gzip verification | **AUTHORIZED** |
| row count evidence | **AUTHORIZED**（须修复 C-8 COUNT(*) caveat） |
| D1 import | **NOT_AUTHORIZED** |
| Migration | **NOT_AUTHORIZED** |
| Cutover | **NOT_AUTHORIZED** |
| Source delete / drop / truncate / move / overwrite | **NOT_AUTHORIZED** |

> 裁定依据：Freeze Coverage Closure 轮已满足全部 ENTRY CRITERIA（#1 维护窗 immediate 已授权、#2 冻结 C-1~C-5 PASS、#3 no-write C-8 PASS、#4 角色具名、#5 G-1=A、#6 G-2 WAIVED residual 已记录、#8 C-9 目录就绪、#9 磁盘 21G 可用、#10 工具就绪、#11 abort 权限确认）。本门**授权**进入 WP4-D 执行轮执行复制式只读快照；**不授权** D1 import / Migration / Cutover / 任何源端破坏操作。实际 mysqldump 仍须在独立授权的执行轮进行。

---

## 11. FINAL GATE

```text
Repo identity confirmed = YES
Baseline read = YES
Copy-not-cut principle recorded = YES
WP4-D execution scope authorized = YES
Source database protection confirmed = YES
Snapshot run decision = READY
C-8 COUNT(*) caveat fix required = YES
G-2 residual acknowledged = YES
Abort rules acknowledged = YES

WP4-D authoritative snapshot execution authorized = YES
D1 import authorized = NO
Migration authorized = NO
Cutover authorized = NO
Source delete/drop/truncate/move authorized = NO

Authoritative snapshot executed = NO
Production dump executed = NO
Production backup executed = NO
Production data modified = NO
Production schema modified = NO
D1 modified = NO
Worker modified = NO
DNS / route changed = NO
Migration executed = NO
Cutover executed = NO
Entered WP4-D Execution = NO

Document created = YES
Ready for WP4-D Execution = YES
```

---

## 12. 纪律声明（本轮）

| 项 | 状态 |
|---|---|
| 执行维护窗 / 实际冻结写入 | ❌ 无（冻结已在 Freeze Coverage Closure 轮完成并恢复） |
| 执行 no-write verification | ❌ 无（已在前轮 PASS） |
| 执行 mysqldump / 权威快照 / 生产备份 | ❌ 无（仅设计授权，不执行） |
| 停止 1.0 / 锁表 / 修改 1.0 代码 | ❌ 无 |
| 修改腾讯云 nginx vhost | ❌ 无 |
| 修改 DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / redeploy | ❌ 无 |
| 修改 MySQL 用户或权限 | ❌ 无 |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git commit / push | ❌ 无（本文件待用户另行授权的 Git Closeout 轮单独提交，仅含本 1 个文件） |

**STOP — 未执行快照，未进入 WP4-D Execution，未执行迁移，未 Cutover。**
WP4-D 执行轮（实际 mysqldump 复制式快照）须 U-08 另行显式授权的独立执行轮进行。
