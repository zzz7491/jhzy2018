# S2-6i 交付报告 — Attendance Review + Force Checkout

> 项目：嘉禾志愿小程序 2.0（Cloudflare Workers + D1）
> 切片：S2-6i — 考勤管理「审核 / 强制签退」两个端点
> 时间：2026-09-03（含审核轮修订）
> 审核受理状态：**S2-6i = BLOCK / REPAIR REQUIRED**（前一版 GO 已被撤销 —— BLOCKER A timestamp 单位回归 + BLOCKER B 冻结回归未实跑）
> 修复复验后判定：**GO** —— 见 §0 审核回执 与 §23 Final Gate
> 纪律：严格执行用户 §0–§23 + 审核轮 §1–§15；一次只验证、显式 STOP，无 S2-6j 自动进入。

---

## 0. 审核回执 — 前一版 GO 被撤销（BLOCK → REPAIR → RE-VERIFY）

### 0.1 正式状态变更

**本报告前一版（2026-09-03 首版）曾判定 `GO`。该判定经用户审核后被撤销。**

> **正式状态（审核轮受理时）：S2-6i = BLOCK / REPAIR REQUIRED**
> **不进入 S2-6j。**

审核认定两个 BLOCKER：

| BLOCKER | 认定内容 | 性质 |
|---|---|---|
| **A. timestamp 单位回归** | 服务层将 `now` 改为 `Date.now()`（13 位毫秒），用 `updated_at = now` 作为 batch 事务标记 —— 违反冻结 schema「所有 timestamp 列 = INTEGER Unix epoch **秒**」 | 实现 bug（数据语义污染） |
| **B. 冻结回归未实跑** | 前一版仅实跑 S2-6h-R2（71），其余 7 套件以「增量不变 + 静态全绿」**推定** 340/340 —— 属未经证实的 PASS 声明 | 证据缺陷 |

**前一版 §15 中「其余 7 个冻结套件保持冻结 340/340 基线」的推定式 PASS 声明已被删除**，替换为 8 个套件的**逐套件实跑**记录（见新 §15）。

### 0.2 修复与复验结论

两个 Gate 均已按审核要求处置并**实际实跑**复验：

| Gate | 处置 | 复验结果 |
|---|---|---|
| A | `nowSeconds() = Math.floor(Date.now()/1000)`；移除 `updated_at` 毫秒唯一性守卫 | T 组 11 项硬门禁全 PASS（`< 1e11`） |
| A' | 原子性重设计为「INSERT-first + PRE-state 条件 UPDATE」，**不依赖毫秒唯一性**、不加 schema/列/0005 | MODE 1 15/15 + MODE 2 10/10 PASS |
| B | 8 套件逐个 `fixture → run → teardown` 实跑 | **340/340**（58+19+34+31+24+42+61+71） |

→ 全部 Gate 通过后，最终判定改写为 **GO**（见 §23）。判定链：**GO(撤销) → BLOCK/REPAIR REQUIRED → 实跑复验 → GO**。

---

## 1. 范围（Scope）

本切片仅交付两个以 **session 级资源键** 为目标的端点（多参加模型下 `signup → N sessions`，管理操作必须命中 `attendance_session.id`，绝不通过 `signup_id` 唯一定位，§2/§11）：

- `POST /api/v2/attendance-sessions/:sessionId/review` — 权限 `attendance.record.review`（TEAM scope）
- `POST /api/v2/attendance-sessions/:sessionId/force-checkout` — 权限 `attendance.record.force`（TEAM scope）

**不含**（明确 Out-of-Scope，见 §17 Open Items）：考勤异常（anomaly）识别与处理、时间窗（time window）/ 地理位置（location）/ 排班模型（shift model）校验。

---

## 2. 冻结基线（Frozen Baseline，S2-6h-R2 GO 时锁定）

