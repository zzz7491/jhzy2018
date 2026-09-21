# P9 G-2 — Off-host Copy Remediation for WP4-D Authoritative Snapshot

> **阶段**：P9 G-2（Off-host Copy Remediation）
> **执行日期**：2026-09-21（CST）
> **run_id**：`wp4d_authoritative_20260921_120656`
> **性质**：**Off-host copy remediation only（仅复制 + 校验，不导入 D1 / 不迁移 / 不 Cutover / 不重新 mysqldump / 不修改源库 / 不 commit）**。
> **纪律**：WP4-D authoritative snapshot 仅被**复制**到 off-host 位置；原快照内容、源 1.0 数据、源库结构**一律保留不动**；禁止删除 / 清空 / 移动 / 覆盖源数据或快照原件。

---

## 1. Repo Identity（本地，只读确认）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `9759315`（`975931539b9a8e7f33e61a8eee7cf7c19a8d3307`，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `9759315…`） |
| staged | 0 |
| P9 scope clean | ✅（292+ 并行改动允许存在，未处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. Baseline（已读取并确认）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION.md` | WP4-D PASS；run_id=`wp4d_authoritative_20260921_120656`；5×`.sql.gz` + sha256 + gzip OK；row counts 131/131、total 619,176；api 128 对象（127 表+1 视图）、signup 3 表；routines 含 `assign_certificate_id`；G-2 WAIVED 已记录 |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_EVIDENCE_20260921_120656.md` | snapshot path、`sha256_manifest.txt` 5 条哈希；G-2 residual：off-host copy before Cutover = REQUIRED，否则 ABORT Cutover |
| `P9_WP4E_MIGRATION_PLANNING.md` | WP4-E = PASS；migration_input=YES；G-2 residual 仍 OPEN（Cutover 前须补 off-host copy）；D1 import=NO |

**结论**：authoritative_snapshot=YES；migration_input=YES；run_id=`wp4d_authoritative_20260921_120656`；G-2 residual 仍为 Cutover 前硬阻塞；D1 import / Migration / Cutover = NO。

---

## 3. Source Snapshot Path

```
/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/
```

---

## 4. Source Snapshot Integrity Check（宿主侧，只读）

在腾讯云生产宿主 `root@101.43.30.163` 上执行只读校验（**未修改任何原件**）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 文件齐全 | `ls -la` | ✅ 5×`.sql.gz` + `sha256_manifest.txt` + `snapshot_manifest.json` + `row_counts_before.json` + `table_inventory.json` + `gzip_check.log` + `evidence.json` + `dump_errors/`（5×0 字节 `.err`） |
| sha256 | `sha256sum -c sha256_manifest.txt` | ✅ 5/5 OK（`sha_exit=0`） |
| gzip | `gzip -t *.sql.gz` | ✅ 5/5 OK |

**源快照完整性 = PASS**（与 WP4-D evidence 记录一致）。

---

## 5. Off-host Target Decision

| Option | 探测结果 | 采用 |
|---|---|---|
| **A. `/mnt/nas-storage`** | CIFS 挂载（`//100.119.44.27/nvme16-135XXXX0654`，腾讯云内网地址），但当前 `Host is down`，不可写 | ❌ 不可用（已探测，未使用） |
| **B. 远端服务器 / 本地运维工作站** | prod 宿主有 `rsync`/`scp`/`ssh`/`tailscale`（`100.126.179.113`），但无预置到家庭 NAS 的路由/凭据 | ✅ **采用：operator_local_workstation** |
| **C. 无法完成** | — | ❌ 不适用（已找到可用 off-host） |

**选定 off-host target**：本地运维工作站（Windows，家庭 LAN），路径独立于腾讯云生产宿主的故障域。

> 说明：Option A 的 NAS 挂载虽为 CIFS 到腾讯内网存储，但其本身仍是腾讯云网络内的存储；无论采用 A 或 B，本次目标均为「使快照脱离生产宿主单机故障域」。本地运维工作站满足该 G-2 意图。建议后续将副本再提升至专用 NAS / VPS 以获得生产级 DR 持久性（见 §10 notes）。

---

## 6. Copy Method

```bash
# 从生产宿主只读拉取到本地 off-host（scp -r，不修改远端）
scp -r -o StrictHostKeyChecking=no -o BatchMode=yes \
  root@101.43.30.163:/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656 \
  /e/D盘备份/p9-offhost/
```

- 复制方式：read-only pull（scp），**远端原件零修改**。
- 目标目录：`E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/`（位于仓库工作树之外，不污染 git status）。
- `scp` 退出码 = 0。

---

## 7. Copied File List（16 文件）

