# P9 WP4-C — Maintenance Window & Write Freeze Definition Gate（维护窗与写入冻结·定义门）

> **阶段**：P9 WP4-C（Maintenance Window / Write Freeze 定义门）
> **定义日期**：2026-09-20（CST）
> **性质**：**Definition Gate Only（只定义维护窗方案、写入冻结策略、no-write 验证、权威快照进入条件、abort/resume 规则、证据模板、Gap Register；不执行、不冻结、不锁表、不停止 1.0、不修改 1.0 / nginx / DNS / route、不写 D1、不 import schema、不迁移、不 Cutover、不修改 MySQL 用户或权限、不 git commit（除非另行授权））**。
> **承接**：`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（G-1=A / G-2=B / G-4=A）、`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（AB-01…AB-09 / G-1…G-4）、`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`（SAFETY_COPY_ONLY PASS，非迁移输入）、`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6（维护窗/冻结计划）、`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 活跃漂移 / 维护窗必需）。
> **纪律**：本轮仅产出定义；所有冻结/维护窗/快照动作须用户显式授权后，在 WP4-C **执行**阶段（非本定义阶段）进行。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| P9 WP4-B Safety Copy Evidence Git Closeout | FINAL PASS（commit `384f651`，HEAD == origin/master） |
| SAFETY_COPY_ONLY | 已完成（run `wp4b_safety_20260920_130838`，非迁移输入） |
| AUTHORITATIVE_SNAPSHOT | **NO / 尚未执行** |
| 最新远端 commit | `384f651` |
| 当前仍 STOP | YES（未进入 WP4-C 执行 / 未进 WP4-D） |
| 本轮性质 | Definition Gate（定义维护窗 + 冻结 + 验证 + 进入条件 + abort/resume） |
| 是否执行冻结 | **NO** |

---

## 1. REPO IDENTITY GATE（已执行，2026-09-20）

| 项 | 值 |
|---|---|
| repository | `E:/D盘备份/miniprogram` |
| branch | `master` |
| HEAD | `384f65177dc8706e5801b383f159b04222c4bcaf`（`384f651`，P9 WP4-B Safety Copy Evidence Git Closeout，已 `origin/master`） |
| HEAD == origin/master | **YES**（`git ls-remote origin master` = `384f65177…`） |
| staged | 0 |
| P9 scope clean | ✅（并行改动允许存在，不处理） |

**结论：REPO_IDENTITY_GATE = PASS。**

---

## 2. 权威基线（已读取，禁止凭记忆重定义）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md` | G-1=A（DBA/root 单独捕获 routines，禁提权 jhzy_mig_ro）；G-2=B（NAS down→SAFETY 允许 local-only，但 AUTHORITATIVE 须 A/C）；G-4=A（无维护窗→仅 SAFETY，AUTHORITATIVE 须维护窗+冻结） |
| `P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md` | binlog OFF / 双库实测 / AB-01…AB-09 / G-1 routines=1 / G-2 NAS down / G-3 混合 collation / G-4 维护窗控制 |
| `P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md` | SAFETY_COPY_ONLY PASS；`offhost_copy=SKIPPED`；非迁移输入；非 authoritative |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | §6 维护窗/冻结计划：开始条件（WP4-B PASS + MG-01…15 + 授权）/ 批准人（Cutover Approver，U-10）/ 通知（≥24h，U-09）/ 冻结方式（入口维护页 + 应用层停写）/ no-write 校验 SQL / 最大冻结 ≤2h（MG-12）/ 双写禁止 |
| `P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md` | binlog OFF（无法增量）→ 必须冻结写入后静止快照；活跃漂移实证（2026-09-20 09:52 仍在写）；active write tables 清单；维护窗必需；no-write 校验法（UPDATE_TIME + COUNT(*) delta） |

