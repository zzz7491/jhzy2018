# P9 WP1A — Cloudflare Worker Resource Preparation Gate（生产 Worker 资源准备门）

> **阶段**：P9 WP1A（生产迁移与切换·Worker 资源准备定义）
> **定义日期**：2026-09-19
> **性质**：**定义门（Definition Only）**。定义关闭 B-01 所需的最小、可审计、可回滚的 Cloudflare Worker 资源准备方案；**不创建 Worker、不部署、不改 route/DNS、不迁移数据、不写生产业务数据**。
> **承接**：P9 WP1（`P9_WP1_PRODUCTION_READINESS_AUDIT.md`，FINAL PASS，B-01 仍 OPEN）；本门为 B-01 关闭路径的定义前置。
> **纪律**：本轮仅产出定义与证据模板；所有创建/部署动作须用户显式授权后，在 P9 WP1A 执行阶段（非本定义阶段）进行。

---

## 0. 入口状态（来自 P9 WP1 人工确认事实）

| 项 | 值 |
|---|---|
| P9 WP1 | FINAL PASS |
| B-01 | OPEN |
| Cloudflare authentication verified | YES（Wrangler 4.135.0 + OAuth） |
| Correct production account verified | YES（Account ID `8770e4917f904aed5df91c883cf058af`） |
| D1 `jhzy-v2-db` exists | YES |
| D1 uuid | `ea603f43-d076-4df5-b118-3d8a0c245439` |
| D1 num_tables | 0 |
| Worker | NOT CREATED / NOT DEPLOYED |
| Worker↔D1 binding | MISSING |
| Ready for P9 WP2 | NO |

**结论**：账号与 D1 已可验证，但生产 Worker 缺失、binding 缺失 → B-01 未关闭。本门定义最小资源准备方案以关闭 B-01。

---

## 1. Worker 名称

候选（均未被生产占用，经 Dashboard 人工核查确认 2.0 Worker 尚未创建）：

| 候选 | 评估 |
|---|---|
| `jhzy-v2-api` ⭐ 推荐 | 语义清晰（jhzy V2 的 API Worker）；`*.workers.dev` 子域为 `jhzy-v2-api.<subdomain>.workers.dev`；与 1.0 PHP 运行时（`api.jhzyfw.com`）物理隔离，符合 `ARCHITECTURE_FREEZE` F-GOV-4（禁 1.0/2.0 共享运行时） |
| `jhzy-v2-worker` | 可用，但语义偏实现层、未凸显 API 角色 |
| `jhzyfw-v2-api` | 可用，含完整域名前缀，但与 1.0 入口 `api.jhzyfw.com` 命名接近，易混淆 |

**采纳**：`jhzy-v2-api`（推荐）。备选 `jhzy-v2-worker` / `jhzyfw-v2-api` 仅在命名冲突时启用。

> 注：Worker 名称仅决定 `*.workers.dev` 默认子域与管理标识；**不绑定任何生产自定义域/route**（见 §4）。

---

## 2. D1 Binding

| 项 | 值 | 来源 |
|---|---|---|
| database name | `jhzy-v2-db` | P9 WP1 §2.2（已 VERIFIED · EXISTS） |
| database uuid | `ea603f43-d076-4df5-b118-3d8a0c245439` | P9 WP1 §2.2 |
| binding name | `DB` | 本门建议（代码中经 `env.DB` 访问） |
| bindings 条目（wrangler.toml 形态） | `[[d1_databases]] binding = "DB" database_name = "jhzy-v2-db" database_id = "ea603f43-d076-4df5-b118-3d8a0c245439"` | 仅记录，不写入（定义阶段） |

**约束**：
- binding 必须指向 **uuid `ea603f43-...`**（即 `jhzy-v2-db`），禁止误绑其它库。
- D1 当前 num_tables = 0；本门**不改 schema、不 import、不写入任何业务表**（见 §5）。
- binding 仅为计算层对 D1 的只读/读写引用；移除 binding 不影响 D1 数据与结构（见 §7）。

---

## 3. Worker 最小职责（允许的处理器）

仅允许以下三类端点，禁止任何业务/迁移/写入逻辑：

| 端点 | 行为 | 允许 |
|---|---|---|
| `GET /health` | 返回 `200` + `{"status":"ok","ts":<iso>}` | ✅ |
| `GET /health/d1` | 经 `DB` binding 执行 D1 smoke check：`SELECT 1` 或 `SELECT count(*) FROM sqlite_master`（只读），返回 `{"d1":"ok","bind":"DB","tables":<n>}`；**不读取/不返回任何业务数据** | ✅ |
| `GET /version` | 返回 Worker 版本字符串（来自 build env / `WORKER_VERSION`），如 `{"version":"<sha>"}` | ✅ |

