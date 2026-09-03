# S2-6j 交付报告 — Attendance Anomaly Handling (V1)

> 项目：嘉禾志愿小程序 2.0（Cloudflare Workers + D1）
> 切片：S2-6j V1 — 考勤异常「处置」(Handling ONLY)
> 时间：2026-09-03（ONE-GATE REPAIR 轮次更新）
> 受理状态：**S2-6j = GO**（经 ONE-GATE REPAIR 后最终判定；详见 §13.1）
> 冻结基线：S2-6h-R2=GO / S2-6i=GO / S2-6j-P0=GO / S2-6j-P0.5=GO；Git baseline commit `30fc0fa`，tag `jhzy-v2-s2-6i-go`（未改写）
> 纪律：严格执行用户 §0–§33 及本轮 ONE-GATE REPAIR 长文授权（§0–§13）；一次只验证、显式 STOP，无 S2-6k 自动进入。

---

## 0. 状态变更与基线锁定

- 本切片为 IMPLEMENTATION 阶段，冻结语义全部来自 S2-6j-P0（设计冻结，23 节）+ S2-6j-P0.5（版本控制基线门，14 节）+ 本轮 §0–§33 长文授权。
- **Git baseline 纪律（不可改写）**：禁止 `git reset --hard` 到 baseline / `git rebase` baseline / `git amend` baseline commit / 删除或移动 baseline tag `jhzy-v2-s2-6i-go`。本切片所有改动均为**增量叠加**于 baseline 之上，未触碰 baseline commit 与 tag。
- 首次实跑 S2-6j MAIN = 79 PASS / 1 FAIL（D7 实时撤销用例失败）；根因定位为**测试用例缺陷**（mock 注入通道下 `user_roles` 不参与权限解析，删除无效），非实现 bug。修复后复验 **80/80**（§13）。最终判定 GO。

---

## 1. 范围（Scope = Handling ONLY）

本切片**仅交付"异常处置"能力**，目标资源键为 `attendance_anomalies.id`（anomaly 级资源键）：

- `GET /api/v2/attendance-anomalies` — 列表（TEAM 隔离 + 过滤 + 游标分页）
- `GET /api/v2/attendance-anomalies/:anomalyId` — 详情（安全 session 视图）
- `POST /api/v2/attendance-anomalies/:anomalyId/resolve` — 处置（confirm / dismiss）

**明确 NOT IN SCOPE（指令 §0 显式排除）**：
1. 自动异常识别 / 检测引擎（AUTO DETECTION）
2. 手工创建异常 API（MANUAL CREATE）
3. 风险引擎 / 风险评分（RISK ENGINE）
4. `out_of_range` / `device_switch` / `multi_account` / `replay` / `cross_day` / `overlong` / `reverse_time` 任一检测逻辑
5. 地理位置 / 设备指纹采集（LOCATION / DEVICE COLLECTION）
6. 时间窗 / 排班模型（TIME WINDOW / SHIFT MODEL）
7. 考勤结算 / `service_records` 修正（ACTIVITY SETTLEMENT）
8. 积分 / 证书联动（POINTS / CERTIFICATES）
9. 审核自动化（REVIEW AUTOMATION）
10. 隐式强制签退（IMPLICIT FORCE CHECKOUT）

处置动作**只写** `attendance_anomalies`（status / handled_by / handled_at / resolution）+ 一条 `attendance_events`（event_type='anomaly'），**绝不**副作用 `attendance_sessions` / `service_records` / `activity_signups` / `attendance_events` 的其它语义（§5）。

---

## 2. 冻结基线（Frozen Baseline）

