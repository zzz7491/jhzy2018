# S2-6k1 V1 — Attendance Time Foundation · 实现报告

> 阶段状态：**S2-6k1 = GO**
> 范围：仅 Time Foundation（0005 migration + Asia/Shanghai 时间工具 + max_session_minutes 支持 + business_service_date 写入 + 历史回填 + 测试 + 报告）。
> **本轮不是 detector 实现**：未创建 anomaly / 未实现 overlong 检测 / 未引入 cross_day 规则 / 未引入 allow_cross_midnight / 未引入 Cron/Queue/scanner / 未在 0005 加 detector 索引。

---

## 0. 冻结基线

| 项 | 值 |
|---|---|
| S2-6h-R2 | GO |
| S2-6i | GO |
| S2-6j | GO |
| S2-6k-P0 | GO |
| S2-6k1-P0 | GO |
| S2-6k1-P0.5 | GO FOR IMPLEMENTATION AUTHORIZATION |
| S2-6i baseline commit | `30fc0fa` (tag `jhzy-v2-s2-6i-go`) |
| S2-6j implementation | `aa0afea` |
| S2-6j live revoke repair | `801f70f` |
| migrations | 0001–0004 → **新增 0005** |
| 0004 SHA256 | `12548781ec7fd04ff58e477116a18319de7f153b1d14ee2ac7d26827cefd044d`（未变 ✅） |
| 0005 SHA256 | `98dedffb03aefaa6aa640d1c489a09e94644d8779ad3ac8dbe2a4101a1f7bff3` |
| roles / permissions / role_permissions | 6 / 83 / 238（未变） |

---

## 1. Scope（本轮做 / 不做）

**实现（DONE）**
1. `workers/migrations/0005_attendance_time_policy.sql` — 最小 Time Policy schema delta。
2. `workers/src/utils/time.ts` — 统一 Asia/Shanghai 时间工具。
3. `activities.max_session_minutes` — read model 支持（ActivityRepository 仅有 read 路径，无 write API，故仅加至类型/行映射；API/validator 不改）。
4. `attendance_sessions.business_service_date` — 写入（check-in 时）、类型/repo 映射。
5. 历史数据回填（迁移内 `strftime` backfill）。
6. 测试：`tests/time_policy_integration.mjs` + 回归编排 `tests/run_s2_6k1.mjs`。
7. 本报告。

**Explicit Exclusions（禁止 / 未做）**
- 不创建 detector / Cron / Queue / scanner。
- 不计算 overlong / 不写 `attendance_anomalies` / 不写 `anomaly_detected` 事件。
- 不引入 cross_day 规则 / `allow_cross_midnight` / shift model / recurrence。
- 不在 0005 加 detector 索引（partial UNIQUE / scanner index / anomaly index）。
- 不改 `service_date` 语义、不改 S2-6i/S2-6j runtime、不改 permission catalog、不改 seed。

---

## 2. 0005 Migration 设计（DESIGN → IMPLEMENTED）

```sql
-- A. activities：活动级单次最大服务时长（分钟），NULL = 该活动未冻结规则
ALTER TABLE activities
  ADD COLUMN max_session_minutes INTEGER
  CHECK (max_session_minutes IS NULL OR max_session_minutes > 0);

-- B. attendance_sessions：业务自然日（Asia/Shanghai YYYY-MM-DD），来源 = checkin_at
ALTER TABLE attendance_sessions
  ADD COLUMN business_service_date TEXT;

-- C. 历史回填（MIGRATION BACKFILL ONLY）
UPDATE attendance_sessions
  SET business_service_date = strftime('%Y-%m-%d', checkin_at, 'unixepoch', '+8 hours')
  WHERE checkin_at IS NOT NULL;
```

**仅含**上述三项。**严禁**：allow_cross_midnight / detector_key / anomaly UNIQUE / partial UNIQUE / Cron scanner index / business_service_date index / anomaly index / rule_version / device / location / risk 字段（遵循 `NO QUERY → NO INDEX`）。

### MIGRATION BACKFILL ONLY 说明
- 下方 `strftime(..., '+8 hours')` **仅用于一次性历史数据回填**。
- 依据：现代中国志愿服务历史数据全部处于 **UTC+8、无 DST** 时期，与 runtime `IANA 'Asia/Shanghai'` 计算等价（已用 9 个边界样本验证一致）。
- **runtime 时间逻辑绝对禁止复制 `+8h` 手工数学**，必须使用 `Intl.DateTimeFormat`（见 §3）。

---

## 3. Runtime Time Utility 契约

`workers/src/utils/time.ts`：