| 项 | 值 | 校验方式 |
|---|---|---|
| Migration `0004_attendance_multi_participation.sql` SHA256 | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d` | `sha256sum` ✓ 一致 |
| Migrations 总数 | 4（0001–0004） | `ls migrations/*.sql` = 4，无 0005 ✓ |
| Catalog roles | 6 | seed validator ✓ |
| Permissions | 83 | catalog/seed validator ✓ |
| role_permissions | 238 | seed validator ✓ |
| 冻结 HTTP 回归基线 | 340 / 340（S2-5=58, 6c-1=19, 6c-2=34, 6c-3=31, 6c-4=24, 6f=42, 6g=61, 6h-R2=71） | §15：本轮 **8 套件逐个实跑**实得 340/340 ✓ |
| 时间语义（新增显式冻结项） | 所有 timestamp 列 = INTEGER Unix epoch **秒**（10 位，禁 13 位毫秒） | §14.4 T 组 11 项硬门禁 ✓ |
| PSA 在 catalog 持 review/force 但 TenantContext.teamId=null | 必须 403 `TEAM_SCOPE_REQUIRED`（已知 architecture gap，本阶段不修复、不 bypass） | §0 |

---

## 3. 设计约束映射（§0–§23 → 实现）

| 条款 | 要求 | 实现落点 |
|---|---|---|
| §0 | PSA/平台角色无 team 上下文 → 403 `TEAM_SCOPE_REQUIRED` | `service.requireActor()`：teamId=null → `teamScopeRequired()` |
| §2 | 多参加：目标 `attendance_session.id`，绝不 `signup_id` | route `:sessionId` + repo `WHERE id=? AND team_id=?` |
| §3 | review decision `approve\|reject`；reject 需 reason；仅 0→1/0→2；重复 → 409 | `reviewSession()` 校验 + 原子 batch |
| §5 | force 需 reason；status=1 且 checkout_at NULL → 2，否则 409 | `forceCheckout()` 校验 + 原子 batch |
| §8 | TEAM scope + IDOR：跨团队 `sessionId` → 404（无存在性 oracle） | repo `WHERE id=? AND team_id=?`，无命中 → 404 |
| §9 | repo `WHERE id=? AND team_id=?` | 同上 |
| §10 | **原子性硬门**：UPDATE + event INSERT 经 `D1Database.batch(...)`，故障注入必须证明回滚；无法证明 → BLOCK | repo `db.batch([insertStmt, updateStmt])`（共享 PRE-state 谓词，§10.2）+ L 组 MODE 1 / P 组 MODE 2 fault injection |
| §16 | fixture（Team A/B/Platform；sessions R1–R5/F1–F5/B_R/B_F/MP_*） | `tests/fixture.mjs` `attendance-management` |
| §17 | 集成测试 ≥50 断言（A–M 组） | `attendance_management_integration.mjs`（**80 断言**，含 T 组时间戳门禁） |
| §18 | 冻结回归 re-run | §15（**8 套件逐个实跑 340/340**） |
| §19 | 静态校验 | §16 |
| §21 | 端口/进程安全（8787 Signivra 不动，新测试端口，仅 kill 显式 PID） | harness `run_s2_6i_final.mjs`（PORT 8796） |
| §22 | 报告 25 节 | 本文 |
| §23 | Final Gate 50 PASS/FAIL → GO 后 STOP（不自动进入 S2-6j） | §23 / §25 |

---

## 4. 端点与授权链

```
POST /api/v2/attendance-sessions/:sessionId/review
  → requirePermission('attendance.record.review')        // DB-backed（D1PermissionProvider, 83/238）
  → AuthContext + TenantContext（PLATFORM_GLOBAL→teamId=null；TEAM_SCOPED→teamId=set）
  → AttendanceManagementService.reviewSession()
  → AttendanceSessionsRepository.reviewSessionAtomically()  // db.batch([INSERT...SELECT WHERE P, UPDATE WHERE P])

POST /api/v2/attendance-sessions/:sessionId/force-checkout
  → requirePermission('attendance.record.force')
  → AttendanceManagementService.forceCheckout()
  → AttendanceSessionsRepository.forceCheckoutAtomically()
```

授权裁决（冻结，DB-backed，无角色名短路、无 wildcard、无 super_admin 硬编码）：
- 未认证 → 401 `AUTH_REQUIRED`
- code 存在但当前用户/上下文无授权 → 403 `FORBIDDEN`
- code 存在、用户有授权但 TEAM scope 缺 team 上下文 → 403 `TEAM_SCOPE_REQUIRED`

**目录事实（来自 `migrations/0003_seed_permissions.sql`，已 seed 冻结）**：
- `attendance.record.review` → `platform_super_admin, team_admin, team_auditor, team_owner`
- `attendance.record.force` → `platform_super_admin, team_admin, team_owner`
- `platform_operator` 与 `volunteer` **均不持有** review/force → 无授权 → 403 `FORBIDDEN`

---

## 5. Repository 实现（原子写：INSERT-first + PRE-state 条件 UPDATE）

> 审核轮已重设计。旧的「post-update `updated_at` 守卫」方案（依赖毫秒唯一性）已废弃，理由与新设计的正确性论证见 **§10.1 / §10.2**。

`src/repository/attendance-sessions.ts` 的两个原子方法（`reviewSessionAtomically` / `forceCheckoutAtomically`）同构，**两条语句共享同一 PRE-state 谓词 P**：

```ts
// reviewSessionAtomically：P := (id = ? AND team_id = ? AND review_status = 0)
const insertStmt = this.db.prepare(
  `INSERT INTO attendance_events (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, reason, raw, occurred_at, created_at)
   SELECT a.id, a.activity_id, a.user_id, a.team_id, ?, ?, ?, ?, ?, ?, ?
     FROM attendance_sessions a
    WHERE a.id = ? AND a.team_id = ? AND a.review_status = 0`   // ← P（前置状态）
).bind(eventType, nonce, operatorId, reason, rawJson, now, now, sessionId, teamId);

const updateStmt = this.db.prepare(
  `UPDATE attendance_sessions
      SET review_status = ?, updated_at = ?
    WHERE id = ? AND team_id = ? AND review_status = 0`         // ← 同一个 P
).bind(newReviewStatus, now, sessionId, teamId);

const results = await this.db.batch([insertStmt, updateStmt]);
return Number(results[1]?.meta?.changes ?? 0);  // 取 UPDATE 的 changes；0 = 未命中（→ 404 或 409）
```

`forceCheckoutAtomically` 的 `P := (id = ? AND team_id = ? AND status = 1 AND checkout_at IS NULL)`，UPDATE 写 `status = ?, checkout_at = ?, updated_at = ?`（`newStatus` 参数默认 `ATTENDANCE_STATUS.CHECKED_OUT`，仅故障 MODE 2 传越界值）。

**关键性质**：`stmt[0]` 只写 `attendance_events`，**不触碰 `attendance_sessions`**，因此在同一 batch 事务内 P 在 `stmt[1]` 求值时真值与 `stmt[0]` 完全相同 —— 命中则「1 条事件 + 1 行更新」同时提交，未命中则两者皆 0 行（**无孤儿事件**），任一语句违例则整体回滚。`changes=0` 驱动上层返回 404（跨团队/不存在）或 409（业务冲突）。判定为**确定性**而非概率性，不依赖任何时间戳唯一性。

---

## 6. Service 实现（业务裁决 + 故障注入）

`src/services/attendance-management-service.ts`：

- `requireActor()`：未认证 → 401；`teamId === null` → 403 `TEAM_SCOPE_REQUIRED`（§0 已知 gap，禁止 bypass）。
- `reviewSession()`：
  - `decision` 必填且 ∈ {approve, reject}；`reject` 必须带 `reason`（否则 400 `INVALID_PARAM`，先于 DB 写）。
  - `now = this.nowSeconds()` = `Math.floor(Date.now() / 1000)`（**epoch 秒**，符合冻结 schema；审核轮 BLOCKER A 修复点。原子性不再依赖时间戳唯一性 —— 见 §10.2）。
  - `eventType = faultMode() === 1 ? '__FAULT__' : 'manual'`；`writeReviewStatus = faultMode() === 2 ? 9 : newReviewStatus`；`operator_id = 执行管理员 auth.userId`（非会话属主，§见 §11）。
  - `changes=0` → `findTeamSession()`：存在 → 409 `ATTENDANCE_ALREADY_REVIEWED`；不存在 → 404 `NOT_FOUND`。
- `forceCheckout()`：
  - `reason` 必填（否则 400）；`status=1 AND checkout_at IS NULL` 才推进到 2（`ATTENDANCE_STATUS.CHECKED_OUT`）。
  - `now = this.nowSeconds()`（epoch 秒）；`writeStatus = faultMode() === 2 ? 9 : ATTENDANCE_STATUS.CHECKED_OUT`。
  - `changes=0` → 404（跨团队/不存在）或 409 `ATTENDANCE_NOT_ACTIVE`。
- `nowSeconds()` / `faultMode()`（§10 原子性证据 + BLOCKER A 修复）：
  ```ts
  private nowSeconds(): number { return Math.floor(Date.now() / 1000); }

  /** 0=正常 1=INSERT 失败 2=UPDATE 失败（仅 local 生效） */
  private faultMode(): 0 | 1 | 2 {
    if ((this.env?.ENVIRONMENT ?? 'local') !== 'local') return 0;
    const v = this.env?.JHZY_FAULT_INJECT ?? (globalThis as any).process?.env?.JHZY_FAULT_INJECT;
    if (v === '1') return 1;
    if (v === '2') return 2;
    return 0;
  }
  ```
  `const FAULT_OUT_OF_RANGE = 9;` —— TEST-ONLY 越界值，用于违反 `status IN (0..4)` / `review_status IN (0,1,2)` 的列 CHECK，制造 **stmt[1] UPDATE 失败**。

  **通道发现（重要）**：`JHZY_FAULT_INJECT` 在 wrangler 4.127.1 local 运行时**仅经 `wrangler.jsonc` 的 `vars` 注入 `c.env` 才能到达 handler**；`wrangler --var` 与 `process.env` 均无法在 `c.env` 暴露（已验证）。故故障测试由 harness 生成临时 `wrangler.s2-6i-fault1.jsonc` / `wrangler.s2-6i-fault2.jsonc` 写入 `vars.JHZY_FAULT_INJECT:"1"|"2"`，运行后自动删除。

---

## 7. 多参加模型（Multi-participation）

同一 `activity_signups` 可派生多条 `attendance_sessions`（按 `service_date`/`slot` 区分）。管理操作一律以 `attendance_session.id` 为唯一目标：
- `MP_F_NEW`（当前活跃）与 `MP_F_OLD`（历史已签退）属于同一 `mpUserA` 的同一 signup；force `MP_F_NEW` 成功、force `MP_F_OLD` → 409（不误伤历史）。
- `MP_R_NEW`（待审）与 `MP_R_OLD`（历史已审，`review_status=1`）同理；review `MP_R_NEW` 成功、`MP_R_OLD` → 409。
- 验证：review/force 仅改动目标 session，不误改其它 session（D6）。

---

## 8. 租户隔离（Tenant Isolation）

Repository 层收口：`WHERE id = ? AND team_id = ?`。跨团队 `sessionId`（同属平台但不同 team）在该查询下 0 命中 → 统一 404 `NOT_FOUND`，**不泄露目标是否存在**（§8 IDOR / 不泄露存在性）。无权限 → 403；跨团队攻击不写任何 `attendance_events`（M3）。

---

## 9. IDOR / 404 不泄露

- 跨团队 review `B_R` → 404；跨团队 force `B_F` → 404。
- 攻击请求**零孤儿事件**：`B_R` 全程事件数=0；`B_F` 仅允许 team B 的 `ownerB` 合法 force 产生的 1 条事件（M3）。
- 不存在 `sessionId`（合法 ULID/畸形/超界）→ 404 / 400，无元数据泄漏（B26/B27/C20）。

---

## 10. 原子性（§10 硬门 — db.batch 真实回滚，审核轮已重设计）

### 10.1 被否决的旧设计（依赖毫秒唯一性）

旧实现为 `batch([UPDATE, INSERT...SELECT WHERE updated_at = ?])`：INSERT 通过 **post-update `updated_at` 精确匹配**判断 UPDATE 是否命中。该设计要求 `updated_at` 在批次内唯一，因此把 `now` 提升为 13 位毫秒 —— 既污染时间语义（BLOCKER A），又把业务字段当作 nonce 使用。**已废弃。**

### 10.2 现设计：INSERT-first + PRE-state 条件 UPDATE（确定性，非概率性）

两条语句共享**同一个 PRE-state 谓词** `P`：

- review：`P := (id = ? AND team_id = ? AND review_status = 0)`
- force：`P := (id = ? AND team_id = ? AND status = 1 AND checkout_at IS NULL)`

```
stmt[0]  INSERT INTO attendance_events (...) SELECT ... FROM attendance_sessions a WHERE P
stmt[1]  UPDATE attendance_sessions SET <target fields>, updated_at = ? WHERE P
results = await db.batch([stmt0, stmt1]);  return results[1].meta.changes;
```

**正确性论证**：`stmt[0]` 只写 `attendance_events`，**不触碰 `attendance_sessions`**，因此在同一 batch 事务内 `P` 在 `stmt[1]` 求值时真值与 `stmt[0]` 完全相同。于是：

| 场景 | stmt[0] | stmt[1] | 事务结果 |
|---|---|---|---|
| 前置状态满足（P 真） | 写 1 条事件 | changes=1 | 提交：**恰好 1 条事件** |
| 冲突/跨团队（P 假） | 写 0 条事件 | changes=0 → 服务判 409/404 | **0 条事件**（无孤儿） |
| 任一语句违例 | — | — | batch 整体回滚，**0 条事件** |

满足审核 §3 全部 7 项约束：epoch 秒 / 原子 UPDATE+INSERT / 冲突不写事件 / 成功恰写 1 条 / 无新 schema / 无事务标记列 / 无 0005。**无 ATOMICITY DESIGN GAP。**

### 10.3 双故障模式实证（审核 §4）

| 模式 | 注入方式 | 证明目标 |
|---|---|---|
| **MODE 1** | `event_type='__FAULT__'`（违反 event_type CHECK）→ **stmt[0] INSERT 失败** | UPDATE 从未生效：`review_status`/`status`/`checkout_at`/**`updated_at` 全部保持原值**，无事件 |
| **MODE 2** | 写越界 `status`/`review_status = 9`（违反列 CHECK）→ **stmt[1] UPDATE 失败（此时 INSERT 已执行）** | **真实事务回滚**：已执行的 audit INSERT 被撤销，事件数 = 0（若非真事务则应为 2） |

实跑结果：**MODE 1 = 15/15 PASS，MODE 2 = 10/10 PASS**（明细见 §14）。→ §10 硬门 PASS。

---

## 11. 审计事件（Audit Event）

- review 写 `event_type='manual'`（fault 时 `'__FAULT__'` 用于测试隔离）；force 写 `event_type='force_checkout'`。
- `operator_id = 执行管理员 auth.userId`（**非会话属主**）：验证 `ownerA`(id=3) 审核 `volA`(id=1) 的会话，事件 `operator_id=3≠1`（B6）。
- `reason` 回写原文字（reject 写 `raw` 含 `reject`）。
- 约束：事件 INSERT 与 UPDATE 共享同一 **PRE-state 谓词 P**（§10.2），P 假则两者皆写 0 行 → 无孤儿事件（B21/B23/C19/M3）。**不再使用 `updated_at` 守卫。**
- 时间语义：`occurred_at` / `created_at` 与 `attendance_sessions.updated_at` 同源，均取 `Math.floor(Date.now()/1000)`（epoch 秒），T10 断言 `event.occurred_at === session.updated_at`。

---

## 12. 测试用例设计（A–E / M / T 主组 + L / P 故障组）

`tests/attendance_management_integration.mjs`（真实 Worker 运行时，≥55 项 → 实际 **80** 项）+ `tests/attendance_management_atomicity.mjs`（**MODE 1 = L 组 15 项 / MODE 2 = P 组 10 项**）。

- **A. Baseline**：目录 83/238、roles=6、fixture 就绪（sessions=19, events=0）。
- **B. Review**：owner 审核 approve/reject、reject 需 reason、非法 decision、401/403 volunteer/403 PSA `TEAM_SCOPE_REQUIRED`/403 platform_operator `FORBIDDEN`、重复 409、跨团队 404、reason 超长 400、畸形/不存在 id、team_auditor & team_admin 正向审核。
- **C. Force**：owner 强制签退、无 reason 400、401、403 volunteer/auditor、403 PSA、重复/已签退/异常/取消 → 409、跨团队 404、team_admin 正向强制签退、ownerB 操作本团队。
- **D. 多参加**：MP_F_NEW/OLD、MP_R_NEW/OLD 精准命中、单一活跃约束释放。
- **E. uq_active_attendance**：索引存在、并发兜底（第二条活跃会话被部分唯一索引拒绝）。
- **M. 安全/IDOR/泄漏**：无 SQL/表名、`role_id`/`permission_id` 泄漏；跨团队无孤儿写；会话总数=19 无孤儿；审计事件总数=9（5 review + 4 force）。
- **T. 时间戳单位硬门禁（审核轮新增 11 项）**：哨兵 `MS_SENTINEL = 100000000000`（1e11）。T1–T4 断言 `attendance_sessions.updated_at / checkout_at / checkin_at / created_at` 全部 `< 1e11`；T5–T6 断言 `attendance_events.occurred_at / created_at < 1e11`；T7–T8 断言 Review/Force 成功写入值即当前 epoch 秒（`|nowSec - val| ≤ 600`）；T9 断言 `checkout_at === updated_at`（同一时间源）；T10 断言 `event.occurred_at === session.updated_at`；T11 对两表 6 个时间列取全局 MAX 再断言 `< 1e11`。→ **13 位毫秒不可能再次进入。**
- **L. 原子性故障注入 MODE 1**（fault worker，INSERT 失败）：15 项全 PASS（§10.3）。
- **P. 原子性故障注入 MODE 2**（fault worker，UPDATE 失败 → 已执行 INSERT 必被回滚）：10 项全 PASS（§10.3）。

---

## 13. 初始失败 → 根因 → 修复（9 项，全部为测试/fixture 缺陷，非实现 bug）

首次运行：主组 60 PASS / 9 FAIL；原子组 12/12 PASS。逐条定位：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| B16 | team_auditor→R3 得 409 | R3 是**已审核**负向 fixture（review_status=1），测试错选 | fixture 新增待审 `R6`，B16 改用 R6 |
| B17 | team_admin→MP_R_NEW 消耗 D3 目标 | 与 D3 争用同一 session | fixture 新增待审 `R7`，B17 改用 R7 |
| B19 | platform_operator→期望 `TEAM_SCOPE_REQUIRED` | 该角色目录**未持** review/force → 403 `FORBIDDEN` 本就正确 | 修正测试期望为 403 `FORBIDDEN`（实现正确） |
| C11 | team_admin→F2 得 409 | F2 是 status=0（未签到）负向 fixture | fixture 新增活跃 `F6`(ownerA)，C11 改用 F6 |
| D4 | MP_R_OLD→200（期望 409） | fixture 中 MP_R_OLD 是待审（review_status=0），应为历史已审 | fixture 置 `MP_R_OLD.review_status=1` |
| D6 | 期望 review_status=2 | 跟随 D4 修复后应为 1 | 断言改为 `=== 1` |
| E3 | dupThrew=false | F1 已被强制签退，volA 无活跃会话，单条插入不冲突 | 重构：同 user 连续插入两条活跃会话，第二条必被部分唯一索引拒绝，按 id 精确清理 |
| M3 | B_F=1 误判孤儿 | C22 的 ownerB 合法 force 事件被计为孤儿 | 改为仅校验 IDOR 写：B_R=0 且 B_F 仅 ownerB 合法事件 |
| M5 | 总数=8（期望）实得 7/9 | 计漏 MP_R_NEW 的 review 事件 + 修正后共 9 | 期望改为 9（5 review + 4 force） |

**结论**：实现自首次编写即符合冻结目录与 §0–§23；9 项失败均源于测试/fixture 选取与计数错误，已全部修正，**未改动任何业务实现语义**。

---

## 14. 最终测试结果（S2-6i，审核轮实跑）

编排器：`tests/run_s2_6i_final.mjs`（PORT 8796，隔离 state `.tmp/s2-6i-final-state`）。**独立实跑两轮，结果完全一致。**

```
[P3] S2-6i MAIN PASS=80 FAIL=0 TOTAL=80 EXIT=0
[P4] ATOMICITY-1 PASS=15 FAIL=0 TOTAL=15 EXIT=0
[P5] ATOMICITY-2 PASS=10 FAIL=0 TOTAL=10 EXIT=0
OVERALL EXIT=0
```

### 14.1 断言数变化说明（审核 §8 — 未删除任何断言）

| 组 | 前一版 | 本轮 | 差值 | 原因 |
|---|---|---|---|---|
| 主集成 | 69 | **80** | +11 | 新增 T 组 11 项 timestamp 单位硬门禁；A/B/C/D/E/M 组 69 项**逐项保留未删** |
| 原子 MODE 1 | 12 | **15** | +3 | 新增 L4 / L9（`updated_at` 保持原值）+ L15（`updated_at` 全局 MAX `< 1e11`） |
| 原子 MODE 2 | — | **10** | +10 | 审核 §4 要求新增「UPDATE 失败 → 已执行 INSERT 真实回滚」故障模式 |
| **合计** | 81 | **105** | +24 | 纯增量 |

### 14.2 REVIEW ATOMICITY 明细（MODE 1 / MODE 2）

```
MODE 1: L1 500 INTERNAL_ERROR / L2 review_status 仍 0 / L3 status·checkin_at·checkout_at 未变
        L4 updated_at 保持原值 / L5 无孤儿事件 / L11–L13 二次故障 R2 一致
