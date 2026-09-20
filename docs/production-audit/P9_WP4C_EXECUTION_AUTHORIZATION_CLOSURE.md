# P9 WP4-C — Execution Authorization Closure（执行授权关闭）

> **阶段**：P9 WP4-C（Execution Authorization Closure）
> **关闭日期**：2026-09-20（CST）
> **性质**：**Authorization Closure Only（明确 U-07/U-08/U-09/U-10 负责人、裁定 G-2 waiver、记录维护窗候选、定义用户通知方案、产出授权矩阵与授权关闭文档；不执行维护窗、不冻结写入、不执行 no-write 验证、不执行 mysqldump、不实际备份生产库、不停止 1.0、不锁表、不修改 1.0 / nginx / DNS / route、不写 D1、不 import schema、不迁移、不 Cutover、不修改 MySQL 用户或权限、不 git commit（除非另行授权））**。
> **承接**：`P9_WP4C_EXECUTION_READINESS_AND_G2_CLOSURE.md`（就绪门 PASS / U-07~U-10=MISSING / G-2=OPEN / Ready=NO）、`P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md`（Recommended=A+B / §6 进入条件 9 项）、`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`（SAFETY_COPY_ONLY PASS，非迁移输入）、`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6。
> **纪律**：本轮仅产出授权关闭文档；所有执行动作（维护窗/冻结/快照/迁移）须用户显式授权后，在 WP4-C **执行**阶段（非本授权阶段）进行。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| 最新远端 commit | `65c7062`（`65c70627b7d5733f4fa094baf8460ad0679ae360`，P9 WP4-C Execution Readiness Git Closeout，已 `origin/master`） |
| P9 WP4-C Execution Readiness Git Closeout | FINAL PASS（commit `65c7062`，HEAD == origin/master） |
| Ready for WP4-C Execution（就绪门结论） | **NO**（U-07~U-10 MISSING / G-2 OPEN / 维护窗未批准） |
| Recommended freeze strategy | **A + B** |
| AUTHORITATIVE_SNAPSHOT | **NOT ENTERED** |
| 当前仍 STOP | YES（未进入 WP4-C 执行 / 未进 WP4-D） |
| 本轮性质 | Authorization Closure（角色具名 + G-2 waiver + 维护窗候选 + 用户通知） |
| 是否执行维护窗/冻结 | **NO** |

---

## 1. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `65c70627b7d5733f4fa094baf8460ad0679ae360`（`65c7062`，P9 WP4-C Execution Readiness Git Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `65c70627…`） |
| staged | 0 |
| P9 scope clean | ✅（并行改动允许存在，不处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4C_EXECUTION_READINESS_AND_G2_CLOSURE.md` | 就绪门 PASS；U-07~U-10 全部 MISSING；G-2 当前 OPEN（NAS `Host is down`）；Ready for Execution=NO；AUTHORITATIVE 进入须 G-2 关闭或 waiver |
| `P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md` | Recommended=A+B；§3 维护窗方案（id=`wp4c-mw-<YYYYMMDD>` / ≤2h / 建议 02:00–04:00 CST）；§5 no-write 验证（T0/T1/T2）；§6 进入条件 9 项；§7 abort AF-01…AF-08 |
| `P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md` | SAFETY_COPY_ONLY PASS；`offhost_copy=SKIPPED`；非迁移输入；非 authoritative |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | §6 维护窗/冻结计划：批准人（Cutover Approver，U-10）/ 通知（≥24h，U-09）/ 冻结方式（入口维护页 + 应用层停写）/ 最大冻结 ≤2h（MG-12）/ 双写禁止 |

**基线确认**：Ready for WP4-C Execution = NO；U-07/U-08/U-09/U-10 此前 MISSING；G-2 此前 OPEN；Recommended freeze strategy = A+B；AUTHORITATIVE_SNAPSHOT 未进入；SAFETY_COPY_ONLY 不作为迁移输入。

---

## 3. Role Closure（角色关闭 / 具名裁定）

> 用户于本轮 Authorization Closure 提供默认裁定（§3：「如用户未另行指定，可按项目责任默认裁定」）。据此将 U-07~U-10 具名，`authorization status = CONFIRMED`。