```ts
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export function toBusinessDate(epochSeconds: number): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)
      || epochSeconds < 1e8 || epochSeconds > 1e11) {
    throw new Error('BAD_EPOCH_SECONDS');               // 防御 NaN/Infinity/13 位毫秒误输入
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type === 'year' || p.type === 'month' || p.type === 'day') m[p.type] = p.value;
  if (!m.year || !m.month || !m.day) throw new Error('BAD_PARTS');
  return `${m.year}-${m.month}-${m.day}`;                // 显式拼装，不依赖 en-CA 恰好输出 YYYY-MM-DD
}
```

- 输入：Unix epoch **seconds**；输出：稳定 ASCII `YYYY-MM-DD`。
- 防御：拒绝 `NaN` / `Infinity` / 13 位毫秒误输入；仅接受合理 epoch 范围。
- 全仓唯一时区真相源；business 时间一律走此 util，禁止散落 `+8h`。

---

## 4. business_service_date 写入路径

`src/services/attendance-service.ts` check-in（保持既有 `service_date` 不变，新增 `business_service_date`）：

```ts
const now = Math.floor(Date.now() / 1000);
const serviceDate = Math.floor(now / 86400);              // legacy UTC epoch-day bucket，语义不变
const sessionId = await attendance.insertCheckIn(
  signup.id, activity.id, userId, teamId, serviceDate, '',
  toBusinessDate(now),                                    // 新增：Asia/Shanghai 业务自然日
  now,
);
```

`src/repository/attendance-sessions.ts`：
- `AttendanceSessionRow` 新增 `business_service_date: string | null`。
- `insertCheckIn(...)` 新增参数 `businessServiceDate`，INSERT 写入该列。
- 两个 `SELECT` 行映射同步加入 `business_service_date`。

**状态机不变**：`uq_active_attendance`（单人全局单活跃）、review / force-checkout 逻辑、`effective_minutes` 均未触碰。

---

## 5. activities.max_session_minutes 支持

`src/repository/activities.ts`：
- `ActivityRow` 新增 `max_session_minutes: number | null`。
- `listByMyTeam` + `findByPublicId` 的 SELECT 加入该列。

> ActivityRepository 仅有 **read** 路径（无 create/update API），故本轮**只加到 read model**，为未来 overlong detector 提供字段读取能力。未暴露任何写 API / validator（用户 §8/§9：若无成熟 write API，不新造 admin API）。

---

## 6. Clean Replay / Migration Baseline Gate

- Wrangler-native 本地迁移（port 8795，隔离 state `.tmp/s2-6k1-state`，`--local --persist-to`，无 `--remote`，无 prod D1）。
- 0001→0005 全部 PASS；`d1_migrations = 5`；0005 存在、0006 不存在。
- 0001–0004 SHA **全部未变**；0004 = `12548781…044d` ✅。

---

## 7. Existing-data 0004→0005 Upgrade + 一致性 Hard Gate

`tests/time_policy_integration.mjs` 在真实迁移后的 DB 上验证：
- 插入 9 个边界历史会话（`checkin_at` 覆盖 Asia 23:59:59 / 00:00:00 / 00:00:01、月末、年末、闰年），`business_service_date` 留 NULL。
- 运行与 0005 完全相同的回填 UPDATE。
- 逐行比对 `strftime(+8h)` 结果 vs `toBusinessDate(checkin_at)`（runtime Intl Asia/Shanghai）：**全部一致**。
- 旧字段 `service_date`（UTC 桶）/ `slot`（空串）未被回填破坏。
- **跨午夜发散证明**：Asia `2026-09-04 00:00:00`（UTC `2026-09-03 16:00:00`）→ `business_service_date=2026-09-04` ≠ `service_date(UTC 桶)=2026-09-03`，证明新字段与旧 UTC 桶语义正确区分。

Runtime vs Migration 一致性在 9 个边界全 PASS（含月末/年末/闰年），任一不一致则 S2-6k1 = BLOCK（已满足）。

---

## 8. New Check-in Runtime Proof

真实 Worker check-in（volA @ actAtt1）：
- 返回 201；新会话写入 `service_date = floor(checkin_at/86400)`（legacy UTC 桶，语义不变）✅
- 新会话写入 `business_service_date = toBusinessDate(checkin_at)`（Asia/Shanghai，非 NULL）✅
- 格式合规 `^\d{4}-\d{2}-\d{2}$` ✅
- `status=1`（既有状态机 / multi-participation 行为不变）✅

> 因无 injected-clock 机制（且禁止 production 时间 override），"Beijing 凌晨 / UTC 前一天" 的发散通过 §7 的边界直接插入样本严格证明，不依赖 Worker 时钟。

---

## 9. Regression 结果（本届完整重跑，非引用旧证据）

