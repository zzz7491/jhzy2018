# P9 WP4-C — Execution Readiness / Role & G-2 Closure Gate（执行就绪 / 角色与 G-2 关闭门）

> **阶段**：P9 WP4-C（Execution Readiness / Role & G-2 Closure Gate）
> **执行日期**：2026-09-20（CST）
> **性质**：**Readiness / Authorization Preparation only（仅定义角色、检查 G-2 当前状态、定义 G-2 关闭/waiver 方案、产出就绪矩阵；不执行维护窗、不冻结写入、不执行 no-write 验证、不执行 mysqldump、不实际备份生产库、不停止 1.0、不锁表、不修改 1.0 / nginx / DNS / route、不写 D1、不 import schema、不迁移、不 Cutover、不修改 MySQL 用户或权限、不 git commit（除非另行授权））**。
> **承接**：`P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md`（定义门 PASS / Recommended=A+B / Ready for Execution=NO / G-2=AUTHORITATIVE BLOCKER）、`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（G-1=A / G-2=B / G-4=A）、`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（AB-01…AB-09 / G-1…G-4）、`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`（SAFETY_COPY_ONLY PASS，非迁移输入）、`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6、`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`（G-10 CLOSED）。
> **纪律**：本轮仅产出就绪文档；所有执行动作须用户显式授权后，在 WP4-C **执行**阶段（非本就绪阶段）进行。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| 最新远端 commit | `5f82fc8`（`5f82fc822375ee6f83ae6b6ede5efd1d2869245c`，P9 WP4-C Definition Git Closeout，已 `origin/master`） |
| P9 WP4-C Definition Gate | FINAL PASS（commit `5f82fc8`，HEAD == origin/master） |
| Recommended freeze strategy | **A + B** |
| Ready for WP4-C Execution | **NO**（定义门结论） |
| AUTHORITATIVE_SNAPSHOT | **NOT ENTERED** |
| 当前仍 STOP | YES（未进入 WP4-C 执行 / 未进 WP4-D） |
| 本轮性质 | Readiness / Authorization Preparation（定义角色 + G-2 检查 + 关闭/waiver 方案 + 就绪矩阵） |
| 是否执行维护窗/冻结 | **NO** |

---

## 1. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `5f82fc822375ee6f83ae6b6ede5efd1d2869245c`（`5f82fc8`，P9 WP4-C Definition Git Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `5f82fc82…`） |
| staged | 0 |
| P9 scope clean | ✅（并行改动允许存在，不处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md` | WP4-C Execution 当前未授权；Recommended=A+B；Ready for Execution=NO；G-2 NAS down（AUTHORITATIVE BLOCKER）；G-1=A；SAFETY_COPY_ONLY 非迁移输入；§6 权威快照进入条件 9 项 |
| `P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md` | G-1=A（DBA/root 单独捕获 routines，禁提权 jhzy_mig_ro）；G-2=B（NAS down→SAFETY 允许 local-only，AUTHORITATIVE 须 A/C）；G-4=A（无维护窗→仅 SAFETY，AUTHORITATIVE 须维护窗+冻结）；授权矩阵 5 项 |
| `P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md` | binlog OFF / 双库实测 / AB-01…AB-09 / G-1 routines=1 / G-2 NAS down / G-3 混合 collation / G-4 维护窗控制 |
| `P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md` | SAFETY_COPY_ONLY PASS；`offhost_copy=SKIPPED`；非迁移输入；非 authoritative |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | §6 维护窗/冻结计划：开始条件（WP4-B PASS + MG-01…15 + 授权）/ 批准人（Cutover Approver，U-10）/ 通知（≥24h，U-09）/ 冻结方式（入口维护页 + 应用层停写）/ no-write 校验 SQL / 最大冻结 ≤2h（MG-12）/ 双写禁止 |
| `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` | G-10 CLOSED（jhzy_mig_ro 最小只读，仅 SELECT 两源库，验证 PASS） |

**基线确认**：WP4-C Execution 当前尚未授权；Recommended freeze strategy = A+B；Ready for WP4-C Execution = NO；G-2 NAS/off-host 是 AUTHORITATIVE_SNAPSHOT 进入阻塞；G-1 routines 捕获策略 = DBA/root 单独捕获；SAFETY_COPY_ONLY 不能作为迁移输入。

---

## 3. Role Decision Register（角色裁定登记）

> 本轮为就绪/授权准备门：定义 U-07/U-08/U-09/U-10 的角色职责与字段，**但不得具名真人**（须由 Cutover Approver / 用户书面指派）。未具名时 `authorization status = MISSING`，**不得进入 Execution**。
> 字段：`name` / `contact` / `responsibility` / `authorization status`（PROPOSED/CONFIRMED/MISSING）。

### U-07 Operator（执行操作人）