MODE 2: P1 500 / P2 review_status 仍 0（未写入越界 9）/ P3 updated_at 保持原值
        P4【真实回滚证明】已执行的 audit INSERT 被撤销：R1 事件数 = 0
```

### 14.3 FORCE ATOMICITY 明细（MODE 1 / MODE 2）

```
MODE 1: L6 500 / L7 status 仍 1 CHECKED_IN / L8 checkout_at 仍 NULL
        L9 updated_at 保持原值 / L10 无孤儿事件
MODE 2: P5 500 / P6 status 仍 1（未写入越界 9）/ P7 checkout_at 仍 NULL
        P8 updated_at 保持原值 / P9【真实回滚证明】F1 事件数 = 0
共同: L14 / P10 故障阶段全局审计事件 = 0（MODE 2 若非真事务则应为 2）
```

### 14.4 TIMESTAMP UNIT（T 组 11/11 PASS）

`attendance_sessions` 的 `updated_at/checkout_at/checkin_at/created_at` 与 `attendance_events` 的 `occurred_at/created_at` 六列全局 MAX **均 `< 1e11`**；成功路径写入值等于当前 epoch 秒；`checkout_at === updated_at === event.occurred_at`。**零 13 位毫秒。**

---

## 15. 冻结回归 re-run（§18 + 审核 §7 — 8 套件逐个实跑）

> **前一版以「增量不变 + 静态全绿」推定 340/340 的声明已删除。** 本节全部数据来自本轮**实际执行**，每套件独立 `fixture → run → teardown`，运行于隔离 state `.tmp/s2-6i-final-state`（非默认 `.wrangler/state`）。

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

### 15.1 隔离 state 构建（审核 §6）

原生 Wrangler 4.127.1 `d1 migrations apply jhzy-v2-local --local --persist-to .tmp/s2-6i-final-state`，0001→0004 全部 ✅（160 + 9 + 241 + 33 commands）。`d1_migrations` = 4 行；0004 索引 `uq_active_attendance` / `idx_as_signup` 均存在。**未使用 sqlite 文件拷贝、未手写 `d1_migrations`、未用 `node:sqlite` apply 迁移。**

### 15.2 测试基础设施变更（仅测试侧，默认行为不变）

7 个冻结测试文件新增 `JHZY_D1_DIR` 环境变量覆盖：
```js
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
```
未设置时行为与冻结版本完全一致；`session_security_integration.mjs` 为纯 HTTP 测试，未修改。

---

## 16. 静态校验（§19）

| 校验 | 命令 | 结果 |
|---|---|---|
| TypeScript 类型 | `tsc --noEmit` | **0 errors** |
| 权限目录 | `scripts/validate_permission_catalog.mjs` | **PASS**（permissions=83，meta 一致，无 wildcard，PSA 显式持 83，platform_operator 受限，E1–E6 增强校验全 PASS） |
| 种子矩阵 | `scripts/validate_permission_seed.mjs` | **PASS**（roles=6；perm=83；rp=238；逐角色 JSON≡DB：83/26/48/43/19/19） |
| 迁移冻结 | `sha256sum migrations/0004_*.sql` | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d` ✅ 一致 |
| 迁移数量 | `ls migrations/*.sql` | **4**（0001–0004），`0005*` 计数 = **0** |
| 隔离 state 目录门 | 编排器 P6（`.tmp/s2-6i-final-state`） | roles=6 / permissions=83 / role_permissions=238 ✅ |

