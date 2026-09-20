# P9 WP4-B — Backup Execution Authorization Gate（备份执行·授权门）

> **阶段**：P9 WP4-B（Authorization Gate only）
> **执行日期**：2026-09-20（CST）
> **性质**：**授权门（Authorization Gate）** —— 仅定义 Backup Execution 的两类执行模式（SAFETY_COPY_ONLY / AUTHORITATIVE_SNAPSHOT），明确 G-1 / G-2 / G-4 三种处理决策，输出授权矩阵（Authorization Matrix），**不执行** mysqldump、不实际备份、不锁表、不冻结、不挂载 NAS、不提权、不触碰生产数据。
> **承接**：`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（Readiness Gate，PASS）、`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5（备份执行计划）、`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`（G-10 CLOSED）、`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 活跃漂移）。
> **纪律**：本轮无任何生产写；未 git commit（待授权）。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| P9 WP4-A | FINAL PASS（commit `f5c606a`，G-10 CLOSED） |
| P9 WP4-B Readiness | FINAL PASS（commit `d90cc71`，HEAD == origin/master） |
| Ready for Backup Execution | **CONDITIONAL YES**（须附：G-2 关闭或 SAFETY_COPY_ONLY / G-1 closure / 维护窗+冻结排定 / 用户书面授权） |
| 最新远端 commit | `d90cc71` |
| 本轮性质 | Authorization Gate（定义模式 + 决策 + 矩阵） |
| 是否执行备份 | **NO** |

---

## 1. 权威基线（已读取）

| 文档 | 角色 / 用途 |
|---|---|
| `P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md` | Readiness Gate：源库实测（5.7.44 / 128+3 表 / binlog OFF / jhzy_mig_ro 仅 SELECT / NAS down / routines=1）/ 命令模板 / 中断规则 AB-01…AB-09 / Gap Register（G-1/G-2/G-3/G-4） |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | WP4 定义 §5 备份执行计划 / G-10 CLOSED |
| `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` | G-10 关闭证据（jhzy_mig_ro 最小只读） |

**基线确认**：G-10=CLOSED；`jhzy_mig_ro` 可 SELECT 两源库；生产业务数据未修改；schema 临时修改已回滚无残留；binlog=OFF；active drift exists；maintenance window required；no-freeze backup cannot be authoritative migration snapshot；dual-write prohibited。

---

## 2. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `d90cc714a99abc4387a96d9b62809f74ff9c9958`（`d90cc71`，P9 WP4-B Readiness Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `d90cc71…`） |
| staged | 0 |
| P9 scope clean | ✅（并行改动允许存在，不处理） |
| 其它并行改动 | 290+ 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），**不在 P9 范围** |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 3. Execution Modes（执行模式定义）

备份执行必须显式归入以下两类模式之一，不得混淆。

### Mode A — SAFETY_COPY_ONLY（安全副本模式）

| 维度 | 定义 |
|---|---|
| 用途 | 生成一份当前生产源库安全副本，作为额外保障；**不作为迁移权威快照** |
| 维护窗 | **可不排定** |
| 写入冻结 | **可不断写** |
| 活跃漂移 | 可接受 active drift 风险（副本可能含漂移期间的新写） |
| NAS 状态 | NAS down 时**仅生成本地备份**，但必须记录 `offhost_copy = FAILED / SKIPPED`（含理由） |
| 命令模板 | 复用 Readiness §3.2 Tier A（jhzy_mig_ro schema+data+triggers dump）；routines 按 §4 决策处理 |
| 证据标记 | `backup_mode = non_authoritative_safety_copy`；`final_decision = SAFETY_COPY_ONLY` |
| 限制 | ① `final_decision` 不得为 `authoritative_snapshot`；② 不得基于本备份进入迁移（WP4-E）；③ 不得进入 Cutover；④ 证据须显式标记 `SAFETY_COPY_ONLY` |

### Mode B — AUTHORITATIVE_SNAPSHOT（权威快照模式）

| 维度 | 定义 |
|---|---|
| 用途 | 生成未来迁移（WP4-E）输入快照 |
| 维护窗 | **必须已排定**（WP4-C 授权后） |
| 写入冻结 | **必须 1.0 写入冻结**（WP4-C 执行） |
| no-write verification | **必须 PASS**（冻结后、dump 前校验 UPDATE_TIME + 行数零变化） |
| G-1 routines | **必须 closed**（授权 DBA 账号捕获或显式排除，见 §4） |
| G-2 off-host | off-host copy 路径必须可用，或**正式豁免**（书面 waiver） |
| 表清单 / 行数 | 必须捕获（table_inventory_hash / row counts） |
| schema + data dump | 必须捕获（Tier A + Tier B routines） |
| hashes | 必须生成（sha256_manifest） |
| evidence | 必须完整（Readiness §5 全部 25 字段） |
| 命令模板 | 复用 Readiness §3.2–§3.4 |
| 限制 | ① 若活跃写入继续 → **ABORT**（AB-06）；② 若要求 off-host 但不可用 → **ABORT**（AB-05）；③ 若要求 routines 但不可用 → **ABORT**（AB-02）；④ 双写禁止；⑤ 本步骤不含迁移执行（除非另行授权进入 WP4-E） |

---

## 4. G-1 ROUTINES DECISION（例程捕获决策）

源库含 1 例程：`api_jhzyfw_com.assign_certificate_id`（PROCEDURE）。`jhzy_mig_ro` 无 `mysql.proc` SELECT → `--routines` 不能走只读账号。

| 选项 | 描述 | 推荐 |
|---|---|---|
| **A. DBA/root 单独捕获 routines** | 用授权 DBA 账号（`AUTH_DUMP_ACCOUNT`）执行 `SHOW CREATE PROCEDURE` 或 `mysqldump --routines`，产物入 evidence 包 | ✅ **默认推荐** |
| B. 显式排除 routines | 论证 D1 无存储过程语义、`assign_certificate_id` 不需迁移，显式排除并留 evidence | 备选（须迁移设计轮 U-03 确认） |
| C. 临时扩展只读账号 | 临时为 `jhzy_mig_ro` 授予 `mysql.proc` SELECT 以捕获 routines 元数据 | ❌ **禁止**（违反最小权限 MG-03；不得临时提权） |

**默认决策**：**A**（DBA/root captures routines separately）。
**原因**：① `jhzy_mig_ro` 不得提权；② `assign_certificate_id` 属生产 schema dependency，应进入 evidence 包；③ routines 捕获不依赖 jhzy_mig_ro，避免污染只读账号语义。

> 本轮不执行任何授权或 dump；选项 C 永久排除。

---

## 5. G-2 NAS / OFF-HOST DECISION（离场拷贝决策）

`/mnt/nas-storage` 当前 `Host is down`（CIFS 定义存在但断连）。

| 选项 | 描述 | 适用模式 |
|---|---|---|
| **A. 备份前重连 NAS** | 重新挂载 + 可达性 + 非破坏写测试；执行前确认 `NAS_path` 可写 | AUTHORITATIVE_SNAPSHOT 要求 A 或 C |
| **B. 仅本地 + 标记 SAFETY_COPY_ONLY** | NAS 不可用时只生成本地备份，记录 `offhost_copy = FAILED/SKIPPED`，标记风险 | SAFETY_COPY_ONLY 允许 B（须标记风险） |
| **C. 改用备用 off-host 路径** | 指定替代 off-host 目标（如另一挂载/对象存储），须同样可写验证 | AUTHORITATIVE_SNAPSHOT 要求 A 或 C |

**默认**：
- AUTHORITATIVE_SNAPSHOT 要求 **A 或 C**（缺离场拷贝克即 ABORT，AB-05）；
- SAFETY_COPY_ONLY 允许 **B**，但必须标记 `offhost_copy = FAILED/SKIPPED` + 风险说明。

> 本轮不挂载 NAS、不拷贝文件；仅定义决策路径。

---

## 6. G-4 MAINTENANCE WINDOW DECISION（维护窗决策）

binlog=OFF + 活跃漂移 → 权威快照必须维护窗 + 写入冻结。

| 选项 | 描述 | 结果 |
|---|---|---|
| **A. 无维护窗** | 不排定窗口、不冻结 | 仅允许 **SAFETY_COPY_ONLY**；不得 AUTHORITATIVE_SNAPSHOT |
| **B. 维护窗排定 + 写入冻结** | WP4-C 授权后：批准窗口、通知、1.0 置维护态、no-write 校验 PASS | 允许 **AUTHORITATIVE_SNAPSHOT** |

**当前状态（无维护窗授权）**：
- Ready for SAFETY_COPY_ONLY = **YES**
- Ready for AUTHORITATIVE_SNAPSHOT = **NO**

---

## 7. Authorization Matrix（授权矩阵）

| 执行项 | allowed now | required explicit authorization | required preconditions | prohibited follow-on actions |
|---|---|---|---|---|
| **SAFETY_COPY_ONLY local only** | YES（须用户书面授权执行轮） | 进入 WP4-B 执行轮授权 | ① 模式显式 = SAFETY_COPY_ONLY；② G-1 closure（A 或 B）；③ 标记 offhost=FAILED/SKIPPED（若 NAS 仍 down） | 不得进入迁移（WP4-E）/ 不得 Cutover / 不得标记为 authoritative |
| **SAFETY_COPY_ONLY with off-host copy** | NO（NAS 当前 down） | 进入执行轮授权 + G-2 A/C 关闭 | ① G-2 关闭（NAS 重连或备用路径）；② G-1 closure；③ 模式 = SAFETY_COPY_ONLY | 不得进入迁移 / 不得 Cutover / 不得标记为 authoritative |
| **AUTHORITATIVE_SNAPSHOT** | NO | 进入执行轮授权 + WP4-C 维护窗授权 | ① 维护窗排定（G-4 B）；② 写入冻结 + no-write PASS；③ G-1 closure；④ G-2 A/C 关闭或书面 waiver；⑤ 表清单/行数/dump/hash 全捕获；⑥ 证据完整 | 双写禁止 / 活跃写入 → ABORT / off-host 不可用 → ABORT / routines 不可用 → ABORT |
| **AUTHORITATIVE_SNAPSHOT + migration** | NO | 上项全部 + 独立 WP4-E 授权 | AUTHORITATIVE_SNAPSHOT PASS + WP4-D 快照 PASS + 用户书面授权进入 WP4-E | 对账 FAIL → NO CUTOVER / 回滚按 WP4-G |
| **AUTHORITATIVE_SNAPSHOT + cutover** | NO | 上项全部 + 独立 P9 WP6 授权 | 对账 Gate PASS（10 维 + SC 全清）+ CG-01…12 + 授权人书面确认 | Cutover 不在 WP4 内 |

---

## 8. FINAL GATE（P9 WP4-B Authorization Gate）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `d90cc71` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（WP4-B Readiness / WP4 Definition / WP4-A 全读） |
| Execution modes defined | **YES**（§3：Mode A SAFETY_COPY_ONLY / Mode B AUTHORITATIVE_SNAPSHOT） |
| G-1 decision options defined | **YES**（§4：A 默认 / B 备选 / C 禁止） |
| G-2 decision options defined | **YES**（§5：A/C 要求 / B 仅 SAFETY 允许） |
| G-4 maintenance decision defined | **YES**（§6：无窗→SAFETY ONLY；有窗+冻结→AUTHORITATIVE 可能） |
| Authorization matrix complete | **YES**（§7：5 项 + 前置 + 禁止后续） |
| Ready for SAFETY_COPY_ONLY | **YES**（无维护窗即可；须用户书面授权执行轮 + G-1 closure + 标记风险） |
| Ready for AUTHORITATIVE_SNAPSHOT | **NO**（须 G-4 B 维护窗 + 冻结 + G-1 closure + G-2 A/C 关闭，均待授权） |
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

### **P9 WP4-B Authorization Gate = PASS**

### **Recommended next execution mode = SAFETY_COPY_ONLY（local only）**
> 理由：当前无维护窗授权（G-4 A）+ NAS down（G-2 B）+ 活跃漂移 → 仅 SAFETY_COPY_ONLY 可立即排期；AUTHORITATIVE_SNAPSHOT 须前置全部关闭。

### **Ready for Backup Execution = YES（CONDITIONAL）**
> 条件：① 用户书面授权进入 WP4-B 执行轮；② 选择模式（推荐 SAFETY_COPY_ONLY local only）；③ G-1 closure（默认 A：DBA 单独捕获 routines）；④ 若选 AUTHORITATIVE_SNAPSHOT，须先关闭 G-4（维护窗+冻结）+ G-2（A/C）。

---

## 9. 纪律声明（P9 WP4-B Authorization Gate）

| 项 | 状态 |
|---|---|
| 执行 mysqldump / 实际备份生产库 | ❌ **无**（仅定义模式与决策） |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 挂载 NAS / 拷贝文件 | ❌ 无（仅定义 G-2 决策） |
| 修改 MySQL 用户或权限 / 提权 jhzy_mig_ro | ❌ **无**（G-1 选项 C 永久排除） |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git 提交 | ❌ 无（待用户授权后提交） |

**STOP — 未执行备份，未进入 WP4-C。** 等待下一步显式授权（WP4-B 执行轮 / Git Closeout / 其它）。

---

## 引用

- Readiness Gate：`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（G-1/G-2/G-3/G-4 / AB-01…AB-09 / Tier A·B 模板）。
- 备份计划：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §5。
- G-10 关闭：`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`。
- Preflight：`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 漂移 / D1 86 表）。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
