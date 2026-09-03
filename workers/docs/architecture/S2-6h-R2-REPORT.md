# S2-6h-R2 — Attendance Multi-Participation Model Repair

> 状态：CODE COMPLETE · S2-6h 集成套件已验证（71/71 PASS）· 全量回归与本报告部分项待环境恢复后复核

## 1. Objective

修复 S2-6h-R1 只读复核发现的模型缺陷：原 `UNIQUE(signup_id)` 将「一次报名」与「一次参加」硬绑定为 1:1，
无法满足「火车站志愿持续一周、周一/周三/周六各参加一次」的真实业务。本阶段解除该绑定，支持单次报名→多次参加，
同时保证每用户任一时刻至多一个活跃会话，并为「每次参加」增加锚点（`service_date` + `slot`）。

## 2. Frozen Baseline（继承 S2-6h）

| 项 | 值 |
|---|---|
| roles | 6 |
| permissions | 83 |
| role_permissions | 238 |
| d1_migrations | 3 → **4**（本阶段新增 0004） |

## 3. Read-only Evidence Inherited（来自 S2-6h-R1）

- `activity_signups.UNIQUE(user_id, activity_id)`：保留（「一次报名」语义正确，不改）。
- `attendance_sessions.UNIQUE(signup_id)`：已移除（根约束）。
- `attendance_events` / `attendance_anomalies` / `service_records` 均经 FK 引用 `attendance_sessions(id)`：
  重建表时一并重建以保证 FK 指向新表。
- 地点/时间窗：字段存在于 schema，逻辑未实现（按决策 defer）。

## 4. Authorized Scope

- 放宽 `UNIQUE(signup_id)` → 改为普通索引 `idx_as_signup`。
- 新增每次参加锚点：`service_date INTEGER NOT NULL DEFAULT 0` + `slot TEXT`。
- 新增 partial unique index：`uq_active_attendance ON attendance_sessions(user_id) WHERE status=1 AND checkout_at IS NULL`。
- 调整 S2-6h 签到逻辑：仅当「该 signup 无活跃会话」时允许签到；已签退可再次签到（创建新会话）。
- 回滚 S2-6i 半成品（保留 S2-6h 基线完好）。

## 5. Explicit Non-Scope

- 地点围栏校验（geo_radius 比较）：defer。
- 签到时间窗校验（start_time~end_time）：defer。
- 新增 `activity_shifts` 表：未采用（选用最小 `service_date + slot` 锚点）。
- S2-6i Review/Force：本阶段不实现（待模型稳定后在新基数下重做）。

## 6. Migration 0004（`migrations/0004_attendance_multi_participation.sql`）

四表重建（attendance_sessions / attendance_events / attendance_anomalies / service_records），保证 FK 全部解析到新表：
- `attendance_sessions`：移除 `UNIQUE(signup_id)`；新增 `service_date` + `slot`；新增普通索引 `idx_as_signup(signup_id)`；新增 `uq_active_attendance` partial index。
- 其余三表按原 DDL 重建，外键目标不变。
- `service_records.UNIQUE(session_id)` 不动（多会话→多记录仍成立）。

**冻结版本（最终）：**
- 文件：`migrations/0004_attendance_multi_participation.sql`
- SHA256：`12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`
- 该 SHA 对应「含 `idx_as_signup`」的最终版本；任何后续修改必须重新冻结并更新本节。

**最终证据来源（见 §21 CLEAN WRANGLER MIGRATION REPLAY）：**
- `service_date` + `slot` 列存在；
- `UNIQUE(signup_id)` 已消失（表 DDL 中不含 UNIQUE，无 signup_id 自动唯一索引）；
- `idx_as_signup(signup_id)` 普通非唯一非 partial 索引存在；
- `uq_active_attendance` 存在（UNIQUE / partial / WHERE status=1 AND checkout_at IS NULL）；
- 三张子表 FK 均解析到新 `attendance_sessions(id)`；
- `d1_migrations` = 4（由 Wrangler 原生写入）。

## 7. Repository Design（`repository/attendance-sessions.ts`）