### 16.1 S2-4 validator 特殊处理（审核 §10）

`scripts/validate_local_d1.mjs` **硬编码** `.wrangler/state/v3/d1/miniflare-D1DatabaseObject`，因此：

> ⚠️ **S2-4 VALIDATOR DB ≠ S2-6i FINAL REGRESSION DB**
> S2-4 validator 读写默认 `.wrangler/state`；S2-6i 官方回归 DB 是隔离 state `.tmp/s2-6i-final-state`。两者互不相关。本轮**未重构该 validator**。

作为**独立静态校验**运行的结果：**结构类断言全 PASS，5 项失败**——

| 失败项 | 期望 | 实测 | 归因 |
|---|---|---|---|
| G. user_roles = 0 | 0 | 8 | 默认 state 历史残留 |
| I. TEAM_SCOPED 隔离 team_id=1 | 1 行 | 6 行 | 同上 |
| I. TEAM_SCOPED 隔离 team_id=2 | 1 行 | 2 行 | 同上 |
| fixture: activity_signups 已建 | 建成 | UNIQUE 冲突 | 同上（残留 signup 占位） |
| I. DERIVED_TEAM 隔离 | 1 行 | 5 行 | 同上 |

**结构类断言（A–H）全部 PASS**：4 迁移、表结构、含 CHECK 的表=57、自定义索引=103、6 冻结角色齐备、`volunteer.scope=team`、permissions=83、role_permissions=238、FK 强制生效、CHECK 强制生效、teardown 后 83/6 不变。

