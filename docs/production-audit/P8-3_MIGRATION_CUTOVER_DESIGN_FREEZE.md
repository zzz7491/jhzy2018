# P8-3 — Migration & Cutover Design Freeze（迁移与切换实施设计冻结）

> **阶段**：P8-3 Migration & Cutover Design（迁移与切换实施设计冻结）
> **冻结日期**：2026-09-18
> **性质**：本文件是 Phase 8 第三子阶段（P8-3）的**唯一正式定义冻结**。它承接 P8-2（统一架构设计 + 各 Freeze + P8-2H 收口），定义"1.0 → 2.0 迁移与切换"的**设计、脚本与测试库验证**阶段，不直接执行生产切换。
> **层级**：本文件为 **L3（实现层定义冻结）**，上位 **L0 = `PROJECT_CONSTITUTION.md`**，上上位 **L1 = 三 Freeze（`ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md`）**，设计层 **L2 = ADR-001 / `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md`**；本文件与 `D1-*` / `D1-RBAC-DESIGN.md` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` 及其它现行设计文档同属 **L3**。

---

## Authority（权威层级）

| 层级 | 文档 | 角色 |
|---|---|---|
| **L0** | `PROJECT_CONSTITUTION.md` | 唯一顶层宪法，最终解释权 |
| **L1** | `ARCHITECTURE_FREEZE.md`（架构冻结）、`BUSINESS_BOUNDARY.md`（业务边界冻结）、`DATA_GOVERNANCE_FREEZE.md`（数据治理冻结） | 冻结层，最高执行约束 |
| **L2** | `ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）、`P5_FINAL_FREEZE.md`（契约冻结）、`ARCHITECTURE_TARGET.md`（目标架构） | 设计层，落点 |
| **L3** | `D1-*`、`D1-RBAC-DESIGN.md`、`PERMISSION-CATALOG`、`ROLE-PERMISSION-MATRIX` 及其它现行设计文档 | 实现层设计细节 |
| **L3** | **本文件 `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md`** | 实现层：迁移与切换实施设计冻结 |

- **引用方向**：本文件（L3）必须引用 L0 / L1 / L2；下层不得覆盖上层（Constitution §4）。
- **禁止改变既有 Authority Chain**：本文件仅作为 L3 新增节点接入既有 L0→L1→L2 链，不修改任何上层层级定义。

---

## 1. Name（正式名称）

**P8-3 — Migration & Cutover Design Freeze（迁移与切换实施设计冻结）**

## 2. Purpose（目的）

基于已冻结的架构 / 业务 / 数据治理，将 1.0（`api_jhzyfw_com` 等 MySQL 实例）事实数据**安全、可审计、可回滚**地并入 2.0 唯一权威库（D1 / Workers，ADR-001）；产出经测试库验证的迁移脚本、数据对账方案、回滚预案与切换 Runbook，为后续生产切换提供可执行产物。

## 3. Scope（范围）

- 1.0 → 2.0 表映射设计（含 `legacy_id_maps` / `migration_issues` 迁移支撑表设计，`DATA_GOVERNANCE_FREEZE.md` O-7）。
- 逐业务域迁移脚本（遵循 F-DB-* 去重，单库单表，禁止 `_old_*` / `_backup_*` / `_temp` / `_deprecated` 残留，F-DB-8~F-DB-13）。
- 数据对账与一致性校验脚本（数量 / 积分 / 时长）。
- 回滚预案文档 + 切换 Runbook（Cutover Runbook）。
- **在测试库**执行迁移演练、对账验证、回滚演练（dry-run）。

## 4. Out of Scope（范围外）

- **生产环境正式迁移、正式部署、域名 / 小程序版本正式切换、灰度放量**：均不在 P8-3 范围内。
- 修改任何 Freeze / Constitution / 设计层文档。
- 新增业务域 / 新增架构组件 / 新增数据治理规则。
- 改变 Core Domain 语义或业务闭环。

> 统一描述：生产环境正式迁移 / 正式部署 / 域名或小程序切换 / 灰度放量，属于**后续尚未正式定义的生产切换阶段**，**必须另行通过 Definition Gate 后才能执行**。本文件**禁止自行创建该阶段编号**（如 P8-4），其定义权归用户 / 架构负责人，须走 Definition Gate。

