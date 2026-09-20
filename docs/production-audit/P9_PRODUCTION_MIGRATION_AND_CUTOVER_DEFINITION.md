# P9 — Production Migration & Cutover Definition Gate（生产迁移与正式切换·定义门）

> **阶段**：P9 Production Migration & Cutover Definition Gate（生产迁移与切换·定义门）
> **定义日期**：2026-09-19
> **性质**：本文件是 **P8-3 之后的独立新阶段 Definition Gate**。它**只定义**生产迁移与正式切换的范围、工作包、安全门、切换契约、回滚决策矩阵与证据要求；**不执行、不实现、不部署**。
> **层级**：本文件为 **L3（实现层定义）**，承接既有权威链：
> - **L0** `PROJECT_CONSTITUTION.md`（唯一顶层宪法）
> - **L1** `ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md`
> - **L2** `ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md`
> - **L3** `D1-*` / `D1-RBAC-DESIGN.md` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / P8-3 文档体系 / **本文件**
> - 引用方向：本文件（L3）必须引用 L0/L1/L2；**不得覆盖上层**（Constitution §4）。
> - **禁止改变既有 Authority Chain**：本文件仅作为 L3 新增节点接入既有链，不修改任何上层层级定义。

---

## 0. 前置状态（Prerequisites — 全部确认）

| # | 前置项 | 状态 | 证据 |
|---|---|---|---|
| 1 | P8-3 = COMPLETE / FINAL PASS | ✅ | `P8-3_CLOSEOUT.md`（WP1–WP6 FINAL PASS、81 tests 全绿、Freeze Conflict=0） |
| 2 | commit `811155c` 已存在于 `origin/master` | ✅ | `git log -1` / `git ls-remote origin master` = `811155cf954a6b962489b8426afd800b20a45226` |
| 3 | P8-3 scope working tree = clean | ✅ | `git status` 中无 `P8-3_*` / `p8-3-migration/` 未提交项 |
| 4 | Migration / Reconciliation / Rollback / Rehearsal 工具链已验证 | ✅ | `p8-3-migration/`（81 tests） |
| 5 | Production data touched = NO（P8-3 全程） | ✅ | `P8-3_CLOSEOUT.md §6` |

> **P9 与 P8-3 的边界**：P8-3 已完成「设计 + 测试库演练 + 回滚框架」，但**明确不含生产迁移/部署/切换/灰度**（P8-3 Definition Freeze §4）。P9 是 P8-3 Definition Freeze §4 所指的「新的独立 Definition Gate + 用户显式授权」阶段。**P9 的 WP1–WP9 与 P8-3 的 WP1–WP6 编号相互独立、不重叠、不覆盖**（P8-3 的 WP 是设计/演练，P9 的 WP 是生产实施）。

---

## 1. REPO IDENTITY GATE

> 执行 `git` 只读检查（master / `811155c`），未处理 Scope 外文件。

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `811155cf954a6b962489b8426afd800b20a45226`（`811155c`） |
| staged | 0（起始） |
| P8-3 commit 存在 | ✅（本地 `commit` 对象 + `origin/master` tip 一致） |
| 其它并行改动 | 289 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），**不在 P9 范围，未处理** |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 角色 / 用途 |
|---|---|
| `PROJECT_CONSTITUTION.md` | L0 顶层宪法（十大铁律①单一数据库、权威层级、变更治理） |
| `ARCHITECTURE_FREEZE.md` | L1 架构冻结（§6 最终生产结构 + 拓扑；F-DB-1 单一业务库；F-GOV-4 禁止 1.0/2.0 共享运行时；E-1~E-4 例外类别） |
| `BUSINESS_BOUNDARY.md` | L1 业务边界冻结（20 业务域唯一；§8 BCR 流程；Non Goals） |
| `DATA_GOVERNANCE_FREEZE.md` | L1 数据治理冻结（§2 SSoT；C-1~C-5 五原则；O-7 迁移支撑表 DEFER 不演化业务表） |
| `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md` | P8-3 定义冻结（Scope / WP / 生产边界） |
| `P8-3_CLOSEOUT.md` | P8-3 收口（Objective / Gate / 覆盖 / 边界 / user_favorites BCR） |
| `P8-3_WP1…WP6_*.md` | 迁移设计总案 / 映射 / 实现 / 对账 / 回滚 Runbook / 演练报告 |
| `ARCHITECTURE_TARGET.md` | L2 目标架构（§3 数据保留/淘汰；§5 1.0 Legacy 只读隔离、2.0 不并入运行） |
| `ADR-DATABASE-MYSQL-TO-D1.md` | L2 ADR-001（MySQL→D1 决策） |
| `SYSTEM_TOPOLOGY.md` / `SITE_INVENTORY.md` / `DATABASE_INVENTORY.md` | P8-1 资产台账（1.0 现状事实） |

