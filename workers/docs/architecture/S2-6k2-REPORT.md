# S2-6k2 V1 — Attendance Location Capture Foundation · 实现报告

> 阶段性质：**Implementation**（已获用户 `@long-text` 显式授权）。
> 范围：**仅 Check-in Location Capture Foundation**。
> 本轮**绝对不计算 distance**、**绝对不实现 out_of_range detector**、**不新增 migration**。

---

## 1. Scope（本轮交付范围）

✅ 实现：
1. check-in 路由解析请求体 `location`
2. `location` 输入校验（纯模块 `src/utils/location.ts`）
3. GCJ-02 API contract（服务端仅做数值合法性校验，不做坐标系检测/转换）
4. `attendance_events` 写入 `latitude / longitude / accuracy`
5. GPS unavailable 的 NULL 行为（无 body / `{}` / `location: null` / `location` 缺省 → 全 NULL，签到照常 200）
6. tests（S2-6k2 Location Suite 22/22）
7. regression（完整重跑，非旧证据引用）
8. 本报告

❌ 明确排除（不实现）：
- `distance` 计算 / haversine / 地理围栏判定
- `out_of_range` anomaly / detector / scanner / Cron / Queue
- `activities.latitude/longitude/geo_radius` 业务读取
- activity 写 API / coord_system 列 / 0006 migration
- checkout 位置采集（CHECK-IN ONLY）
- 背景定位 / 轨迹采集 / location tracking

---

## 2. Coordinate Contract = GCJ-02（冻结）

**1.0 实证（只读勘察结论）**：
- `miniprogram/pages/admin/activity-create-flow/basic.ts:204` 用 `wx.chooseLocation()` 设置活动坐标 → 腾讯地图生态 → **GCJ-02**。
- `miniprogram/pages/activities/checkout-confirm/sign-confirm.ts:126-127` 用 `wx.getLocation({ type: 'gcj02' })`（注释「腾讯地图高精度坐标系」），并与 `activity.latitude/longitude` 直接比较距离 → 活动端坐标系 = **GCJ-02**。
- ⚠️ **1.0 不一致遗留**：`miniprogram/services/checkinService.js:149-150` 用 `wx.getLocation({ type: 'wgs84' })` 上报服务器 —— 与活动端 GCJ-02 冲突。**2.0 不复制该 WGS-84 上报行为**。

**2.0 契约冻结**：
- 微信小程序客户端必须 `wx.getLocation({ type: 'gcj02' })` 上报（若误用 wgs84 须在客户端转 GCJ-02 后再上报）。
- 服务端**不**转换 WGS84/GCJ02/BD09，**不**猜测坐标系。
- **关键**：服务器无法仅通过 latitude/longitude 数值证明客户端真的提交 GCJ-02。因此 **GCJ-02 是 API CONTRACT，不是 server-side detectable property**；服务端仅验证数值合法性。

---

## 3. Request Contract

```
POST /api/v2/activities/:activityId/attendance/checkin
Content-Type: application/json

{
  "location": {
    "latitude": 31.2304,
    "longitude": 121.4737,
    "accuracy": 12.5
  }
}
```

- 字段命名：**`latitude` / `longitude` / `accuracy`**（与微信 location API `res.latitude/longitude/accuracy` 及 `attendance_events` schema 一致；不用 `lat`/`lng`/`accuracy_m`）。
- `accuracy` 单位 = 米，可选。

---

## 4. Missing / Null / Malformed 语义（冻结）

| 输入 | 行为 |
|---|---|
| 无 body / `{}` / body 无 `location` | 合法 → location unavailable → check-in 200 → 三列 NULL |
| `{ "location": null }` | 合法 → check-in 200 → 三列 NULL |
| `{ "location": {} }` | **400 INVALID_PARAM** |
| 仅 latitude / 仅 longitude | **400 INVALID_PARAM** |
| latitude/longitude/accuracy 为 string | **400 INVALID_PARAM**（不自动 `Number()` 转换） |

> 注意：`body={}` 与 `location={}` 不同 —— 前者视为「无位置」，后者视为「提供了空对象」→ 400。

---

## 5. 校验规则（`src/utils/location.ts`）

