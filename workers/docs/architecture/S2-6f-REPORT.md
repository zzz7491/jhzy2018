# S2-6f 实施报告：Runtime Authorization Core Integration

> 执行搭档：**WorkBuddy**
> 目标：让 Worker Runtime 正式从 D1 加载当前用户角色对应的 permissions，并实现统一的 Permission Authorization Core。
> 范围：**仅授权核心**（Authenticated / Role / Permission / Tenant Scope）。未触碰活动报名、积分、证书、签到等业务写链路。
> 结论：**S2-6f = GO**（详见 §18 Final Gate，A–S 全 PASS）。

---

## 1. Baseline（冻结基线）

| 项 | 状态 |
|---|---|
| Authentication / Session / Tenant Scope / Permission Catalog / Permission Seed | 全部 GO |
| 机器事实源 | `workers/scripts/permission-catalog.json` |
| 数据库事实源 | `0003_seed_permissions.sql`（机械生成，非手改） |
| 冻结计数 | roles=6 / permissions=83 / role_permissions=238 / d1_migrations=3 |
| 本阶段前一刻回归 | S2-4..S2-6c-4 = **189/189 PASS** |

本阶段在以上基线上新增「运行时权限解析」，不改变 Catalog / Matrix / Schema / Seed。

---

## 2. Runtime Authorization Architecture

请求链路（每请求实时推导，无任何权限固化）：

```
authContextMiddleware
  └─ extractAuth(c)
       ├─ 主通道：真实 D1 Session（Bearer / x-session-token / __Host-session Cookie）
       │    → SessionService.resolve() 返回 { auth, roles: UserRoleRow[] }
       │    → 透传 auth.roles（来自 user_roles，绝不固化权限）
       └─ 回归通道（local only）：x-test-* 头同样构造 roles[] 列表
  ↓
tenantContextMiddleware → buildTenantContext(auth)
  └─ 平台级绑定(scopeTeamId==null) 任一存在 → PLATFORM_GLOBAL
  └─ 否则团队角色 + teamId → TEAM_SCOPED；其余 → USER_SCOPED
  ↓
业务路由 requirePermission(code) / can(...)
  └─ authorizePermission(env, auth, code)
       └─ authorizePermissionDecision(env, auth, code)
            └─ new D1PermissionProvider(env.DB)  ← 唯一运行时权威 = D1 role_permissions
```

职责分离：**PermissionProvider 只回答「用户有没有某项业务能力」**；**Tenant Scope（Repository 层）只回答「该能力在哪些数据范围内可用」**。两者正交，Provider 永不生成 `WHERE team_id=?`。

---

## 3. D1PermissionProvider

文件：`src/services/permission-provider.ts`（新建）。

```ts
export interface PermissionProvider {
  getPermissions(auth: AuthContext): Promise<Set<string>>;   // Platform ∪ Team(active)
  isKnownPermission(code: string): Promise<boolean>;          // 存在性（区分 403/500）
  hasPermission(auth: AuthContext, code: string): Promise<boolean>;
}

export class D1PermissionProvider implements PermissionProvider {
  // request-local 缓存（实例每请求新建，见 rbac.ts）
  private permCache: Set<string> | null = null;
  private catalogCache: Set<string> | null = null;
  ...
}
```

**禁止项（全部满足）**：硬编码六角色权限 / runtime 读 JSON / wildcard / 写死 `super_admin => true` / 按角色名 if-else / Session token 固化 permission list。正式运行时唯一 truth = D1 `role_permissions`。

---

## 4. Permission Resolution SQL

单次参数化 JOIN（禁字符串拼 SQL，禁随 83 条增长为 83 次查询）：

```sql
SELECT DISTINCT p.code
  FROM roles r
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p       ON p.id   = rp.permission_id
 WHERE r.code IN (?, ?, ... )          -- codes 来自 auth.roles 经 effectiveRoleCodes 过滤，.bind(...codes)
```

`effectiveRoleCodes(auth)` 过滤规则（§五/§六/§七）：

```ts
auth.roles
  .filter(b => b.scopeTeamId == null            // platform 绑定：恒生效，不依赖 active team
            || b.scopeTeamId === auth.teamId)   // team 绑定：仅当 scopeTeamId === 当前 active teamId
  .map(b => b.role)
```