→ 5 项失败**全部归因于默认 `.wrangler/state` 的历史业务数据残留**（validator 要求干净的 post-migration DB），**与 S2-6i 实现、与 S2-6i 官方回归 DB 均无关**。按审核 §11：**只报告，不修、不清、不重建、不依赖。**

### 16.2 默认 `.wrangler/state` 现状（审核 §11 — 仅报告）

只读快照（未做任何写入/清理/重建）：

```
DB_FILE  = 5bd981b6161a90512ed847c619725cbfd66e0892aa2b5473f0e48e1c77d601cc.sqlite
migrations = 0001,0002,0003,0004（4 行）
catalog  roles=6  permissions=83  role_permissions=238   ← 未漂移
残留业务数据 users=7 user_roles=8 teams=4 activities=8 activity_signups=6
            attendance_sessions=7 attendance_events=12 sessions=6
毫秒污染探测(>=1e11)：全部 6 个时间列 ms_rows=0（global_max≈1.788e9，均为 epoch 秒）
DEFAULT_STATE_MS_ROWS = 0
```

### 16.3 毫秒 timestamp 残留排查（审核 §5）

| 检查对象 | 结果 |
|---|---|
| 本轮隔离 DB `.tmp/s2-6i-final-state` | P0 阶段 `rm` 后由原生迁移**全新重建**；T 组运行期 11 项断言证明零毫秒；P6 teardown 后业务表全 0 |
| 上一轮遗留隔离 DB `.tmp/s2-6i-state` | 只读探测：`ms_rows = 0`（max=1756500000 = fixture `T0`，events 表为 null） |
| 默认 `.wrangler/state` | `DEFAULT_STATE_MS_ROWS = 0`（见 §16.2） |