**基线确认**：SAFETY_COPY_ONLY 已完成且非迁移输入；AUTHORITATIVE_SNAPSHOT=NO；binlog=OFF；active drift exists；maintenance window required；write freeze required；dual-write prohibited；G-1=A（DBA/root 单独捕获）；G-2 NAS down（须关闭或正式 waiver 方可 AUTHORITATIVE）。

---

## 3. Maintenance Window Plan（维护窗方案）

> 仅定义；不实际开启维护窗。

| 字段 | 定义 |
|---|---|
| `maintenance_window_id` | `wp4c-mw-<YYYYMMDD>`（执行轮生成，例 `wp4c-mw-2026092X`） |
| proposed duration | **≤ 2 小时**（MG-12；超期自动延长须重新授权；含：冻结 + no-write 验证 + WP4-D 静止快照 + 漂移复检 + 解冻结缓冲） |
| preferred time range | **低峰窗口**（建议 CST 02:00–04:00，周二至周四；具体时段由 Cutover Approver 依 U-08 最终裁定） |
| operator role | Migration Operator（具名，U-07；执行轮指派） |
| approver role | Cutover Approver（具名，U-10；批准并具 STOP/回滚授权） |
| communication channel | U-09 沟通/事件通道（执行轮定义；建议：公众号推文 + 小程序端维护提示 + 内部运维群；提前 ≥ 24h 公告） |
| start criteria | ① WP4-B authoritative 备份 PASS + sha256 校验 OK；② G-1 routines capture ready（A 已定义）；③ G-2 off-host 路径 ready 或**正式书面 waiver**；④ MG-01…MG-15 全满足；⑤ 用户**书面授权**进入 WP4-C 执行轮 |
| end criteria | WP4-F 对账 PASS 且未进入 Cutover → 源保持静止至 Cutover；若触发回滚（WP4-G） → 入口回指 1.0、恢复写入 |
| abort authority | Cutover Approver（U-10） |
| rollback authority | Cutover Approver（U-10） |
| affected systems | ① 1.0 API（`api.jhzyfw.com`）② 微信小程序（客户端，受服务端维护响应驱动）③ 管理后台/backend ④ MySQL 源库（`api_jhzyfw_com` + `signup_db`）⑤ 腾讯云入口（Tencent ingress / vhost） |
| user-facing impact | 注册 / 活动报名 / 签到签退 / 积分变化 / 培训考试提交 / 证书生成 / 后台写入 **暂停**；读请求可继续或展示「系统维护中」提示；不影响已登录浏览类操作 |

---

## 4. Write Freeze Strategy（写入冻结策略）

### 4.1 冻结目标（本次须禁止的写域）

| 冻结目标 | 说明 |
|---|---|
| 禁止 1.0 新注册 | `volunteers` / `jhzy_*` 用户档案类写入 |
| 禁止活动报名 | `jhzy_activity_signups` / `activity_signups` |
| 禁止签到/签退 | `jhzy_attendance_records` / attendance |
| 禁止积分变化 | `points_transactions` / `points_exchange_records` / `points_mall` |
| 禁止培训考试提交 | `training_user_progress` / `training_user_course_status` / `exam_*` 写入 |
| 禁止证书生成 | `certificates` / `jhzy_certificates` / `exam_certificates` |
| 禁止后台写入 | 管理端所有 INSERT/UPDATE/DELETE |
| 禁止一切导致源库变化的操作 | 含 `id_pool` 分配、operation_logs / security_events 写入、文件上传等 |

### 4.2 候选策略

| 选项 | 描述 | 评估 |
|---|---|---|
| **A. 应用层维护模式** | 1.0 应用置 maintenance flag，service 层拒绝写请求，返回友好维护提示 | ✅ 推荐组成 |
| **B. Nginx/API 写接口拦截** | 腾讯云入口（vhost `api.jhzyfw.com`）对写方法（POST/PUT/DELETE）返回 503/维护页，放行 GET/health | ✅ 推荐组成 |
| **C. MySQL read-only 或权限级冻结** | `SET GLOBAL read_only=ON` 或回收写权限 | ⚠️ **不优先**（影响系统/维护任务；routines 捕获、readonly dump 等维护动作受扰；违背最小干扰原则） |
| **D. 组合策略** | A + B（+ 可选 C 仅作兜底） | ✅ **推荐落地形态** |

