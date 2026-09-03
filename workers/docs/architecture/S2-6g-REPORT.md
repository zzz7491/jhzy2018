# S2-6g 报告：Activity Signup Vertical Slice

> 执行搭档：**WorkBuddy**
> 目标：首个真实业务授权闭环 `Session → Role → Permission(D1) → Tenant Scope → Ownership → Repository Write`
> 范围：**仅**活动报名创建 + 本人取消 + 直接相关的查询/校验 + `activity_signups` ownership。其余业务域一律未扩展。

---

## 1. Baseline（S2-6f 收口状态）

| 项 | 值 |
|---|---|
| Authentication | GO |
| Session | GO |
| Tenant Scope | GO |
| Permission Catalog | GO（冻结） |
| Permission Seed | GO（冻结） |
| Runtime Authorization | GO |
| roles | 6 |
| permissions | 83 |
| role_permissions | 238 |
| d1_migrations | 3 |
| S2-4 ~ S2-6f regression | 231/231 PASS（本次复跑全部 0 fail） |

---

## 2. Slice Selection

本阶段仅实现两个写端点（不做整套 Signup CRUD）：

- `POST   /api/v2/activities/:activityId/signups` —— 当前登录用户报名活动
- `DELETE /api/v2/activities/:activityId/signups/me` —— 当前登录用户取消**本人**报名

禁止实现：管理员批量/代报名、审核后台、签到、服务时长、积分、证书、候补、通知、支付、活动发布流程重构。

---

## 3. Existing Schema Evidence（只读事实，非草案）

来自 `migrations/0001_initial_schema.sql`：

- `activity_signups`：**无 `team_id` 列**，`user_id` + `activity_id` 均引用他表；含 `UNIQUE(user_id, activity_id)`（§12 并发安全的事实基础）。
- `activities.status` CHECK：`BETWEEN 0 AND 7`；业务字典（数据库设计方案 V1.0 §4.2）：`0草稿 / 1报名中 / 2进行中 / 3已结束 / 4已取消 / 5已下架 / 6待发布 / 7已下架`。
- `activities.allow_cancel`、`activities.need_audit`：已存在（RESOURCE-OWNERSHIP-RULES §3 明示约束）。
- `activity_signups.review_status` / `status` / `cancel_count`：已存在列。
- Tenant Scope 矩阵（S2-3）：`activity_signups` 属 **DERIVED_TEAM_TABLES**（team 由 `activity_id → activities.team_id` 派生，禁止简单 `WHERE team_id=?`）。

---

## 4. Frozen Permission Codes Used

唯一事实 = `scripts/permission-catalog.json`（未改、未增）：

| 用途 | 冻结 permission code | scopeType / risk | 冻结持有人 |
|---|---|---|---|
| 报名活动 | `signup.signup.create` | USER / LOW | `platform_super_admin`, `volunteer` |
| 取消自己的报名 | `signup.signup.cancel` | USER / LOW | `platform_super_admin`, `volunteer` |
| 审核活动报名 | `signup.signup.review` | TEAM / HIGH | **本阶段不使用**（审核 ≠ 取消他人） |

- **CATALOG GAP：无。** 完成本切片所需能力均已在冻结目录中。
- 未新增任何 permission，未改任何 code，未改 83/238 矩阵。

---

## 5. Signup Create Flow（POST /signups）

判定链（`service.createOwn`）：

1. 已认证 + 有 `userId`（否则 401 `AUTH_REQUIRED`）。
2. 合法团队上下文（否则 403 `TEAM_SCOPE_REQUIRED`）。
3. 权限 `signup.signup.create` 由 `D1PermissionProvider` 裁决（无权限 → 403 `FORBIDDEN`）。
4. `:activityId` 为 ULID public_id；非法格式 → 400 `INVALID_PARAM`（先于任何 DB 访问，兼作注入防护第一层）。
5. `ActivityRepository.findSignupTargetByPublicId`：`activities.public_id = ? AND team_id = ? AND deleted_at IS NULL` → 活动不存在 / 跨团队 → 同一 404 `NOT_FOUND`（不泄露存在性）。
6. 业务不变式：仅 `activities.status = 1`（报名中）开放报名，否则 409 `activity_signup_closed`。
7. 重复预检（快路径）→ 409 `signup_already_exists`。
8. `INSERT`：`user_id` 恒等于 `AuthContext.userId`（**绝不来自请求体**）；`review_status` 由 `activities.need_audit` 推导（免审→1 通过 / 需审→0 待审）；`UNIQUE(user_id,activity_id)` 冲突 → 409 `signup_duplicate_race`。

响应：统一 `ok(c, { signup }, 201)`，`X-Request-ID` 与体一致。

---

## 6. Signup Cancel Flow（DELETE /signups/me）

判定链（`service.cancelOwn`）：