**禁止**（硬性）：
- ❌ 任何业务 API（用户/活动/报名/积分/培训/考试/证书等）
- ❌ 任何迁移逻辑（schema 创建、数据导入、reconcile、rollback）
- ❌ 任何生产写入（`INSERT/UPDATE/DELETE/DDL` 业务表）
- ❌ 引用 1.0 MySQL `api_jhzyfw_com` 或 `api_jhzyfw_v2`
- ❌ 静态资源托管、路由代理到腾讯云 PHP

> smoke check 仅验证 binding 连通性与 D1 可达性，是 B-01 关闭证据的一部分（§6）。

---

## 4. Route 策略

| 项 | 决策 |
|---|---|
| 正式生产 route | ❌ **不绑定**（不将 `api.jhzyfw.com` 或任何生产自定义域指向本 Worker） |
| 生产流量接入 | ❌ **不接** `api.jhzyfw.com` 生产流量；不修改腾讯云 nginx |
| 验证通道 | ✅ 使用默认 `*.workers.dev`（`jhzy-v2-api.<subdomain>.workers.dev`）或**显式标注的临时测试 route**（如 `wp1a-test.<非生产域>`），仅用于 B-01 关闭验证 |
| 临时 route 约束 | 不得含生产域名；验证完成后可保留或删除，不影响 1.0 |
| DNS | ❌ 不修改任何 DNS 记录 |

> 默认策略即「无生产流量」：Worker 部署后仅通过 `workers.dev` 可达，1.0 用户无感，符合安全边界（§5）。

---

## 5. 安全边界（禁止清单）

| 禁止项 | 说明 |
|---|---|
| 迁移数据 | 不在本门/本 Worker 内执行任何 1.0→D1 数据迁移 |
| 写入生产业务数据 | Worker 无业务写入端点；D1 smoke check 仅只读 |
| 修改腾讯云 nginx | 不触碰 `api.jhzyfw.com.conf` 或任何 vhost |
| 修改 DNS | 不新增/不改任何 DNS 记录 |
| 替换 1.0 | 不接生产流量，1.0 PHP 运行时保持唯一生产入口 |
| 灰度 | 不灰度、不分流 |
| Cutover | 不执行任何切换契约（P9 §7）动作 |
| user_favorites BCR | 保持 EXCLUDED / BCR pending（沿用 P9 WP1 纪律） |
| schema import | 不 import 任何 schema / migration，除非后续单独显式授权 |

> 上述边界与 `PROJECT_CONSTITUTION` / `ARCHITECTURE_FREEZE` / `DATA_GOVERNANCE_FREEZE` 一致，无 Freeze 冲突（见 FINAL GATE）。

---

## 6. B-01 关闭标准（Closure Criteria）

必须**全部**满足，方可判定 B-01 = CLOSED（在用户显式授权后的 P9 WP1A 执行阶段验证，非本定义阶段）：

| # | 标准 | 验证方式 |
|---|---|---|
| C1 | Worker exists | `wrangler workers inspect jhzy-v2-api`（或 Dashboard 确认存在） |
| C2 | Worker deployment verified | `wrangler deploy` 成功 + 版本号记录 |
| C3 | Worker has D1 binding to `jhzy-v2-db` | wrangler.toml / Dashboard 确认 binding `DB` → uuid `ea603f43-...` |
| C4 | health endpoint returns OK | `curl <workers.dev>/health` → `200 {"status":"ok"}` |
| C5 | D1 binding smoke check succeeds | `curl <workers.dev>/health/d1` → `{"d1":"ok",...}`；证明 `DB` 可达 `jhzy-v2-db` |
| C6 | no production route changed | 核查无 `api.jhzyfw.com` / 生产自定义域 route 绑定 |
| C7 | no production data migrated | 核查 D1 `jhzy-v2-db` 仍 num_tables = 0（无业务数据写入） |
| C8 | evidence recorded | 落盘 `operator-evidence/v1/wp1a-b01-closure.md`（含 C1–C7 证据 + 命令输出 + 时间戳） |

> 全部满足 → B-01 = CLOSED，回写 P9 WP1 §9/§10/FINAL GATE；随后可重评 Ready for P9 WP2。