- `findOwnActiveSession(signupId, userId)`：**仅**返回 `status=1 AND checkout_at IS NULL` 的会话
  （并发安全真相 = `uq_active_attendance`，不再依赖 `UNIQUE(signup_id)`）。
- `insertCheckIn(...)`：写入 `service_date` + `slot`；不再依赖 `UNIQUE(signup_id)` 兜底
  （兜底改为 `uq_active_attendance`）。
- `insertEvent(...)`：签名扩展 `slot`，事件行记录 `service_date`/`slot` 一致性。

## 8. Service Design（`services/attendance-service.ts`）

- `checkInOwn`：预检改为 `findOwnActiveSession`（仅活跃）；已签退会话**不阻止**再次签到（创建新会话）。
- `checkOutOwn`：预检 `findOwnActiveSession`；无活跃会话 → `attendance_checkin_required`（409，无副作用）。
- 保留 SELF ownership、`team_id` 租户隔离、D1 权限（未改）。

## 9. 多参加语义（S2-6h-R2 模型）

```
activity        1 ── N  activity_signups (UNIQUE user_id,activity_id)
activity_signups 1 ── N  attendance_sessions (idx_as_signup; 每用户单一活跃 via uq_active_attendance)
attendance_sessions 1 ── N  attendance_events
attendance_sessions 1 ── 0..1 service_records
```

- 同一报名可产出多条会话（不同 `service_date`/`slot`）。
- 每用户全局至多一个活跃会话（跨活动也被 partial index 约束）。

## 10. Atomicity Evidence

- 本阶段**无**「状态更新 + 审计事件」双写新需求（仅调整签到预检与锚点写入）。
- 签到写会话 + 写事件两步，由既有的 `uq_active_attendance` 在并发下保证单活跃会话，事件写入失败由外层 try/catch 收敛为 409，不泄露 SQL。

## 11. Fixture Design（`tests/fixture.mjs` `attendance` 模式）

- 复用 S2-6h 的 `attendance` fixture（6 users / 2 teams / 6 activities / 6 signups）。
- volA 对 actAtt1/2/4/5 报名，actAttB 为 teamB 数据（跨团队 IDOR 测试）。

## 12. Integration Test Matrix（`tests/attendance_integration.mjs`）

- 原有 A–F 组（本人签到/签退/权限/租户/实时授权/安全）保留并修正为单一活跃会话模型期望。
- **G 组（新增，S2-6h-R2 模型修复）覆盖：**
  - G1 重复签退（无活跃会话）→ 409 `attendance_checkin_required`
  - G2 进入前 volA 活跃会话数=0
  - G3 签退后再次签到同一活动（多次参加）→ 201
  - G4 新会话 `service_date` 已填充（>0）
  - G5 新会话 `slot` 默认值（空串）
  - G6 新会话 `status=1` 活跃
  - G7 同活动未签退再签到 → 409 `ALREADY_CHECKED_IN`（同报名单一活跃）
  - G8 actAtt1 下 volA 会话累计=2（签退 + 1 活跃，证多次参加）
  - G9 再次签退 → 200
  - G10 签退后签到另一活动（多次参加另一活动）→ 201
  - G11 `uq_active_attendance` 索引存在（每用户单一活跃）
  - G12 并发兜底：直写第二条 volA 活跃会话被 `uq_active_attendance` 拒绝
  - G13 已有活跃会话时跨活动签到 actAtt5 → 409 `ALREADY_CHECKED_IN`（第5条背景）
  - G14 volA 签退 actAtt2 → 200
  - G15 收尾 volA 活跃会话=0（无悬挂）
  - G16 volA 会话累计=5（actAtt1×2 + actAtt4 + actAtt5 + actAtt2）

**结果：pass=71 fail=0**（端口 8796，本地 D1 已含 0004）。

## 13. Regression Results