1. 已认证 + 团队上下文（401 / 403 `TEAM_SCOPE_REQUIRED`）。
2. 权限 `signup.signup.cancel`（D1 裁决）。
3. 活动存在 + 租户范围 → 404。
4. 业务不变式：`activities.allow_cancel = 1`，否则 409 `activity_cancel_not_allowed`。
5. 查本人**有效**报名（`status=1`，经 activities 派生租户隔离）→ 无 → 404（取消为单向终态，已取消再取消亦 404）。
6. Ownership（SELF）判定 `signup.user_id === auth.userId` → 不成立 → 404（不泄露存在）。
7. 原子 `UPDATE ... WHERE id=? AND activity_id=? AND user_id=? AND status=1 AND EXISTS(activities.team_id=?) → changes=0` 即 404。

**本阶段不提供取消他人报名入口**：冻结目录与 RESOURCE-OWNERSHIP-RULES 均无以角色名授予"取消他人"的规则（`signup.signup.review` 只覆盖 `review_status`，不覆盖取消他人）。

---

## 7. Tenant Scope

- `activity_signups` 为 **TEAM_SCOPED（派生）**：所有查询经 `JOIN activities a ON a.id = s.activity_id` 并以 `a.team_id = ?` 限定（见 `activity-signups.ts`、`activities.findSignupTargetByPublicId`）。
- 中间件权限放行后，Repository **仍**二次收口：`PermissionProvider != Tenant filter`。
- 跨团队（Team A 用户请求 Team B 活动/报名）→ 404，与既有 Tenant Repository 冻结语义一致。

---

## 8. Ownership Policy

文件：`src/policies/ownership.ts`

- 仅实现 `ActivitySignupOwnershipPolicy`（实现最小接口 `OwnershipPolicy<T>.canAct`）。
- 规则：`resource.user_id === auth.userId`（RESOURCE-OWNERSHIP-RULES §3 SELF 清单）。
- 未实现 `Certificate/Points/Profile` 策略；未建立 registry / DSL / policy engine（避免过度抽象，§五）。
- Ownership 与 Permission **严格正交**：Permission granted 不自动意味着可操作他人资源。

---

## 9. Repository Design

- `ActivitySignupRepository extends BaseRepository`（唯一写入口）：
  - `findOwnSignup` / `findOwnActiveSignup` / `findByIdForTeam`：均 `JOIN activities` 派生租户隔离，全参数化。
  - `insertSignup`：`user_id` 由 Service 以 `AuthContext.userId` 传入，绝不来自请求体；`UNIQUE` 冲突 → 409。
  - `cancelOwnSignup`：原子 UPDATE，`tenant + ownership + status` 全部写入 `WHERE`（IDOR 与零副作用双保险）。
- `ActivityRepository` 仅扩展 `findSignupTargetByPublicId`（读报名目标活动，含 `allow_cancel`/`need_audit` 与派生 team 隔离），未改既有响应结构。
- 分层：`route → authorization(middleware) → service(use-case) → repository`，未揉成 MegaService。

---

## 10. Business Invariants

仅实现可由 Schema / 冻结文档 / 1.0 业务证据证实的规则：

| 规则 | 来源 | 实现 |
|---|---|---|
| 仅 `status=1 报名中` 可报名 | DB 设计方案 §4.2 | 409 `activity_signup_closed` |
| `allow_cancel=1` 才可取消 | RESOURCE-OWNERSHIP-RULES §3 | 409 `activity_cancel_not_allowed` |
| 免审→报名即审核通过(1)；需审→待审核(0) | 蓝图 V1.0「免审/需审」流程 | `review_status` 推导 |
| 取消为单向终态（已取消再取消→404） | 冻结语义 | `findOwnActiveSignup` 仅查 status=1 |
| 报名 `user_id` = 当前用户 | §四 Ownership | Service 固定 `AuthContext.userId` |

---

## 11. Duplicate Protection（§十二）

- Schema 已有 `UNIQUE(user_id, activity_id)`（0001）。
- 预检 `SELECT` 仅快路径；**真正的并发安全 = 数据库约束**。
- `INSERT` 抛出 UNIQUE 冲突 → 收敛为 409 `signup_duplicate_race`，**不泄露 SQL/表名**。
- 未新增任何 migration（见 §21）。

---

## 12. Error Semantics

沿用既有 `AppError` / uniform response，新增 `CONFLICT(409)`（仅增量，不影响既存码）：

| 场景 | code | HTTP |
|---|---|---|
| 无 Session | `AUTH_REQUIRED` | 401 |
| 无 permission / 无团队上下文 / 越权团队 | `FORBIDDEN` / `TEAM_SCOPE_REQUIRED` | 403 |
| 活动/报名不存在 / 跨团队 | `NOT_FOUND` | 404（不泄露存在） |
| 重复报名 / 状态冲突 / 禁止取消 | `CONFLICT`（reason: `signup_already_exists` 等） | 409 |
| `TEST_ONLY_PERMISSION` 等不在目录 | `INTERNAL_ERROR` | 500 |