### 4.3 推荐策略（明确）

**推荐 = D（组合），但落地为 A + B，明确不采用 C 作为主冻结手段。**

- 主冻结：① 应用层 maintenance flag（A）拒绝写；② 入口层写接口拦截（B）兜底（即使客户端绕过应用层，入口仍拦截写方法）。
- 不采用全库 MySQL `read_only`（C）：避免干扰维护期间必要的 DBA 任务（routines 捕获、jhzy_mig_ro 一致性 dump 等），且 root 仍可在维护态完成只读 dump。
- 冻结期间读请求继续（或客户端展示维护提示）；**不得长期双写**（双写 = Architecture Change，命中即 STOP）。

### 4.4 冻结实现要点（执行轮参考，本轮不执行）

- 入口拦截：腾讯云 vhost 对写路径返回 `503 Service Unavailable` + 维护 JSON；`/health`、`GET` 读路径放行。
- 应用层：维护标志位（配置表或环境变量）置位；写 service 统一前置校验，拒绝写并返回「系统维护中」。
- 小程序端：收到维护响应即展示维护提示页，不报错。

---

## 5. No-Write Verification Plan（无写入验证方案）

> 仅定义；不执行冻结、不采集。

### 5.1 时间线

| 标记 | 含义 |
|---|---|
| T0（pre-freeze baseline） | 冻结**前**采集重点表 `UPDATE_TIME` + `COUNT(*)` 基线 |
| T1（freeze start） | 冻结生效时间戳 |
| T_wait | 等待窗口（建议 120s，确保活跃事务落定） |
| T2（post-freeze collect） | 冻结**后**复采 |

### 5.2 已知活跃写表（来自 WP3 §2 / 用户清单）

| 用户清单项 | 实际源表（api_jhzyfw_com） |
|---|---|
| id_pool | `id_pool` |
| volunteers | `volunteers` |
| attendance | `jhzy_attendance_records` |
| activities | `jhzy_activities` |
| activity_signups | `jhzy_activity_signups` |
| points | `points_transactions` / `points_exchange_records` / `points_mall` |
| training_user_progress | `training_user_progress` / `training_user_course_status` |
| exam_* tables | `exam_records` / `exam_certificates` / `exam_questions` / `training_signatures` |
| certificates | `certificates` / `jhzy_certificates` |
| operation logs | `operation_logs` / `security_events` |

### 5.3 验证查询（执行轮填真实值）

```sql
-- (1) 冻结前基线（T0）
SELECT table_name, update_time
FROM information_schema.tables
WHERE table_schema='api_jhzyfw_com'
  AND table_name IN ('id_pool','volunteers','jhzy_attendance_records','jhzy_activities',
                     'jhzy_activity_signups','points_transactions','points_exchange_records',
                     'points_mall','training_user_progress','training_user_course_status',
                     'exam_records','exam_certificates','exam_questions','training_signatures',
                     'certificates','jhzy_certificates','operation_logs','security_events');

SELECT 'id_pool' t, COUNT(*) n FROM api_jhzyfw_com.id_pool;
SELECT 'volunteers' t, COUNT(*) n FROM api_jhzyfw_com.volunteers;
SELECT 'jhzy_activity_signups' t, COUNT(*) n FROM api_jhzyfw_com.jhzy_activity_signups;
SELECT 'jhzy_attendance_records' t, COUNT(*) n FROM api_jhzyfw_com.jhzy_attendance_records;
SELECT 'training_user_progress' t, COUNT(*) n FROM api_jhzyfw_com.training_user_progress;
-- … 其余重点表同理（执行轮补全）

-- (2) 冻结后复采（T2），与 T0 比对
-- 预期：所有表 UPDATE_TIME 不变且 COUNT(*) 无增量
SELECT table_name, update_time
FROM information_schema.tables
WHERE table_schema='api_jhzyfw_com'
  AND update_time > '<T1_freeze_start>';
-- → 预期空集（任何返回行 = 仍有写入 = ABORT）
```