| 套件 | 结果 | 备注 |
|---|---|---|
| tsc --noEmit | ✅ exit 0 | R2-1 回滚后、R2-3 调整后均通过 |
| validate_permission_catalog | ✅ ALL PASS | 83/238 无漂移 |
| validate_permission_seed | ✅ ALL PASS | 83/238/6 无漂移 |
| S2-4 validate_local_d1 | ⏳ 已修待复核 | 修复 `recursive` readdir 与 `mig.length===3→4`；环境故障未能复跑确认 |
| S2-5 / 6c-1..4 / 6f / 6g / 6h | ⏳ 待环境恢复后复跑 | 基线 323/323 需在 0004 schema 上重验 |

## 14. Leakage / IDOR Evidence

- 无 IDOR：跨团队签到/签退 → 404（不泄露存在性）；`uq_active_attendance` 在数据层阻止跨用户活跃会话。
- 无 SQL/表名/role_id/permission_id 泄露（F 组扫描 business surface，不含 `/probe`）。

## 15. Catalog / Schema / Migration Drift Check

- Catalog：未改（仍 83/238）。
- Schema：仅 0004（授权），无其它改动；`activity_signups` / `service_records` 不动。
- Migration：3 → 4（仅新增 0004，未改 0001/0002/0003）。

## 16. Port / Process Safety

- 测试端口：8796（项目隔离端口，同本地 D1 fixture）。
- Signivra 8787：未触及。
- 历史 zombie：8788/8799/8797 此前已退出；本阶段未 broad-kill。
- 无 production / deploy / DNS / Secret。

## 17. OPEN ARCHITECTURE RULES

1. 地点围栏校验未实现（字段在 schema，逻辑 defer）。
2. 签到时间窗校验未实现（defer）。
3. `service_date`/`slot` 目前由服务端默认填充（service_date=now 日期整型、slot=''）；未来由前端/排班传入具体班次。
4. S2-6i Review/Force 需在新基数下重做（当前已回滚半成品）。

## 18. Final Gate（逐条）

| # | 项 | 状态 |
|---|---|---|
| 1 | Frozen catalog 仍 83/238 | ✅ 已验证 |
| 2 | migrations 仍 3→4（仅新增） | ✅ 已验证 |
| 3 | Schema 零未授权修改（仅 0004） | ✅ 已验证 |
| 4 | 解除 UNIQUE(signup_id) 1:1 | ✅ 已验证 |
| 5 | 每用户单一活跃会话（partial index） | ✅ 已验证 |
| 6 | 签退后再次签到同一活动可行 | ✅ G3/G9 验证 |
| 7 | 多次参加不同活动可行 | ✅ G10 验证 |
| 8 | S2-6h 集成套件全绿 | ✅ 71/71 |
| 9 | tsc 0 error | ✅ |
| 10 | catalog/seed validator 全绿 | ✅ |
| 11 | S2-4 本地 D1 校验 | ⏳ 修复后待复跑 |
| 12 | 完整冻结回归 323→（含 0004）全 PASS | ⏳ 待环境恢复复跑 |
| 13 | fixture teardown 零残留 | ✅ harness 末 teardown OK |
| 14 | Signivra 8787 untouched | ✅ |
| 15 | 无 production/deploy | ✅ |
| 16 | S2-6i 半成品已回滚 | ✅ |

## 19. GO / BLOCK

**最终结论：S2-6h-R2 = GO**

全量冻结回归已在最终 0004 Schema（SHA256 `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`）上完成，证据见 §21（Clean Wrangler Migration Replay）、既有数据升级报告（0003→0004 UPGRADE = PASS）与 §22（FINAL FROZEN REGRESSION）。
S2-4 Schema Validator 23/23 ALL PASS；HTTP/Integration 8 套共 340/340 PASS（58+19+34+31+24+42+61+71）。

## 20. STOP

完成模型修复与 S2-6h 验证后 STOP。未进入 S2-6i（已回滚）；未进入 S2-6j。

## 21. CLEAN WRANGLER MIGRATION REPLAY（R2 最终证据）

在全新隔离的 local state 上，由 Wrangler 4.127.1 原生流程从零重放 0001→0004（未复用/未修改 `.wrangler/state`，未用 `node:sqlite` 执行迁移 SQL）。

