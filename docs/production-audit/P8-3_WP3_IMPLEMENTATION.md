# P8-3 WP3 — Migration Script Implementation（迁移脚本实现）

> **层级**：L3（实现层，接入 P8-3 Definition Freeze → WP2 表映射）
> **Authority**：`PROJECT_CONSTITUTION`（L0）· `ARCHITECTURE_FREEZE` / `BUSINESS_BOUNDARY` / `DATA_GOVERNANCE_FREEZE`（L1）· `ADR-001` / `P5_FINAL_FREEZE` / `ARCHITECTURE_TARGET`（L2）· `D1-*` / `D1-RBAC-DESIGN` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / `P8-3_WP1_*` / `P8-3_WP2_*`（L3）

---

## 1. Scope（本轮范围）

- 实现 1.0 → 2.0 的迁移 ETL 工具链（Extract → Transform → Load）。
- 仅针对 WP2 已裁定结论的 **130 个迁移对象**编写脚本。
- `user_favorites` 按 WP2 §3 / P8-3 Definition Freeze **显式 EXCLUDED**：不迁移、不 DROP、不自动归档、不猜测目标，写入 exclusion / issue 记录，等待 BCR 结果。
- **严格禁止生产执行**：本工具链在内存 / 文件适配器中运行与验证，未绑定任何 D1 生产库、未连接生产 MySQL、未部署、未触发任何正式切换。

---

## 2. 工具链结构

```
p8-3-migration/
├── package.json            # ESM, 零运行时依赖, "test": "node --test"
├── src/
│   ├── ulid.js             # ULID(26, Crockford) 生成器 + 确定性 PRNG (makeRng/makeUlid)
│   ├── logger.js           # 确定性结构化日志 (sink 收集, 可断言)
│   ├── checkpoint.js        # MemoryCheckpoint / FileCheckpoint (resumable)
│   ├── idmap.js            # legacy_id_maps 访问器 (系统管理, 非业务表)
│   ├── issues.js           # migration_issues 访问器 (系统管理, 非工单系统)
│   ├── adapters.js         # Source(T1.0) / Target(T2.0 D1) / ArchiveSink
│   │   ├── FixtureSource   # 测试用内存源
│   │   ├── DumpSource      # 生产用: 1.0 导出 JSON 逐表读取
│   │   ├── MemoryTarget    # 测试用内存目标 (镜像 D1 自增 INTEGER PK)
│   │   └── D1Target        # 生产用 Cloudflare D1 绑定 (接口同 MemoryTarget, 本仓不调用)
│   ├── transforms.js       # 具名变换 + 通用列映射 (冻结 D1 模型: INTEGER PK / ULID / epoch)
│   ├── tablemap.js         # TABLE_MAP: WP2 §2 逐表映射 (131 = 130 mapped + 1 EXCLUDED)
│   ├── batches.js          # B0–B20 依赖顺序批次
│   ├── runner.js           # 编排器: 幂等/可恢复/批次感知/失败隔离/dry-run/idmap+issues
│   └── cli.js              # 入口: --dry-run / --dump / --batch / --checkpoint
└── test/
    ├── fixtures.js         # 标准夹具 (含 user_favorites/quick_actions/qr_codes 边界对象)
    ├── runner.test.js      # 8 项: 全量/排除/幂等/恢复/dry-run/归档丢弃/失败隔离/拓扑
    ├── tablemap.test.js    # 7 项: 覆盖/有效性/transform存在/源系统/可达/排除/ULID
    └── ulid.test.js        # 4 项: 格式/确定性/时间前缀/PRNG
```

---

## 3. 设计约束（严格遵循冻结）