### 5.4 判定

- 有 `updated_at`/`created_at` 列的表：比对行级时间戳无新增。
- 无 per-row 时间戳的表：以表级 `UPDATE_TIME` + 重点表 `COUNT(*)` delta 为准（WP3 §3）。
- 表清单 hash：`information_schema.tables` 两库全表清单 SHA256（T0 vs T2）一致。
- 行数 hash：重点表 `COUNT(*)` 集合 SHA256（T0 vs T2）一致。
- **任一表 `UPDATE_TIME > T1` 或 `COUNT(*)` 增加 → 判定仍有写入 → ABORT（no snapshot / no migration）**。

---

## 6. Authoritative Snapshot Entry Criteria（权威快照进入条件）

> 进入 WP4-D（AUTHORITATIVE_SNAPSHOT）前，**必须全部满足**：

| # | 条件 | 状态（当前） |
|---|---|---|
| 1 | maintenance window approved（G-4 执行） | ❌ 未授权（须 WP4-C 执行轮） |
| 2 | write freeze applied（§4） | ❌ 未执行 |
| 3 | no-write verification PASS（§5） | ❌ 未执行 |
| 4 | G-1 routines capture ready（A 已定义，执行轮捕获） | ✅ 策略已定 |
| 5 | G-2 off-host copy path ready **或正式书面 waiver** | ❌ NAS down（须关闭或 waiver） |
| 6 | source backup command ready（Readiness Tier A/B） | ✅ 模板就绪 |
| 7 | evidence directory ready | ❌ 未建 |
| 8 | abort rules acknowledged（§7） | ✅ 已定义 |
| 9 | operator roles assigned（U-07/U-10 具名） | ❌ UNKNOWN |

**否则**：仅允许 SAFETY_COPY_ONLY；**migration cannot start**（WP4-E 须基于 authoritative snapshot）。

---

## 7. Abort / Resume Rules（中止 / 恢复规则）

| ID | 触发 | 级别 | 动作 |
|---|---|---|---|
| AF-01 | 冻结无法应用（A/B 任一层失败） | CRITICAL | **ABORT**（不进快照） |
| AF-02 | 冻结后用户仍写入（no-write 验证失败） | CRITICAL | **ABORT**（SC-13 freeze conflict） |
| AF-03 | 管理后台仍可能写入（维护 flag 未全覆盖） | CRITICAL | **ABORT** |
| AF-04 | no-write verification 失败（UPDATE_TIME/COUNT 变化） | CRITICAL | **ABORT**（AB-06 / SC-11） |
| AF-05 | off-host 不可用且未 waiver（G-2） | CRITICAL | **ABORT**（AB-05，仅 AUTHORITATIVE） |
| AF-06 | routines 捕获不可用（G-1） | CRITICAL | **ABORT**（AB-02） |
| AF-07 | 快照失败 / 漂移复检失败 | CRITICAL | **ABORT**（SC-11） |
| AF-08 | 磁盘不足 / 工具缺失 / 源库不存在 | CRITICAL | **ABORT**（AB-01/03） |

**Resume（恢复）**：
- ABORT 后须恢复 1.0 正常写服务（解除 maintenance flag + 入口放行写方法）。
- 证据必须记录 abort reason（`abort_status` + reason 字段）。
- 恢复后源库回到活跃态，可重新排期维护窗。

---

## 8. Evidence Template（未来 WP4-C 执行证据）