**引用声明**：本文件所有架构/业务/数据判定均引用上述基线，不新增原则、不重述定义。

---

## 3. 固定生产目标拓扑（Frozen Topology）

P9 严格沿用 P8-3 WP5 §2 与 ARCHITECTURE_FREEZE §6 已冻结拓扑，**不得修改**：

```
大陆用户 / 微信小程序 / 管理端
  → 国内备案域名
  → 腾讯云国内服务器（国内入口 / Gateway / Reverse Proxy）
  → Cloudflare Worker
  → Cloudflare D1（2.0 唯一权威业务数据库）
  → R2 / KV 等 Cloudflare 服务
```

### 拓扑硬规则（不可变更）

| # | 规则 | 依据 |
|---|---|---|
| T-1 | 腾讯云服务器承担**中国大陆对外服务入口**（网关/反代），**不是** V2 authoritative business database | ARCHITECTURE_FREEZE §2.1 / §6.2；P8-3 WP5 §2 |
| T-2 | 腾讯云 MySQL **不得作为 2.0 长期权威库**（非 authoritative DB） | ARCHITECTURE_FREEZE A-DB-1（单一库=D1）；P8-3 WP5 §2.C.3 |
| T-3 | Cloudflare D1 = V2 **唯一**权威业务数据库 | ADR-001；ARCHITECTURE_FREEZE A-DB-1 |
| T-4 | 1.0 在正式 Cutover 前继续保持可运行（read/write） | ARCHITECTURE_TARGET §5（1.0 Legacy 只读隔离；P8-3 WP5 §2.C.2） |
| T-5 | **不允许长期双权威数据库**（1.0 与 2.0 不得同时作为 authoritative writer） | Constitution 原则①（单一数据库）；F-GOV-4（禁止 1.0/2.0 共享运行时）；见 §7 |
| T-6 | 客户端不得绕过腾讯云国内入口直接改生产访问拓扑 | P8-3 WP5 §2（约束 4） |

---

## 4. P9 Scope（定义）

P9 **仅设计生产迁移与正式切换阶段**。定义下列工作包，但**不得立即实施**：

| WP | 名称 | 定义态交付物（本轮只设计） |
|---|---|---|
| **WP1** | Production Readiness Audit | 生产就绪审计（凭据复核 / 最小权限 / 备份 / 快照 / 版本钉死 / 维护窗口 / 沟通计划 / 授权矩阵） |
| **WP2** | Production Source Snapshot & Backup Plan | 源库快照 + hash + 备份计划 + 可恢复性验证方案 |
| **WP3** | Production Migration Preflight | 生产迁移 Preflight（复用 P8-3 WP5 PF-01…PF-10 + SC-01…SC-15，扩展生产维度） |
| **WP4** | Production Migration Execution | 生产迁移执行计划（批次 B0–B20 沿用、增量迁移策略、run_id 贯穿） |
| **WP5** | Production Reconciliation Gate | 生产对账 Gate（复用 P8-3 WP4 10 维 + SC-01…SC-15 全清） |
| **WP6** | Application Cutover / Routing Switch | 应用切换 / 路由切换计划（国内入口指向 Worker→D1；灰度/全量窗口） |
| **WP7** | Post-Cutover Verification & Observation | 切换后验证与观察（核心链路冒烟 / 监控 / 告警 / 观察期） |
| **WP8** | Rollback / Abort Execution if Required | 回滚 / 中止执行（复用 P8-3 WP5 CLASS_3 设计 + 决策矩阵 §9） |
| **WP9** | Production Closeout | 生产收口（证据归档 / 1.0 退役/保留裁定 / 复盘） |