### U-07 Operator（技术执行人 / 执行操作人）

| 字段 | 值 |
|---|---|
| name | **OpenCode 执行助手操作者（WorkBuddy / OpenCode 会话内操作代理）** |
| role | 技术执行人（Migration Operator） |
| contact channel | 本会话（WorkBuddy 对话）/ 生产宿主 SSH（root@101.43.30.163） |
| responsibility | 执行维护窗（排定窗口启动）；应用层 maintenance flag 置位（A）；入口写接口拦截（B）；no-write 验证（T0/T1/T2 采集比对）；执行 WP4-D 静止权威快照命令（mysqldump 两源库 + routines root 捕获 + sha256） |
| authorization status | **CONFIRMED**（本轮默认裁定） |

### U-08 Approver（批准人 / 维护窗批准 / 即 Cutover Approver）

| 字段 | 值 |
|---|---|
| name | **ming mo（项目负责人）** |
| role | 项目负责人 / Cutover Approver |
| contact channel | 本会话（WorkBuddy 对话） |
| responsibility | 批准维护窗开始（具体时段/时长≤2h）、确认冻结策略 A+B、批准进入 AUTHORITATIVE_SNAPSHOT、对 G-2 waiver 出具书面裁定 |
| authorization status | **CONFIRMED**（本轮默认裁定） |

### U-09 Abort Authority（中止授权人）

| 字段 | 值 |
|---|---|
| name | **ming mo（项目负责人）** |
| role | 项目负责人 / Cutover Approver |
| contact channel | 本会话（WorkBuddy 对话） |
| responsibility | 在任一验证失败（冻结无法应用 / 用户仍写入 / 后台仍可能写入 / no-write 验证失败 / off-host 不可用且未 waiver / routines 捕获不可用 / 快照或漂移复检失败）时下令 ABORT |
| authorization status | **CONFIRMED**（本轮默认裁定） |

### U-10 Rollback Authority（回滚授权人 / 即 Cutover Approver）

| 字段 | 值 |
|---|---|
| name | **ming mo（项目负责人）** |
| role | 项目负责人 / Cutover Approver |
| contact channel | 本会话（WorkBuddy 对话） |
| responsibility | 批准恢复 1.0 正常写入、撤销冻结（解除 maintenance flag + 入口放行写方法）、终止快照执行；与 WP4-D/WP4-G 回滚链路一致（SC-01…SC-15 / CLASS_1-3） |
| authorization status | **CONFIRMED**（本轮默认裁定） |

> **角色裁定结论**：U-07/U-08/U-09/U-10 **全部 CONFIRMED**（本轮按用户默认裁定具名）。仍须维护窗批准 + G-2 waiver 关闭，方可进入执行。

---

## 4. G-2 Closure Decision（三选一判定）

| 选项 | 条件满足？ | 结论 |
|---|---|---|
| **A. G-2 CLOSED by NAS restore** | NAS 可访问 / 测试写入 PASS / 测试复制 PASS / sha256 verify PASS / cleanup PASS | ❌ **不满足**（就绪门 SSH 探针：`/mnt/nas-storage` → `Host is down`，写入/sha256/cleanup 全 FAIL） |
| **B. G-2 CLOSED by ALTERNATE off-host** | 明确备用 off-host 路径 / 测试写入 PASS / sha256 verify PASS / cleanup PASS | ❌ **不满足**（无备用 off-host 路径、未测试） |
| **C. G-2 WAIVED** | Cutover Approver 明确书面 waiver / 记录 waiver reason / 记录 residual risk / 记录 compensating control | ✅ **满足**（U-08=Cutover Approver 于本轮提供书面 waiver 文本，见下） |

**判定**：A / B 不满足；C 满足 → **G-2 = WAIVED（closure method = WAIVER）**。

### G-2 Waiver 书面裁定（Option C）