---

## 7. 回滚 / 删除策略

| 场景 | 动作 | 对 D1 影响 |
|---|---|---|
| Worker 创建错误 | `wrangler delete jhzy-v2-api`（或 Dashboard 删除）；因未绑生产 route，无用户流量影响 | **无**（D1 数据与结构不受影响） |
| binding 错误 | 从 wrangler.toml / Dashboard 移除 `[[d1_databases]]` 条目，重新 `wrangler deploy`；或删除 Worker | **无**（binding 仅为引用，移除即断开连接，D1 不变） |
| 部署错误 | `wrangler rollback jhzy-v2-api`（Cloudflare 保留历史版本）或重新部署 last-known-good；亦可 `wrangler delete` 后重建 | **无**（回滚仅换 Worker 代码版本，不触 D1） |
| 版本/命名错误 | 删除错误 Worker，按 §1 重新采纳名称创建 | **无** |

**硬性保证**：Worker / binding 的创建、修改、回滚、删除**均不影响 D1 `jhzy-v2-db` 的数据与结构**（影响 = NO）。D1 是唯一权威库，Worker 是计算层引用；解耦是 `ARCHITECTURE_FREEZE` F-DB-1（单一库）与 F-GOV-4 的设计前提。

---

## FINAL GATE（P9 WP1A Definition）

| Gate 项 | 结果 |
|---|---|
| Worker preparation scope defined | **YES** |
| Worker name proposed | **YES**（`jhzy-v2-api`，备选 `jhzy-v2-worker` / `jhzyfw-v2-api`） |
| D1 binding defined | **YES**（name `jhzy-v2-db` / uuid `ea603f43-...` / binding `DB`） |
| Route strategy defined | **YES**（默认不绑生产 route；验证走 `*.workers.dev` / 临时测试 route） |
| No-production-traffic rule defined | **YES**（不接 `api.jhzyfw.com`、不改 nginx/DNS） |
| Safety boundary defined | **YES**（9 项禁止清单） |
| B-01 closure criteria defined | **YES**（C1–C8） |
| Rollback/delete strategy defined | **YES**（Worker/binding/部署回滚；D1 不受影响 = NO） |
| Freeze Conflict Count | **0**（与 Constitution / Architecture Freeze / Data Governance Freeze 无冲突） |
| Production data modified | **NO** |
| Production config modified | **NO** |
| Deployment performed | **NO** |
| Routing changed | **NO** |

### **P9 WP1A Definition Gate = PASS**（定义完整、可审计、可回滚、安全边界明确、无 Freeze 冲突）

### **Ready for Worker Creation = YES**（定义门通过；实际创建/部署 Worker、建立 binding 仍须**用户显式授权**后进入 P9 WP1A 执行阶段，按 §6 标准验证关闭 B-01）

> **STOP — 定义阶段结束**。未创建 Worker、未部署、未改 route/DNS。等待用户显式授权后，方可在执行阶段创建 `jhzy-v2-api`、绑定 `DB`→`jhzy-v2-db`、验证 `/health` 与 `/health/d1`，并依 §6 回写 B-01 关闭证据。

### **Execution Closure（2026-09-19）：B-01 = CLOSED**

经用户显式授权执行：Worker `jhzy-v2-api` 已创建部署（Version `b10791f8-b8ad-4a6e-963b-c40194af9a12`），D1 binding `DB`→`jhzy-v2-db` 验证通过，`/health`/`version`/`/health/d1` 均 200，远程 D1 烟雾查询 `ok:1` 且 read-only。B-01 关闭标准 C1–C8 全满足（见 §8）。**Ready for P9 WP2 = YES**（进入 WP2 仍需用户显式授权）。STOP — 不进入 WP2。

---

## 引用与依据

- P9 WP1：`P9_WP1_PRODUCTION_READINESS_AUDIT.md`（账号/D1 已 VERIFIED，B-01 OPEN 原因=Worker 缺失）
- 拓扑与硬规则：P9 Definition §3（T-1…T-6）；ARCHITECTURE_FREEZE §6（F-DB-1 单一库；F-GOV-4 禁 1.0/2.0 共享运行时）；ADR-001
- 安全门 MG-01…15 / CG-01…12：P9 Definition §6
- 生产证据 13 字段：P9 Definition §10；P8-3 WP5 `operator-evidence/v1`
- user_favorites EXCLUDED / BCR pending：P8-3 WP5 PF-08；P9 Definition §5
