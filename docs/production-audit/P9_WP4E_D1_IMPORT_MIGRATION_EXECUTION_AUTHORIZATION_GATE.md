# P9 WP4-E D1 Import / Migration Execution Authorization Gate

> **性质**：Authorization Gate only — 本轮**只定义并确认**后续 D1 import / migration 执行轮的授权边界、输入、分阶段策略、校验规则、ABORT 条件与禁止事项。**本轮不得实际导入 D1、不得迁移、不得 Cutover、不得 git commit。**

---

## 1. Repo Identity

| 项 | 值 |
|---|---|
| branch | `master` |
| HEAD | `7f47f3c` (docs(migration): record P9 G-2 off-host copy remediation) |
| HEAD == origin/master | YES (`7f47f3c`) |
| staged | 0（并行改动存在但未处理） |
| 其它并行工作流 | 存在（miniprogram/workers 等 292+ 项），本轮一律不处理 |

## 2. Baseline（已读确认）

| 来源文档 | 关键确认 |
|---|---|
| P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION.md | `authoritative_snapshot = YES`、`migration_input = YES`、run_id=`wp4d_authoritative_20260921_120656` |
| P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_EVIDENCE_20260921_120656.md | 5×`.sql.gz`、sha256/gzip PASS、row_counts 131/131、total 619176、routines 含 `assign_certificate_id`、B0 RBAC SKIP |
| P9_WP4E_MIGRATION_PLANNING.md | WP4-E Migration Planning = PASS、131 源对象、D1 86 frozen schema、source→target 映射、B0–B20 批次、GAP-RE-1、SHADOW/LEGACY excluded |
| P9_G2_OFFHOST_COPY_REMEDIATION_20260921.md | off-host copy = PASS、G-2 residual = `CLOSED_FOR_WP4D_SNAPSHOT`、Ready for Cutover w.r.t. G-2 = YES |

结论：先决条件全部满足，可进入 D1 import / migration 的**后续执行轮授权定义**。

## 3. D1 / Target Baseline Readiness

只读确认（未执行任何 D1 写操作）：

- D1 database name = **`jhzy-v2-db`**
- D1 database id = `ea603f43-d076-4df5-b118-3d8a0c245439`（与既有 evidence 一致）
- D1 frozen schema = **86 tables**
- RBAC seed（规划态，由 `workers/scripts/gen_permission_seed.mjs` 生成）：
  - permissions = **104**
  - roles = **6**
  - role_permissions = **295**
- `wrangler.jsonc` 绑定：`binding=DB`、`database_name=jhzy-v2-db`、`migrations_dir=migrations`
- migrations 脚本：`workers/migrations/0001.sql` … `0043.sql`（共 43 个，已冻结）
- **staging D1 环境：不存在**（wrangler 仅 1 个 `d1_databases` binding，无 `staging`）
- D1 business tables 当前为**业务空表**（仅 RBAC seed 已装载，B0 须 SKIP 不覆盖）

## 4. Snapshot Input Check（只读）

源快照目录 `/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/` 与 off-host 副本均经 evidence 记录：

- 5 × `.sql.gz`（api schema/data/routines + signup schema/data）= PASS
- `sha256_manifest.txt` = PASS
- `gzip_check.log` = PASS
- `row_counts_before.json` = 131/131，total 619,176
- `table_inventory.json` = PASS（api 128 对象 + signup 3 = 131）
- routines capture = PASS，`assign_certificate_id` captured = YES
- off-host copy = PASS（G-2 `CLOSED_FOR_WP4D_SNAPSHOT`）

本轮不重新生成、不重新 dump、不修改快照原件。

## 5. Copy-not-cut Principle

```
迁移 = 复制式迁移，不是剪切。
源端 1.0 原库、原文件、原服务必须保留不动。
WP4-E 只能基于 WP4-D authoritative snapshot 执行迁移，不得直接改源库。
禁止删除、清空、移动、覆盖、破坏 1.0 源数据。
```

