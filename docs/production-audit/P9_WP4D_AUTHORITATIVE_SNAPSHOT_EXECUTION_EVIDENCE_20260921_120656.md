# P9 WP4-D — Authoritative Snapshot Execution Evidence

> **阶段**：P9 WP4-D（AUTHORITATIVE_SNAPSHOT 执行轮）
> **执行日期**：2026-09-21（CST）
> **run_id**：`wp4d_authoritative_20260921_120656`
> **性质**：只读复制式快照（copy-not-cut）。从源库 `api_jhzyfw_com` + `signup_db` 只读导出 **5 个 `.sql.gz`** + 行数 / 表清单 / sha256 / gzip / manifest / evidence。
> **纪律**：源端 1.0 原库、原文件、原服务 **保留不动**；未写 D1、未 import schema、未迁移、未 Cutover、未删/清/移/覆盖源数据、未改 Worker/DNS/MySQL 权限、未 git commit（按本任务禁令）。
> **执行方式偏差说明（透明记录）**：依据已提交的 `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_AUTHORIZATION_GATE.md`（HEAD `2e20f3a`），本轮 WP4-D 执行 **不要求重新施加 WP4-C 冻结**；用户在先前的 Freeze Coverage Closure 执行轮已完成冻结 + no-write 验证（PASS）并恢复原服务。本轮快照在**冻结已解除、服务恢复**状态下执行，属授权范围内的只读复制。冻结态本就只为 no-write 验证服务，复制式 dump 对源为纯读（`--single-transaction` 一致性快照，无锁、无源写）。
> **凭证说明**：5 个 dump 均经 `mysql`/`mysqldump -u root`（本地 unix_socket，免密只读）执行 —— 即授权门 G-1=A「DBA/root 单独捕获」；未使用 `jhzy_mig_ro`（避免提权，且 ro 口令不在本环境）。schema/data/routines 三层分离，全为只读导出。

---

## 1. Repo Identity（本地，只读确认）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `2e20f3a`（`2e20f3a3dc5738ee6339907e3c0c0521674720f6`，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `2e20f3a…`） |
| staged | 0 |
| P9 scope clean | ✅（292+ 并行改动允许存在，未处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. Baseline（已读取并确认）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_AUTHORIZATION_GATE.md` | WP4-D Execution = AUTHORIZED；Ready for WP4-D = YES；Copy-not-cut recorded；C-8 COUNT(*) caveat fix = YES；G-2 residual acknowledged；Snapshot run = READY（沿用 `wp4d_authoritative_20260921_120656`） |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md` | §5 产物结构 / §6 命令设计 / §7 校验规则 / §8 迁移输入裁定；api_jhzyfw_com=128 对象（127 表+1 视图）、signup_db=3 表 |
| `P9_WP4D_FREEZE_COVERAGE_CLOSURE_EXECUTION.md` | Freeze Coverage Closure Execution = PASS；C-1~C-10 = PASS；service resumed = PASS；root crontab restored = PASS |
| `P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_20260921_114716.md` | snapshot/dump/migration/Cutover = NO；G-2 = WAIVED（Cutover 前须补 off-host copy）；C-8 COUNT(*) caveat（No database selected → SKIPPED）已记录 |
| `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md` | 边界确认；源库清单；入执行轮前置条件 |

**结论：BASELINE read = YES；WP4-D Execution authorized = YES；Ready for WP4-D Execution = YES。**

---

## 3. Snapshot Run Directory（宿主侧）

| 项 | 值 |
|---|---|
| 路径 | `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/` |
| 权限 | `drwx------`（0700） |
| 状态（执行前） | 空（仅 `dump_errors/` 子目录，由本执行轮创建） |
| 污染检查 | 无 `.sql` / `.sql.gz` / 旧 dump / 旧 manifest → **未污染** |
| 判定 | **READY**（沿用 C-9 已准备目录，未复用污染目录） |

---

## 4. Pre-Snapshot Source Safety Check

| 项 | 值 |
|---|---|
| MySQL reachable | **YES**（root via unix_socket，passwordless，SELECT 1 = ok） |
| `api_jhzyfw_com` exists | **YES** |
| `signup_db` exists | **YES** |
| source table inventory readable | **YES**（information_schema） |
| source row count readable | **YES**（逐表 COUNT(*)） |
| disk space | **YES**（`/www/backup` 21G 可用 ≫ 9.1MB 源） |
| `mysqldump` available | **YES**（`/usr/bin/mysqldump` 5.7.44） |
| `gzip` available | **YES**（`/usr/bin/gzip` 1.12） |
| `sha256sum` available | **YES**（`/usr/bin/sha256sum`） |
| `python3` available | **YES**（`/usr/bin/python3`，用于 JSON 构建） |
| routines capture (root) | **YES**（root 单独捕获，未用 jhzy_mig_ro） |