> **命名纪律**：若现有冻结文档规定其它命名/编号，以现有正式架构为准。本文件 WP1–WP9 为 P9 阶段内部编号，不与 P8-3 的 WP1–WP6 冲突（两者阶段不同）。

---

## 5. Definition 边界（IN / OUT OF SCOPE）

### IN SCOPE（生产迁移与切换设计）

- 生产迁移准备（readiness / 快照 / 备份 / 凭据）
- source snapshot & hash
- backup & restore path
- production migration（执行计划，**非本轮执行**）
- reconciliation gate
- cutover / routing switch（计划）
- rollback / abort
- routing switch
- production verification & observation
- production closeout

### OUT OF SCOPE（冲突即 STOP → Architecture Change / BCR）

- 新业务功能 / UI 重构 / Core Domain 修改
- Schema redesign（迁移 schema 已冻结于 D1-*，仅经 wrangler d1 migrations，不重新设计）
- 新业务域 / 新架构组件
- user_favorites BCR 解决（保持 EXCLUDED / BCR pending，见 §10）
- 1.0 功能修改
- 非迁移相关基础设施改造（如新增第二套缓存/队列等，属 Architecture Change）
- 任何上述冲突 → **STOP**，转 `ARCHITECTURE_FREEZE.md §5` 或 `BUSINESS_BOUNDARY.md §8`，**不得自行裁定**。

---

## 6. Production Safety Gates（生产安全门）

### 6.1 Before Migration（迁移前必须全部满足）

| ID | 要求 | 证据 |
|---|---|---|
| MG-01 | P8-3 = COMPLETE（WP1–WP6 FINAL PASS + 81 tests） | `P8-3_CLOSEOUT.md` |
| MG-02 | production credentials reviewed（凭据已复核、最小权限） | 凭据清单（不入 Git / 不入文档明文） |
| MG-03 | production access least privilege（D1 token 最小权限、只读源库账号） | IAM / token 策略记录 |
| MG-04 | source database backup verified（源库备份已验证可恢复） | 备份恢复演练记录 |
| MG-05 | source snapshot hash（源快照 + hash 可验证） | snapshot hash |
| MG-06 | D1 backup / restore path（目标 D1 备份/恢复路径就绪） | 恢复路径文档 |
| MG-07 | Worker version pinned（Worker 版本钉死） | version 字符串 |
| MG-08 | migration code SHA pinned（迁移代码 SHA 钉死） | git SHA |
| MG-09 | reconciliation code SHA pinned（对账代码 SHA 钉死） | git SHA |
| MG-10 | rollback code SHA pinned（回滚代码 SHA 钉死） | git SHA |
| MG-11 | operator identity（操作人身份明确） | 操作人记录 |
| MG-12 | maintenance window（维护窗口已规划） | 窗口时间 |
| MG-13 | communication plan（沟通计划） | 通知/公告计划 |
| MG-14 | abort authority（中止授权人） | 授权人 |
| MG-15 | rollback authority（回滚授权人） | 授权人 |

### 6.2 Before Cutover（切换前必须全部 PASS，否则 NO CUTOVER）

| ID | 要求 |
|---|---|
| CG-01 | migration completed（迁移完成） |
| CG-02 | reconciliation PASS（对账 10 维全 PASS） |
| CG-03 | row conservation PASS |
| CG-04 | identity PASS |
| CG-05 | relationship PASS |
| CG-06 | points/growth PASS |
| CG-07 | training/result PASS |
| CG-08 | media PASS |
| CG-09 | audit PASS |
| CG-10 | user_favorites remains EXCLUDED（仍为 EXCLUDED / BCR pending） |
| CG-11 | no CRITICAL issue（无 CRITICAL 级 migration issue） |
| CG-12 | SC-01…SC-15 all clear（P8-3 WP5 §D 全部未命中） |

> **任何一项失败 → NO CUTOVER。** 切换决策必须经授权人书面确认。

---

## 7. 1.0 / 2.0 Cutover Contract（切换契约）

### 7.1 1.0 何时保持 read/write

- 在 **Migration Snapshot 之前**与 **最终增量迁移对账 PASS 之前**，1.0 保持正常 read/write（T-4）。
- 仅在 **冻结写入窗口（§7.3）** 内，1.0 置维护态停止新写入；窗口解除条件见 §7.5。