| 字段 | 值 |
|---|---|
| waiver approver | **ming mo（U-08 / Cutover Approver）** |
| waiver reason | NAS（`/mnt/nas-storage`，CIFS //100.119.44.27/nvme16-135XXXX0654）当前不可达（`Host is down`），且本轮无可用备用 off-host 路径；AUTHORITATIVE_SNAPSHOT 执行轮需在冻结态取静止快照，不能因 off-host 缺失而无限期阻塞 |
| residual risk | 权威快照初始仅存于腾讯云生产宿主本地（`/www/backup/database/.../wp4-snapshot-*/`），在后续 off-host 拷贝完成前存在单点存储风险；若宿主故障且尚未 off-host 拷贝，快照可能丢失 |
| compensating control | ① `sha256_manifest` 钉死快照 hash；② `gzip -t` 完整性校验；③ 本地路径隔离（专用 `wp4-snapshot-<run_id>/` 目录）；④ 迁移执行前须确认快照 evidence 完整（run_id / 表清单 / 行数 / schema+data hash / 漂移复检）；⑤ **快照执行后、Cutover 前必须重试 off-host（NAS 或备用路径）拷贝**，失败则 ABORT Cutover |
| validity scope | 仅 WP4-C/WP4-D 准备与执行期间（preparation + frozen snapshot）；不延伸至 P9 WP6 Cutover |
| expiry condition | NAS 恢复后须立即补 off-host copy；若至 Cutover 前仍未完成 off-host copy，则 **Cutover 须 ABORT**（不进入切换） |

> **Waiver 原文（采用用户建议文本）**：
> ```
> G-2 off-host backup is waived for WP4-C/WP4-D preparation only because NAS is currently unreachable and no alternate off-host path is available in this round. Residual risk: authoritative snapshot will initially exist only on local Tencent host before any later off-host copy. Compensating controls: sha256 manifest, gzip integrity verification, local path isolation, no migration execution until snapshot evidence is complete, and post-snapshot off-host copy must be retried before Cutover. This waiver does not waive reconciliation, rollback evidence, or Cutover approval.
> ```

**结果**：G-2 = **WAIVED**；AUTHORITATIVE_SNAPSHOT 进入前置的 G-2 阻塞**已通过 waiver 关闭**。

---

## 5. Maintenance Window Decision（维护窗裁定）

| 字段 | 值 |
|---|---|
| proposed window date | **待 U-08 排定具体日期**（建议周二至周四低峰） |
| proposed window time | **02:00–04:00 CST**（建议时段） |
| max duration | **≤ 2 小时**（MG-12；超期自动延长须重新授权） |
| timezone | **CST / China Standard Time（UTC+8）** |
| affected systems | ① 1.0 API（`api.jhzyfw.com`）② 微信小程序（客户端）③ 管理后台/backend ④ MySQL 源库（`api_jhzyfw_com` + `signup_db`）⑤ 腾讯云入口（Tencent ingress / vhost） |
| user-facing impact | 注册 / 活动报名 / 签到签退 / 积分变化 / 培训考试提交 / 证书生成 / 后台写入 **暂停**；读请求可继续或展示「系统维护中」提示 |
| approval status | **PROPOSED**（时段/时长已建议并登记，但**尚未由 U-08 显式批准**） |

> **说明**：维护窗候选时段已记录（02:00–04:00 CST，≤2h），但用户本轮未显式批准具体日期/时段 → `approval status = PROPOSED`。依就绪门规则「如果尚未批准：Ready for WP4-C Execution = NO」。

---

## 6. User Notice Plan（用户通知方案）

| 字段 | 值 |
|---|---|
| notice required | **YES** |
| notice timing | 维护窗开始前 **≥ 24h** 发布公告（U-09 通道） |
| notice channel | 公众号推文 + 小程序端维护提示 + 内部运维群（沿用 WP4 Def §3 建议） |
| notice owner | **ming mo（U-09 / Cutover Approver）** |
| notice content draft | 见下 |
| status | **READY**（文案已拟，渠道与责任人已定，待排定窗口后发出） |

**通知文案草案**：
```
系统维护通知：嘉禾志愿平台将于【日期】02:00–04:00 进行系统维护。维护期间，小程序报名、签到签退、培训考试提交、积分变动及后台写入功能可能暂停；已打开页面建议维护后重新进入。维护完成后服务将恢复正常。感谢理解。
```

---

## 7. Authorization Matrix（授权矩阵）