| 约束 | 实现 |
|---|---|
| 冻结目标模型 | `INTEGER PRIMARY KEY`（目标自增）+ `public_id`(ULID 26, Crockford) + `DATETIME→INTEGER epoch`；**不使用未冻结 `schema.sql` 的 BIGINT+uuid** |
| 单一权威库 | 仅写入 D1（经 `D1Target` 或测试 `MemoryTarget`）；不写第二库、不写第二 API |
| 迁移支撑表 | `legacy_id_maps` / `migration_issues` 仅系统管理用途，**不得演化为业务表 / 工单系统** |
| 正式生产拓扑 | 国内备案域名 → 腾讯云国内入口 → Cloudflare Worker → D1；WP3 不修改该拓扑 |
| 幂等 | 每源行先查 `legacy_id_maps`，命中则跳过（不重复插入） |
| 可恢复 | `checkpoint` 记录已完表，重跑跳过已完成表 |
| 批次感知 | 严格按 B0–B20 依赖顺序（RBAC 种子 → 身份 → 团队 → … → 收尾） |
| 失败隔离 | 单行变换失败 → 记 `migration_issues`(dirty, error) + 计 errors，继续下一行 / 下一表 |
| dry-run | `--dry-run` 仅记录意图日志，不写任何目标数据 |
| 确定性日志 | 日志含 `seq/ts/level/msg/meta`，可断言、可重放 |

---

## 4. 关键实现说明

### 4.1 user_favorites 排除（BCR 待裁）
- `EXCLUSIONS = ['api.user_favorites']`；`TABLE_MAP` 同时含 `'api.user_favorites': { kind: 'EXCLUDED' }`（双保险）。
- Runner 主循环按 `EXCLUSIONS` 过滤，永不进入迁移批次；单独循环写入 `excluded` issue（severity=info，resolution_status=excluded）。
- 不为其迁移、不 DROP、不自动归档、不猜测目标表。

### 4.2 计数口径（与 WP2 一致）
- `TABLE_MAP` 共 **131** 源对象键 = **130** MIGRATE/TRANSFORM/MERGE/ARCHIVE/DROP + **1** EXCLUDED(`user_favorites`)。
- `mappedCount()` = 131 − 1(EXCLUSIONS) = **130**。
- 已移除 `api.v_all_certificates`（MySQL **视图**，非基表，不应迁移）；`user_favorites` 作为 EXCLUDED 对象计入 131，使总数严格对应 WP2「131 = 130 已映射 + 1 UNKNOWN」。

### 4.3 冻结目标模型合规
- 所有具名变换（`users/volunteers/teams/activities/signups/checkins/points_ledger/certificates/admins/...`）生成 `INTEGER PK` + `ULID public_id`(仅 `users/teams/activities/content_articles/files`) + `epoch` 时间。
- PII 处理：`id_card` 经 `maskIdCard` 脱敏入 `id_card_mask`；证书 `holder_name` 明文**不带入** 2.0（置 `null`），掩码身份仅经 `id_card_mask` 承载。

### 4.4 生产执行路径（已接线，本仓不触发）
- `cli.js --dump <dir>` 读取 1.0 导出 JSON，`D1Target` 绑定 `env.DB` 执行。本 WP3 **仅实现**，未连接生产库、未 `npm run` 生产迁移、未部署。
- 所有验证在 `MemoryTarget` / `FixtureSource` 本地完成，满足「禁止生产执行」纪律。

---

## 5. 测试结果

```
# tests 19 · # pass 19 · # fail 0
runner.test.js   (8) 全量迁移+冻结模型 / user_favorites排除 / 幂等重跑 / checkpoint恢复 / dry-run / 归档+丢弃 / 失败隔离 / 拓扑未动
tablemap.test.js (7) 131覆盖 / kind有效 / transform存在 / 源系统解析 / 批次可达 / 排除未排程 / ULID合规
ulid.test.js     (4) 格式 / 确定性 / 时间前缀 / PRNG
```

---

## 6. 禁止事项确认（本 WP3 已遵守）

- ✅ 未修改 `PROJECT_CONSTITUTION` / 三 Freeze / P5 / 设计层文档
- ✅ 未修改 Core Domain / 业务代码逻辑
- ✅ 未修改生产数据库 / schema
- ✅ 未连接并写入生产库
- ✅ 未正式运行迁移
- ✅ 未部署 / 灰度切换
- ✅ 未处理 `user_favorites` BCR（仅记录 excluded，等待裁定）
- ✅ 未进入 WP4

---

## 7. Gate 结论（详见对话输出 #RECOMMENDATION）

`P8-3 WP3 Gate = PASS`；`Ready for WP4 = YES`（前置：用户显式授权 + 生产 dump 就绪 + 测试库演练通过）。