响应体仅含 `code / message / request_id`；无 SQL、表名、role_id、permission_id、内部栈。

---

## 13. Security / IDOR

- **禁止 IDOR**：取消接口无"按 signupId 操作任意报名"入口，仅 `signups/me`（本人 + 当前租户）。`cancelOwnSignup` 的 `WHERE` 自带 `user_id=?` + `EXISTS(activities.team_id=?)`，即使持有跨团队 signupId 也 0 命中。
- 跨团队读取/写入在**数据访问层**共同阻断（Tenant Scope + Ownership）。
- Ownership 失败 → 404，且在 mutation 之前，**零写入**（§19 由 C 组/C16/F7 断言证明）。
- `TEST_ONLY_PERMISSION` 不在目录 → 500，无授权效力。

---

## 14. Tests（tests/activity_signup_integration.mjs）

**总计 61 项，全部 PASS（A=5 / B=14 / C=16 / D=8 / E=7 / F=7）。**

- **A. Baseline**：目录 83/238、冻结权限存在且持有人正确、fixture 就绪。
- **B. Create**：合法报名落库 + 统一响应 + user_id/activity_id/team 正确；无 Session→401；无权限→403；不存在→404；跨团队→404；注入→400；重复→409 且库内仅 1 条；草稿→409；被拒不落库。
- **C. Cancel Own**：取消生效（status=2、cancel_count=1）；重复取消→404 且零二次计数；不能取消他人（→404，他人零变更）；跨团队→404；不存在→404；需审报名 review_status=0；`allow_cancel=0`→409；被拒零副作用。
- **D. Permission + Tenant**：TeamA volunteer + active A 正常；team_admin + active B 不继承 A 权限；切换 active team 行为正确；PLATFORM 权限不绕过 ownership/tenant；TEAM 权限不跨 Team。
- **E. Live Authorization**：撤销 volunteer@teamA → 下一请求权限消失（403）；恢复 → 下一请求恢复（201）；全程无需重新登录；Permission 未固化进 Session；revoke/restore 后目录仍 83/238。
- **F. Security**：报名业务面响应无 SQL/表名泄露；无 role_id/permission_id 泄露；`TEST_ONLY_PERMISSION` 无效；无 signupId 写端点；409 不泄露 UNIQUE；无越界/孤儿报名行；套件自检清理后 `activity_signups=0`。

---

## 15. Regression（全量冻结回归）

| 套件 | 命令 | 结果 |
|---|---|---|
| tsc --noEmit | `npm run typecheck` | 0 error |
| Catalog 校验 | `validate_permission_catalog` | 全 PASS（83/238 无漂移） |
| Seed 校验 | `validate_permission_seed` | 全 PASS（六角色集合 equality） |
| S2-4 | `validate_local_d1` | ALL PASS（干净库） |
| S2-5 | `api_integration` | exit 0 / 0 fail |
| S2-6c-1 | `session_integration` | exit 0 / 0 fail |
| S2-6c-2 | `auth_integration` | exit 0 / 0 fail |
| S2-6c-3 | `firstlogin_integration` | 31 pass / 0 fail |
| S2-6c-4 | `session_security_integration` | exit 0 / 0 fail |
| S2-6f | `authorization_integration` | pass=42 / fail=0 |
| **S2-6g（新）** | `activity_signup_integration` | **pass=61 / fail=0** |

→ 原 231 项保持 PASS + 新 signup 套件 61 项 PASS。未因新业务修改 Auth / Session / Authorization 行为。

---

## 16. Changed Files

新增：
- `src/policies/ownership.ts` — `ActivitySignupOwnershipPolicy`（唯一实现）
- `src/repository/activity-signups.ts` — `ActivitySignupRepository`（唯一写入口，全参数化 + 派生租户隔离）
- `src/services/activity-signup-service.ts` — `ActivitySignupService`（创建/取消本人报名 use-case）
- `tests/activity_signup_integration.mjs` — 61 项集成套件
- `docs/architecture/S2-6g-REPORT.md` — 本报告

修改：
- `src/utils/errors.ts` — **增量**新增 `CONFLICT(409)` 与 `ConflictReason`（不改既存码）
- `src/utils/response.ts` — 状态集合纳入 409（既存折叠策略不变）
- `src/repository/activities.ts` — 仅扩展 `findSignupTargetByPublicId`（读报名目标活动）
- `src/routes/activities.ts` — 新增两个 signup 写端点（既有只读端点未改）
- `tests/fixture.mjs` — 新增 `signup` 模式 + `IDS`（actS1~S6、platSuper 等）+ cascade 覆盖 `activity_signups` + teardown 零残留断言
- `package.json` — 新增 `fixture:signup` / `test:signup` 脚本