有效权限集合 = `PlatformPermissions(user) UNION TeamPermissions(user, activeTeam)`，继续受 Tenant Scope 约束；无合法 active team 时 team 绑定一律不生效（middleware 拒绝）。

---

## 5. PLATFORM vs TEAM semantics

- `platform_super_admin` / `platform_operator` 的绑定 `scopeTeamId == null` → 恒生效，不依赖 `X-Team-Id`。
- team 角色（`team_owner` / `team_admin` / `team_auditor` / `volunteer`）绑定 `scopeTeamId != null` → 仅当其 `scopeTeamId === auth.teamId`（当前 active team）时参与解析。
- 两者正交：`buildTenantContext` 与 `D1PermissionProvider` 分别依据 `scopeTeamId` 判定，不存在「把某用户全部 TEAM 角色 permissions 全 UNION 用于任意团队」。

---

## 6. Active Team semantics

- `X-Team-Id` 仅决定当前 TEAM Context（绑定的 `auth.teamId`），**不固化进 Session**。
- 多团队用户（如 TeamA=team_owner + TeamB=volunteer）：active=TeamB 时只计算 TeamB 的 volunteer 绑定，不得继承 TeamA 的 team_owner 权限（测试 C2/C4/F4 证明）。
- 切回 TeamA → team_owner 权限恢复（测试 C3/D2/G 证明）。

---

## 7. Multi-role semantics

- 同团队多角色（ownerA@teamA = team_owner + volunteer）：权限 UNION（测试 D1/D1b/D2/D3）。
- 不同团队角色：不跨团队 UNION（测试 C2/S8b）。
- PLATFORM + TEAM 合并：`PlatformPermissions UNION TeamPermissions(activeTeam)`（测试 B4/I1）。
- 重复 permission 自动去重（Set 语义）。

---

## 8. requirePermission

`src/middleware/rbac.ts` 升级为 DB-backed（原 mock / `PERMISSION_CATALOG_FROZEN` 已退役）：

| 情形 | 结果 | 内部 error code |
|---|---|---|
| 未认证 | 401 | `AUTH_REQUIRED` |
| code 不在目录（配置错误） | 500 | `INTERNAL_ERROR`（服务端 `console.error` 记录，**不向客户端泄露 code/SQL/id**） |
| code 存在但当前用户/上下文无授权 | 403 | `FORBIDDEN` |
| 否则 | 放行 | — |

`requirePermission(code)` 返回 Hono middleware，内部 `await authorizePermission(...)`；调用方（`__test` 路由等）均已 `await`。

---

## 9. can()

```ts
export async function can(env, auth, _tenant, code): Promise<boolean>
```

便捷布尔判定，等价于 `authorizePermissionDecision(...) === 'allow'`。`_tenant` 入参保留签名以承载未来 Ownership 扩展；`can()` 会「吞掉」`unknown_permission` 信号，需区分 403/500 的调用方应使用 `authorizePermissionDecision`。

---

## 10. request-local caching

- `D1PermissionProvider` 实例由 `authorizePermissionDecision` **每请求新建**，内部 `permCache` / `catalogCache` 仅在该请求生命周期内有效。
- **无** KV / Durable Objects / Redis / 跨请求长期缓存 → 角色变化下一请求立即生效（§十三，测试 E 组证明）。

---

## 11. TEST_ONLY_PERMISSION disposition

- 常量 `TEST_ONLY_PERMISSION` 保留为历史标记，**不再参与任何授权路径**。
- 它 **NOT IN** 正式 catalog / D1；本阶段**未**为旧 K2 测试 `INSERT TEST_ONLY_PERMISSION`。
- 旧 K2（local mock 放行）已迁移为真实 seed permission 验证：`api_integration.mjs` 的 K 组改为以 `volunteer` 请求无授权 code（→403）/ 已授权 code（→200）/ 未认证（→401）三态验证（K1/K2/K3）。
- 测试「不存在 code」走 `/permission?code=不存在值` 真实路由，不写 DB（测试 F1）。

---

## 12. Ownership boundary（§十八）