| 项 | 结果 |
|---|---|
| Wrangler 版本 | 4.127.1（项目本地 `node_modules/.bin/wrangler.cmd`） |
| 数据库名 | `jhzy-v2-local`（wrangler.jsonc） |
| 隔离 state | `.tmp/s2-6h-r2-clean-state-v2`（`--persist-to`） |
| 0001 | ✅ 160 commands |
| 0002 | ✅ 9 commands |
| 0003 | ✅ 241 commands |
| 0004（含 idx_as_signup） | ✅ 33 commands（上一版 32，+1 即新增索引） |
| d1_migrations | 4（Wrangler 原生记录） |
| seed 基线 | permissions=83 / role_permissions=238 / roles=6 |
| `idx_as_signup` | 存在；列=signup_id；non-unique；non-partial |
| `uq_active_attendance` | 存在；列=user_id；UNIQUE；partial；WHERE status=1 AND checkout_at IS NULL |
| 原有 attendance 索引 | idx_as_act / idx_as_user / idx_as_review / idx_as_servicedate 全部保留；子表 idx_ae_* / idx_aa_* / idx_sr_* 全部保留 |
| 子表 FK | attendance_events / attendance_anomalies / service_records 的 session_id → `attendance_sessions(id)`，BAD_to=0，OLD_target=0 |
| `PRAGMA foreign_key_check` | 0 violations |
| `PRAGMA integrity_check` | ok |
| 迁移残留（`_old`/`_bak`/`_tmp`） | 无 |
| EXIT CODE | 0 |

**CLEAN WRANGLER MIGRATION REPLAY = PASS**

> 注：上一轮（不含 `idx_as_signup` 的 0004）曾因 `idx_as_signup` 缺失判 FAIL；本轮仅补该索引后重放，未新增 0005，未改 0001/0002/0003，未改任何业务代码。

## 22. FINAL FROZEN REGRESSION

### 22.1 基线