- `parseAttendanceLocation(v)`：
  - `v` 为 `undefined` / `null` → 返回 `null`（合法无位置）。
  - `v` 为 object：
    - `latitude` / `longitude` 必须成对存在且 `typeof === 'number'` + `Number.isFinite`。
    - `latitude` 范围 `[-90, 90]`，`longitude` 范围 `[-180, 180]`（边界 -90/90/-180/180 合法，越界 400）。
    - `accuracy` 可选：若提供须 `finite && > 0`（**不设任意 hard max**，业务阈值留给 detector）。
  - 其它一切 → 抛 `AppError(ErrorCode.INVALID_PARAM)`。
- 不检测、不转换坐标系。

---

## 6. 路由 / 服务 / 仓储接线

- `src/routes/activities.ts`（check-in 路由）：
  - `const body = await c.req.json().catch(() => null);`（空 body 安全回退 → 旧客户端无 body 仍 200，向后兼容 hard gate）。
  - 仅取 `body?.location` 传入 `checkInOwn(activityPublicId, parseAttendanceLocation(body?.location))`。
  - **checkout 路由未改**（仍忽略 body，不采位置）。
- `src/services/attendance-service.ts`：
  - `checkInOwn(activityPublicId, location: AttendanceLocation | null)`。
  - 位置**不影响** signup ownership / tenant / permission / active-session 唯一性 / multi-participation / 状态机。
  - `insertEvent(...)` 调用透传 `location?.latitude, location?.longitude, location?.accuracy`。
- `src/repository/attendance-sessions.ts`：
  - `insertEvent` 新增 `latitude, longitude, accuracy` 参数；`distance` **始终 NULL**。
  - `null` location → 三列 NULL；supplied → 写真实值。
  - checkout 调用方传默认 `null` → checkout event 三列 NULL（CHECK-IN ONLY 验证见 §10）。

---

## 7. Privacy / Raw Coordinate Retention

- 坐标仅持久化于 `attendance_events.latitude / longitude / accuracy`。
- **不**写入 logs / console / error response / request_id metadata / `attendance_events.raw`（raw 仍存 `{"checkin":true}`，不含坐标）/ `anomaly.detail` / 其它 JSON 字段。
- 不重复存储、不建第二份 location payload。
- check-in response 沿用既有 contract，**不**回显原始坐标。

---

## 8. No Distance（Final Gate）

- `attendance_events.distance` 本轮**始终 NULL**。
- 即使 `activity.latitude/longitude/geo_radius` 存在，也不计算 haversine / 不比较 geo_radius / 不信任客户端距离 / 不做任何地理围栏判断。
- 签到**永远**不因 distance/geo_radius 被拒绝。

---

## 9. Activity Geo 不进入 Runtime

- 本轮未扩展业务逻辑读取 `activities.latitude/longitude/geo_radius`。
- **Activity Geo Administration** 仍是独立 foundation gap（无成熟 activity 写 API；运营端须能可靠设置活动坐标 + 坐标系，out_of_range 方能点亮）。

---

## 10. 测试结果（完整重跑，非旧证据）

### 10.1 S2-6k2 Location Suite（新增，22/22 PASS）
覆盖：无 body / `{}` / location missing / location null / valid lat+lng / valid lat+lng+accuracy / location={}→400 / only latitude→400 / only longitude→400 / latitude string→400 / longitude string→400 / accuracy string→400 / 边界 -90,90,-180,180 合法与越界→400 / accuracy 缺失合法、正数合法、0→400、负数→400 / **DB 持久化硬门**（合法位置 → latitude/longitude/accuracy 正确写入、distance NULL、raw 不含坐标）/ **location=null → 三列 NULL** / **checkout event 三列 NULL（CHECK-IN ONLY 验证）**。

### 10.2 全量冻结回归（本轮实跑，非引用旧证据）
| 套件 | 结果 |
|---|---|
| Frozen HTTP 340/340 | ✅ |
| S2-6h-R2 71/71 | ✅ |
| S2-6i 80/80 / 15/15 / 10/10 | ✅ |
| S2-6j 87/87 / 13/13 / 13/13 | ✅ |
| S2-6k1 Time Policy | ✅ (business_service_date 仍正确写入，legacy service_date 仍 UTC 桶) |
| S2-6k2 Location Suite | ✅ 22/22 |
| **OVERALL** | **EXIT 0** |