| 维度 | 状态 | 说明 |
|---|---|---|
| U-07 Operator | **CONFIRMED** | OpenCode 执行助手操作者（技术执行人） |
| U-08 Approver | **CONFIRMED** | ming mo（项目负责人 / Cutover Approver） |
| U-09 Abort Authority | **CONFIRMED** | ming mo（项目负责人） |
| U-10 Rollback Authority | **CONFIRMED** | ming mo（项目负责人 / Cutover Approver） |
| G-2 off-host | **WAIVED** | Option C（书面 waiver，U-08 出具） |
| maintenance window | **PROPOSED** | 02:00–04:00 CST / ≤2h 已建议，未批准 |
| user notice | **READY** | 文案 + 渠道 + 责任人已定 |
| freeze strategy A+B | **READY** | WP4-C 定义门 §4 已定 |
| no-write verification | **READY** | WP4-C 定义门 §5 已定 |
| rollback/resume plan | **READY** | WP4-C 定义门 §7 已定（AF-01…AF-08 + resume） |

**Open items（仍阻断 Execution）**：维护窗时间 **显式批准**（PROPOSED → APPROVED）。

---

## 8. FINAL GATE（P9 WP4-C Execution Authorization Closure）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `65c7062` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（WP4-C Readiness / WP4-C Def / WP4-B Safety / WP4 Def 全读） |
| Role closure complete | **YES**（U-07~U-10 全部 CONFIRMED） |
| U-07 Operator | **CONFIRMED** |
| U-08 Approver | **CONFIRMED** |
| U-09 Abort Authority | **CONFIRMED** |
| U-10 Rollback Authority | **CONFIRMED** |
| G-2 off-host status | **WAIVED** |
| G-2 closure method | **WAIVER** |
| Maintenance window approved | **NO**（PROPOSED，未显式批准） |
| User notice ready | **YES** |
| Recommended freeze strategy | **A + B** |
| Ready for WP4-C Execution | **NO**（维护窗未 APPROVED） |
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
| Entered AUTHORITATIVE_SNAPSHOT | **NO** |
| Entered WP4-D | **NO** |

### **P9 WP4-C Execution Authorization Closure = PASS（授权关闭门）**

### **Ready for WP4-C Execution = NO（仅余维护窗显式批准一项未闭）**
> 进入 WP4-C **执行**轮须同时满足：
> ① 用户书面授权进入执行轮；
> ② U-07/U-08/U-09/U-10 CONFIRMED（**本轮已闭**）；
> ③ G-2 关闭或书面 waiver（**本轮 WAIVED 已闭**）；
> ④ 维护窗时间显式批准（MG-12 ≤2h）+ 用户通知发出（≥24h）。
> 当前角色全 CONFIRMED、G-2 WAIVED，仅维护窗 `approval status=PROPOSED` → 不可进入执行。

---

## 9. 纪律声明（P9 WP4-C Execution Authorization Closure）

| 项 | 状态 |
|---|---|
| 执行维护窗 / 实际冻结写入 | ❌ 无（仅授权关闭） |
| 执行 no-write verification | ❌ 无 |
| 执行 mysqldump / 实际备份生产库 | ❌ 无 |
| 停止 1.0 / 锁表 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 修改 MySQL 用户或权限 / 提权 jhzy_mig_ro | ❌ 无（G-1 选项 C 永久排除） |
| 重连/挂载/拷贝 NAS（G-2 实际动作） | ❌ 无（仅书面 waiver，未改动挂载） |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git 提交 | ❌ 无（本轮仅授权关闭文档，待用户授权后提交） |

**STOP — 未执行维护窗，未冻结写入，未进入 AUTHORITATIVE_SNAPSHOT（WP4-D）。** 等待下一步显式授权（WP4-C 执行轮 / 维护窗显式批准 / Git Closeout / 其它）。

---

## 引用

- 就绪门：`P9_WP4C_EXECUTION_READINESS_AND_G2_CLOSURE.md`（U-07~U-10 MISSING / G-2 OPEN / Ready=NO）。
- 定义门：`P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md`（Recommended=A+B / §6 进入条件 9 项）。
- 安全副本证据：`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`。
- WP4 定义：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6（维护窗/冻结计划）。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