| 字段 | 值 |
|---|---|
| name | **MISSING**（待 Cutover Approver 具名指派） |
| contact | MISSING |
| responsibility | 执行维护窗（排定窗口启动）、应用层 maintenance flag 置位（A）、入口写接口拦截（B）、no-write 验证（T0/T1/T2 采集比对）、执行 WP4-D 静止权威快照命令（mysqldump 两源库 + routines root 捕获 + sha256） |
| authorization status | **MISSING**（PROPOSED 角色占位，未 CONFIRMED） |

### U-08 Approver（批准人 / 维护窗批准）

| 字段 | 值 |
|---|---|
| name | **MISSING** |
| contact | MISSING |
| responsibility | 批准维护窗开始（具体时段/时长≤2h）、确认冻结策略 A+B、批准进入 AUTHORITATIVE_SNAPSHOT、对 G-2 waiver 出具书面裁定 |
| authorization status | **MISSING** |

### U-09 Abort Authority（中止授权人）

| 字段 | 值 |
|---|---|
| name | **MISSING** |
| contact | MISSING |
| responsibility | 在任一验证失败（冻结无法应用 / 用户仍写入 / 后台仍可能写入 / no-write 验证失败 / off-host 不可用且未 waiver / routines 捕获不可用 / 快照或漂移复检失败）时下令 ABORT |
| authorization status | **MISSING** |

### U-10 Rollback Authority（回滚授权人 / 即 Cutover Approver）

| 字段 | 值 |
|---|---|
| name | **MISSING** |
| contact | MISSING |
| responsibility | 批准恢复 1.0 正常写入、撤销冻结（解除 maintenance flag + 入口放行写方法）、终止快照执行；与 WP4-D/ WP4-G 回滚链路一致（SC-01…SC-15 / CLASS_1-3） |
| authorization status | **MISSING** |

> **角色裁定结论**：U-07/U-08/U-09/U-10 **全部 MISSING**（本轮仅定义角色骨架，未具名）。按本门规则，MISSING 状态下**不得进入 WP4-C Execution**。

---

## 4. G-2 Off-host Check（只读检查，2026-09-20）

> 仅只读探测，允许创建/删除一个明确命名的临时探针文件（`p9_wp4c_g2_probe_<timestamp>.txt`）；不得复制生产备份、不得执行正式备份、不得改变数据库。

| 检查项 | 实测值（SSH root@101.43.30.163，只读） | 结果 |
|---|---|---|
| `/mnt/nas-storage` 挂载可达 | `ls: cannot access '/mnt/nas-storage': Host is down` | ❌ DOWN |
| 测试写入（命名探针文件） | `WRITE=FAIL`（`Host is down`，文件未落盘） | ❌ FAIL |
| 测试 sha256 校验 | `sha256sum: ... Host is down` | ❌ FAIL |
| 测试清理 | `rm: ... Host is down`（文件本未创建） | ❌ FAIL |
| 剩余空间 `df` | `df: /mnt/nas-storage: Host is down` | ❌ N/A |
| 网络错误原因 | CIFS 挂载定义存在但断连（`Host is down`） | 与 WP4-B Readiness G-2 一致 |
| 备用 off-host 路径 | **未定义、未测试**（本轮未提供替代路径） | ❌ 缺 |

**G-2 当前状态 = OPEN（NAS 仍 DOWN，无备用 off-host 路径，无书面 waiver）。**

---

## 5. G-2 Decision（三选一判定）

| 选项 | 条件满足？ | 结论 |
|---|---|---|
| **A. G-2 CLOSED by NAS restore** | NAS 可访问 / 测试写入 PASS / 测试复制 PASS / sha256 verify PASS / cleanup PASS | ❌ **不满足**（NAS `Host is down`，写入 FAIL） |
| **B. G-2 CLOSED by ALTERNATE off-host** | 明确备用 off-host 路径 / 测试写入 PASS / sha256 verify PASS / cleanup PASS | ❌ **不满足**（未定义、未测试备用路径） |
| **C. G-2 WAIVED** | Cutover Approver 明确书面 waiver / 记录 waiver reason / 记录 residual risk / 记录 compensating control | ❌ **不满足**（本轮未收到书面 waiver） |

**判定**：A / B / C **均不满足** → **G-2 = OPEN**。

- `G-2 off-host status` = **OPEN**
- `G-2 closure method` = **NONE**
- 结果：AUTHORITATIVE_SNAPSHOT 进入前置**仍未关闭**；**Ready for WP4-C Execution = NO**（若目标为 AUTHORITATIVE_SNAPSHOT）。
- 补偿说明：若仅目标为 SAFETY_COPY_ONLY，G-2 仍允许以 `offhost_copy=SKIPPED` 执行（见 WP4-B Auth Gate G-2/B）；但 WP4-C Execution 默认面向 AUTHORITATIVE 静止快照，须 G-2 关闭或书面 waiver。

### G-2 关闭路径建议（供下一轮）