**源端保护确认（全部 = NO，本快照为纯读）：**

```
source_delete_allowed            = NO
source_truncate_allowed          = NO
source_drop_allowed              = NO
source_move_allowed              = NO
source_overwrite_allowed         = NO
source_data_modification_allowed = NO
source_schema_modification_allowed = NO
```

未检测到任何计划或已执行的破坏性源操作 → 未 ABORT。

---

## 5. Fixed Row Count Collection（C-8 caveat 已修复）

逐表 `SELECT COUNT(*) FROM \`db\`.\`table\`;`（**不再使用导致 `No database selected` 的 union**）。输出 `row_counts_before.json`。

| 库 | 表/对象数 | 总行数 |
|---|---|---|
| `api_jhzyfw_com` | 128（127 BASE TABLE + 1 VIEW） | 619,175 |
| `signup_db` | 3 | 1 |
| **合计** | **131** | **619,176** |

- 逐表计数：131 / 131 表全部成功，**0 缺失** → `row_counts_before.json` 完整。
- C-8 caveat（`per-table COUNT(*) hash skipped due to No database selected`）**已修复**。

---

## 6. Table Inventory

`table_inventory.json`（via information_schema）：

| 库 | 对象数 | 明细 |
|---|---|---|
| `api_jhzyfw_com` | 128 | 127 表 + 1 视图（VIEW） |
| `signup_db` | 3 | 3 表 |
| **合计** | **131** | 与边界/证据记录一致，**无差异**（无需 ABORT） |

记录字段：db / table / table_type / engine / table_rows(estimate) / update_time / collation。

---

## 7. Authoritative Snapshot Dumps（5 × `.sql.gz`）

执行命令（root unix_socket，只读）：

```bash
# schema (no data, with triggers+events)
mysqldump --single-transaction --no-data --triggers --events \
  --default-character-set=utf8mb4 -u root api_jhzyfw_com > api_jhzyfw_com.schema.sql 2>dump_errors/api_jhzyfw_com.schema.err
# data (no create-info, hex-blob)
mysqldump --single-transaction --no-create-info --triggers --events \
  --skip-lock-tables --hex-blob --default-character-set=utf8mb4 -u root api_jhzyfw_com > api_jhzyfw_com.data.sql 2>dump_errors/api_jhzyfw_com.data.err
# routines (root only — NOT jhzy_mig_ro)
mysqldump --single-transaction --routines --no-data --no-create-info --no-create-db --no-tablespaces \
  --default-character-set=utf8mb4 -u root api_jhzyfw_com > api_jhzyfw_com.routines.sql 2>dump_errors/api_jhzyfw_com.routines.err
# signup_db schema / data 同上（库名 signup_db）
```

| 文件 | 大小 (bytes) | sha256 | gzip |
|---|---|---|---|
| `api_jhzyfw_com.schema.sql.gz` | 19,011 | `b67db86eafcad747ee465654aac452e1638df5a2336983435406d5a2f28dd6b9` | OK |
| `api_jhzyfw_com.data.sql.gz` | 9,140,558 | `5850ff6cd4dccefc75dac425d19c7691a18d412d05879ef211f78e0be6196936` | OK |
| `api_jhzyfw_com.routines.sql.gz` | 1,356 | `792b9bda57ce83745766dfbb497255d4ad3393772d17d4de80429fd54fd41567` | OK |
| `signup_db.schema.sql.gz` | 1,008 | `720ec264a78ad24d977739fa2e4453db1452878d6a61abb58b26346a31dece23` | OK |
| `signup_db.data.sql.gz` | 688 | `bfa1cfe95a41efb3544cdd57f27a7620b024020af7ac9fd84a1be026dc07e2b1` | OK |

- 5 个 `.sql.gz` 全部存在、size > 0。
- `gzip -t` 全部 **OK**（`gzip_check.log` 全 OK）。
- `sha256_manifest.txt` 完整覆盖 5 文件。
- `dump_errors/*.err` 全部 **0 字节**（无 WARNING/ERROR）。
- **禁止项**：未使用 `--add-drop-database`；未生成 `DROP DATABASE` / `CREATE DATABASE` / `TRUNCATE TABLE` / `DELETE FROM`；schema 文件中含标准 `DROP TABLE IF EXISTS` ×131（mysqldump 默认 boilerplate，仅出现在快照文件内、永不执行于源，非禁止项）。