| # | 字段 | 说明 |
|---|---|---|
| 1 | `maintenance_window_id` | `wp4c-mw-<YYYYMMDD>` |
| 2 | `operator` | 具名操作员（U-07） |
| 3 | `approver` | 具名批准人（U-10） |
| 4 | `timestamp_start` | 维护窗开始（CST） |
| 5 | `timestamp_freeze_applied` | 冻结生效时间 |
| 6 | `timestamp_no_write_verified` | no-write 验证 PASS 时间 |
| 7 | `timestamp_end` | 维护窗结束 / 解冻结时间 |
| 8 | `freeze_strategy` | `A+B`（应用层 + 入口层，非全库 read_only） |
| 9 | `affected_endpoints` | 1.0 API / 小程序 / 管理后台 / MySQL 源 / 腾讯云入口 |
| 10 | `user_notice_status` | 公告已发（≥24h）/ 小程序维护提示 ON |
| 11 | `pre_freeze_write_baseline` | T0 重点表 UPDATE_TIME + COUNT(*) 清单 |
| 12 | `no_write_verification_queries` | §5.3 查询 + 实际输出 |
| 13 | `row_count_before` | T0 重点表 COUNT(*) 集合 |
| 14 | `row_count_after` | T2 重点表 COUNT(*) 集合 |
| 15 | `table_inventory_hash_before` | T0 两库表清单 SHA256 |
| 16 | `table_inventory_hash_after` | T2 两库表清单 SHA256 |
| 17 | `abort_status` | PASS / ABORTED + reason |
| 18 | `resume_status` | 正常写恢复确认 |
| 19 | `final_decision` | FROZEN_OK / ABORTED |

---

## 9. Gap Register（WP4-C 缺口登记）

分类：READY / PARTIAL / MISSING / UNKNOWN / BLOCKER

| ID | Area | Finding | Evidence | Severity | Blocking Stage | Required Closure | Owner Role |
|---|---|---|---|---|---|---|---|
| G-1 | routines 捕获 | 策略=A（DBA/root 单独捕获），已定义 | Auth Gate §4 | READY | WP4-D 执行 | 执行轮由 root 捕获 `assign_certificate_id` | DBA / Infra Operator |
| G-2 | NAS off-host | `/mnt/nas-storage` 仍 `Host is down`；AUTHORITATIVE 须 A/C 或书面 waiver | Readiness §2 / Auth Gate §5 | **MISSING（BLOCKER for AUTHORITATIVE）** | WP4-D 进入 | 重连 NAS + 可达性写测试，或 Cutover Approver 出具书面 waiver | Infra Operator |
| G-4 | 维护窗 + 冻结计划 | 本轮已定义方案/策略/验证/abort | 本门 §3–§7 | READY（定义） | WP4-C 执行 | 执行轮排定窗口 + 冻结 + no-write PASS（须授权） | Migration Operator / Cutover Approver |
| U-07 | 具名操作人 | 仅 ROLE 占位 | WP3 §8 | UNKNOWN | WP4-C 执行 | 指派具名 Migration Operator | Cutover Approver |
| U-08 | 维护窗时间 | 时段/时长未定（建议 02:00–04:00 CST，≤2h） | WP3 §8 | UNKNOWN | WP4-C 执行 | 裁定具体窗口 | Cutover Approver |
| U-09 | 沟通/事件通道 | 未定义（建议公众号+小程序提示+运维群） | WP3 §8 | UNKNOWN | WP4-C 执行 | 定义通道 + ≥24h 公告 | Cutover Approver |
| U-10 | STOP/回滚授权人 | 仅 ROLE | WP3 §8 | UNKNOWN | WP4-C 执行 | 具名 Cutover Approver | Cutover Approver |
| W2-02 | 冻结写入验证 | 比对 UPDATE_TIME/行数法已定义，未实测 | WP2 §6 / WP3 | UNKNOWN | WP4-C 执行 | 执行轮实测 no-write 校验 | Migration Operator |