| 文件 | 大小 (bytes) |
|---|---|
| api_jhzyfw_com.schema.sql.gz | 19,011 |
| api_jhzyfw_com.data.sql.gz | 9,140,558 |
| api_jhzyfw_com.routines.sql.gz | 1,356 |
| signup_db.schema.sql.gz | 1,008 |
| signup_db.data.sql.gz | 688 |
| sha256_manifest.txt | 463 |
| snapshot_manifest.json | 1,808 |
| row_counts_before.json | 4,306 |
| table_inventory.json | 30,222 |
| gzip_check.log | 153 |
| evidence.json | 2,510 |
| dump_errors/api_jhzyfw_com.schema.err | 0 |
| dump_errors/api_jhzyfw_com.data.err | 0 |
| dump_errors/api_jhzyfw_com.routines.err | 0 |
| dump_errors/signup_db.schema.err | 0 |
| dump_errors/signup_db.data.err | 0 |

---

## 8. Off-host SHA256 Verification

在 off-host 目标侧重新计算 5 个 `.sql.gz` 的 sha256，并与 `sha256_manifest.txt` 比对：

| 文件 | sha256(前12) | 结果 |
|---|---|---|
| api_jhzyfw_com.schema.sql.gz | `b67db86eafca` | ✅ OK |
| api_jhzyfw_com.data.sql.gz | `5850ff6cd4dc` | ✅ OK |
| api_jhzyfw_com.routines.sql.gz | `792b9bda57ce` | ✅ OK |
| signup_db.schema.sql.gz | `720ec264a78a` | ✅ OK |
| signup_db.data.sql.gz | `bfa1cfe95a41` | ✅ OK |

`ALL_SHA256_PASS = True`；`manifest` / `json` / `gzip_check.log` / `evidence.json` / `dump_errors/` 均存在且完整。

**off-host sha256 verification = PASS。**

---

## 9. Off-host Copy Manifest

生成并随副本存放：`E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/offhost_copy_manifest.json`

关键字段：
- `run_id` = `wp4d_authoritative_20260921_120656`
- `source_snapshot_path` = `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`
- `off_host_target_type` = `operator_local_workstation`
- `off_host_target_path` = `E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/`
- `copy_method` = `scp -r (read-only pull; originals untouched)`
- `off_host_sha256_verification` = `PASS (5/5 matched)`
- `g2_status` = `CLOSED_FOR_WP4D_SNAPSHOT`
- `cutover_blocker_status` = `REMOVED for G-2 (off-host copy present & verified); Cutover remains NOT authorized`
- `operator` = `WorkBuddy (automation edf6a75d-4cfa-4c1d-afba-889048a22cc9)`

---

## 10. Final G-2 Decision

```
G-2 off-host copy                  = PASS
G-2 residual                      = CLOSED_FOR_WP4D_SNAPSHOT
Ready for Cutover with respect to G-2 = YES
```

> ⚠️ 这仅**关闭 G-2 对 Cutover 的阻塞**。不代表 Cutover 已授权 —— Cutover 仍需在后续 WP4-F/WP6 阶段显式授权。

---

## 11. Prohibitions Observed（全部 = NO）

| 禁止项 | 状态 |
|---|---|
| D1 import / 写 D1 / SQL import | NO |
| Migration（数据迁移） | NO |
| Cutover | NO |
| 修改源库 / 源结构 / 源数据 | NO |
| 重新 mysqldump / 重新 snapshot | NO |
| 修改 snapshot 原件 / 删除 / 覆盖 | NO |
| 删除 / 清空 / 移动 / 覆盖 1.0 源数据 | NO |
| 修改 Worker / DNS / route / MySQL 权限 | NO |
| git commit / push（本轮） | NO（待用户另行授权 Git Closeout） |
| 生产数据 / schema 修改 | NO |

---

## 12. Artifact Inventory

**Off-host 副本（已校验）**：`E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/`
（16 文件 + `offhost_copy_manifest.json`）

**源快照原件（未改动）**：`/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`（腾讯云生产宿主）

---

## FINAL GATE

```
Repo identity confirmed = YES
Baseline read = YES
Source snapshot integrity = PASS
Off-host target selected = YES
Off-host target = operator_local_workstation (E:/D盘备份/p9-offhost/wp4d_authoritative_20260921_120656/)
Snapshot copied off-host = PASS
Off-host sha256 verification = PASS
offhost_copy_manifest created = YES
Evidence document created = YES

G-2 off-host copy = PASS
G-2 residual = CLOSED_FOR_WP4D_SNAPSHOT
Ready for Cutover with respect to G-2 = YES

D1 import executed = NO
Migration executed = NO
Cutover executed = NO
Source data modified = NO
Source schema modified = NO
D1 modified = NO
Worker modified = NO
DNS / route changed = NO

P9 G-2 Off-host Copy Remediation = PASS
```

**STOP — 不得进入 D1 import / 不得迁移 / 不得 Cutover / 不得 commit。**
下一步须用户另行显式授权：WP4-E 实际执行轮（D1 import / 迁移）、Cutover（WP6）、或本 G-2 证据文档的 Git Closeout。