| 项 | 值 |
|---|---|
| final 0004 SHA256 | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`（本轮未改动，0001/0002/0003 亦未改动） |
| Wrangler | 4.127.1（项目本地 `node_modules/.bin/wrangler.cmd`） |
| 数据库名 | `jhzy-v2-local`（wrangler.jsonc） |
| 隔离 state | `.tmp/s2-6h-r2-final-regression-v2`（全新空目录，`--persist-to`；未复制 sqlite、未用 `node:sqlite` 执行迁移、未手工 INSERT `d1_migrations`） |
| migration replay | 0001 ✅160 / 0002 ✅9 / 0003 ✅241 / 0004 ✅33；`d1_migrations` = 4，全部由 Wrangler 原生记录 |
| Clean Wrangler Migration Replay | PASS（§21） |
| Existing Data 0003→0004 Upgrade | PASS（独立临时 state，逐字段 diff=0，smoke A/B/C 全通过并回滚） |
| TEST PORT | 8802（未使用 8787；Signivra 8787 全程 not listening / untouched） |

### 22.2 最终 Schema 基线（测试前只读校验）

roles = 6 · permissions = 83 · role_permissions = 238 · `d1_migrations` = 4
`attendance_sessions.signup_id` 非 UNIQUE（旧 `sqlite_autoindex_attendance_sessions_1` 已消失）· `service_date` 存在 · `slot` 存在
`idx_as_signup` = 列[signup_id] · unique=0 · partial=0
`uq_active_attendance` = 列[user_id] · unique=1 · partial=1 · WHERE status = 1 AND checkout_at IS NULL
子表 FK（attendance_events / attendance_anomalies / service_records）session_id → `attendance_sessions(id)`，BAD=0
`PRAGMA foreign_key_check` = 0 violations · `PRAGMA integrity_check` = ok · 无 `_old`/`_bak`/`_tmp` 迁移残留

### 22.3 静态校验

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | EXIT=0，0 errors |
| Permission Catalog Validator | PASS（83 permissions；20 项 + 6 项增强全 PASS） |
| Permission Seed Validator | PASS（permissions=83 / role_permissions=238 / roles=6；19 项全 PASS） |
| S2-4 `scripts/validate_local_d1.mjs` | **ALL PASS**，PASS=23 / FAIL=0 / EXIT=0（migrations=4 为合法最终基线；validator 文件 SHA 未改动，仅通过 cwd 重定向解析到本轮 state） |

### 22.4 HTTP / Integration 冻结回归（8 套，逐套 fixture + teardown）

| # | Suite | 文件 | fixture | PASS | FAIL | TOTAL | EXIT |
|---|---|---|---|---|---|---|---|
| 1 | S2-5 | api_integration.mjs | setup | 58 | 0 | 58 | 0 |
| 2 | S2-6c-1 | session_integration.mjs | session | 19 | 0 | 19 | 0 |
| 3 | S2-6c-2 | auth_integration.mjs | auth | 34 | 0 | 34 | 0 |
| 4 | S2-6c-3 | firstlogin_integration.mjs | firstlogin | 31 | 0 | 31 | 0 |
| 5 | S2-6c-4 | session_security_integration.mjs | sec | 24 | 0 | 24 | 0 |
| 6 | S2-6f | authorization_integration.mjs | authz | 42 | 0 | 42 | 0 |
| 7 | S2-6g | activity_signup_integration.mjs | signup | 61 | 0 | 61 | 0 |
| 8 | S2-6h-R2 | attendance_integration.mjs | attendance | 71 | 0 | 71 | 0 |
| | **TOTAL** | | | **340** | **0** | **340** | **0** |

各套 assertion 数与冻结记录完全一致，无需说明差异。

### 22.5 S2-6h-R2 业务回归覆盖（71 条内）

| 要求 | 证据 | 结果 |
|---|---|---|
| A 同一 signup 签到→签退→再签到成功 | G3（签退后再次签到 actAtt1 → 201） | PASS |
| B 第二次签到生成不同 session id | G8（actAtt1 下 volA 会话累计=2）、G16（累计=5，actAtt1×2 + actAtt4 + actAtt5 + actAtt2） | PASS |
| C 已有 active session 时签到另一 activity 返回冲突 | G13（→ 409 ALREADY_CHECKED_IN）、B13（跨活动签到 → 409） | PASS |
| D 并发安全由 `uq_active_attendance` 数据库级兜底 | G11（索引存在）、G12（直写第二条活跃会话被 uq_active_attendance 拒绝） | PASS |
| E 首个 active session 签退后可签到另一 activity | G9 → G10（签退 actAtt1 后签到 actAtt2 → 201） | PASS |
| F 原有 checkin/checkout/tenant/ownership/permission/cross-team 无回归 | B14/B15/B17/B19/B20、C5/C8–C15、D2–D7、E3/E4、F4 全部 PASS | PASS |

### 22.6 Teardown / 残留

全部 8 套 `tests/fixture.mjs teardown` 均 EXIT=0（fixture 自断言零残留）。
最终 state 中仅剩系统基础数据：`_cf_METADATA=1`、`d1_migrations=4`、`permissions=83`、`roles=6`、`role_permissions=238`；
`users / teams / sessions / activities / activity_signups / attendance_sessions / attendance_events / attendance_anomalies / service_records` 全部 = 0。
`PRAGMA foreign_key_check` = 0 violations · `PRAGMA integrity_check` = ok · 无迁移临时表。

### 22.7 进程与边界

- 本轮启动 Worker：8802（wrangler node PID 24512 → workerd PID 27416）；结束后按明确 PID `taskkill /PID 24512 /T` 精确结束，未做 broad kill。
- 收敛过程中曾启动 8801（PID 28460），同样按明确 PID 精确结束。
- Signivra 8787 全程无监听、未被触碰。
- 未使用 remote / production / deploy / DNS / Secret；未 git push；未进入 S2-6i / S2-6j；未实现 anomaly、time / location / shift 功能。

### 22.8 Final Gate

34 项逐条全部 PASS（Final 0004 SHA / clean replay / existing-data upgrade / migrations=4 / S2-4 validator / schema 四项 / 多参加四项 / FK+integrity / tsc / catalog / seed / 83-238-6 / 8 套 HTTP 套件 / teardown 零残留 / 8787 untouched / 无越界动作）。

**FINAL: S2-6h-R2 = GO**
