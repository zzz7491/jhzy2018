# P9 WP4-D — Authoritative Snapshot Execution（聚合记录）

> **阶段**：P9 WP4-D（AUTHORITATIVE_SNAPSHOT 执行轮）
> **run_id**：`wp4d_authoritative_20260921_120656`
> **执行日期**：2026-09-21（CST）
> **详细证据**：`P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_EVIDENCE_20260921_120656.md`
> **性质**：只读复制式快照（copy-not-cut）。源 1.0 原库/文件/服务保留不动；未写 D1 / 未迁移 / 未 Cutover / 未 commit。

---

## 执行摘要

| 阶段 | 结果 |
|---|---|
| REPO IDENTITY GATE | PASS（master / `2e20f3a` / HEAD==origin/master / staged=0） |
| BASELINE read | YES（5 份基线文档已读，WP4-D authorized=YES，Ready=YES） |
| Snapshot run dir | READY（0700、空、未污染） |
| Source safety | PASS（MySQL reachable；api_jhzyfw_com + signup_db 存在；tools 齐全；root routine capture） |
| Row counts (C-8 fix) | PASS（131/131 表计数成功，0 缺失；合计 619,176 行） |
| Table inventory | PASS（api 128 + signup 3 = 131 对象，与基线一致） |
| 5× dumps | PASS（schema/data/routines × api；schema/data × signup） |
| gzip integrity | PASS（5× OK） |
| sha256 manifest | PASS（5 文件完整） |
| routines capture | PASS（`assign_certificate_id` captured） |
| G-2 residual | WAIVED 已记录（Cutover 前须补 off-host copy，否则 ABORT Cutover） |
| FINAL | **authoritative_snapshot = YES / migration_input = YES / Ready for WP4-E = YES / abort_status = PASS** |

---

## 产物（宿主目录）

`/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`

| 文件 | 大小 | sha256(前8) | gzip |
|---|---|---|---|
| api_jhzyfw_com.schema.sql.gz | 19,011 | b67db86e | OK |
| api_jhzyfw_com.data.sql.gz | 9,140,558 | 5850ff6c | OK |
| api_jhzyfw_com.routines.sql.gz | 1,356 | 792b9bda | OK |
| signup_db.schema.sql.gz | 1,008 | 720ec264 | OK |
| signup_db.data.sql.gz | 688 | bfa1cfe9 | OK |
| sha256_manifest.txt / snapshot_manifest.json / row_counts_before.json / table_inventory.json / gzip_check.log / evidence.json / dump_errors/ | — | — | — |

---

## 关键裁定

1. **复制式迁移**：源库仅被读取，未删/清/移/覆盖/修改任何 1.0 数据或结构。
2. **C-8 caveat 已修复**：逐表 `SELECT COUNT(*) FROM \`db\`.\`table\``（无 union），131/131 全部成功。
3. **快照在冻结解除后执行**：依据已提交的授权门（HEAD `2e20f3a`），本轮不要求重新施加 WP4-C 冻结；用户在先冻结+no-write 验证（PASS）并已恢复服务，本快照为授权范围内只读复制。
4. **root 单独捕获**：5 个 dump 均经 `mysql`/`mysqldump -u root`（unix_socket 免密只读），未用 `jhzy_mig_ro`，符合 G-1=A。
5. **schema 文件含标准 `DROP TABLE IF EXISTS` ×131**：mysqldump 默认 boilerplate，仅存在于快照文件内、永不执行于源；未使用 `--add-drop-database`，无 `DROP DATABASE`/`CREATE DATABASE`/`TRUNCATE`/`DELETE FROM`。

---

## 禁止项（全部 = NO）

D1 import / import schema / import data / Migration / Cutover / 删除·清空·DROP·移动源 / 停止 1.0 / 锁表 / 改源结构·数据 / 改 Worker / 改 DNS·route / 改 MySQL 权限 / git commit·push。

---

## 下一步（须用户另行显式授权）

- WP4-E Migration Planning（使用本快照作为唯一权威输入）
- G-2 off-host copy 补录（Cutover 前置，否则 ABORT Cutover）
- Git Closeout（提交本执行证据文档）

**STOP — 不得进入 WP4-E / 不得导入 D1 / 不得迁移 / 不得 Cutover / 不得 commit。**