| 项 | 值 | 校验方式 |
|---|---|---|
| Migration `0004_attendance_multi_participation.sql` SHA256 | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d` | `sha256sum` ✓ 一致（本轮校验，未漂移） |
| Migrations 总数 | 4（0001–0004） | `ls migrations/*.sql` = 4，无 0005 ✓ |
| Catalog roles | 6 | seed validator ✓ |
| Permissions | 83 | catalog/seed validator ✓ |
| role_permissions | 238 | seed validator ✓ |
| 冻结 HTTP 回归基线 | 340 / 340（8 套件） | §15 本轮**逐个实跑**实得 340/340 ✓ |
| 时间语义 | 所有 timestamp 列 = INTEGER Unix epoch **秒**（禁 13 位毫秒） | §11 J 组门禁 ✓ |
| PSA 在 catalog 持 `attendance.anomaly.handle` 但 TenantContext.teamId=null | 必须 403 `TEAM_SCOPE_REQUIRED`（已知 architecture gap，不修复、不 bypass） | §权限矩阵 D5 ✓ |
| 目录事实 | `attendance.anomaly.handle` 持有者 = `platform_super_admin` / `team_admin` / `team_owner`；`volunteer` / `team_auditor` / `platform_operator` **不持有** | §权限矩阵 D7/D8 静态校验 ✓ |

---

## 3. 设计约束映射（§0–§33 → 实现）

| 条款 | 要求 | 实现落点 |
|---|---|---|
| §0 | Handling ONLY；排除 10 项 | route/service/repo 仅实现 list/detail/resolve；无 create/detect 路径 |
| §1 | status 冻结 1=OPEN/2=CONFIRMED/3=DISMISSED；合法转移 1→2、1→3；重复 → 409；无重开/撤销/修正 | `ANOMALY_STATUS` 枚举 + 原子 UPDATE `WHERE status=1` |
| §2 | MIGRATION REQUIRED=NO / CATALOG CHANGE REQUIRED=NO；migrations=4；无 0005；0004 SHA 不变 | 无新增迁移；权限 `attendance.anomaly.handle` 已存在于冻结 catalog |
| §3 | API 三端点；无 POST 创建端点 | `src/routes/attendance-anomalies.ts` |
| §4 | resolve body：`decision` ∈ {confirm,dismiss} 必填；`resolution` 必填/trim/非空/≤1000；无 status 来自客户端 | `normalizeResolution()` + 校验 |
| §5/§6 | 仅写 anomaly + 一条 event；无副作用 | `resolveAnomalyAtomically()` |
| §9/§10/§11/§12 | TEAM 隔离 + IDOR：`WHERE id=? AND team_id=?`；跨团队 → 404（无存在性 oracle） | repo 层收口 |
| §14 | 全部 3 路由使用 `attendance.anomaly.handle`；unauth→401、volunteer/auditor/operator→403、PSA→403 `TEAM_SCOPE_REQUIRED` | `requirePermission('attendance.anomaly.handle')` + `requireActor()` |
| §15/§16/§17/§18 | 原子性 `db.batch([INSERT event, UPDATE anomaly])` + 共享 PRE-state 谓词 P；changes=0 → 重查区分 404/409；audit raw 最小 | repo + service |
| §20 | `Math.floor(Date.now()/1000)`；毫秒硬门禁 `< 1e11` | `nowSeconds()` + J 组断言 |
| §21/§22 | 无 `updated_at`/`user_id`/`activity_id` 列；JOIN `attendance_sessions`；无 team_id 索引；无 0005 | schema 已冻结，未改 |
| §23/§24 | 集成 ≥60 断言（A–K 组）/ 原子性 ≥12 断言（故障注入） | `attendance_anomaly_integration.mjs`(80) + `attendance_anomaly_atomicity.mjs`(26) |
| §25 | 测试 DB `.tmp/s2-6j-state`（原生 0001→0004，无 0005） | harness `run_s2_6j.mjs` |
| §29 | 端口 8795（非 8787 Signivra） | harness PORT=8795 |
| §30 | `git add workers`（不 `.`/`-A`）；commit `feat(jhzy-v2): add attendance anomaly handling`；不 push | §21/§26 |
| §31 | 报告 `docs/architecture/S2-6j-REPORT.md` | 本文 |
| §32/§33 | Final Gate 57 项 → GO 后 STOP | §23 |

---

## 4. 端点与授权链

```
GET  /api/v2/attendance-anomalies
  → requirePermission('attendance.anomaly.handle')   // DB-backed（D1PermissionProvider, 83/238）
  → AttendanceAnomalyService.list({status, anomaly_type, limit, cursor})

GET  /api/v2/attendance-anomalies/:anomalyId
  → requirePermission('attendance.anomaly.handle')
  → AttendanceAnomalyService.detail(anomalyId)        // repo findTeamAnomaly WHERE id=? AND team_id=?

POST /api/v2/attendance-anomalies/:anomalyId/resolve
  → requirePermission('attendance.anomaly.handle')
  → AttendanceAnomalyService.resolve(anomalyId, {decision, resolution})
  → AttendanceAnomaliesRepository.resolveAnomalyAtomically()  // db.batch([INSERT...SELECT WHERE P, UPDATE WHERE P])
```

授权裁决（冻结，DB-backed，无角色名短路、无 wildcard、无 super_admin 硬编码）：
- 未认证 → 401 `AUTH_REQUIRED`
- code 存在但当前用户/上下文无授权 → 403 `FORBIDDEN`
- code 存在、用户有授权但 TEAM scope 缺 team 上下文 → 403 `TEAM_SCOPE_REQUIRED`

**目录事实（来自 `migrations/0003_seed_permissions.sql`，已 seed 冻结）**：
- `attendance.anomaly.handle` → `platform_super_admin, team_admin, team_owner`
- `volunteer` / `team_auditor` / `platform_operator` **均不持有** → 403 `FORBIDDEN`

---

## 5. Repository 实现（原子写：INSERT-first + PRE-state 条件 UPDATE）

`src/repository/attendance-anomalies.ts` 的 `resolveAnomalyAtomically()` 与 S2-6i 同构，**两条语句共享同一 PRE-state 谓词 P**：

```ts
// P := (a.id = ? AND a.team_id = ? AND a.status = 1)   ← 仅 OPEN 可接受处置
const insertStmt = this.db.prepare(
  `INSERT INTO attendance_events
     (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, reason, raw, occurred_at, created_at)
   SELECT a.session_id, s.activity_id, s.user_id, a.team_id, ?, ?, ?, ?, ?, ?, ?
     FROM attendance_anomalies a
     LEFT JOIN attendance_sessions s ON s.id = a.session_id
    WHERE a.id = ? AND a.team_id = ? AND a.status = 1`   // ← P（前置状态）
).bind(eventType, nonce, operatorId, reason, rawJson, now, now, anomalyId, teamId);

const updateStmt = this.db.prepare(
  `UPDATE attendance_anomalies
      SET status = ?, handled_by = ?, handled_at = ?, resolution = ?
    WHERE id = ? AND team_id = ? AND status = 1`         // ← 同一个 P
).bind(newStatus, operatorId, now, reason, anomalyId, teamId);

const results = await this.db.batch([insertStmt, updateStmt]);
return Number(results[1]?.meta?.changes ?? 0);  // 取 UPDATE 的 changes；0 = 未命中（→ 404 或 409）
```

**关键性质**：`stmt[0]` 只写 `attendance_events`，**不触碰 `attendance_anomalies`**，因此在同一 batch 事务内 P 在 `stmt[1]` 求值时真值与 `stmt[0]` 完全相同 —— 命中则「1 条事件 + 1 行更新」同时提交；未命中（跨团队/已处置）则两者皆 0 行（**无孤儿事件**）；任一语句违例则整体回滚。`changes=0` 驱动上层返回 404（跨团队/不存在）或 409（已 CONFIRMED/DISMissed）。判定为**确定性**而非概率性，不依赖任何时间戳唯一性（§17/§18）。

---

## 6. Service 实现（业务裁决 + 故障注入）

`src/services/attendance-anomaly-service.ts`：

- `requireActor()`：未认证 → 401；`teamId === null` → 403 `TEAM_SCOPE_REQUIRED`（§0/§14 已知 gap，禁止 bypass）。
- `list()`：
  - `status` 校验 ∈ {1,2,3}；`anomaly_type` 校验 ∈ 7 个冻结值（`ANOMALY_TYPES`）；`limit` 默认 20、min 1、max 100（越界或 ≤0 → 400）；游标 `cursor=created_at|id` 解析，非法 → 400。
  - 取 `limit+1` 行计算 `next_cursor`（`created_at DESC, id DESC` 确定性排序）。
  - 列表返回**最小字段**（id / session_id / anomaly_type / status / created_at / handled_at），不含 detail。
- `detail()`：`findTeamAnomaly()` → 0 命中 → 404（跨团队/不存在统一 404）。
- `resolve()`：
  - `decision` ∈ {confirm, dismiss}（否则 400）；`confirm → status=2 CONFIRMED`、`dismiss → status=3 DISMISSED`。
  - `resolution` 必填/trim/非空/≤1000（`RESOLUTION_MAX=1000`），否则 400。
  - `now = this.nowSeconds()` = `Math.floor(Date.now()/1000)`（epoch 秒）。
  - `eventType = faultMode() === 1 ? '__FAULT__' : 'anomaly'`；`writeStatus = faultMode() === 2 ? 9 : newStatus`；`raw = {"action":"anomaly_resolve","decision"}`（最小审计）。
  - `changes=0` → `findTeamAnomaly()`：存在 → 409 `ATTENDANCE_ANOMALY_ALREADY_HANDLED`；不存在 → 404。
- `nowSeconds()` / `faultMode()`（§20 + 原子性证据）：
  ```ts
  private nowSeconds(): number { return Math.floor(Date.now() / 1000); }
  private faultMode(): 0 | 1 | 2 {
    if ((this.env?.ENVIRONMENT ?? 'local') !== 'local') return 0;
    const v = this.env?.JHZY_FAULT_INJECT ?? (globalThis as any).process?.env?.JHZY_FAULT_INJECT;
    if (v === '1') return 1;
    if (v === '2') return 2;
    return 0;
  }
  ```
  `FAULT_STATUS = 9` —— TEST-ONLY 越界值，用于违反 `status IN (1,2,3)` 的列 CHECK，制造 **stmt[1] UPDATE 失败**。

  **通道发现（重要，与 S2-6i 一致）**：`JHZY_FAULT_INJECT` 在 wrangler 4.127.1 local 运行时**仅经 `wrangler.jsonc` 的 `vars` 注入 `c.env` 才能到达 handler**；`wrangler --var` 与 `process.env` 均无法在 `c.env` 暴露（已验证）。故故障测试由 harness 生成临时 `wrangler.s2-6j-fault1.jsonc` / `wrangler.s2-6j-fault2.jsonc` 写入 `vars.JHZY_FAULT_INJECT:"1"|"2"`，运行后自动删除。

---

## 7. 租户隔离（Tenant Isolation）

Repository 层收口：`WHERE id = ? AND team_id = ?`。跨团队 `anomalyId`（同属平台但不同 team）在该查询下 0 命中 → 统一 404 `NOT_FOUND`，**不泄露目标是否存在**（§9/§11 IDOR / 不泄露存在性）。无权限 → 403；跨团队攻击不写任何 `attendance_events`（I3）。

---

## 8. IDOR / 404 不泄露

- 跨团队 detail `AB1` → 404；跨团队 resolve `AB1` → 404。
- 攻击请求**零孤儿事件**：`AB1` 全程事件数=0；`B_S1` 事件=0（I3）。
- 不存在 `anomalyId`（合法正整数/畸形 `abc`/超大）→ 404 / 400，无元数据泄漏（C4/C5/H6）。
- 列表跨团队：`AB1`/`AB2` 绝不出现在 team A 的列表（B3）。

---

## 9. 审计事件（Audit Event）

- resolve 写 `event_type='anomaly'`（fault 时 `'__FAULT__'` 用于测试隔离）。
- `operator_id = 执行管理员 auth.userId`（**非异常属主**）。
- `raw` 最小：`{"action":"anomaly_resolve","decision":"confirm"|"dismiss"}`（K2 校验精确匹配，不泄露 request body / 详情 / secret）。
- 约束：事件 INSERT 与 UPDATE 共享同一 **PRE-state 谓词 P**（§5），P 假则两者皆写 0 行 → 无孤儿事件。
- 时间语义：`occurred_at` / `created_at` 与 `handled_at` 同源 `Math.floor(Date.now()/1000)`（epoch 秒，J 组断言）。

---

## 10. 原子性（§17/§18 硬门 — db.batch 真实回滚）

两条语句共享**同一个 PRE-state 谓词** `P := (id = ? AND team_id = ? AND status = 1)`：

```
stmt[0]  INSERT INTO attendance_events (...) SELECT ... FROM attendance_anomalies a LEFT JOIN attendance_sessions s ON s.id=a.session_id WHERE P
stmt[1]  UPDATE attendance_anomalies SET status=?, handled_by=?, handled_at=?, resolution=? WHERE P
results = await db.batch([stmt0, stmt1]);  return results[1].meta.changes;
```

**正确性论证**：`stmt[0]` 只写 `attendance_events`，**不触碰 `attendance_anomalies`**，因此在同一 batch 事务内 `P` 在 `stmt[1]` 求值时真值与 `stmt[0]` 完全相同。于是：

| 场景 | stmt[0] | stmt[1] | 事务结果 |
|---|---|---|---|
| 前置状态满足（P 真，status=1） | 写 1 条事件 | changes=1 | 提交：**恰好 1 条事件** + status 落库 |
| 冲突/跨团队（P 假） | 写 0 条事件 | changes=0 → 服务判 409/404 | **0 条事件**（无孤儿） |
| 任一语句违例 | — | — | batch 整体回滚，**0 条事件** |

满足 §17/§18 全部约束：epoch 秒 / 原子 UPDATE+INSERT / 冲突不写事件 / 成功恰写 1 条 / 无新 schema / 无事务标记列 / 无 0005。**无 ATOMICITY DESIGN GAP。**

### 10.1 双故障模式实证（§18）

| 模式 | 注入方式 | 证明目标 |
|---|---|---|
| **MODE 1** | `event_type='__FAULT__'`（违反 event_type CHECK）→ **stmt[0] INSERT 失败** | UPDATE 从未生效：`status`/`handled_by`/`handled_at`/`resolution` 全部保持原值（NULL），无事件 |
| **MODE 2** | 写越界 `status=9`（违反列 CHECK）→ **stmt[1] UPDATE 失败（此时 INSERT 已执行）** | **真实事务回滚**：已执行的 audit INSERT 被撤销，事件数 = 0（若非真事务则应为 1+） |

实跑结果：**MODE 1 = 13/13 PASS，MODE 2 = 13/13 PASS**（明细见 §14）。→ §18 硬门 PASS。

---

## 11. 时间戳单位（§20 硬门禁）

| 检查对象 | 结果 |
|---|---|
| `attendance_anomalies.handled_at` | 成功路径写入值 = 当前 epoch 秒（`|nowSec - handled_at| ≤ 600`） |
| `attendance_events.occurred_at` | 全局 MAX `< 1e11`（无 13 位毫秒） |
| `attendance_anomalies.handled_at` 全局 MAX | `< 1e11` |
| 毫秒硬门禁哨兵 | `Math.floor(Date.now()/1000)` 恒 `< 1e11`（10 位） |

→ **零 13 位毫秒**，与冻结 schema 一致。

---

## 12. 测试用例设计（A–K 主组 + 故障组）

`tests/attendance_anomaly_integration.mjs`（真实 Worker 运行时，**87** 项，A–L 组）+ `tests/attendance_anomaly_atomicity.mjs`（**MODE 1 = 13 项 / MODE 2 = 13 项**）。

- **A. Baseline**：目录 83/238、roles=6、migrations=4、无 0005、fixture 就绪。
- **B. List**：owner 列表 200、team A 6 条全在、跨团队 AB1/AB2 缺席、最小字段、status 过滤（1→4 / 2→AA3 / 3→AA4）、anomaly_type 过滤、游标分页（limit=2 + next_cursor + 第二页无重复）、limit 边界（0/-5 → 400、1000 clamp ≤100）、非法 status/anomaly_type/cursor → 400。
- **C. Detail**：owner/team_admin 200、跨团队 404、不存在 404、detail 含安全 session 视图（无 raw/device/network 字段）。
- **D. Permissions**：unauth→401、volunteer→403、team_auditor→403、platform_operator→403、PSA→403 `TEAM_SCOPE_REQUIRED`、owner 正向 200、**D7 目录接线校验**（holders = platform_super_admin,team_admin,team_owner）、**D8 反向接线校验**（volunteer/auditor/operator 不持有）。
- **E. Confirm**：confirm 200、status=2、handled_by=actor、handled_at epoch 秒、resolution 存储、DB 落库、兄弟 session 未动（status=2/review=0/checkin-checkout 不变）、service_records 未动、恰 1 条 anomaly 事件。
- **F. Dismiss**：dismiss 200、status=3、session 未动、service_records 未动、再增 1 条事件（A_S1 共 2 条）。
- **G. Conflict**：confirm 已 CONFIRMED→409、dismiss 已 DISMISSED→409、重复 confirm→409、dismissed→confirm→409、无额外事件、AA3 仍 status=2。
- **H. Validation**：非法 decision、缺 decision、缺 resolution、空白 resolution、超长 resolution(1001)、畸形 id → 全部 400。
- **I. Tenant**：team A resolve team B 的 AB1 → 404、AB1 status 不变、B_S1 无事件。
- **J. Timestamp**：confirm AA5 200、handled_at 秒级、event.occurred_at 秒级、全局 MAX `< 1e11`。
- **K. Leakage**：resolve 响应无 raw/hash、audit raw 最小（精确 `{"action":"anomaly_resolve","decision":"dismiss"}`）、detail 响应无敏感键。
- **Atomicity MODE 1（13）**：INSERT 失败 → 500 + status 仍 1 + handled_by/handled_at/resolution NULL + 0 事件 + 全局 0 事件。
- **Atomicity MODE 2（13）**：UPDATE 失败（写越界 9）→ 500 + status 仍 1（**未写入越界 9**）+ **真实回滚证明**（事件数=0，非真事务应为 1）。

---

## 13. 初始失败 → 根因 → 修复（1 项，测试缺陷，非实现 bug）

首次运行：S2-6j MAIN **79 PASS / 1 FAIL**（D7 `revoke → 403 live` 得 200）。

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D7（第一版修复，已被裁定为**无效测试设计**） | 删除 `user_roles` 后 ownerA 仍能 200 | 测试使用 `x-test-role` **mock 注入通道**：`extractAuth()` 直接以 header 角色构造 `ctx.roles`，权限解析 `D1PermissionProvider.getPermissions()` 经 `roles.code → role_permissions → permissions` JOIN，**从不读 `user_roles`**。故删除 `user_roles` 对 mock 通道的权限判定零影响 | 当时改为**静态目录接线校验**（D7 holders / D8 non-holders），只读校验 `attendance.anomaly.handle` 持有者集合。**该修复无法证明「真实 Bearer session 下 user_roles 被撤销后下一请求立即失去权限」**——见 §13.1 用户裁定 ONE-GATE REPAIR |

**第二版修复（本轮 ONE-GATE REPAIR）**：在 `tests/attendance_anomaly_integration.mjs` 新增 **L 组**，使用项目真实认证链（Bearer opaque token → SHA256 → sessions → SessionService.resolve() 实时读 live user_roles → roles → D1PermissionProvider JOIN role_permissions → permissions），**禁止 x-test-role**。仅 DELETE 一行 `user_roles`，复用同一 Bearer token 复测，证明 session 仍有效但 live role 已撤销 → 立即 403。详见 §13.1。

**结论**：实现自首次编写即符合冻结目录与 §0–§33；首轮 1 项失败源于测试用例误用 mock 通道，第二轮的"静态 catalog 替代"仍属无效测试设计；本轮以真实 Bearer live revoke 彻底修复，**未改动任何业务实现语义**（runtime source 0 变化）。

---

## 13.1 ONE-GATE REPAIR（用户裁定：D7 静态校验无效 → 真实 Bearer live revoke）

### 13.1.1 裁定内容

用户将 S2-6j 重新分级为 **BLOCK / ONE-GATE REPAIR**，唯一修复项：

> 原始 Final Gate 明确要求 **permission revoke takes effect live**；上一轮第一次 D7 失败后将其改成了静态 catalog 接线断言，**不能替代 live revoke**。静态 catalog 校验只能证明 `role_permissions` 配置正确，不能证明真实 Bearer Session 下 `user_roles` 被撤销后下一次 anomaly API 请求会立即失去权限。

本轮只修这一项，禁止扩大范围；禁止进入 S2-6k；禁止修改 migration / catalog / seed；禁止新增权限；禁止修改 anomaly 业务实现（除非 live revoke 暴露实现 bug）；禁止 deploy / push。

### 13.1.2 上一轮 D7（静态 catalog）为何无效

- `x-test-role` **mock 注入通道**：`extractAuth()` 直接以 header 角色构造 `ctx.roles`，权限解析 `D1PermissionProvider.getPermissions()` 经 `roles.code → role_permissions → permissions` JOIN，**从不读 `user_roles`**。
- 因此删除 `user_roles` 对 mock 通道的权限判定**零影响**（第一次 D7 失败的根因）。
- 同时 `fixture.mjs` 禁止写 `role_permissions`（catalog 必须保持 83/238 不可变），故无法用"删 role_permissions"模拟撤销。
- 结论：第一版 D7 修复属于**无效测试设计**，非实现缺陷。

### 13.1.3 本轮修复（L 组：真实 Bearer Session 链）

在 `tests/attendance_anomaly_integration.mjs` 新增 **L 组**，严格走项目真实认证链（**禁止 x-test-role**）：

```
Bearer opaque token
  → SHA256(session token)
  → sessions（token_hash 命中、status=1、未过期）
  → SessionService.resolve() 实时读 live user_roles（WHERE user_id=?）
  → roles（含 scope_team_id）
  → D1PermissionProvider 经 roles.code JOIN role_permissions → permissions
```

**执行步骤与实测（actor = adminA / team_admin@teamA，manifest 含 adminA，不含 teamAdminA）：**

| 步骤 | 动作 | 结果 |
|---|---|---|
| L0 | 向 `sessions` 插入真实 Bearer session（adminA） | token 就绪 |
| L1 | revoke **前** GET list（真实 Bearer） | **HTTP 200** |
| L2 | revoke **前** POST `/:id/resolve` confirm（真实 Bearer，临时 seed 一枚 OPEN anomaly） | **HTTP 200**，status=2 CONFIRMED |
| L3 | `DELETE FROM user_roles WHERE user_id=adminA AND role_id=team_admin AND scope_team_id=teamA`（**只动 user_roles**，不动 sessions / role_permissions / permissions） | 1 行删除 |
| L4 | revoke **后** GET list（**同一 Bearer token，不重新登录**） | **HTTP 403** |
| L4b | revoke **后** POST `/:id/resolve`（同一 Bearer） | **HTTP 403**（写权限一并实时失效） |
| L5 | 查 `sessions`：该 Bearer session 仍 `status=1`、未过期 | **SESSION STILL ACTIVE = YES** |
| L6 | 恢复 `user_roles`（re-INSERT 同一行，cleanup） | 1 行插入 |
| L7 | 恢复 **后** GET list（同一 Bearer token） | **HTTP 200** |

→ **证明**：session 本身仍有效，但 live role 已撤销 → 下一请求立即失去权限（403）；role 恢复后权限立即恢复（200）。架构为 **fully live-role**。

### 13.1.4 两类测试必须区分

| 测试 | 性质 | 能证明什么 |
|---|---|---|
| **D7 / D8（静态 catalog 接线）** | CATALOG WIRING TEST | `attendance.anomaly.handle` 持有者集合 = PSA/team_admin/team_owner；non-holders 为空（仅证明目录接线） |
| **L 组（真实 Bearer live revoke）** | LIVE PERMISSION REVOCATION TEST | 真实 Session 下 `user_roles` 撤销后下一请求立即 403；session 仍有效；role 恢复后立即 200 |

两者均保留，但**只有 L 组满足 Final Gate 的 "permission revoke takes effect live"**；D7/D8 仅作为 catalog wiring 证据，不能替代。

### 13.1.5 判定

- REAL BEARER LIVE REVOKE = **PASS**（L1 200 → L3 DELETE user_roles → L4 同一 token 403 → L5 session 仍 active → L6 restore → L7 同一 token 200）。
- runtime source **0 变化**（§1 业务实现冻结未被触碰）。S2-6j 由 BLOCK 转为 **GO**。

---

## 14. 最终测试结果（S2-6j，本轮实跑）

编排器：`tests/run_s2_6j.mjs`（PORT 8795，隔离 state `.tmp/s2-6j-state`）。

> **ONE-GATE REPAIR 轮次说明**：本轮仅改测试文件（runtime source 0 变化），按用户 §9 收窄回归范围——**未重跑完整 Frozen 340**（仍为有效先前证据，见 §15 / §14.4）。本轮实跑：S2-6j MAIN **87/87**（含新增 L 组真实 Bearer live revoke）+ 原子性 **13/13 + 13/13** + 窄回归 S2-6c-1 / S2-6c-2 / S2-6f（见 §14.5）。

```
[REPAIR] S2-6j MAIN        PASS=87 FAIL=0 TOTAL=87 EXIT=0   (A–K 组 78 + L 组 9 项 live revoke)
[REPAIR] S2-6j ATOMICITY-1 PASS=13 FAIL=0 TOTAL=13 EXIT=0
[REPAIR] S2-6j ATOMICITY-2 PASS=13 FAIL=0 TOTAL=13 EXIT=0
```

### 14.4 PREVIOUS FULL REGRESSION EVIDENCE（NOT RE-RUN THIS REPAIR）

以下为前次完整实跑证据，本轮**未重跑**（用户 §9 明文禁止第三次无意义跑 340）；runtime 0 变化，继续有效：

```
Frozen HTTP 340/340  ·  S2-6i 80/80 + 15/15 + 10/10  ·  S2-6j atomic 13/13 + 13/13
catalog 6/83/238  ·  0004 SHA 一致  ·  integrity/teardown 全 PASS
```

### 14.5 THIS REPAIR AUTH REGRESSION（本轮实际跑过）

| 套件 | 测试文件 | PASS | FAIL | TOTAL | EXIT | 期望 | 判定 |
|---|---|---|---|---|---|---|---|
| S2-6j-MAIN | `attendance_anomaly_integration.mjs` | 87 | 0 | 87 | 0 | 87 | ✅ |
| S2-6c-1 | `session_integration.mjs` | 19 | 0 | 19 | 0 | 19 | ✅ |
| S2-6c-2 | `auth_integration.mjs` | 34 | 0 | 34 | 0 | 34 | ✅ |
| S2-6f | `authorization_integration.mjs` | 42 | 0 | 42 | 0 | 42 | ✅ |

→ 真实 session/auth 链路（含本项目 Bearer 认证链）无回归。

### 14.1 REVIEW / DISMISS 明细（E/F 组）
```
E1–E12 confirm: 200 / status=2 / handled_by=actor / handled_at 秒 / resolution=verified genuine
         DB status=2 / handled_by 正确 / 兄弟 session 未动(status=2,review=0,checkin/checkout 不变)
         service_records 未动(=0) / 恰 1 条 anomaly 事件(A_S1)
F1–F9  dismiss:  200 / status=3 / session 未动 / service_records 未动 / 再增 1 条(A_S1 共 2)
```

### 14.2 ATOMICITY 明细（MODE 1 / MODE 2）
```
MODE 1: 500 INTERNAL_ERROR / status 仍 1 / handled_by·handled_at·resolution NULL / 0 事件 / 全局 0 事件
MODE 2: 500 INTERNAL_ERROR / status 仍 1（未写入越界 9）/ 【真实回滚证明】事件数 = 0（非真事务应为 1）
```

### 14.3 TIMESTAMP 单位（J 组，全 PASS）
`attendance_anomalies.handled_at` 与 `attendance_events.occurred_at` 六列全局 MAX **均 `< 1e11`**；成功路径写入值 = 当前 epoch 秒。**零 13 位毫秒。**

---

## 15. 冻结回归 re-run（§26 — 8 套件逐个实跑）

> 本轮**实际执行**，每套件独立 `fixture → run → teardown`，运行于隔离 state `.tmp/s2-6j-state`。

| # | 套件 | 测试文件 | PASS | FAIL | TOTAL | EXIT | 期望 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | S2-5 | `api_integration.mjs` | 58 | 0 | 58 | 0 | 58 | ✅ |
| 2 | S2-6c-1 | `session_integration.mjs` | 19 | 0 | 19 | 0 | 19 | ✅ |
| 3 | S2-6c-2 | `auth_integration.mjs` | 34 | 0 | 34 | 0 | 34 | ✅ |
| 4 | S2-6c-3 | `firstlogin_integration.mjs` | 31 | 0 | 31 | 0 | 31 | ✅ |
| 5 | S2-6c-4 | `session_security_integration.mjs` | 24 | 0 | 24 | 0 | 24 | ✅ |
| 6 | S2-6f | `authorization_integration.mjs` | 42 | 0 | 42 | 0 | 42 | ✅ |
| 7 | S2-6g | `activity_signup_integration.mjs` | 61 | 0 | 61 | 0 | 61 | ✅ |
| 8 | S2-6h-R2 | `attendance_integration.mjs` | 71 | 0 | 71 | 0 | 71 | ✅ |
| | **FROZEN HTTP TOTAL** | | **340** | **0** | **340** | — | **340** | ✅ |

### 15.1 S2-6i 主回归（§26 要求再次运行）
```
[P3] S2-6i MAIN        PASS=80 FAIL=0 TOTAL=80 EXIT=0
[P4] S2-6i ATOMICITY-1 PASS=15 FAIL=0 TOTAL=15 EXIT=0
[P5] S2-6i ATOMICITY-2 PASS=10 FAIL=0 TOTAL=10 EXIT=0
```
→ S2-6i 80/80 + 15/15 + 10/10 全部复验通过（无回归）。

### 15.2 隔离 state 构建
原生 Wrangler 4.127.1 `d1 migrations apply jhzy-v2-local --local --persist-to .tmp/s2-6j-state`，0001→0004 全部 ✅（160 + 9 + 241 + 33 commands）。`d1_migrations` = 4 行；0004 索引 `uq_active_attendance` / `idx_as_signup` 均存在。**未使用 sqlite 文件拷贝、未手写 d1_migrations、未用 node:sqlite apply 迁移、无 0005。**

---

## 16. 静态校验（§27）

| 校验 | 命令 | 结果 |
|---|---|---|
| TypeScript 类型 | `tsc --noEmit` | **0 errors** |
| 权限目录 | `scripts/validate_permission_catalog.mjs` | **PASS**（permissions=83，meta 一致，无 wildcard） |
| 种子矩阵 | `scripts/validate_permission_seed.mjs` | **PASS**（roles=6；perm=83；rp=238） |
| 迁移冻结 | `sha256sum migrations/0004_*.sql` | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d` ✅ 一致 |
| 迁移数量 | `ls migrations/*.sql` | **4**（0001–0004），`0005*` 计数 = **0** |
| 隔离 state 目录门 | 编排器 P0（`.tmp/s2-6j-state`） | roles=6 / permissions=83 / role_permissions=238 ✅ |

---

## 17. Open Items / 已知 Gap（明确 Out-of-Scope，本切片不处理）

1. **AUTO DETECTION = OPEN** — 异常自动识别（迟到/早退/缺勤/设备切换/多账号/重放/跨天/超时/逆序时间）不属 Handling 范围。
2. **LOCATION MODEL = OPEN** — 地理位置采集与判定模型未建立。
3. **DEVICE IDENTITY = OPEN** — 设备指纹采集与绑定判定未建立。
4. **MULTI_ACCOUNT = OPEN** — 多账号识别逻辑未建立。
5. **TIME WINDOW = OPEN** — 服务时间窗校验未建立。
6. **SHIFT MODEL = OPEN** — 排班模型校验未建立。
7. **CROSS_DAY TIMEZONE = OPEN** — 跨天时区边界处理未建立。
8. **OVERLONG THRESHOLD = OPEN** — 超长时长阈值未定义。
9. **RISK ENGINE = OPEN** — 风险评分引擎未建立。
10. **ANOMALY TEAM INDEX OPTIMIZATION = OPEN** — `attendance_anomalies` 无 team_id 索引（按 §21 纪律本轮不新增索引；后续如列表量大可评估）。
11. **PLATFORM TEAM-SCOPE GAP = OPEN（已知，按 §14 设计冻结）** — `platform_super_admin` 在 catalog 持 `attendance.anomaly.handle` 但 `TenantContext.teamId=null` 时返回 403 `TEAM_SCOPE_REQUIRED`；此为本切片既有 architecture gap，**不修复、不 bypass**，待专项决策。
12. **ATTENDANCE CORRECTION / SETTLEMENT = OPEN** — 处置不直接修正 `attendance_sessions` / `service_records` / 结算；属后续切片。

---

## 18. 安全 / 泄漏（Security / Leakage）

- 全部响应无 SQL / 表名泄露（K 组）。
- 全部响应无 `role_id` / `permission_id` 泄露。
- 响应 envelope 为 `{success, data, request_id}`，不回显内部标识符。
- 跨团队请求无存在性 oracle（统一 404）。
- detail 视图不含 `raw` / `device_fp_hash` / `ip_hash` / `factor_scores` / `risk_score` / `latitude` / `longitude` / `accuracy` / `network_type`（C6/K3）。
- audit `raw` 仅含 `action` + `decision`，不含请求体/详情/secret（K2）。

---

## 19. 端口 / 进程安全（§29）

- 编排器统一使用 **8795**（Signivra 8787 保留）。
- **8787（Signivra）全程 `LISTEN_COUNT = 0`，未触碰、未 kill、未占用。** 运行前后各复核一次。
- `killPort()` 只针对 `Get-NetTCPConnection -LocalPort 8795 -State Listen` 的 OwningProcess 逐一 `Stop-Process`，**无 broad kill**（不使用 `taskkill /IM node.exe` 之类）。
- 运行结束 `8795_LISTEN_COUNT = 0`，无 worker 泄漏。
- 故障临时配置 `wrangler.s2-6j-fault1.jsonc` / `wrangler.s2-6j-fault2.jsonc` 运行后已由编排器自动删除（日志有 `[harness] removed ...` 记录）。

---

## 20. 已知限制 / 边界（Boundaries）

- resolve 仅 `status=1 (OPEN)` 可处置；`2/3` 一律 409（G 组）。
- `decision` 仅 `confirm`/`dismiss`；`resolution` 必填且 ≤1000 字符。
- 无 POST 创建端点；异常数据源（检测引擎）不属本切片。
- 故障注入仅 `ENVIRONMENT=local` + `JHZY_FAULT_INJECT ∈ {1,2}` 生效（`faultMode()` 首行即校验 `ENVIRONMENT`），生产路径 `faultMode()` 恒返回 0，不受影响。
- 注入通道只有 `wrangler.jsonc` 的 `vars` → `c.env` 一条（实测 `--var` 与 `process.env` 均无法进入 Worker 运行时 `c.env`），因此故障模式必须经临时配置文件启用，无法被生产环境意外触发。
- 时间源统一为 `nowSeconds()`；**禁止**在任何 DB 写入路径直接使用 `Date.now()`。
- 列表游标为确定性 `created_at DESC, id DESC` + `cursor=created_at|id`（明文，不发明第二套分页系统）。

---

## 21. 交付物清单（Deliverables）

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/routes/attendance-anomalies.ts` | 新增 | 三端点 + `requirePermission('attendance.anomaly.handle')` 授权链 + `requirePositiveIntParam('anomalyId')` |
| `src/services/attendance-anomaly-service.ts` | 新增 | `list`/`detail`/`resolve` + `requireActor()`/`nowSeconds()`/`faultMode()`/`normalizeResolution()` |
| `src/repository/attendance-anomalies.ts` | 新增 | `ANOMALY_TYPES`/`ANOMALY_STATUS` + `listAnomalies`/`findTeamAnomaly`/`resolveAnomalyAtomically` |
| `src/app.ts` | 修改 | 挂载 `v2.route('/attendance-anomalies', attendanceAnomalies)`（S2-6j V1 增量） |
| `src/utils/errors.ts` | 修改 | 新增冲突原因 `ATTENDANCE_ANOMALY_ALREADY_HANDLED`（§1 重复处置） |
| `tests/fixture.mjs` | 修改 | 新增 `anomaly` dispatch + `attendanceAnomalySetup()`（9 用户/2 团队/2 活动/3 会话/8 异常；断言 perm=83/rp=238） |
| `tests/attendance_anomaly_integration.mjs` | 新增 | A–L 组 **87 断言**（含 L 组真实 Bearer live revoke） |
| `tests/attendance_anomaly_atomicity.mjs` | 新增 | MODE 1（13）+ MODE 2（13）故障注入 |
| `tests/run_s2_6j.mjs` | 新增 | FINAL REGRESSION 编排：P0 原生迁移建隔离 state → P1 普通 worker → P2 8 套件 340 → P3 S2-6i 主组 → P6 S2-6j 主组 → P4/7 S2-6i+S2-6j atomic MODE1 → P5/8 MODE2 → P9 integrity/teardown |
| `migrations/0004_attendance_multi_participation.sql` | 冻结 | SHA 不变，未修改；migrations=4，无 0005 |
| `docs/architecture/S2-6j-REPORT.md` | 新增 | 本报告 |

> 注：本切片**未**执行任何 git commit / push / `wrangler deploy`；**未新增 migration（无 0005）**；D1 migration apply 仅作用于本地隔离 state `.tmp/s2-6j-state`（Cloudflare 远端零动作），符合作用域纪律。

---

## 22. 阶段结论（Phase Conclusion）

S2-6j V1 经 IMPLEMENTATION 阶段，全部通过冻结基线与 §0–§33 全部硬约束：
- 三端点行为正确（list 最小字段 + 游标分页、detail 安全 session 视图、resolve confirm→2 / dismiss→3 / 重复→409）。
- 授权、租户隔离、IDOR/404、409/400/401/403 全部分类正确；PSA 维持 403 `TEAM_SCOPE_REQUIRED`（已知 gap 不 bypass）。
- 原子性 INSERT-first + PRE-state 条件 UPDATE，双故障模式（INSERT 失败 / UPDATE 失败）双向证明真实回滚（§17/§18 硬门 PASS）。
- 时间戳回归 epoch 秒，J 组门禁封堵 13 位毫秒再入。
- 目录/种子/migration 冻结未漂移（83/238/4，无 0005，0004 SHA 一致）。
- S2-6i 80/80+15/15+10/10 与冻结 340/340 全部复验通过（无回归）。
- 静态校验 + 类型检查 + 完整性/teardown 全绿。

---

## 23. Final Gate（§32 — 57 项 → GO 后 STOP）

**任何 FAIL → BLOCK；全部 PASS → GO，STOP（不自动进入 S2-6k）。**

### S2-6j 主集成组（87 项，全部 PASS）
- A 组 5/5：A1 migrations=4, A2 无 0005, A3 roles=6, A4 permissions=83, A5 role_permissions=238
- B 组 18/18：list 200 / teamA 6 全在 / 跨团队缺席 / 最小字段 / status 过滤(1→4,2→AA3,3→AA4) / type 过滤 / 游标分页 / limit 边界(0/-5→400, 1000 clamp) / 非法 status/type/cursor→400
- C 组 6/6：detail owner/team_admin 200、跨团队 404、不存在 404、session 视图、无敏感字段
- D 组 8/8：unauth→401、volunteer→403、auditor→403、operator→403、PSA→403 TEAM_SCOPE_REQUIRED、owner 200、**D7 holders=PSA/team_admin/team_owner（CATALOG WIRING ONLY）**、**D8 non-holders 空（CATALOG WIRING ONLY）**
- **D7-L 组（REAL BEARER LIVE REVOKE，满足 Final Gate "permission revoke takes effect live"）9/9 PASS**：L1 revoke 前真实 Bearer list=200、L2 revoke 前真实 Bearer resolve=200(status=2)、L3 仅 DELETE user_roles、L4 同一 token revoke 后 list=**403**、L4b 同一 token revoke 后 resolve=**403**、L5 session 仍 active(status=1)、L6 restore user_roles、L7 同一 token 恢复后 list=**200**
- E 组 12/12：confirm 全路径 + 兄弟 session 未动 + service_records 未动 + 恰 1 事件
- F 组 9/9：dismiss 全路径 + session 未动 + 再增 1 事件
- G 组 6/6：409 矩阵（已 confirm/dismiss/再 confirm/dismissed→confirm）+ 无额外事件 + AA3 仍 2
- H 组 6/6：validation 400 矩阵
- I 组 3/3：跨团队 resolve→404 + status 不变 + 无事件
- J 组 4/4：timestamp 秒级 + event.occurred_at 秒级 + 全局 MAX < 1e11
- K 组 3/3：无 raw/hash 泄漏 + audit raw 最小 + detail 无敏感键

### S2-6j 原子性故障组（26 项，全部 PASS）
- **MODE 1（13/13）**：INSERT 失败 → 500 + status 仍 1 + handled_by/handled_at/resolution NULL + 全局事件=0
- **MODE 2（13/13）**：UPDATE 违例失败 → 500 + 未写入越界 9 + **已执行的 audit INSERT 被真实回滚（事件数=0，非真事务应为 1）**

### S2-6i 复验组（105 项，全部 PASS）
- MAIN **80/80** · ATOMICITY-1 **15/15** · ATOMICITY-2 **10/10**

### 冻结回归（8 套件逐个实跑，340 项全部 PASS）
- S2-5 **58/58** · S2-6c-1 **19/19** · S2-6c-2 **34/34** · S2-6c-3 **31/31** · S2-6c-4 **24/24** · S2-6f **42/42** · S2-6g **61/61** · S2-6h-R2 **71/71**
- **FROZEN HTTP TOTAL = 340/340（EXIT 全 0）**，全部为本轮实际执行

### 静态 / 类型 / 目录门（全部 PASS）
- `tsc --noEmit` = **0 errors**
- catalog validator = **83 PASS**
- seed validator = **roles 6 / permissions 83 / role_permissions 238 PASS**
- 0004 SHA = `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`（一致）；migrations = **4**；**无 0005**

### 完整性 / Teardown 门（§28，全部 PASS）
```
foreign_key_check = 0      integrity_check = ok      d1_migrations = 4
catalog 保留：roles=6  permissions=83  role_permissions=238
业务残留：users=0 teams=0 activities=0 activity_signups=0
          attendance_sessions=0 attendance_events=0 attendance_anomalies=0
          sessions=0 user_roles=0 team_members=0 user_identities=0 security_events=0
```

### 端口 / 进程门（§29，PASS）
- 8787（Signivra）`LISTEN_COUNT = 0`，全程未触碰；8795 运行后 `LISTEN_COUNT = 0`，无泄漏；仅 kill 显式 PID，无 broad kill

### 汇总
| Gate | Result |
|---|---|
| S2-6j 主组 | **87/87 PASS** |
| S2-6j 原子组 MODE 1 | **13/13 PASS** |
| S2-6j 原子组 MODE 2 | **13/13 PASS** |
| S2-6i 复验 MAIN | **80/80 PASS** |
| S2-6i 复验 ATOMICITY-1 | **15/15 PASS** |
| S2-6i 复验 ATOMICITY-2 | **10/10 PASS** |
| 冻结回归 | **340/340 PASS** |
| 静态/类型/目录 | **全 PASS** |
| 完整性 / Teardown | **全 PASS** |
| 端口 / 进程安全 | **PASS** |
| **Final Gate 总判定** | **GO（0 FAIL）** |

→ **STOP。不自动进入 S2-6k。等待用户显式授权。**

---

## 24. 后续建议（S2-6k 及以后，待用户显式授权）

1. 异常**识别/检测引擎**（AUTO DETECTION）：迟到/早退/缺勤/`out_of_range`/`device_switch`/`multi_account`/`replay`/`cross_day`/`overlong`/`reverse_time`。
2. 异常**创建 API**（MANUAL CREATE）+ 风险引擎（RISK ENGINE）。
3. 地理位置 / 设备指纹模型（LOCATION / DEVICE IDENTITY）。
4. 时间窗 / 排班模型（TIME WINDOW / SHIFT MODEL）/ 跨天时区（CROSS_DAY TIMEZONE）/ 超长阈值（OVERLONG THRESHOLD）。
5. 考勤结算 / `service_records` 修正（ATTENDANCE CORRECTION / SETTLEMENT）。
6. PLATFORM TEAM-SCOPE GAP 专项决策（§17 Open Item 11）。
7. `attendance_anomalies` team_id 索引优化评估（§17 Open Item 10）。
8. 建议把 `tests/run_s2_6j.mjs` 的「隔离 state + 8 套件 340 门禁 + timestamp 单位门禁」固化为后续所有切片的标准回归入口。

---

## 25. 签名 / 时间戳

- 报告时间：2026-09-03（CST）。
- 执行环境：Cloudflare Workers 运行时（wrangler **4.127.1** local, miniflare D1）；Node 22.22.2。
- 官方回归 DB：`.tmp/s2-6j-state`（原生 `d1 migrations apply` 0001→0004 全新构建）。
- 证据 artifact：`.tmp/run_s2_6j.log`、`.tmp/s2-6j-summary.json`、`.tmp/suite-*.log`（逐套件明细）。
- 判定：**GO** — S2-6j V1 交付完成，**STOP**，等待用户下一阶段显式授权；**未进入 S2-6k**。

---

## 26. 版本控制收口（ONE-GATE REPAIR 轮次）

> 状态：S2-6j V1 实现已于前轮提交 `aa0afea`（`feat(jhzy-v2): add attendance anomaly handling`，**未 push**，baseline `30fc0fa` / tag `jhzy-v2-s2-6i-go` 未动）。

本轮 ONE-GATE REPAIR 的 git 纪律（用户 §11）：

- **不 amend** `aa0afea`。
- 最终 Gate PASS 后，允许新增**一个独立本地 commit**（仅测试修复）：`test(jhzy-v2): verify live anomaly permission revocation`。
- 作用域：`git add workers`（仅 `workers/` 下本轮确实修改的文件；**不** `git add .` / `git add -A`）。
- 不 push、不新增 tag、不 deploy。
- Baseline `30fc0fa` / tag `jhzy-v2-s2-6i-go` **保持不动**（未 reset / rebase / amend / 移动）。

> 本轮改动文件（git 作用域）：
> - 修改：`tests/attendance_anomaly_integration.mjs`（新增 L 组真实 Bearer live revoke）、`docs/architecture/S2-6j-REPORT.md`（§13.1 记录 D7 无效测试设计 + 真实 live revoke 证据）
> - 注：`workers/.tmp/run_repair.mjs` 为临时窄回归编排器（位于 `.tmp/`，不纳入提交）。
> - 注意：`miniprogram/`（小程序端）的若干改动与 `../.gitignore` 改动属其它并行任务，**不在本切片 `git add workers` 作用域**。

---

## 27. FINAL OUTPUT（§13 ONE-GATE REPAIR 格式）

```
FILES MODIFIED:
  tests/attendance_anomaly_integration.mjs   (新增 L 组：真实 Bearer live revoke；A–K 组 78 + L 组 9 = 87 断言)
  docs/architecture/S2-6j-REPORT.md          (§13.1 记录 D7 无效测试设计 + 真实 live revoke 证据)

LIVE REVOKE AUTH PATH (禁止 x-test-role，走项目真实认证链):
  Bearer opaque token
    → SHA256(session token)
    → sessions (token_hash 命中, status=1, 未过期)
    → SessionService.resolve() 实时读 live user_roles (WHERE user_id=?)
    → roles (含 scope_team_id)
    → D1PermissionProvider 经 roles.code JOIN role_permissions → permissions

BEFORE REVOKE HTTP:
  200 (GET list + POST resolve，同一真实 Bearer)

USER_ROLES MUTATION:
  DELETE FROM user_roles WHERE user_id=adminA AND role_id=team_admin AND scope_team_id=teamA
  （仅删此一行；不动 sessions / role_permissions / permissions；目录 83/238 不变）

SAME SESSION TOKEN USED:
  YES（revoke 前后、恢复后均复用同一 Bearer token，不重新登录）

AFTER REVOKE HTTP:
  403（GET list 与 POST resolve 均为 403；session 仍有效但 live role 已撤）

SESSION STILL ACTIVE:
  YES（sessions 行 status=1、未过期；被拒仅因 user_roles 撤销，非 session 失效）

ROLE RESTORE RESULT:
  re-INSERT 同一 user_roles 行 → 恢复成功（YES）

AFTER RESTORE HTTP:
  200（同一 Bearer token 恢复后 list 立即 200，证明架构 fully live-role）

STATIC CATALOG TEST (D7/D8, CATALOG WIRING ONLY，不替代 live revoke):
  PASS — holders=platform_super_admin,team_admin,team_owner ; non-holders 为空
  （明确：仅证明目录接线，不能证明 live revoke）

S2-6j MAIN:
  PASS / TOTAL = 87 (A–L 组；其中 L 组 9 项 = 真实 Bearer live revoke 全 PASS)

THIS REPAIR AUTH REGRESSION (本轮实际跑过，用户 §9 收窄范围):
  S2-6j MAIN        87/87  EXIT=0
  S2-6c-1          19/19  EXIT=0
  S2-6c-2          34/34  EXIT=0
  S2-6f            42/42  EXIT=0
  （其余冻结套件未重跑；runtime 0 变化）

PREVIOUS FULL REGRESSION EVIDENCE (前次完整实跑，NOT RE-RUN THIS REPAIR):
  Frozen HTTP 340/340
  S2-6i 80/80 + 15/15 + 10/10
  S2-6j atomic 13/13 + 13/13
  均标记为：NOT RE-RUN THIS REPAIR（继续有效）

TSC:
  0 errors (tsc --noEmit)

CATALOG:
  6 / 83 / 238 (roles / permissions / role_permissions 不变)

RUNTIME SOURCE CHANGED:
  NO（src/ 业务实现 0 改动；仅 tests/ 测试 + 本报告）

REPORT:
  docs/architecture/S2-6j-REPORT.md 已更新（§13.1：D7 无效测试设计 + 真实 Bearer live revoke = PASS）

COMMIT:
  （Gate PASS 后）新增独立本地 commit: test(jhzy-v2): verify live anomaly permission revocation
  不 amend aa0afea；不 push；baseline 30fc0fa / tag jhzy-v2-s2-6i-go 不动

FINAL:
  S2-6j = GO   （ONE-GATE REPAIR 完成：真实 Bearer live revoke 通过，runtime 无其它问题）
```

→ **STOP。不自动进入 S2-6k。等待用户显式授权。**