## 6. Migration Execution Authorization Scope

| 项 | 授权判定 | 说明 |
|---|---|---|
| Dry-run transform-only | **AUTHORIZED_FOR_NEXT_EXECUTION** | 读取 snapshot → 解析/转换 → 产出本地中间结果/报告；不写 production D1 |
| Staging D1 import | **NOT_AUTHORIZED** | 当前无 staging D1；须先创建/指定 staging 目标后再授权 |
| Production D1 import | **NOT_AUTHORIZED** | 仅 dry-run / staging / reconciliation PASS 后才可另行授权 |
| Cutover | **NOT_AUTHORIZED** | 须等 production import + reconciliation PASS 后再入独立 Cutover Gate |

→ 本轮对实际迁移的授权边界：**LIMITED_TO_DRY_RUN**。

## 7. Migration Execution Order（定义，不执行）

```
E0: Importer implementation readiness check
E1: Dry-run transform-only
E2: Dry-run reconciliation report
E3: Staging D1 import
E4: Staging reconciliation
E5: Production D1 import authorization gate
E6: Production D1 import
E7: Production reconciliation
E8: Cutover authorization gate
E9: Cutover execution
```

任一阶段失败 → STOP；不自动进入下一阶段；记录 evidence；**须用户另行授权**后才继续。

## 8. Batch Authorization Matrix（基于 WP4-E B0–B20）

| 批次 | 内容 | 判定 |
|---|---|---|
| B0 | RBAC seed | **SKIP / NOT_IMPORT**（D1 已 seed，禁止覆盖） |
| B1 | reference / dictionary / region / organization basics | PLANNED |
| B2 | users / volunteers / identity | PLANNED |
| B3 | teams / memberships / RBAC-safe links | PLANNED |
| B4 | activities / occurrences / positions / slots | PLANNED |
| B5 | signups / participations | PLANNED |
| B6 | attendance / checkin-checkout history | PLANNED |
| B7 | points / certificates / insurance | PLANNED |
| B8 | training / exams / answers / scores | PLANNED |
| B9 | dynamic forms / form answers | PLANNED |
| B10 | audit logs / compatibility archive | PLANNED |
| B11 | reconciliation / final validation | PLANNED |
| B12–B20 | 其余规划批次 | PLANNED / AS_DEFINED_IN_WP4E_PLANNING |

约束：每批必须有 id mapping；每批必须可回滚/可重跑；每批必须有 reconciliation；批次间不得跳过依赖；**若 B0 试图覆盖 RBAC seed → ABORT**。

## 9. ID Mapping / Idempotency Requirement

后续执行轮须满足：

- 使用 `legacy_id_maps` 映射表（不污染正式业务表）
- 使用 `public_id` / ULID；source PK → target PK 稳定映射
- 重跑必须幂等（同一 legacy 记录重复导入不得产生重复业务行）
- duplicate legacy record 必须可解释（去重/合并/报告）
- orphan record 不得静默丢弃（须落 `migration_issues` 或归档）
- rejected rows 必须落报告
- SHADOW/LEGACY excluded 表不迁入业务表（仅存档于 snapshot）
- **GAP-RE-1**：双名源表（`activities` vs `jhzy_activities` 等）须在实际导入前由源适配器 `srcKey` 规则裁定；**未裁定 → production import = ABORT**
- 如需临时表，须在后续执行授权中单独说明

## 10. Validation / Reconciliation Gate（后续执行轮通过条件）

关键校验须全部 PASS：

- row-count reconciliation PASS（源→转换→插入 守恒，差异须解释）
- source logical hash PASS
- target logical hash PASS
- FK / orphan check PASS（participation / attendance / certificate / points / training 无孤儿）
- duplicate active check-in = **0**（同一志愿者同一时刻至多一个已签到）
- certificate number duplicate = **0**
- points detail vs total reconciliation PASS（积分总和与明细一致）
- training/exam score consistency PASS
- dynamic forms JSON validity PASS（P20 `schema_json`/`answers_json`）
- rejected rows reviewed、skipped rows explained、archived rows listed
- business invariants PASS（历史报名/签到记录不丢失等）
- evidence complete

