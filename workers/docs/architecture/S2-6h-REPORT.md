# S2-6h 报告 — 活动签到垂直切片（Check-in / Check-out）

> 执行搭档：**WorkBuddy** ｜ 授权阶段：**S2-6h** ｜ 目标业务域：活动签到 Check-in
> 纪律基线：S2-4 ~ S2-6f 收口 83/238 + 3 migrations；S2-6g 已 GO（活动报名垂直切片）。
> 本阶段只做：**本人签到 / 本人签退 + 最小 evidence 写入**。完成后 **STOP**。

---

## 1. Baseline（收口基线确认）

| 项 | 值 | 来源 |
|---|---|---|
| roles | 6 | `0003_seed_permissions.sql` |
| permissions | 83 | `permission-catalog.json` |
| role_permissions | 238 | `seed` |
| d1_migrations | 3 | `migrations/0001,0002,0003` |
| S2-6g signup suite | 61/61 PASS | 本阶段回归复跑确认 |
| S2-4 ~ S2-6f 冻结回归 | 231/231 PASS | 全量复跑确认（见 §15） |

---

## 2. Slice Selection（切片选择）

经阶段门禁确认，S2-6h 第一刀只切 **自我签到/签退**：

- **包含**：`attendance.record.checkin`（USER 本人签到）、`attendance.record.checkout`（USER 本人签退）、`AttendanceSessionOwnershipPolicy`（SELF）、`attendance_sessions` / `attendance_events` 写、租户派生隔离。
- **排除**（后续切片）：`attendance.record.force`（TEAM 强制签退）、`attendance.record.review`（TEAM 审核）、`attendance.anomaly.handle`（TEAM 异常处理）、heartbeat、设备指纹、风险打分、积分/证书联动。

选定理由：与 S2-6g 同构的最小闭环（Permission + Tenant Scope + Ownership + Repository Write），不扩大范围。

---

## 3. Existing Schema Evidence（真实 Schema 证据）

取自 `migrations/0001_initial_schema.sql`，**未猜字段**：

### `attendance_sessions`（TEAM_SCOPED，含显式 `team_id` 列）
```sql
CREATE TABLE attendance_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signup_id INTEGER NOT NULL UNIQUE REFERENCES activity_signups(id),
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  checkin_at INTEGER,
  checkout_at INTEGER,
  status INTEGER NOT NULL CHECK(status IN (0,1,2,3,4)) DEFAULT 0,
  review_status INTEGER NOT NULL CHECK(review_status IN (0,1,2)) DEFAULT 0,
  checkin_risk INTEGER,
  device_changed INTEGER,
  effective_minutes INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
**关键约束**：`UNIQUE(signup_id)` ⇒ 每报名仅一个考勤会话，是并发安全的根因（§11）。

### `attendance_events`（TEAM_SCOPED，append-only 证据链）
```sql
event_type TEXT CHECK(event_type IN ('checkin','checkout','heartbeat','force_checkout','anomaly','correction','manual'))
operator_id INTEGER, risk_score INTEGER, disposition TEXT, device_fp_hash TEXT, nonce TEXT UNIQUE, session_id INTEGER
```
`nonce UNIQUE` ⇒ 事件写入幂等。

### Tenant Scope 分类（`src/repository/tenant-scope.ts`）
`attendance_sessions` / `attendance_events` / `attendance_anomalies` = **TEAM_SCOPED**；`attendance_devices` = PLATFORM_GLOBAL（本切片不使用）。

---

## 4. Frozen Permission Codes Used（冻结权限码，未增未改）

| code | scopeType | risk | 持有人（六角色） |
|---|---|---|---|
| `attendance.record.checkin` | USER | LOW | `platform_super_admin`, `volunteer` |
| `attendance.record.checkout` | USER | LOW | `platform_super_admin`, `volunteer` |

`force` / `review` / `anomaly` 为 TEAM scope，**本切片不调用**（管理员操作他人考勤留后续）。

**Catalog GAP：无**（本人签到/签退码已冻结存在）。

---

## 5. Check-in Flow（本人签到）

`POST /api/v2/activities/:activityId/attendance/checkin`

```
1. requireActor：已认证 + userId + 有团队上下文（teamId != null）
   - 未认证 → 401 AUTH_REQUIRED
   - 无 team 上下文（平台角色 scope NULL）→ 403 TEAM_SCOPE_REQUIRED