→ **全环境零毫秒残留**，无需额外 teardown/重建。

---

## 17. Open Items / 已知 Gap（明确 Out-of-Scope，本切片不处理）

1. **TIME WINDOW / LOCATION / SHIFT MODEL = OPEN** — `review`/`force` 当前不做服务时间窗、地理位置、排班模型校验；属后续切片。
2. **ANOMALY = S2-6j / NOT IMPLEMENTED** — 考勤异常（迟到/早退/缺勤识别与处置）不在 S2-6i 范围，归 S2-6j。
3. **PLATFORM TEAM-SCOPE GAP = OPEN（已知，按 §0 设计冻结）** — `platform_super_admin`/`platform_operator` 在 catalog 持 review/force（仅 PSA）但 `TenantContext.teamId=null` 时返回 403 `TEAM_SCOPE_REQUIRED`；此为既有 architecture gap，本阶段**不修复、不 bypass**，待专项决策。

---

## 18. 安全 / 泄漏（Security / Leakage）

- 全部响应无 SQL / 表名泄露（M1）。
- 全部响应无 `role_id` / `permission_id` 泄露（M2）。
- 响应 envelope 为 `{success, data, request_id}`，不回显内部标识符（§9）。
- 跨团队请求无存在性 oracle（统一 404）。

---

## 19. 端口 / 进程安全（§21 + 审核 §13）

- 审核轮编排器统一使用 **8796**（前一版曾用 8799 / 8798）。
- **8787（Signivra）全程 `LISTEN_COUNT = 0`，未触碰、未 kill、未占用。** 运行前后各复核一次。
- `killPort()` 只针对 `Get-NetTCPConnection -LocalPort 8796 -State Listen` 的 OwningProcess 逐一 `Stop-Process`，**无 broad kill**（不使用 `taskkill /IM node.exe` 之类）。
- 本轮显式启动并结束的 PID：run#1 `26848 / 28188 / 26540`；run#2 `22252 / 23844 / 18120`（NORMAL / FAULT1 / FAULT2 各一）。
- 运行结束 `8796_LISTEN_COUNT = 0`，无 worker 泄漏。
- 故障临时配置 `wrangler.s2-6i-fault1.jsonc` / `wrangler.s2-6i-fault2.jsonc` 运行后已由编排器自动删除（日志有 `[harness] removed ...` 记录）。
- ⚠️ **残留提示**：前一版编排器 `run_s2_6i.mjs` 遗留 `wrangler.s2-6i-fault.jsonc`（含 `JHZY_FAULT_INJECT: "1"`）未被清理。该文件仅在显式 `--config` 指定时才生效，不影响 `wrangler.jsonc` 默认路径；**本轮仅报告，未删除**，建议后续清理以免误用。

---

## 20. 已知限制 / 边界（Boundaries）

- `force` 仅在 `status=1 AND checkout_at IS NULL` 生效；`status ∈ {0,2,3,4}` 一律 409（C13–C16）。
- `review` 仅 `review_status=0` 可改；`1/2` 一律 409（B20、D4）。
- 同一用户同时仅一条活跃会话（`uq_active_attendance` 部分唯一索引，status=1），E3 并发兜底验证。
- 故障注入仅 `ENVIRONMENT=local` + `JHZY_FAULT_INJECT ∈ {1,2}` 生效（`faultMode()` 首行即校验 `ENVIRONMENT`），生产路径 `faultMode()` 恒返回 0，不受影响。
- 注入通道只有 `wrangler.jsonc` 的 `vars` → `c.env` 一条（实测 `--var` 与 `process.env` 均无法进入 Worker 运行时 `c.env`），因此故障模式必须经临时配置文件启用，无法被生产环境意外触发。
- 时间源统一为 `nowSeconds()`；**禁止**在任何 DB 写入路径直接使用 `Date.now()`。

---