---

## 8. Routines Capture

- `api_jhzyfw_com.routines.sql.gz` 含 `assign_certificate_id`：
  - `assign_certificate_id_captured` = **YES**
  - `routines_capture_status` = **PASS**
- 由 root 单独捕获（G-1=A），未提权 `jhzy_mig_ro`。

---

## 9. G-2 Residual Record

```
G-2 status = WAIVED
authoritative snapshot created locally = YES
off-host copy before Cutover = REQUIRED
if off-host copy cannot be completed before Cutover = ABORT Cutover
```

- G-2 **不阻止** WP4-D snapshot（本快照仅宿主本地生成）。
- G-2 **阻止** Cutover：Cutover 前必须补 **off-host copy**，否则 **ABORT Cutover**。
- residual risk 已记入 evidence 与 `snapshot_manifest.json` / `evidence.json`。

---

## 10. Final Decision

| 判定 | 值 |
|---|---|
| `authoritative_snapshot` | **YES** |
| `migration_input` | **YES**（Validation PASS） |
| `Ready for WP4-E Migration Planning` | **YES** |

Validation PASS 条件（定义 §7）全部满足：5×`.sql.gz` + `sha256_manifest.txt` + `snapshot_manifest.json` + `row_counts_before.json` + `table_inventory.json` + `gzip_check.log` + `evidence.json` 齐全；size>0；gzip 全 OK；sha256 完整；dump_errors 全 0；routines 含 `assign_certificate_id`；inventory=131；row-count 完整；snapshot manifest 完整；evidence 完整；G-2 residual 已记录。

`abort_status` = **PASS**（无任何 dump 失败 / gzip 失败 / sha256 缺失 / routines 缺失 / 磁盘不足 / 源写入 / 污染 / evidence 不完整）。

---

## 11. Prohibitions Observed（全部 = NO）

| 禁止项 | 状态 |
|---|---|
| D1 import | NO |
| import schema | NO |
| import data | NO |
| Migration（数据迁移） | NO |
| Cutover | NO |
| 删除源库数据 / 清空表 / DROP / 移动 1.0 文件 / 覆盖 1.0 代码 | NO |
| 停止 1.0 / 锁表 | NO |
| 修改源库结构 / 数据 | NO |
| 修改 Worker / DNS / route | NO |
| 修改 MySQL 用户或权限 | NO |
| git commit / push | NO（按本任务禁令，待另行授权） |

---

## 12. Artifact Inventory（宿主目录 `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`）

```
api_jhzyfw_com.schema.sql.gz      19,011  b67db86e…28dd6b9  gzip OK
api_jhzyfw_com.data.sql.gz     9,140,558 5850ff6c…6196936  gzip OK
api_jhzyfw_com.routines.sql.gz     1,356 792b9bda…fd41567  gzip OK
signup_db.schema.sql.gz           1,008 720ec264…31dece23  gzip OK
signup_db.data.sql.gz               688 bfa1cfe9…dc07e2b1  gzip OK
sha256_manifest.txt
snapshot_manifest.json
row_counts_before.json             (131 表, 0 缺失, 619,176 行)
table_inventory.json               (128 + 3 = 131 对象)
gzip_check.log                     (5× OK)
dump_errors/                       (5× .err, 全 0 字节)
evidence.json
```

---

## FINAL GATE

```
Repo identity confirmed = YES
Baseline read = YES
Snapshot run directory ready = YES
Source safety check = PASS
Copy-not-cut principle enforced = YES
Row counts collected = PASS
Table inventory collected = PASS

api_jhzyfw_com schema dump = PASS
api_jhzyfw_com data dump = PASS
api_jhzyfw_com routines dump = PASS
signup_db schema dump = PASS
signup_db data dump = PASS

gzip integrity = PASS
sha256 manifest = PASS
routines capture = PASS
assign_certificate_id captured = YES
snapshot_manifest created = YES
evidence created = YES

G-2 residual recorded = YES
authoritative_snapshot = YES
migration_input = YES
Ready for WP4-E Migration Planning = YES

Production data modified = NO
Production schema modified = NO
Source delete/drop/truncate/move executed = NO
D1 modified = NO
Worker modified = NO
DNS / route changed = NO
Migration executed = NO
Cutover executed = NO

P9 WP4-D AUTHORITATIVE_SNAPSHOT Execution = PASS
```

**STOP — 不得进入 WP4-E / 不得导入 D1 / 不得迁移 / 不得 Cutover / 不得 commit。**
（下一步须用户另行显式授权：WP4-E Migration Planning、off-host copy 补录（G-2）、或 Git Closeout。）