- **本阶段只建立接口边界，不实现真实业务资源（活动/报名/积分/证书）所有权判定。**
- 边界由架构强制保持：
  1. `PermissionProvider` 只回答 capability，绝不做数据行过滤（§七）；
  2. `can()` 显式将 ownership 排除在本阶段之外（`_tenant` 仅签名保真）；
  3. 数据范围过滤完全由既有 `TenantContext` / Repository scope 层负责。
- 因此：**Permission granted ≠ resource ownership automatically granted** 在本阶段即成立（授权与所有权是两件事）。
- 显式 `OwnershipPolicy` 接口桩将随首个真实业务授权垂直切片（S2-6g，如活动写 API）一并引入，以 `signup.user_id` / `certificate.user_id` 等 Repository 检查收口。

---

## 13. New tests

- **新建 `tests/authorization_integration.mjs`（42 项，A–G 组）**，全部走真实 Session 路径（Bearer + D1 `user_roles` → Provider），覆盖：
  - A 目录/Provider 基线（83/238、各角色解析数）；
  - B PLATFORM 解析（operator 持/无、不依赖 team 头）；
  - C TEAM 绑定 active team（owner@A、owner@B 仅 volunteer、teamAdmin@A）；
  - D 多角色 UNION；
  - E 角色变化下一请求即时生效（真实改 `user_roles`：team_admin→volunteer 立即 403，恢复立即 200）；
  - F 安全与越权（unknown→500、未认证→401、停用→401、跨团队→403、平台带 team 头仍无 team perm）；
  - G Platform/Team 正交与矩阵严格性。
- **`api_integration.mjs` K 组迁移**：以真实 seed permission 替换旧 mock 判定（K1 无授权→403 / K2 已授权→200 / K3 未认证→401）。
- 结果：**42/42 PASS**。

---

## 14. Regression

完整回归（单台常驻 dev 服务器 + 各套件 fixture setup/teardown，端口 8788；signivra 8787 未触碰）：

| Suite | 内容 | 结果 |
|---|---|---|
| S2-4 | validate_local_d1（standalone，直读 D1） | ✅ exit 0 |
| S2-5 | api_integration | ✅ 58/58 |
| S2-6c-1 | session_integration | ✅ 19/19 |
| S2-6c-2 | auth_integration | ✅ 34/34 |
| S2-6c-3 | firstlogin_integration | ✅ 31/31 |
| S2-6c-4 | session_security_integration | ✅ 24/24 |
| S2-6f | authorization_integration（新建） | ✅ 42/42 |
| **合计** | | **231/231 PASS（TOTAL_FAIL=0）** |

附加门禁（本地）：`tsc --noEmit` 通过；`validate_permission_catalog`（83/238 无漂移、无 wildcard、平台/团队正交）全 PASS；`validate_permission_seed`（DB==JSON、6 角色、238 绑定、无 wildcard）全 PASS。旧 189 项全部保持 PASS，新套件全 PASS。

---

## 15. Security Audit（§二十二，逐项 PASS）

- [x] Permission lookup 来自 D1（D1PermissionProvider，无 JSON 读取）
- [x] 无 role hardcode shortcut（无任何 `if (role === '...')`）
- [x] 无 super_admin bypass（`platform_super_admin` 经 83 条显式 binding 解析）
- [x] 无 wildcard（目录/种子校验器均确认 0 条 `*`，Provider 不识别 `*`）
- [x] no N+1（单次 JOIN 解析全部有效 permission）
- [x] SQL parameterized（全部 `prepare().bind()`）
- [x] TEAM role 不跨 active team（`effectiveRoleCodes` 过滤）
- [x] PLATFORM/TEAM scope 正交（`buildTenantContext` + Provider 分别判定）
- [x] Permission 未固化进 Session（每请求 `user_roles` 实时推导；E 组证明）
- [x] role change 下一请求生效（E 组 live-change 测试）
- [x] test permission 不进入正式 runtime/DB（`TEST_ONLY_PERMISSION` 退役，未 INSERT）
- [x] no token / Cookie / identity leakage（响应体零 token/SQL/内部 id；M/F 组）
- [x] no SQL leakage（error-handler 统一剥离；F1b 500 不泄露 code）
- [x] no Schema change（未新增 migration；d1_migrations 仍 = 3）
- [x] 0003 未手改（seed validator DB==JSON）
- [x] 83/238 未漂移（catalog/seed validator + 每套件断言）
- [x] no Production / no deploy / no DNS / no Secret / 1.0 untouched