## 21. 交付物清单（Deliverables）

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/routes/attendance-sessions.ts` | 新增 | 两端点 + `requirePermission` 授权链 |
| `src/services/attendance-management-service.ts` | **审核轮修正** | `nowSeconds()` = `Math.floor(Date.now()/1000)`（**BLOCKER A 修复**）；`faultMode()` 返回 0/1/2；`FAULT_OUT_OF_RANGE = 9`；导入 `ATTENDANCE_STATUS` |
| `src/repository/attendance-sessions.ts` | **审核轮修正** | 两个原子方法重设计为 **INSERT-first + PRE-state 条件 UPDATE**；移除 `updated_at` 毫秒守卫；返回 `results[1].meta.changes`；`forceCheckoutAtomically` 新增 `newStatus` 参数 |
| `tests/fixture.mjs` | 修正（前一版） | `attendance-management` 增 R6/R7/F6、ownerA 报名、MP_R_OLD 置已审；manifest 含 19 sessions；`T0 = 1756500000`（epoch 秒） |
| `tests/attendance_management_integration.mjs` | **审核轮修正** | A–E/M 组 69 项保留 + **新增 T 组 11 项** = **80 断言** |
| `tests/attendance_management_atomicity.mjs` | **审核轮重写** | MODE 1（L 组 15）+ MODE 2（P 组 10），经 `JHZY_FAULT_MODE` 选择 |
| `tests/api_integration.mjs`<br>`tests/auth_integration.mjs`<br>`tests/session_integration.mjs`<br>`tests/firstlogin_integration.mjs`<br>`tests/authorization_integration.mjs`<br>`tests/activity_signup_integration.mjs`<br>`tests/attendance_integration.mjs` | **审核轮修正（仅测试基础设施）** | 新增 `JHZY_D1_DIR` 环境变量覆盖 D1 持久化目录；未设置时行为与冻结版本完全一致 |
| `tests/run_s2_6i_final.mjs` | **审核轮新增** | FINAL REGRESSION 编排：P0 原生迁移建隔离 state → P1 普通 worker → P2 8 套件 340 → P3 S2-6i 主组 → P4 MODE 1 → P5 MODE 2 → P6 integrity/teardown |
| `tests/run_s2_6i.mjs` / `tests/run_s2_6h.mjs` | 前一版 | 保留备查，本轮未使用 |
| `migrations/0004_attendance_multi_participation.sql` | 冻结 | SHA 不变，未修改 |
| `docs/architecture/S2-6i-REPORT.md` | **审核轮修正** | 本报告（新增 §0 审核回执，重写 §10/§12/§14/§15/§16/§19/§23） |

> 注：本切片**未**执行任何 git commit / push / `wrangler deploy`；**未新增 migration（无 0005）**；D1 migration apply 仅作用于本地隔离 state `.tmp/s2-6i-final-state`（Cloudflare 远端零动作），符合作用域纪律。

---

## 22. 阶段结论（Phase Conclusion）

S2-6i 经「GO 被撤销 → BLOCK/REPAIR REQUIRED → 修复 → 实跑复验」后，**全部通过**冻结基线与 §0–§23 + 审核轮 §1–§15 全部硬约束：
- 两个端点行为正确（审核只改 `review_status`、强制签退只改 `status/checkout_at`、均写正确审计事件、`operator_id`=执行管理员）。
- 授权、租户隔离、IDOR/404、409/400/401/403 全部分类正确。
- **BLOCKER A 已修复**：全部时间列回归 epoch 秒，T 组 11 项硬门禁封堵 13 位毫秒再入。
- **原子性不再依赖毫秒唯一性**：INSERT-first + PRE-state 条件 UPDATE，双故障模式（INSERT 失败 / UPDATE 失败）双向证明真实回滚（§10 硬门 PASS）。
- **BLOCKER B 已修复**：8 个冻结套件逐个实跑，**实得 340/340**，不再有任何推定式 PASS 声明。
- 静态校验 + 类型检查 + 完整性/teardown 全绿；目录/种子/migration 冻结未漂移。

---

## 23. Final Gate（§23 — 50+ PASS/FAIL 项 → GO 后 STOP）

**任何 FAIL → BLOCK；全部 PASS → GO，STOP（不自动进入 S2-6j）。**

### S2-6i 主集成组（80 项，全部 PASS）
- A 组 5/5：A1 permissions=83, A2 rp=238, A3 roles=6, A4 catalog 含两权限, A5 sessions=19/events=0
- B 组 28/28：B1–B28（审核全路径 + 401/403/404/409/400 + team_auditor/team_admin 正向）
- C 组 22/22：C1–C22（强制签退全路径 + 401/403/404/409/400 + team_admin/ownerB 正向）
- D 组 6/6：D1–D6（多参加精准命中 + 单一活跃约束）
- E 组 3/3：E1–E3（索引存在 + 并发兜底）
- M 组 5/5：M1–M5（无泄漏 + 无孤儿写 + 会话总数 19 + 事件总数 9）
- **T 组 11/11**：T1–T11（六时间列 `< 1e11` + 成功写入为当前 epoch 秒 + 三源时间一致 + 全局 MAX 门禁）

### S2-6i 原子性故障组（25 项，全部 PASS）
- **MODE 1（L1–L15，15/15）**：INSERT 失败 → 500 + `review_status`/`status`/`checkout_at`/**`updated_at` 全部未变** + 全局事件=0 + `updated_at` MAX `< 1e11`
- **MODE 2（P1–P10，10/10）**：UPDATE 违例失败 → 500 + 未写入越界值 9 + `updated_at` 未变 + **已执行的 audit INSERT 被真实回滚（事件数=0，非真事务应为 2）**

### 冻结回归（8 套件逐个实跑，340 项全部 PASS）
- S2-5 **58/58** · S2-6c-1 **19/19** · S2-6c-2 **34/34** · S2-6c-3 **31/31** · S2-6c-4 **24/24** · S2-6f **42/42** · S2-6g **61/61** · S2-6h-R2 **71/71**
- **FROZEN HTTP TOTAL = 340/340（EXIT 全 0）**，全部为本轮实际执行，无历史引用

### 静态 / 类型 / 目录门（全部 PASS）
- `tsc --noEmit` = **0 errors**
- catalog validator = **83 PASS**
- seed validator = **roles 6 / permissions 83 / role_permissions 238 PASS**
- 0004 SHA = `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`（一致）；migrations = **4**；**无 0005**
- S2-4 validator = 结构类全 PASS / 5 项因默认 state 残留失败（**S2-4 VALIDATOR DB ≠ S2-6i FINAL REGRESSION DB**，§16.1，不作为 S2-6i gate）

### 完整性 / Teardown 门（审核 §12，全部 PASS）
```
foreign_key_check = 0      integrity_check = ok      d1_migrations = 4
catalog 保留：roles=6  permissions=83  role_permissions=238
业务残留：users=0 teams=0 activities=0 activity_signups=0
          attendance_sessions=0 attendance_events=0 sessions=0 user_roles=0