任一关键校验失败：

```
migration_input remains available
production import = FAIL
cutover = NOT_AUTHORIZED
```

## 11. Source Protection Rules

```
source_database_read_only_input = YES
source_delete_allowed = NO
source_truncate_allowed = NO
source_drop_allowed = NO
source_move_allowed = NO
source_overwrite_allowed = NO
source_data_modification_allowed = NO
source_schema_modification_allowed = NO
```

实际执行必须基于 snapshot（只读副本/off-host 副本），**不得直接连接 1.0 源库进行数据修改**。任何源端 destructive 操作 → ABORT。

## 12. D1 Write Boundary

| 项 | 判定 |
|---|---|
| D1 production write authorized | **NO** |
| D1 staging write authorized | **NO**（无 staging 目标；创建 staging 后须另行授权） |
| D1 dry-run artifact write authorized | **YES**（仅限本地临时 artifact，绝写入 D1） |
| D1 schema overwrite authorized | NO |
| D1 RBAC seed overwrite authorized | NO |
| D1 destructive reset authorized | NO |
| D1 table drop/truncate authorized | NO |

## 13. Cutover Boundary

```
Cutover authorized = NO
Worker route switch authorized = NO
DNS change authorized = NO
Production traffic switch authorized = NO
Rollback cutover authorized = NO
```

> G-2 已关闭**不等于** Cutover 已授权。Cutover 须等 production import + reconciliation PASS 后，再进入独立 Cutover Gate（WP6）。

## 14. Abort Rules（后续执行轮）

任一情况必须 ABORT：

- D1 schema mismatch
- D1 target 在要求 empty 时非空
- RBAC seed mismatch / 试图覆盖 RBAC seed
- source snapshot sha256 mismatch
- importer script 缺失或未经 review
- **GAP-RE-1 未裁定**
- id mapping collision 未解决
- orphan rate 超阈
- duplicate active check-in > 0
- certificate id collision
- points reconciliation 失败
- row-count reconciliation 失败
- logical hash 失败
- rejected rows 未解释
- 未授权的 D1 写入
- 任何源端 destructive 操作
- evidence 不完整

---

## Final Gate

```
Repo identity confirmed = YES
Baseline read = YES
D1 / target baseline checked = YES
Snapshot input checked = YES
Copy-not-cut principle recorded = YES
Source protection rules recorded = YES
Migration execution order defined = YES
Batch authorization matrix defined = YES
ID mapping / idempotency requirement recorded = YES
Validation / reconciliation gate defined = YES
D1 write boundary recorded = YES
Cutover boundary recorded = YES
Abort rules recorded = YES
Authorization document created = YES

Dry-run transform-only authorized for next execution = YES
Staging D1 import authorized for next execution = NO
Production D1 import authorized = NO
Migration execution authorized = NO / LIMITED_TO_DRY_RUN
Cutover authorized = NO

D1 import executed = NO
D1 modified = NO
Migration executed = NO
Cutover executed = NO
Source data modified = NO
Source schema modified = NO
Worker modified = NO
DNS / route changed = NO

P9 WP4-E D1 Import / Migration Execution Authorization Gate = PASS
Ready for Git Closeout = YES（仅提交本门文档，待用户授权）
Ready for Dry-run Transform-only Execution = YES
Ready for Staging D1 Import = NO（须先建 staging D1）
Ready for Production D1 Import = NO
```

**STOP — 不得导入 D1 / 不得迁移 / 不得 Cutover / 不得 commit。** 下一步须用户另行显式授权：Dry-run transform-only 执行轮、创建 staging D1、或本授权门文档的 Git Closeout。