2. requirePermission('attendance.record.checkin')  ← D1PermissionProvider 裁决（83/238）
3. ActivityRepository.findSignupTargetByPublicId：活动存在 + team_id = activeTeam
   - 不存在 / 跨团队 → 同一 404 NOT_FOUND（不泄露存在性）
4. ActivitySignupRepository.findOwnActiveSignup(activityId, userId)：本人有效报名(status=1)
   - 无 → 409 CONFLICT reason=attendance_not_signed_up
5. AttendanceSessionRepository.findOwnSessionBySignup：重复签到预检
   - 已存在 → 409 reason=attendance_already_checked_in
6. INSERT（status=1）；UNIQUE(signup_id) 兜底 race → 409
7. INSERT attendance_events(type=checkin, nonce=`${sid}:checkin:${ts}`)
8. 返回统一 envelope {success, data:{attendance:{session_id,...}}}
```

---

## 6. Check-out Flow（本人签退）

`POST /api/v2/activities/:activityId/attendance/checkout`

```
1-2 同签到
3. findSignupTargetByPublicId → 404（跨团队/不存在）
4. findOwnActiveSignup → 无报名 409 attendance_not_signed_up
5. findOwnSessionBySignup → 无会话 409 attendance_checkin_required（必须先签到）
6. OwnershipPolicy.canAct(session, auth)（SELF: user_id===auth.userId）→ 不成立 404
7. 已签退(status=2) → 409 attendance_already_checked_out（不被 0 行 UPDATE 掩盖）
8. 原子 UPDATE（WHERE signup_id+user_id+team_id+status=1 同在）→ 0 命中 409
9. INSERT attendance_events(type=checkout)
```

---

## 7. Tenant Scope（租户作用域）

- `attendance_sessions.team_id` 为**显式列**（非派生），INSERT 时由 `tenant.teamId` 注入。
- 活动查询经 `activities.team_id = activeTeam AND deleted_at IS NULL`（复用 S2-6g 的 `findSignupTargetByPublicId`）。
- 报名查询 `activity_signups` JOIN `activities` 派生隔离：`a.team_id = ? AND s.user_id = ?`。
- 会话查询 `attendance_sessions` 由 `signup_id + user_id + team_id` 三重过滤。
- **Permission ≠ Tenant filter**：权限在 middleware 裁决；数据范围在 Repository 层强制（§9 纪律保持）。

---

## 8. Ownership Policy（归属策略）

`src/policies/ownership.ts` — 仅新增 `AttendanceSessionOwnershipPolicy`：

```ts
export interface OwnershipPolicy<T> { canAct(resource: T, auth: AuthContext): boolean; }
export class AttendanceSessionOwnershipPolicy implements OwnershipPolicy<OwnedAttendanceResource> {
  canAct(r, auth) {
    if (!auth.authenticated || auth.userId == null) return false;
    if (r == null || typeof r.user_id !== 'number') return false;
    return r.user_id === auth.userId; // SELF
  }
}
```

- 与 S2-6g `ActivitySignupOwnershipPolicy` 同构；**不过度抽象**（无 policy registry / DSL / engine）。
- 正式模型：**Permission AND Tenant Scope AND Ownership**，三者正交。
- 取消他人报名/签到：冻结目录与 Ownership Rules 中**无**"管理员可操作他人考勤"规则 ⇒ 本阶段不提供任何角色的越权入口。

---

## 9. Repository Design（数据层设计）

`src/repository/attendance-sessions.ts` — `AttendanceSessionRepository`：

- 继承 `BaseRepository`，注入 `RepositoryContext { auth, tenant }`。
- 全部 SQL 参数化（`prepare().bind()`）：`signupId / activityId / userId / teamId / status / now / nonce` 均绑定。
- `insertCheckIn(signupId, activityId, userId, teamId, now)`、`checkOut(...)`、`findOwnSessionBySignup`、`insertEvent(...)`。
- Repository 负责租户约束（§7），route 不做裸 SQL。
- 复用 `ActivityRepository.findSignupTargetByPublicId` 与 `ActivitySignupRepository.findOwnActiveSignup`，保持单一 SQL 事实源。

`src/services/attendance-service.ts` — `ActivityAttendanceService`（use-case 编排，不碰 HTTP）：
- `checkInOwn` / `checkOutOwn`：仅做业务不变式 + 归属判定 + 编排。
- 任何一步失败均零写入（§19）。

---

## 10. Business Invariants（业务不变式，仅实现可证项）

| # | 规则 | 实现依据 | 状态 |
|---|---|---|---|
| 1 | 签到须有本人有效报名 | `findOwnActiveSignup(status=1)` | ✅ Schema + 1.0 evidence |
| 2 | 每报名仅一次签到 | `UNIQUE(signup_id)` + 预检 | ✅ Schema 约束 |
| 3 | 签退须先签到 | `findOwnSessionBySignup` 非空 | ✅ 本切片约定 |
| 4 | 重复签到/签退安全失败 | UNIQUE + 预检 → 409 | ✅ |
| 5 | 签到/签退须团队上下文 | `requireActor` teamId 校验 | ✅ TEAM_SCOPED |

**OPEN BUSINESS RULES（未擅自决定，见 §17）**：
- `attendance_sessions.status` 0/1/2/3/4 **字典语义在仓库内无文档出处**；本切片仅用 1=已签到 / 2=已签退，其余值（0/3/4）语义未知，未写。
- 是否要求活动处于"进行中"等特定 `activities.status` 才允许签到：Schema 无强制，本切片不强校验。
- `review_status` 由 risk 还是 activity 驱动：留 `attendance.record.review` 切片处理。
- 是否同时写 `attendance_events` 风险打分（`risk_score`/`device_fp_hash`）：本切片仅写最小 `checkin`/`checkout` 证据行，不写风险字段。

---

## 11. Duplicate Protection（并发安全）

- 根因：`attendance_sessions.signup_id UNIQUE` ⇒ 数据库层保证每报名单会话。
- 双重防护：service 预检 `findOwnSessionBySignup` + DB 唯一约束。
- 测试 B20/B21：重复签到 → 409 且数据库仅 1 条；race 冲突映射为 409（不泄露内部）。

---

## 12. Error Semantics（错误语义）

| HTTP | 触发 | code / details |
|---|---|---|
| 401 | 无 Session | `AUTH_REQUIRED` |
| 403 | 无 permission / 无 team 上下文 / 权限随团队失效 | `FORBIDDEN` / `TEAM_SCOPE_REQUIRED` |
| 404 | 跨团队 / 不存在 / Ownership 不成立 | `NOT_FOUND`（不泄露存在性） |
| 409 | 重复/非法状态/未报名/未签到 | `CONFLICT` + `details.reason`（`attendance_not_signed_up` / `attendance_already_checked_in` / `attendance_checkin_required` / `attendance_already_checked_out`） |
| 400 | SQL 注入 activityId | `INVALID_PARAM`（先于 DB 校验） |

**不泄露**：SQL、表名、role id、permission id、internal stack（F1/F2 扫描已验证）。

---

## 13. Security / IDOR（安全与越权）

- **IDOR 阻断**：用户手工构造 activityId/signupId/teamId 均无法跨团队读写。
  - 跨团队活动 → 404（B17 / C15 / D7）。
  - 同团队他人报名（ownerA 签退 volA 的 actAtt1）→ 409 `attendance_not_signed_up`（C12）。
  - volA active=teamB（无该团队角色）→ 403（C14 / D3），Permission 随租户上下文失效。
- **平台角色不绕过**：`platform_super_admin` 持 checkin 但无 team 上下文 → 403 `TEAM_SCOPE_REQUIRED`（D5）；`platform_operator` 无 checkin 权限 → 403（D4）。
- **Ownership 失败零副作用**：C13/F5 验证他人会话（`volB` status=1）未被任何越权请求改变。
- **SQL 参数化**：全部绑定，无插值（§10 纪律）。

---

## 14. Tests（集成测试套件）

新增 `tests/attendance_integration.mjs`：**54/54 PASS**（A=5 / B=17 / C=15 / D=7 / E=6 / F=8）。

| 组 | 覆盖 |
|---|---|
| A. Baseline | 83/238、冻结签到权限存在、持有人、fixture 就绪 |
| B. Check-in | 合法签到落库、统一响应、user/activity/team 正确、status=1、checkin_at、events 行、401/403/404/400/409 全分支、重复签到 409 + 仅 1 条 |
| C. Check-out | 本人签退 status=2 + checkout_at + events、重复签退 409、已报名未签到 409、同团队他人 409、active=teamB 403、跨团队 404、他人会话不受影响 |
| D. Permission+Tenant | volunteer@A 正常、team_admin 无权限 403、切换 team 403、platform 角色约束、team_owner 兼 volunteer 可签到、跨团队 404 |
| E. Live Auth | 角色撤销→下一请求 403、恢复→同一 token 无需重登即 200（Permission 未固化进 Session） |
| F. Security | 无 SQL/表名泄露、无 role/permission id 泄露、无 TEST_ONLY_PERMISSION、无 IDOR 写、无副作用、会话/事件计数一致、无孤儿会话 |

Fixture：新增 `fixture:attendance` 模式（2 teams / 6 users / 8 user_roles / 6 activities / 6 signups / 0 sessions），teardown 后零残留。

---

## 15. Regression（全量冻结回归）

端口：本阶段测试运行时用 **8797**（同本地 D1 fixture；8788/8799 为历史僵死实例，未 broad-kill，8787 Signivra 未受影响）。

| 套件 | 结果 |
|---|---|
| `tsc --noEmit` | 0 error |
| `validate_permission_catalog` | PASS（83/238 无漂移） |
| `validate_permission_seed` | PASS（六角色逐集合 equality） |
| S2-4 `validate_local_d1` | ALL PASS |
| S2-5 `api_integration` | 58 pass, 0 fail |
| S2-6c-1 `session_integration` | 19 pass, 0 fail |
| S2-6c-2 `auth_integration` | 34 pass, 0 fail |
| S2-6c-3 `firstlogin_integration` | 31 pass, 0 fail |
| S2-6c-4 `session_security_integration` | 24 pass, 0 fail |
| S2-6f `authorization_integration` | 42 pass, 0 fail |
| S2-6g `activity_signup_integration` | 61 pass, 0 fail |
| S2-6h `attendance_integration` | 54 pass, 0 fail |

**原冻结 231 项仍全 PASS + 新切片 61+54 PASS = 323 全绿**。未因新业务修改 Auth/Session/Authorization 行为。

---

## 16. Changed Files（变更文件）

新增：
- `src/policies/ownership.ts`（扩展 `AttendanceSessionOwnershipPolicy`）
- `src/repository/attendance-sessions.ts`
- `src/services/attendance-service.ts`
- `src/routes/activities.ts`（扩展 checkin/checkout 路由）
- `src/utils/errors.ts`（新增 `ATTENDANCE_*` ConflictReason）
- `tests/attendance_integration.mjs`
- `tests/fixture.mjs`（`attendance` 模式 + teardown 残留在册）
- `package.json`（`fixture:attendance` / `test:attendance` 脚本）
- `run_regression.sh`（全量回归编排，非提交物）
- `docs/architecture/S2-6h-REPORT.md`

**未改（纪律遵守）**：`permission-catalog.json` / `0003_seed_permissions.sql` / roles / role_permissions / 任何 migration（仍 3 个）/ `activity_signups` schema。

---

## 17. OPEN BUSINESS RULES（待裁决，未擅自决定）

1. `attendance_sessions.status` 0/1/2/3/4 字典语义缺失文档出处 → 本切片仅用 1/2。
2. 签到是否要求活动特定 `activities.status`（如"进行中"）未确认 → 不强校验。
3. `review_status` 驱动逻辑 → `attendance.record.review` 切片。
4. `attendance_events` 风险打分/设备指纹 → 后续切片（非最小 evidence）。
5. 管理员强制签退/审核他人（`force`/`review`）→ 明确冻结于后续切片，本阶段不实现。

---

## 18. CATALOG / SCHEMA GAP

- **CATALOG GAP：无**（本人签到/签退码已冻结）。
- **阻塞性 SCHEMA GAP：无**（`attendance_sessions` 列齐备，`UNIQUE(signup_id)` 已保障并发安全；无需新增 0004）。
- 文档缺口：`docs/architecture/RESOURCE-OWNERSHIP-RULES.md`（S2-6g 引用）在仓库内**不存在** —— 影响 ownership 规则可追溯性，建议后续补建（非本切片阻塞项）。

---

## 19. Final Gate（逐项回答）

| # | Gate | 结果 |
|---|---|---|
| A | 签到是否真实落库 | ✅ B5/B7-B11 验证 session + events 写入 |
| B | 本人签退是否真实生效 | ✅ C5/C6/C8 验证 status=2 + checkout_at |
| C | Permission 是否来自 D1 Runtime | ✅ D1PermissionProvider 裁决 83/238 |
| D | Tenant Scope 是否阻断跨团队 | ✅ B17/C15/D7 → 404 |
| E | Ownership 是否阻断取消他人 | ✅ C12 同团队他人 → 409 |
| F | Permission 与 Ownership 是否独立 | ✅ 两者正交，均显式判定 |
| G | 重复签到是否安全 | ✅ B20/B21 → 409 且仅 1 条 |
| H | 是否不存在 IDOR | ✅ 跨团队/同团队他人均阻断 |
| I | 角色撤销是否下一请求生效 | ✅ E3 撤销→403 |
| J | Permission 是否未固化进 Session | ✅ E6 同 token 恢复→200 |
| K | 83/238 是否无漂移 | ✅ catalog/seed validator + A1/A2 |
| L | Schema 是否未改 | ✅ 仍 3 migrations |
| M | Catalog 是否未改 | ✅ 未触动 permission-catalog.json |
| N | 新 attendance suite 是否全 PASS | ✅ 54/54 |
| O | 原 231 项是否仍全 PASS | ✅ 全量回归确认 |
| P | Final teardown 是否零残留 | ✅ 全部测试表 = 0 |
| Q | Signivra 8787 是否未受影响 | ✅ PID 2600 仍 LISTENING |
| R | 是否发生 Production 操作 | ✅ 否（仅本地 D1 + 端口 8797） |
| S | 是否存在未裁决 CATALOG GAP | ✅ 无 |
| T | 是否存在阻塞性 SCHEMA GAP | ✅ 无 |
| U | 是否可以进入下一个垂直切片 | ⚠️ 需新授权简报（见 STOP） |

---

## 20. STOP

完成：
```
Signup(S2-6g) → Check-in/Check-out(S2-6h)
→ Permission → Tenant Scope → Ownership → Repository mutation
→ integration test(54) → full regression(323) → report
```
之后立即 **STOP**。

未进入（需独立授权与 phase-confirmation gate）：
- 强制签退（`force`）/ 审核（`review`）/ 异常处理（`anomaly`）
- 签到心跳（heartbeat）/ 设备指纹 / 风险打分
- 服务时长 / 积分 / 证书 / 候补队列 / 通知 / 支付 / 活动发布流程重构
- S2-6i 或其它业务域

**S2-6h = GO**（全部 Final Gate 成立）。进入下一切片需新授权简报，按"只读优先 / 阶段门禁 / 不越权"纪律先对该域做只读探查。