- **路径 A（推荐）**：Infra Operator 重连 NAS（`mount -t cifs ... //100.119.44.27/nvme16-135XXXX0654 /mnt/nas-storage`），复测可达性 + 命名探针写/sha256/cleanup 全 PASS → G-2=CLOSED。
- **路径 B**：定义备用 off-host（如另一挂载点 / 对象存储 / 异地 rsync 目标），同法验证可写 + sha256 → G-2=CLOSED。
- **路径 C**：Cutover Approver 出具书面 waiver（含 reason + residual risk + compensating control，e.g. 本地副本 + 隔离恢复演练替代 off-host），证据记入 WP4-D 执行 evidence → G-2=WAIVED。

---

## 6. WP4-C Execution Readiness Matrix（执行就绪矩阵）

| 维度 | 状态 | 说明 |
|---|---|---|
| U-07 Operator | **MISSING** | 角色定义，未具名 |
| U-08 Approver | **MISSING** | 角色定义，未具名 |
| U-09 Abort Authority | **MISSING** | 角色定义，未具名 |
| U-10 Rollback Authority | **MISSING** | 角色定义，未具名 |
| G-2 off-host | **OPEN** | NAS down / 无备用 / 无 waiver |
| freeze strategy A+B | **READY** | WP4-C 定义门 §4 已定（应用层 + 入口层，非全库 read_only） |
| no-write verification plan | **READY** | WP4-C 定义门 §5 已定（T0/T1/T2 + 活跃表映射 + SQL） |
| maintenance window time | **MISSING** | 时段/时长未批准（建议 02:00–04:00 CST，≤2h） |
| user notice | **NOT READY** | 通道未定义（建议公众号+小程序提示+运维群，≥24h 公告） |
| rollback/resume plan | **READY** | WP4-C 定义门 §7 已定（AF-01…AF-08 + resume） |

**Open items（阻断 Execution）**：U-07 / U-08 / U-09 / U-10 具名 + G-2 关闭或 waiver + 维护窗时间批准 + 用户通知准备。

---

## 7. FINAL GATE（P9 WP4-C Execution Readiness / G-2 Closure）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `5f82fc8` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（WP4-C Def / WP4-B Auth/Readiness/Safety / WP4 Def / WP4-A 全读） |
| Role register complete | **YES（已文档化；U-07/U-08/U-09/U-10 全部 MISSING）** |
| U-07 Operator | **MISSING** |
| U-08 Approver | **MISSING** |
| U-09 Abort Authority | **MISSING** |
| U-10 Rollback Authority | **MISSING** |
| G-2 off-host status | **OPEN** |
| G-2 closure method | **NONE** |
| Recommended freeze strategy | **A + B** |
| Maintenance window approved | **NO** |
| Write freeze executed | **NO** |
| No-write verification executed | **NO** |
| Production dump executed | **NO** |
| Production backup executed | **NO** |
| Production data modified | **NO** |
| Production schema modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4-C Execution Readiness Gate = PASS（作为就绪/准备门）**

### **Ready for WP4-C Execution = NO（须先关闭全部 Open items）**
> 进入 WP4-C **执行**轮须同时满足：
> ① 用户书面授权进入执行轮；
> ② U-07/U-08/U-09/U-10 具名裁定（CONFIRMED）；
> ③ G-2 关闭（NAS 重连可达 / 备用 off-host 验证）**或** Cutover Approver 书面 waiver；
> ④ 维护窗时间批准（MG-12 ≤2h）+ 用户通知准备（≥24h）。
> 当前角色全 MISSING、G-2=OPEN、维护窗未批准 → 不可进入执行。

---

## 8. 纪律声明（P9 WP4-C Execution Readiness / G-2 Closure Gate）

| 项 | 状态 |
|---|---|
| 执行维护窗 / 实际冻结写入 | ❌ 无（仅就绪定义） |
| 执行 no-write verification | ❌ 无 |
| 执行 mysqldump / 实际备份生产库 | ❌ 无 |
| 停止 1.0 / 锁表 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 修改 MySQL 用户或权限 / 提权 jhzy_mig_ro | ❌ 无（G-1 选项 C 永久排除） |
| G-2 实际挂载/拷贝/重连 NAS | ❌ 无（仅只读探针，写 FAIL 即止，未改动挂载） |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git 提交 | ❌ 无（待用户授权后提交） |

**STOP — 未执行维护窗，未冻结写入，未进入 AUTHORITATIVE_SNAPSHOT（WP4-D）。** 等待下一步显式授权（WP4-C 执行轮 / Git Closeout / G-2 关闭或 waiver 提供 / 角色具名 / 其它）。

---

## 引用

- WP4-C 定义门：`P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md`（Recommended=A+B / Ready=NO / G-2 BLOCKER / §6 进入条件 9 项）。
- 授权门：`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（G-1=A / G-2=B / G-4=A / 授权矩阵）。
- 就绪门：`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（AB-01…AB-09 / G-1…G-4）。
- 安全副本证据：`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`。
- WP4 定义：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6（维护窗/冻结计划）。
- G-10 关闭：`P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md`。
- Preflight：`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 活跃漂移 / 维护窗必需）。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