| 套件 | PASS | FAIL | TOTAL | EXIT | 期望 |
|---|---|---|---|---|---|
| S2-5 | 58 | 0 | 58 | 0 | 58 |
| S2-6c-1 | 19 | 0 | 19 | 0 | 19 |
| S2-6c-2 | 34 | 0 | 34 | 0 | 34 |
| S2-6c-3 | 31 | 0 | 31 | 0 | 31 |
| S2-6c-4 | 24 | 0 | 24 | 0 | 24 |
| S2-6f | 42 | 0 | 42 | 0 | 42 |
| S2-6g | 61 | 0 | 61 | 0 | 61 |
| S2-6h-R2 | 71 | 0 | 71 | 0 | 71 |
| **Frozen HTTP 合计** | **340** | **0** | **340** | **0** | **340** |
| **S2-6k1 TIME POLICY** | **22** | **0** | **22** | **0** | — |
| S2-6i MAIN | 80 | 0 | 80 | 0 | 80 |
| S2-6i ATOMICITY-1 | 15 | 0 | 15 | 0 | 15 |
| S2-6i ATOMICITY-2 | 10 | 0 | 10 | 0 | 10 |
| S2-6j MAIN | 87 | 0 | 87 | 0 | 87 |
| S2-6j ATOMICITY-1 | 13 | 0 | 13 | 0 | 13 |
| S2-6j ATOMICITY-2 | 13 | 0 | 13 | 0 | 13 |
| Catalog validator (JSON-only) | — | — | — | 0 | 0 |
| tsc --noEmit | — | — | — | 0 | 0 |

> S2-6j MAIN 原 group A 硬编码 `migrations = 4` / "no 0005" 已随本轮基线更新为 `5` + "0005 存在 / 0006 不存在"（属 S2-6k1 测试范围必要修正，断言数不变，仍为 87/87）。

---

## 10. Static Gates / Integrity / Teardown

- `tsc --noEmit` = 0。
- Permission catalog validator = 83 PASS（JSON-only）。
- Seed 集合一致性（DB vs `permission-catalog.json`）= true；roles=6 / permissions=83 / role_permissions=238；d1_migrations=5。
- FK check = 0；integrity_check = ok。
- Teardown 后业务表全 0（users/teams/activities/activity_signups/attendance_sessions/attendance_events/attendance_anomalies/sessions/user_roles/team_members/user_identities/security_events）；catalog 保留。
- 端口纪律：仅用 8795，未触碰 8787（Signivra）；临时 fault config 已清理。
- 测试时钟 / config 卫生：未向 `wrangler.jsonc` 注入任何 enabled test clock；无 production 时间 override。

---

## 11. Final Gate 对照

- [x] workers preflight clean（仅父仓库 1.0 平行改动，已排除）
- [x] 0001–0004 unchanged；0004 SHA unchanged
- [x] 0005 only Time Policy
- [x] 0005 native clean replay PASS；migrations=5
- [x] max_session_minutes schema correct（NULL/正数合法，0/负数被 CHECK 拒）
- [x] business_service_date schema correct
- [x] existing-data backfill correct
- [x] old service_date preserved
- [x] runtime Intl time utility PASS
- [x] runtime/migration boundary consistency PASS（9 边界）
- [x] month-end / year-end / leap-day PASS
- [x] new check-in writes business_service_date
- [x] new check-in still writes legacy service_date
- [x] multi-participation unchanged（S2-6h-R2 71/71）
- [x] active-session uniqueness unchanged
- [x] no detector code
- [x] no cross_day code
- [x] no allow_cross_midnight
- [x] no scanner/Cron/Queue
- [x] no detector migration indexes
- [x] tsc 0；catalog 83；seed 6/83/238；Frozen 340/340；FK 0；integrity ok；teardown clean；8787 untouched；git workers-only；report complete；no push

**结论：S2-6k1 = GO。** STOP，未进入 S2-6k2 / Location / Detector Core / 任何后续 implementation。

---

## 12. Open Items / Next Slices

- **S2-6k2 Location Input Foundation** → 解锁 `out_of_range`（需客户端上传 lat/lng/accuracy + activity geo 配置读取 + 距离计算）。
- **Device Identity Foundation** → 解锁 `device_switch` / `multi_account`。
- **Cross-Day Policy（独立切片）** → 届时再决定 `allow_cross_midnight` BOOLEAN / schedule / occurrence 模型。
- **Detector Core（建议 0006）** → partial UNIQUE(session_id, anomaly_type) WHERE status=1 + 扫描索引；overlong 规则 = `completed session` + `max_session_minutes NOT NULL` + `duration > max*60`；active session 不判 overlong；force-checkout 照常参与。
- **replay** → 长期 defer（属鉴权协议范畴）。