### 7.2 Migration Snapshot 时如何防止数据漂移

- 在**停止 1.0 写入的同时**取源库一致性快照（snapshot + hash，MG-05）；
- 快照点之后 1.0 不再接受写，避免快照后与迁移执行间的数据漂移；
- 若无法在单点原子停写，则需 **maintenance/read-only window（§7.3）** 保证快照一致性。

### 7.3 是否需要 maintenance / read-only window

- **需要**：正式切换前的「最终增量迁移」必须在一个明确的 **维护/只读窗口** 内进行，期间 1.0 入口返回维护页（P8-3 WP5 §2.C.2），确保源静止。
- 窗口长度由数据量与增量迁移耗时决定，纳入 MG-12。

### 7.4 增量数据如何处理

- 冻结写入前已写入 1.0 的数据：通过初始全量迁移进入 D1；
- 冻结写入窗口内若有已接受但在途的请求：由应用层在窗口开启前完成或拒绝，窗口内不接受新写；
- 窗口结束后：不再有增量（源已静止），无需持续增量管道；
- 若因运营要求**必须**在源静止后仍处理写入，则视为 **dual-write 诉求（§7.7）**，须单独 Architecture Change 审批。

### 7.5 最终一致性窗口

- 「源静止 → 最终增量迁移 → 对账 PASS → 权威切换」之间存在**有限的最终一致性窗口**；
- 该窗口内 D1 尚未对外权威，客户端仍由 1.0 服务（维护页或只读）；
- 权威切换（§8）完成后，D1 成为唯一权威，一致性窗口关闭。

### 7.6 Cutover 原子边界

- 原子边界 = **Worker 指向 D1 为唯一权威源**这一配置动作（P8-3 WP5 §2.C.4）；
- 切换动作应可一键回退（路由/入口回指 1.0），不得形成不可逆现场调试；
- 切换前 D1 不作为对外权威；切换后 1.0 不再作为 authoritative writer（T-5）。

### 7.7 如何避免 1.0 与 2.0 同时成为 authoritative writer

- **默认禁止 dual-write**（双写一段时间不得作为默认方案）；
- 权威切换边界（§7.6）保证任意时刻只有一个 authoritative writer：切换前=1.0，切换后=2.0（D1）；
- 若确需 dual-write（如灰度期双写），**必须视为 Architecture Change**，走 `ARCHITECTURE_FREEZE.md §5` 六步流程 + 用户显式批准，并登记失效条件与收敛计划（§5 例外 E-4 灰度亦须收敛为唯一入口）；
- 回滚后（§8）：客户端回到 1.0，D1 不作为对外权威，避免双写。

### 7.8 rollback 后客户端应回到哪里

- 回滚后客户端**回到 1.0**（腾讯云入口回指 1.0），D1 未确认前不作为对外权威源（P8-3 WP5 §E.3）；
- 1.0 在回滚态下仍保持可运行 read/write；
- 腾讯云 MySQL 回滚态下仍**不得**被当作 2.0 authoritative DB（T-2）。

---

## 8. 国内入口 Cutover（未来正式切换时验证，本轮只设计）

定义未来正式切换时需验证的项（**本 Definition 阶段不得真正修改任何生产路由**）：

| 验证项 | 要求 |
|---|---|
| DNS / proxy / upstream | 国内备案域名 → 腾讯云 Gateway → Cloudflare Worker 链路可达 |
| TLS | 证书有效、SNI 正确、HSTS 合规 |
| Host headers | Worker 收到正确 Host；1.0/2.0 区分无误 |
| client IP forwarding | 真实客户端 IP 经腾讯云入口正确透传（X-Forwarded-For / CF-Connecting-IP） |
| timeout | 入口→Worker→D1 全链路超时与重试预算合理 |
| retry behavior | 失败重试幂等、不放大写 |
| health check | Worker `/health` 与 `/api/v2/health` 探针正常 |
| fallback route | Worker 异常时回退到维护页/只读，不暴露 5xx |
| rollback route | 入口可一键回指 1.0（§7.8） |

> **纪律**：本轮**只验证设计**，不改动 DNS、不改动 Gateway、不改动 Worker 路由、不触发真实切换。