```

### 端口 / 进程门（审核 §13，PASS）
- 8787（Signivra）`LISTEN_COUNT = 0`，全程未触碰；8796 运行后 `LISTEN_COUNT = 0`，无泄漏；仅 kill 显式 PID，无 broad kill

### 汇总
| Gate | Result |
|---|---|
| BLOCKER A — timestamp 单位 | **修复并复验 PASS**（T 组 11/11） |
| BLOCKER B — 冻结回归实跑 | **340/340 PASS**（8 套件逐个实跑） |
| S2-6i 主组 | **80/80 PASS** |
| S2-6i 原子组 MODE 1 | **15/15 PASS** |
| S2-6i 原子组 MODE 2 | **10/10 PASS** |
| 静态/类型/目录 | **全 PASS** |
| 完整性 / Teardown | **全 PASS** |
| 端口 / 进程安全 | **PASS** |
| 可重复性 | **两轮独立实跑结果完全一致** |
| **Final Gate 总判定** | **GO（0 FAIL）** |

→ **STOP。不自动进入 S2-6j。等待用户显式授权。**

---

## 24. 后续建议（S2-6j，待用户显式授权）

1. 考勤异常识别（ANOMALY）：迟到/早退/缺勤判定与处置端点。
2. TIME WINDOW / LOCATION / SHIFT MODEL 校验（§17 Open Item 1）。
3. PLATFORM TEAM-SCOPE GAP 专项决策（§17 Open Item 3）：是否放开 PSA/operator 的团队级管理能力，或维持 403 `TEAM_SCOPE_REQUIRED` 现状。
4. ~~逐套件重跑 S2-5/6c/6f/6g~~ —— **本轮已完成**（§15，340/340 实跑）。
5. 卫生项（非 S2-6i gate，待授权）：清理默认 `.wrangler/state` 的历史业务残留（会使 S2-4 validator 恢复 ALL PASS）；删除前一版遗留的 `wrangler.s2-6i-fault.jsonc`。
6. 建议把 `tests/run_s2_6i_final.mjs` 的「隔离 state + 8 套件 340 门禁 + timestamp 单位门禁」固化为后续所有切片的标准回归入口。

---

## 25. 签名 / 时间戳

- 报告首版：2026-09-03（CST），判定 GO —— **该判定已被用户审核撤销**。
- 报告修订：2026-09-03（CST）审核轮，先记录 **BLOCK / REPAIR REQUIRED**，修复 BLOCKER A/B 并实跑复验后改写判定。
- 执行环境：Cloudflare Workers 运行时（wrangler **4.127.1** local, miniflare D1）；Node 22.22.2。
- 官方回归 DB：`.tmp/s2-6i-final-state`（原生 `d1 migrations apply` 0001→0004 全新构建）。
- 证据 artifact：`.tmp/run_s2_6i_final.log`、`.tmp/s2-6i-final-summary.json`、`.tmp/suite-*.log`（逐套件明细）。
- 判定：**GO（修复后复验）** — S2-6i 交付完成，**STOP**，等待用户下一阶段显式授权；**未进入 S2-6j**。

---

## 26. FINAL CLOSEOUT / HYGIENE（2026-09-03，用户显式授权）

本轮不重新跑 340/340，只做最终收口与卫生清理。所有 Gate 实测通过。

### 26.1 故障注入配置清理
- 已删除：`wrangler.s2-6i-fault.jsonc`（前一版遗留的临时 fault 配置，含 `JHZY_FAULT_INJECT:"1"`）。
- 全项目 `JHZY_FAULT_INJECT` 残留位置复核（删除后）：
  - `src/services/attendance-management-service.ts` — 受 `ENVIRONMENT==='local'` gate 保护，`faultMode()` 默认返回 `0`，生产绝不触发。✅ 合法
  - `src/env.ts` — 仅 `JHZY_FAULT_INJECT?: string` 类型声明（binding 类型）。✅ 合法
  - `tests/run_s2_6i_final.mjs` / `tests/run_s2_6i.mjs` / `tests/attendance_management_atomicity.mjs` — S2-6i 明确测试代码。✅ 合法
  - `docs/architecture/S2-6i-REPORT.md` — S2-6i 报告说明。✅ 合法
  - `.tmp/make_fault_cfg.mjs` — S2-6i 测试工具（fault 配置生成器，仅被显式调用，写入临时 config；非默认=1、非 production/deploy）。属 `.tmp` 证据，按 §11 保留。✅ 合法
  - **正式 `wrangler.jsonc`：无 `JHZY_FAULT_INJECT`**。✅ 合规
  - 无 production config / deploy config / 默认值=1。✅ 合规

### 26.2 7 个冻结 regression test diff 审计（read-only）
`workers/` 目录未纳入 git（仅 Initial Commit，整目录 `?? workers/`），故 `git diff` 无基线；改为内容审计 + 功能验证：
- 7 文件均含**完全相同**的 3 行 `JHZY_D1_DIR` 参数化块（注释 + `const D1_DIR = process.env.JHZY_D1_DIR ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')`），`JHZY_D1_DIR` 出现 2 次（注释+定义）、`const D1_DIR =` 恰好 1 次。
- `BASE` 端口维持原值 `:8787`（7 文件均未变）。
- 功能验证：最近一次实跑逐套件计数 **S2-5=58 / 6c-1=19 / 6c-2=34 / 6c-3=31 / 6c-4=24 / 6f=42 / 6g=61 / 6h-R2=71，全部 0 FAIL**，与冻结基线逐一吻合——任何 assertion 删除/新增/放宽、HTTP status / error code / 权限 / tenant / fixture 语义变化都会导致计数漂移或失败。

| 文件 | ONLY_PATH_PARAMETERIZATION |
|---|---|
| tests/api_integration.mjs | PASS |
| tests/auth_integration.mjs | PASS |
| tests/session_integration.mjs | PASS |
| tests/firstlogin_integration.mjs | PASS |
| tests/authorization_integration.mjs | PASS |
| tests/activity_signup_integration.mjs | PASS |
| tests/attendance_integration.mjs | PASS |

（B–J 全部满足：未改 assertion / 未删 assertion / 未改 HTTP status / 未改 error code / 未改权限预期 / 未改 tenant 预期 / 未改 fixture 语义 / 未放宽 / 未设置时仍用原 `.wrangler/state`。）

### 26.3 默认 `.wrangler/state` 清理 + 原生重建
- 授权边界：仅本机 local state；无 `--remote` / production / deploy / remote D1 / Cloudflare production。
- 删除路径（精确）：`E:/D盘备份/miniprogram/workers/.wrangler/state`（仅该项目的 local D1 state 数据）。相邻 `src/ migrations/ node_modules/ .tmp/ Signivra / 其它项目` 均未触碰。
- 原生重建：`node_modules/wrangler/bin/wrangler.js d1 migrations apply jhzy-v2-local --local`（4.127.1）→ 0001✅ 0002✅ 0003✅ 0004✅，EXIT=0。无 node:sqlite apply / 无手写 d1_migrations / 无复制 sqlite。

### 26.4 默认 baseline 验证
- `d1_migrations = 4`；`0004 SHA = 12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d` ✅
- `roles = 6` / `permissions = 83` / `role_permissions = 238` ✅
- 业务数据全 0：users=0 teams=0 sessions=0 activities=0 activity_signups=0 attendance_sessions=0 attendance_events=0 attendance_anomalies=0 service_records=0 user_roles=0 ✅
- `PRAGMA foreign_key_check = 0` ✅ / `PRAGMA integrity_check = ok` ✅

### 26.5 S2-4 validator（干净 baseline 重跑）
- **23/23 PASS / 0 FAIL / EXIT 0**。A×2 B C×2 D E F×2 G×3 H×2 I×5 + 3 fixture 检查，全部 ✅。

### 26.6 静态 sanity
- `tsc --noEmit` EXIT=0。
- `migrations = 4`，无 0005。
- 正式 `wrangler.jsonc` 无 `JHZY_FAULT_INJECT`。

### 26.7 证据保留（§11）
- `.tmp/s2-6i-final-state`（隔离回归 DB）、`.tmp/s2-6i-final-summary.json`、`.tmp/run_s2_6i_final.log`、`.tmp/suite-*.log`（逐套件明细）均保留未删。

### 26.8 最终冻结判定
- S2-6i = **GO**（此判定不改变此前真实结果：340/340、主组 80/80、原子 MODE1 15/15、MODE2 10/10；本轮仅做收口与卫生清理）。
- **STOP。未进入 S2-6j。未执行 git commit/push、未 wrangler deploy、未新增 migration、未触碰 Signivra 8787。**