### 10.3 静态门
- `tsc --noEmit` = 0
- permission catalog validator = 83 PASS（未动 catalog）
- seed = 6 roles / 83 permissions / 238 role_permissions（未动）
- migrations = 5，0006 = NONE
- FK check = 0，integrity = ok
- 0001–0005 SHA 全部不变（0004=`12548781…044d`，0005=`98dedffb…f7bff3`）

### 10.4 Teardown
- formal harness 使用 isolated state（`.tmp/s2-6k2-state`），业务 fixture 表清空，catalog 保留，未污染默认 `.wrangler/state`。
- 端口隔离：使用 8798（非 8787，未触碰 Signivra）。

---

## 11. No Detector Gate（代码确认）

本轮未新增：out_of_range 创建 / `AttendanceAnomalyRepository.insert` / detector / scanner / Cron / Queue / geofence blocking。签到不因 distance/geo_radius 被拒。

---

## 12. Final Gate 核对（逐项）

- [x] workers preflight clean（仅 6 个 S2-6k2 文件改动，父仓库 1.0 平行改动排除）
- [x] migrations remain 5 / no 0006 / 0001–0005 不变
- [x] GCJ-02 contract documented / server 不声称能检测坐标系
- [x] missing / null / valid / partial / malformed 全部按契约
- [x] 坐标边界正确 / accuracy 可选 / accuracy>0 强制
- [x] check-in event 写 latitude/longitude/accuracy / distance NULL / raw 不重复坐标
- [x] checkout location NULL（CHECK-IN ONLY）
- [x] 无 activity geo 依赖 / 无 haversine / 无 geo_radius 强制 / 无 out_of_range / 无 detector/Cron/Queue/背景定位
- [x] 向后兼容无 body check-in 200 / multi-participation 不变 / active-session 唯一性不变
- [x] S2-6k1 时间语义不变
- [x] tsc 0 / catalog 83 / seed 6/83/238
- [x] S2-6h-R2 71/71 / S2-6i 80/15/10 / S2-6j 87/13/13 / Frozen 340/340 / S2-6k1 Time Policy PASS / S2-6k2 Location Suite PASS
- [x] FK 0 / integrity ok / teardown clean / 8787 未碰 / report 完整 / workers-only commit / no push

**全部 PASS → S2-6k2 = GO**

---

## 13. Git Scope & Commit

- 改动文件（仅 workers/）：
  - `workers/src/utils/location.ts`（新增）
  - `workers/src/routes/activities.ts`（check-in 解析 location）
  - `workers/src/services/attendance-service.ts`（checkInOwn 接收 location）
  - `workers/src/repository/attendance-sessions.ts`（insertEvent 写坐标，distance 恒 NULL）
  - `workers/tests/location_integration.mjs`（新增）
  - `workers/tests/run_s2_6k2.mjs`（新增）
- Commit（授权后）：`feat(jhzy-v2): add attendance location capture`（仅 stage workers/ 上述文件，no push / no tag / 不 amend `bb90816`）。
- baseline `30fc0fa` / `aa0afea` / `801f70f` / `bb90816` 均未动。

---

## 14. Open Items（后续切片，未启动）

- **Activity Geo Administration**：运营端配置活动 lat/lng/geo_radius/坐标系（阻塞 out_of_range 点亮）。
- **Device Identity Foundation**：设备指纹生命周期，解锁 device_switch / multi_account。
- **Cross-Day Policy**：独立设计跨午夜/跨日语义（allow_cross_midnight 模型待定）。
- **Detector Core（建议 0006）**：Cron 执行模型 + 幂等 + 扫描索引 + 审计/权限/租户；可先仅点亮 reverse_time 完整性扫描。
- 待上述就绪，out_of_range 方可点亮（受 Detector Core + 活动地理 admin 双重依赖）。

---

## 15. STOP

**S2-6k2 = GO**。已 STOP，未自动进入 Activity Geo Administration / Device Identity / Cross-Day / Detector Core / S2-6k3 或任何后续 implementation。下一阶段需你以 `@long-text` 显式授权后，我方可启动对应只读设计冻结。