---

## 9. Rollback Decision Matrix（回滚决策矩阵）

每类明确：Trigger / Decision Owner / Rollback Scope / Recovery Target / Max Acceptable Data Loss / Verification / Evidence。

| # | 类别 | Trigger | Decision Owner | Rollback Scope | Recovery Target | Max Acceptable Data Loss | Verification | Evidence |
|---|---|---|---|---|---|---|---|---|
| RB-1 | pre-migration abort | Preflight（MG-01…MG-15）任一 FAIL | 中止授权人 | 不开始迁移 | 源库原状 | 0（未动） | Preflight re-run | Operator Evidence（preflight） |
| RB-2 | migration abort | 批次 reconcile FAIL / 命中 SC-01…SC-14 | 回滚授权人 | CLASS_1 单批回滚（P8-3 WP5 E.1） | 该批目标行清除、源未动 | 0（按 legacy_id_maps 批次定位） | verifyRecovery 批次级 | rollback issue + recovery JSON |
| RB-3 | reconciliation failure | 对账 10 维 FAIL 且无法定位 | 回滚授权人 | CLASS_2 完整测试/生产回滚（E.2/E.3） | 切换前生产状态（D1 未权威） | 0（源静止） | verifyRecovery 全量 | rollback issue + recovery JSON |
| RB-4 | application smoke failure | 切换后核心链路冒烟 FAIL（登录/报名/签到/积分/证书） | 回滚授权人 | 路由回指 1.0（§7.8） | 1.0 可运行态 | 0（D1 未权威） | 冒烟复测 + 入口回退验证 | routing state + evidence |
| RB-5 | routing failure | 国内入口→Worker→D1 链路异常 | 回滚授权人 | rollback route（§8） | 1.0 服务 | 0 | DNS/Gateway 回退验证 | routing state |
| RB-6 | severe data mismatch | 行守恒/身份/关系/积分 严重偏差 | 回滚授权人 | CLASS_3 生产回滚（E.3） | 切换前生产状态 | 0（源静止+快照） | verifyRecovery + 源对账 | recovery JSON + source snapshot |
| RB-7 | Worker failure | Worker 不可服务 | 回滚授权人 | fallback route / 回指 1.0 | 1.0 服务 | 0 | health check + 回退验证 | routing state |
| RB-8 | D1 failure | D1 不可用/数据损坏 | 回滚授权人 | 回指 1.0 + D1 时间点恢复（restore point） | 1.0 服务 + D1 恢复点 | ≤ 快照点之后增量（源静止故≈0） | verifyRecovery + 源对账 | recovery JSON + source snapshot |
| RB-9 | unexpected production regression | 切换后非预期回归（性能/安全/业务） | 中止授权人 | 路由回指 1.0 | 1.0 可运行态 | 0 | 监控/告警复测 | routing state + evidence |

> **通用原则**：达到 rollback trigger 即回滚，**不在生产现场调试**；`legacy_id_maps` / `migration_issues` 全量保留作审计证据（P8-3 WP5 E.3）；回滚后必须执行 Recovery Verification 并留存 Operator Evidence Record。

---

## 10. Production Evidence Requirements（生产证据要求）

未来每个正式生产步骤必须留（**禁止只用聊天记录作为生产证据**）：

| 字段 | 说明 |
|---|---|
| timestamp | 操作时间（UTC+8） |
| operator | 操作人身份 |
| git SHA | 迁移/对账/回滚代码 SHA（MG-08/09/10） |
| Worker version | Worker 版本（MG-07） |
| migration run_id | 本次迁移执行 run_id（贯穿 issues/reconcile/rollback/evidence，P8-3 DEFECT-WP6-01） |
| source snapshot ID/hash | 源快照标识 + hash（MG-05） |
| backup ID | 备份标识（MG-04/06） |
| migration stats | 迁移统计（inserted/dropped/excluded/archived） |
| reconciliation JSON | 对账 10 维结果（CG-02…CG-09） |
| STOP condition result | SC-01…SC-15 判定结果（CG-12） |
| routing state | 切换后路由状态（§8） |
| rollback evidence | 回滚记录（若触发） |
| final production verification | 最终生产验证结论（WP7） |