---

## 16. Changed Files

| 文件 | 变更 |
|---|---|
| `src/types/auth.ts` | `AuthContext` 新增 `roles: UserRoleBinding[]`；新增 `UserRoleBinding`；`UNAUTHENTICATED.roles=[]` |
| `src/types/tenant.ts` | `buildTenantContext` 基于 `auth.roles` 派生 PLATFORM_GLOBAL（平台级绑定恒生效） |
| `src/middleware/auth.ts` | `extractAuth` 透传 `resolved.roles`；新增 `mockRoleBindings()` 使 local mock 同样走 roles 路径 |
| `src/services/session-service.ts` | `resolve()` 返回的 `auth` 填充 `roles`（来自实时 `user_roles`） |
| `src/repository/tenant-scope.ts` | AUDIT_ONLY 读者判定改用 `auth.roles` 列表 |
| `src/services/permission-provider.ts` | **新建** D1PermissionProvider + `authorizePermissionDecision` + `can()` |
| `src/middleware/rbac.ts` | `authorizePermission` / `requirePermission` 升级为 DB-backed（403/500 语义）；`TEST_ONLY_PERMISSION` 退役 |
| `src/routes/__test.ts` | `/permission` 改 `await` DB-backed；新增 `/permissions` 探针路由 |
| `tests/authorization_integration.mjs` | **新建** 42 项授权矩阵套件（A–G） |
| `tests/fixture.mjs` | 新增 `authz` 模式（teamAdminA + 多角色/多团队 user_roles=9） |
| `tests/api_integration.mjs` | K 组由 mock 迁移为真实 seed permission 验证 |
| `package.json` | 新增 `fixture:authz` / `test:authz` 脚本 |

调试脚本 `scripts/_probe_perms.mjs`、`scripts/_debug_authz.mjs` 为本阶段排查用，已删除，非交付物。

---

## 17. OPEN / GAP

- **无 CATALOG GAP**：本阶段未触发任何「角色应多一个权限」的修改需求；Catalog / Matrix 保持 83/238 冻结。
- **OwnershipPolicy 接口桩**：按 §十八为「允许」项，显式接口随首个业务垂直切片（S2-6g）引入，本阶段仅建架构边界。
- 未发现需用户裁决的缺口。

---

## 18. Final Gate（§二十四）

| Gate | 结论 |
|---|---|
| A. Runtime 从 D1 读取权限 | ✅ PASS |
| B. 无 role hardcode shortcut | ✅ PASS |
| C. super_admin 无隐式 bypass | ✅ PASS |
| D. PLATFORM role 正确 | ✅ PASS |
| E. TEAM role 绑定 active team | ✅ PASS |
| F. 跨团队阻断 | ✅ PASS |
| G. 多角色权限合并正确 | ✅ PASS |
| H. Role 修改下一请求立即生效 | ✅ PASS |
| I. Permission 未固化进 Session | ✅ PASS |
| J. TEST_ONLY_PERMISSION 未进入正式 runtime/DB | ✅ PASS |
| K. unknown permission 安全失败（500） | ✅ PASS |
| L. SQL 全部参数化 | ✅ PASS |
| M. 避免 N+1 | ✅ PASS |
| N. Ownership 保持独立边界 | ✅ PASS |
| O. 83/238 未漂移 | ✅ PASS |
| P. 原 189 项保持通过 | ✅ PASS |
| Q. 新 Authorization suite 全 PASS | ✅ PASS |
| R. 无 Production 操作 | ✅ PASS |
| S. 可开始首个真实业务授权垂直切片 | ✅ PASS |

**全部关键 Gate 成立 → S2-6f = GO。**

---

## 19. STOP

完成 `D1PermissionProvider → runtime can()/requirePermission → PLATFORM/TEAM resolution → authorization tests → full regression → report` 后，**立即 STOP**。

未自动进入以下任何一项（待用户授权）：
- 活动报名 / 积分 / 签到 / 证书 / 团队成员正式写 API
- Production D1 / deploy / DNS
- S2-6g

执行搭档：**WorkBuddy**。