---

## 17. OPEN BUSINESS RULES（未擅自决定，标记待裁决）

1. 非 `status=1` 活动（进行中/已结束/已下架等）是否允许报名 —— 本阶段仅开放 `status=1`，其余为 OPEN。
2. 已取消后是否允许重新报名（当前 `UNIQUE` 覆盖全 status → 不可重新报名；若业务需"取消后重报"需放开 UNIQUE，属 schema 变更，待裁决）。
3. 报名时间窗（`signup_start/end`）—— Schema 无此列，未实现。
4. 用户是否必须属于活动团队才能报名 —— 现有实现仅要求**合法 active team 上下文**且活动属该团队，未强制 `team_members` 成员关系（无冻结证据）。
5. 管理员/团队 owner 取消他人报名的 ownership 规则 —— 冻结目录无此规则，本阶段未实现（留后续切片）。

---

## 18. CATALOG / SCHEMA GAP

- **CATALOG GAP：无。** 完成本切片所需 permission 均已在冻结目录。
- **SCHEMA GAP：无（阻塞性）。** 现有 `UNIQUE(user_id,activity_id)`、`activities.status`/`allow_cancel`/`need_audit`、`activity_signups` 已有列均足以支撑本切片，无需新增 migration。
- 本阶段 `d1_migrations` 仍 = 3（未创建 0004）。

---

## 19. Final Gate（逐项回答）

| 项 | 结论 |
|---|---|
| A. Signup Create 真实落库 | ✅ B1–B5 断言 user_id/activity_id/team/status 正确 |
| B. Cancel Own Signup 真实生效 | ✅ C1–C2 断言 status=2、cancel_count=1、updated_at 写入 |
| C. Permission 来自 D1 Runtime | ✅ `requirePermission` 复用 `D1PermissionProvider`（83/238），无角色名短路 |
| D. Tenant Scope 阻断跨团队 | ✅ B9/D3b/D5/C9 跨团队→404 |
| E. Ownership 阻断取消他人 | ✅ C6–C7 他人记录零变更 |
| F. Permission 与 Ownership 独立 | ✅ D4c 平台权限不绕过 ownership |
| G. Duplicate signup 安全 | ✅ B11–B12 预检 + UNIQUE 约束，库内仅 1 条 |
| H. 不存在 IDOR | ✅ F4 无 signupId 写端点；cancelOwnSignup WHERE 自带归属+租户 |
| I. Role revoke 下一请求生效 | ✅ E1 撤销后下一请求 403 |
| J. Permission 未固化进 Session | ✅ E4 |
| K. 83/238 无漂移 | ✅ validate 校验 + E5 |
| L. Schema 未改 | ✅ migrationsApplied=3，无 0004 |
| M. Catalog 未改 | ✅ permission-catalog.json 未动 |
| N. 新 signup suite 全 PASS | ✅ 61/61 |
| O. 原 231 项仍全 PASS | ✅ S2-4~S2-6f 全部 0 fail |
| P. Final teardown 零残留 | ✅ users/identities/sessions/user_roles/team_members/teams/security_events/activities/activity_signups = 0 |
| Q. Signivra 8787 未受影响 | ✅ 仅用 8799（见端口说明）；8787(PID 13020) 持续监听 |
| R. 无 Production 操作 | ✅ 仅本地 `--local` |
| S. 无未裁决 CATALOG GAP | ✅ |
| T. 无阻塞性 SCHEMA GAP | ✅ |
| U. 可进入下一业务 vertical slice | ✅ |

---

## 20. STOP

已完成：`Signup Create → Signup Cancel Own → Permission → Tenant Scope → Ownership → Repository mutation → integration test（61/61）→ full regression（231 原项 0 fail）→ report`。

**S2-6g = GO**

未自动进入：签到、服务时长、积分、证书、培训、团队成员写 API、Production、deploy、S2-6h。

---

### 端口与 Harness 说明（纪律补充）

- 本切片测试运行于 **8799**（项目内新建、port-scoped、与 8787 无关）。
- 8788 的常驻 dev 在上一会话因被中途 `taskkill` 其 worker 子进程而进入僵死（listen 但不响应）；为避免 broad kill、且不触碰 8787，本次改用全新 8799 实例（同一本地 D1 fixture，数据一致）。8788 僵死进程未做强制清理（仅 project/port-scoped 操作，未影响 8787 或任何生产）。如需恢复 8788 标准运行，建议单独重启该 worker 父进程。
- 所有 fixture 操作遵守 `setup before dev / teardown after dev`，未触发文件锁竞争；teardown 后零残留。