## 5. Preconditions（前置条件）

P8-3 启动须同时满足：

- **P8-1 = PASS**（1.0 资产台账完成，`SYSTEM_MASTER_INVENTORY.md` 及其配套 Inventory 文档）。
- **P8-2H = PASS**（冻结体系闭合，26 份 GOVERNED 文档全部可回溯唯一 L0）。
- **当前 Authority Chain 已闭合**（L0→L1→L2 引用链完整，无悬空、无冲突登记未裁定阻断）。
- **用户明确授权启动 P8-3**（显式授权，非默认进入）。

> 路线图（`嘉禾志愿V2.0开发实施路线图V1.0.md` §Phase 8）中的"管理员批准切换"仅作为**未来生产切换 Gate**，不作为 P8-3 前置条件。

## 6. Authority / Inputs（权威与输入）

- **L0**：`PROJECT_CONSTITUTION.md`（唯一顶层，最终解释权）。
- **L1**：`ARCHITECTURE_FREEZE.md`、`BUSINESS_BOUNDARY.md`、`DATA_GOVERNANCE_FREEZE.md`。
- **L2**：`ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）、`P5_FINAL_FREEZE.md`、`ARCHITECTURE_TARGET.md`。
- **L3**：`D1-*`、`D1-RBAC-DESIGN.md`、`PERMISSION-CATALOG`、`ROLE-PERMISSION-MATRIX` 及其它现行设计文档；本文件 `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md` 同属 L3（实现层定义冻结）。
- **P8-1 输入**：`DATABASE_INVENTORY.md`、`SITE_INVENTORY.md`、`CRON_INVENTORY.md`、`WECHAT_INVENTORY.md`、`SYSTEM_MASTER_INVENTORY.md` 及 Phase 0.4.1 / 0.4.2 迁移前置核查报告（状态枚举字典、证书域核查）。
- 引用方向：P8-3 产物**必须引用**上述层级，不得覆盖上层（Constitution §4）。

## 7. Work Packages（工作包）

- **WP1** 迁移设计总案（映射策略 / 批次 / 顺序 / 依赖 / 状态值语义字典）。
- **WP2** 表映射与 `legacy_id_maps` / `migration_issues` 设计（迁移支撑表，不得演化为业务表）。
- **WP3** 逐域迁移脚本（migration 文件，遵循 migration-only 纪律，不手工改表）。
- **WP4** 数据对账与一致性校验脚本（数量 / 积分 / 时长）。
- **WP5** 回滚预案 + 切换 Runbook（Cutover Runbook）。
- **WP6** 测试库迁移演练 + 对账验证 + 回滚演练（dry-run，产出证据报告）。

## 8. Deliverables（交付物）

- 迁移设计文档（WP1 / WP2）。
- 迁移脚本集（WP3，migration 文件）。
- 对账脚本与校验报告（WP4）。
- 回滚预案 + 切换 Runbook（WP5）。
- **测试库演练报告**（对账通过证据，WP6）—— 作为 P8-3 PASS 的核心证据。

## 9. PASS Criteria（Gate / 通过条件）

- 测试库迁移**对账通过**（数量 / 积分 / 时长一致，无丢失）。
- 回滚预案在测试库**验证可行**。
- 所有脚本**不违反 F-***（单一 DB / 单一 API / 无第二组件，`ARCHITECTURE_FREEZE.md` F-DB-1 / F-API-1）。
- 未引入任何新业务域 / 新架构组件 / 新数据治理规则。
- 用户确认交付物完整。
- 路线图中的"管理员批准切换"**仅约束未来生产切换阶段**，不在此 Gate 内。

## 10. STOP Conditions（停止条件）

- 任何需求需**修改 Core Domain / 新增业务 / 修改 Freeze / 引入第二套组件** → **STOP**，转 Architecture Change（`ARCHITECTURE_FREEZE.md` §5）或 BCR（`BUSINESS_BOUNDARY.md` §8），不得自行裁定。
- 对账不一致且无法在不改 Freeze 前提下解决 → STOP，登记 UNKNOWN，走 Change 流程（Constitution §7）。
- 触发生产切换动作（生产部署 / 域名切换 / 灰度放量）→ STOP，超出 P8-3 Scope（见 §4）。

## 11. Modification Permissions（修改权限）

**P8-3 允许：**
- 创建 / 修改 P8-3 交付文档（迁移设计 / Runbook / 报告）。
- 编写迁移脚本、对账脚本、迁移工具。
- 创建 migration 文件。
- 在测试库执行迁移、数据对账、回滚演练。
- Git selective staging / commit / push（仅 P8-3 交付物）。

**P8-3 禁止：**
- 修改 `PROJECT_CONSTITUTION.md`。
- 修改任何 Freeze（`ARCHITECTURE_FREEZE` / `BUSINESS_BOUNDARY` / `DATA_GOVERNANCE_FREEZE` / `P5_FINAL_FREEZE`）。
- 修改 Core Domain。
- 新增业务域。
- 新增架构组件。
- 新增数据治理规则。
- 修改业务应用逻辑以迁就迁移。
- 修改生产 schema。
- 正式写入 / 迁移生产数据。
- 生产部署。
- 正式切换。
- 灰度放量。

## 12. Git Policy（Git 策略）

- 允许 `git add <具体路径>` selective staging 提交 P8-3 交付物（脚本 / 文档 / 报告）。
- **禁止 `git add .` / `git add -A`**，保护历史 WIP。
- 允许 commit / push（仅 P8-3 交付物分支 / 变更）。
- 不得借 P8-3 提交混入对 Freeze / Constitution / 业务代码的无关改动。

## 13. Production Boundary（生产边界）

- **生产 schema**：只读；禁止直接改生产 schema（F-DB-8 禁止无版本化手工改表，仅经 migration 文件且先在测试库验证）。
- **生产数据**：禁止正式写入 / 迁移生产数据；生产库仅作只读对账基准。
- **生产部署 / 正式切换 / 灰度放量**：OUT OF SCOPE（§4），触发即 STOP（§10）。
- 任何迁移实现与现有 Freeze 冲突 → **STOP → Architecture Change / BCR**，禁止直接修改实现规则绕过 Freeze。

---

## 纪律声明（P8-3）

| 项 | 状态 |
|---|---|
| 修改 PROJECT_CONSTITUTION | ❌ 无 |
| 修改任何 Freeze | ❌ 无 |
| 修改 Core Domain | ❌ 无 |
| 新增业务域 / 架构组件 / 数据治理规则 | ❌ 无 |
| 修改生产 schema | ❌ 无 |
| 正式写入 / 迁移生产数据 | ❌ 无 |
| 生产部署 / 正式切换 / 灰度放量 | ❌ 无（OUT OF SCOPE） |
| 创建未定义未来阶段编号（如 P8-4） | ❌ 无（禁止自行创建） |
| 进入尚未定义的生产切换阶段 | ❌ 无（须另行 Definition Gate） |

> **本阶段完成条件**：WP1~WP6 交付物齐备、测试库对账通过、回滚演练可行、用户确认。完成后 STOP，未进入生产切换阶段。

---

## 引用与依据

- 单一 DB / 单一 API 冻结：`ARCHITECTURE_FREEZE.md` §2.1、F-DB-1 / F-API-1。
- 迁移设计属 P8-3 范畴（1.0 遗留表逐表归属）：`DATA_GOVERNANCE_FREEZE.md` §3.2。
- `api_jhzyfw_com` 作为 MySQL 实例淘汰、数据按 P8-2 §3.2 迁移、淘汰 ≠ 立即删除：`DATA_GOVERNANCE_FREEZE.md` §3.2 / §5。
- 迁移支撑表 `legacy_id_maps` / `migration_issues` = 系统管理域、DEFER、不得演化为业务表：`DATA_GOVERNANCE_FREEZE.md` O-7。
- 20 业务域冻结、每域唯一、新增中心提 BCR：`BUSINESS_BOUNDARY.md` §2 / §5.3 / §8。
- Phase 8 总目标（数据迁移 + 灰度上线 + 回滚预案）：`嘉禾志愿V2.0开发实施路线图V1.0.md` §Phase 8。
- P8-1 资产台账：`SYSTEM_MASTER_INVENTORY.md` 及配套 Inventory。
- P8-2H 冻结体系闭合：本会话 P8-2H 结论（L0 链）。
- 设计层：ADR-001 / `ARCHITECTURE_TARGET.md` / `D1-*` / `P5_FINAL_FREEZE.md`。