> 证据结构沿用 P8-3 WP5 `operator-evidence.json`（schema `p8-3-operator-evidence/v1`），扩展生产字段。

---

## 11. Definition 文档范围

- 本轮**仅创建/修改**本 Definition 文档；
- **不得创建生产执行脚本**（迁移/对账/回滚执行复用 P8-3 `p8-3-migration/` 工具链，不在 P9 Definition 阶段新增）；
- 不得修改 Freeze / Constitution / Core Domain / 业务代码 / 生产 schema；
- 不得连接或写生产 D1、不得迁移生产数据、不得部署、不得 DNS/路由切换、不得灰度、不得正式 Cutover、不得处理 user_favorites BCR。

---

## 纪律声明（P9 Definition Gate）

| 项 | 状态 |
|---|---|
| 修改 PROJECT_CONSTITUTION | ❌ 无 |
| 修改任何 Freeze | ❌ 无 |
| 修改 Core Domain | ❌ 无 |
| 新增业务域 / 架构组件 / 数据治理规则 | ❌ 无 |
| 修改生产 schema | ❌ 无 |
| 连接/写入生产 D1 | ❌ 无 |
| 迁移生产数据 | ❌ 无 |
| 部署 / DNS/路由切换 / 灰度 / 正式 Cutover | ❌ 无（OUT OF SCOPE） |
| 处理 user_favorites BCR | ❌ 无（保持 EXCLUDED / BCR pending） |
| 创建生产执行脚本 | ❌ 无（仅 Definition） |
| Git 操作 | ❌ 无（本轮仅 Definition 文档，待授权后提交） |

> **本 Definition Gate 完成条件**：§1–§10 全部定义完成、FINAL GATE = PASS。完成后 STOP，未进入 P9 WP1，除非用户显式授权。

---

## FINAL GATE（P9 Definition Gate）

| Gate 项 | 结果 |
|---|---|
| P8-3 prerequisite confirmed | **YES** |
| Production topology confirmed | **YES**（沿用 ARCHITECTURE_FREEZE §6 / P8-3 WP5 §2） |
| P9 scope defined | **YES**（WP1–WP9） |
| P9 work packages defined | **YES**（WP1–WP9 设计态交付物定义） |
| Production safety gates defined | **YES**（§6 Before Migration MG-01…15 / Before Cutover CG-01…12） |
| 1.0/2.0 cutover contract defined | **YES**（§7 八条契约） |
| Authoritative DB rule preserved | **YES**（D1 唯一权威；腾讯云 MySQL 非权威；T-2/T-3/T-5） |
| Dual-write prohibited by default | **YES**（§7.7 默认禁止；dual-write=Architecture Change） |
| Rollback decision matrix defined | **YES**（§9 RB-1…RB-9） |
| Production evidence requirements defined | **YES**（§10 13 字段） |
| user_favorites remains EXCLUDED / BCR pending | **YES** |
| Freeze Conflict Count | **0** |
| Production data touched | **NO** |
| Production deployment performed | **NO** |
| Routing changed | **NO** |

### P9 Definition Gate = **PASS**
### Ready for P9 WP1 = **YES**（前置：用户显式授权进入 P9 WP1）

---

## 引用与依据

- 单一 DB / 单一 API 冻结：`ARCHITECTURE_FREEZE.md` §2.1、F-DB-1 / F-API-1。
- 1.0 Legacy 只读隔离、不并入 2.0 运行：`ARCHITECTURE_FREEZE.md` OPS-10 / F-GOV-4；`ARCHITECTURE_TARGET.md` §5。
- 腾讯云 MySQL 非权威、D1 唯一权威：ADR-001；P8-3 WP5 §2。
- 迁移支撑表 DEFER、含 run_id、不演化业务表：`DATA_GOVERNANCE_FREEZE.md` O-7；P8-3 DEFECT-WP6-01。
- SC-01…SC-15 机器判定 STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md` §D。
- 测试库演练与回滚框架已验证：P8-3_WP6 / P8-3_CLOSEOUT（81 tests）。
- user_favorites EXCLUDED / BCR pending：P8-3_WP5 §A PF-08；P8-3_CLOSEOUT §7。
- 生产切换属独立 Definition Gate：P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md §4。