> **Definition Gate BLOCKER = 0**（G-2 为 **AUTHORITATIVE_SNAPSHOT 进入 BLOCKER**，不阻断本 Definition Gate；本门仅定义，不进入执行）。
> **Execution preconditions（进入 WP4-C 执行）**：U-07/U-08/U-09/U-10 须具名裁定；G-2 须关闭或书面 waiver（仅当目标为 AUTHORITATIVE_SNAPSHOT）。
> **UNKNOWN count = 5**（U-07/U-08/U-09/U-10/W2-02）。Freeze Conflict Count = 0。

---

## 10. FINAL GATE（P9 WP4-C Definition）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `384f651` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（WP4-B Auth/Readiness/Safety + WP4 Def + WP3 全读） |
| Maintenance window plan defined | **YES**（§3：id / 时长≤2h / 时段建议 / 角色 / 通道 / 起止条件 / abort/rollback 授权 / 影响系统） |
| Write freeze strategy defined | **YES**（§4：冻结目标 + A/B/C/D + **推荐 A+B（非全库 read_only）** + 实现要点） |
| No-write verification plan defined | **YES**（§5：T0/T1/T2 + 已知活跃表映射 + 验证 SQL + 判定） |
| Authoritative snapshot entry criteria defined | **YES**（§6：9 项全满足方可进 WP4-D；否则仅 SAFETY） |
| Abort/resume rules defined | **YES**（§7：AF-01…AF-08 + resume + 留 abort reason） |
| Evidence template defined | **YES**（§8：19 字段） |
| Gap Register complete | **YES**（§9：0 Definition BLOCKER / G-2 为 AUTHORITATIVE BLOCKER / 5 UNKNOWN） |
| Recommended freeze strategy | **A + B（应用层维护模式 + 入口写接口拦截；不采用全库 MySQL read_only）** |
| Maintenance window approved | **NO**（须执行轮授权） |
| Write freeze executed | **NO** |
| No-write verification executed | **NO** |
| Production backup executed | **NO** |
| Production dump executed | **NO** |
| Production data modified | **NO** |
| Production schema modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4-C Definition Gate = PASS**

### **Ready for WP4-C Execution = NO（须先满足执行前置）**
> 进入 WP4-C **执行**轮须同时满足：① 用户书面授权；② U-07/U-08/U-09/U-10 具名裁定；③ 若目标为 AUTHORITATIVE_SNAPSHOT，G-2 须关闭或书面 waiver。
> 当前为**定义门 PASS**，未执行任何冻结、未进入 WP4-D。

---

## 11. 纪律声明（P9 WP4-C Definition Gate）

| 项 | 状态 |
|---|---|
| 停止 1.0 / 锁表 / 实际冻结写入 | ❌ 无（仅定义） |
| 执行 mysqldump / 实际备份生产库 | ❌ 无 |
| 修改 1.0 / 腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 修改 MySQL 用户或权限 | ❌ 无 |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git 提交 | ❌ 无（待用户授权后提交） |

**STOP — 未执行冻结，未进入 WP4-D（AUTHORITATIVE_SNAPSHOT），未执行迁移。** 等待下一步显式授权（WP4-C 执行轮 / Git Closeout / 其它）。

---

## 引用

- 授权门：`P9_WP4B_BACKUP_EXECUTION_AUTHORIZATION_GATE.md`（G-1=A / G-2=B / G-4=A）。
- 就绪门：`P9_WP4B_SOURCE_BACKUP_EXECUTION_READINESS.md`（AB-01…AB-09 / G-1…G-4）。
- 安全副本证据：`P9_WP4B_SAFETY_COPY_BACKUP_EXECUTION_EVIDENCE.md`。
- WP4 定义：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §6（维护窗/冻结计划）。
- Preflight：`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md`（binlog OFF / 活跃漂移 / 维护窗必需 / no-write 法）。
- 回滚 / STOP：`P8-3_WP5_ROLLBACK_PLAN_AND_CUTOVER_RUNBOOK.md`（SC-01…SC-15 / CLASS_1-3）。
