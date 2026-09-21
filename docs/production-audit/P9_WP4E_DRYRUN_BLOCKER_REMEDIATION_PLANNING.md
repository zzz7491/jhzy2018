# P9 WP4-E Dry-run Blocker Remediation Planning

- **Planning round**: P9 WP4-E Dry-run Blocker Remediation Planning (仅规划，不执行)
- **Date**: 2026-09-21
- **run_id**: `wp4d_authoritative_20260921_120656`
- **Mode**: 制定 blocker remediation 规则 / 裁定口径 / 执行批次 / 校验标准 / 后续 dry-run rerun 条件。
- **不执行**: 不写 D1 / 不迁移 / 不 Cutover / 不修改源库 / 不修改 snapshot 原件 / 不 commit。

---

## 1. Repo Identity Gate

| Item | Value |
|---|---|
| branch | `master` |
| HEAD | `1145dfd825e71dd347c1810aed1a5835a1fc38a2` |
| HEAD == origin/master | YES |
| staged | 0 |
| parallel changes | 存在但未处理（按禁令保留） |

---

## 2. Dry-run Baseline (读取自证据与本地报告)

来源：
- `docs/production-audit/P9_WP4E_DRYRUN_TRANSFORM_ONLY_EXECUTION_20260921.md` (已 commit `1145dfd`)
- `.var/migration-dryrun/wp4e_dryrun_20260921/reports/dryrun_reconciliation_report.md`
- `.var/migration-dryrun/wp4e_dryrun_20260921/reports/gap_re_1_dual_name_source_decision.md`
- `.var/migration-dryrun/wp4e_dryrun_20260921/rejected/rejected_rows.ndjson`
- `.var/migration-dryrun/wp4e_dryrun_20260921/mappings/legacy_id_maps_preview.ndjson`

### 2.1 当前裁定

```
Dry-run transform-only = PARTIAL
Ready for Staging D1 Import = NO
Ready for Production D1 Import = NO
Critical blockers = ORPHAN_FK_PRESENT, CERT_NO_DUP_PRESENT, DUP_ACTIVE_CHECKIN_PRESENT
```

### 2.2 必须提取并记录的指标

| 指标 | 数值 |
|---|---|
| duplicate active check-in pairs | **91** (业务不变式 FAIL；rejected 样本 50) |
| certificate number duplicates | **62** (业务不变式 FAIL；rejected 样本 50) |
| orphan FK — attendance_volunteer | **485** |
| orphan FK — attendance_activity | **113** |
| orphan FK — signup_activity | **118** |
| orphan FK 合计 | **716** (att_volunteer 485 + att_activity 113 + signup_activity 118) |
| orphan FK — signup_user | 0 (✅) |
| orphan FK — certificate_volunteer | 0 (✅) |
| ID mapping collision | **73** (见 rejected_rows) |
| rejected rows 合计 | **816** (ORPHAN_FOREIGN_KEY 716 / DUPLICATE_ACTIVE_CHECKIN 50 / CERTIFICATE_ID_COLLISION 50) |
| GAP-RE-1 状态 | 关键业务域 RESOLVED (srcKey high)；`welfare_options`/`service_areas` 两版均非空→建议 jhzy_，置信度 low，非阻塞 |

### 2.2b 关键裁定速查 (audit shorthand)

- ORPHAN_FK_PRESENT
- CERT_NO_DUP_PRESENT
- DUP_ACTIVE_CHECKIN_PRESENT
- duplicate active check-in pairs = 91
- cert no duplicate = 62
- orphan FK = 716
- ID map collision = 73
- rejected rows = 816
- RELINK / ARCHIVE_COMPATIBILITY / REJECT （见 §3）
- MERGE_ALIAS / CERT_NO_COLLISION_RENUMBER_REQUIRED （见 §4）
- SPLIT_TO_OCCURRENCE_ATTENDANCE / SELECT_CANONICAL_ATTENDANCE / FORCE_RESOLVE_TO_SINGLE_ACTIVE （见 §5）
- R0-R8 remediation batches （见 §7）
- rerun dry-run acceptance criteria （见 §8）

### 2.3 关键数据局限（影响后续执行轮设计）

- `rejected_rows.ndjson` 仅记录 `{source_database, source_table, source_pk, reason_code, severity, recommended_handling}`，**未记录断裂的 FK 值**（如 broken activity_id / user_id）。因此 R1 执行轮必须从源表重新提取 FK 列，才能判定 RELINK 目标；仅凭 source_pk 无法补链。
- `legacy_id_maps_preview.ndjson` 中 `public_id_preview` 由 `sha256(src_table:pk)` 派生，稳定可重跑；collision 行需 R4 解析。
- `attendance status` 分布: `{'3': 46, '2': 490, '1': 10}`（即 status=2 已签到约 490 行，与报名 490 大体对应；status=1 签到中 10、status=3 已签退 46）。重复 active 判定须基于 (volunteer, activity) 同时 status∈{1,2}。

---

## 3. BLOCKER A — ORPHAN FK REMEDIATION PLAN

**当前 blocker**: `ORPHAN_FK_PRESENT`（716 行，分三类：`signup_activity` 118 / `attendance_activity` 113 / `attendance_volunteer` 485）

### 3.1 可补链记录 → RELINK

若 orphan FK 可通过以下任一唯一键唯一解析到 canonical target row，则规划为 RELINK：

- 解析键：手机号 / openid / unionid / volunteer name + phone（对 volunteer/user）
- activity 解析：activity_id legacy alias / activity title + date + organizer / source_signup 关联 / source_attendance 关联 / source_certificate 关联

规则输出：

```
action = RELINK
target = resolved canonical target row (2.0 目标表 pk)
confidence = high / medium / low
evidence_required = YES   (必须记录用来解析的源字段与匹配依据)
```

- `confidence=high`：单一唯一键精确匹配（如 phone 完全匹配且唯一）。
- `confidence=medium`：组合键匹配（name+phone 部分匹配、title+date 近似匹配），需人工抽检复核样本。
- `confidence=low`：仅模糊匹配，默认不自动 RELINK，降级为 ARCHIVE/REJECT 并标记 requires_user_review=YES。

### 3.2 不可补链但有业务保留价值 → ARCHIVE_COMPATIBILITY

```
action = ARCHIVE_COMPATIBILITY
target = legacy_archive / compatibility table (不进入业务表)
business_table_import = NO
reason = unresolved orphan FK
```

- 保留原始记录与 source_pk，供审计追溯；不得静默丢弃。
- 历史服务次数/积分若需保留，以独立兼容表记录，不污染 2.0 业务不变式。

### 3.3 无效 / 垃圾记录 → REJECT

```
action = REJECT
reason = invalid legacy record (测试/空壳/损坏)
requires_user_review = YES if uncertain
```

- 明显测试数据、空壳行、损坏行 → REJECT。
- 不确定时必须 `requires_user_review=YES`，不得自动丢弃。

### 3.4 输出要求与验收

后续执行轮 R1 必须生成：

```
reports/orphan_fk_remediation_plan.md
rejected/orphan_fk_rejected.ndjson
mappings/orphan_fk_relink_preview.ndjson
```

验收标准：

```
critical orphan FK = 0 才能进入 staging import
所有 orphan 必须 RELINK / ARCHIVE / REJECT 三选一
不得 silent drop
```

---

## 4. BLOCKER B — CERTIFICATE NUMBER DUPLICATE REMEDIATION PLAN

**当前 blocker**: `CERT_NO_DUP_PRESENT`（62 个重复证书号，跨源表 `certificates` 59 / `certificate_master` 104 / `exam_certificates` 413）

### 4.1 权威证书源优先级

建议优先级（须以实际字段完整度、发证时间、业务类型校验为准，不得仅按表名机械套用）：

```
1. certificate_master   (若字段最完整、含统一编号)
2. certificates         (线上活动证书)
3. exam_certificates    (培训/考试证书)
```

- 校验维度：证书号格式一致性、发证日期非空、关联 volunteer/activity 有效、证书类型匹配。
- 若某源表在该业务类型下为空或缺字段，自动降级到下一优先级。

### 4.2 同号同人同活动 → MERGE_ALIAS

若重复证书号满足：

```
same volunteer (canonical user/volunteer)
same activity / exam
same issue date
same certificate type
```

则：

```
action = MERGE_ALIAS
canonical_certificate = best complete record (按 4.1 优先级 + 字段完整度)
legacy_alias = all duplicate source rows
business_duplicate = NO
```

- 保留全部历史记录为 alias，canonical 仅一条；历史证书号可追溯。

### 4.3 同号不同人 / 不同活动 → CERT_NO_COLLISION_RENUMBER_REQUIRED

若重复证书号对应**不同人**或**不同活动**：

```
action = CERT_NO_COLLISION_RENUMBER_REQUIRED
business_import = BLOCKED until resolved
```

处理策略：

```
preserve legacy_cert_no            (原始号保留，不可覆盖)
generate new canonical cert_no    仅当 policy approved
store legacy_cert_no_alias
record collision evidence
requires_user_review = YES
```

- 证书编号不得静默覆盖；历史证书号必须可追溯。
- 未获管理员书面 policy 批准前，collision 行不得进入业务表。

### 4.4 输出要求与验收

后续执行轮 R2 必须生成：

```
reports/cert_no_collision_remediation_plan.md
mappings/certificate_alias_preview.ndjson
rejected/certificate_collision_rejected.ndjson
```

验收标准：

```
certificate number duplicate = 0 才能进入 staging import
证书编号不得静默覆盖
历史证书号必须可追溯
```

---

## 5. BLOCKER C — DUPLICATE ACTIVE CHECK-IN / ATTENDANCE REMEDIATION PLAN

**当前 blocker**: `DUP_ACTIVE_CHECKIN_PRESENT`（91 个 (volunteer, activity) 多考勤对；status 分布 {3:46, 2:490, 1:10}）

### 5.1 历史多次服务记录 → SPLIT_TO_OCCURRENCE_ATTENDANCE

若多条记录代表不同日期 / 不同场次 / 不同服务时段：

```
action = SPLIT_TO_OCCURRENCE_ATTENDANCE
target = separate occurrence / attendance rows
business_duplicate = NO
```

- 按 checkin_time 日期/场次拆分到对应 occurrence，不构成重复。

### 5.2 同一活动同一时间窗口重复提交 → SELECT_CANONICAL_ATTENDANCE

若多条为同一时间窗口重复提交：

```
action = SELECT_CANONICAL_ATTENDANCE
canonical_rule (优先级从高到低):
  1. has both checkin and checkout (完整签到-签退)
  2. valid duration (checkout - checkin 在合理区间)
  3. latest updated_at
  4. non-null location
  5. lowest legacy id 作为 tie-breaker
duplicate_action = ARCHIVE_COMPATIBILITY
```

### 5.3 当前 active check-in 冲突 → FORCE_RESOLVE_TO_SINGLE_ACTIVE

若存在同一志愿者多个未签退 / active 状态 (status∈{1,2})：

```
action = FORCE_RESOLVE_TO_SINGLE_ACTIVE
rule:
  - keep most recent valid active attendance
  - archive older active rows
  - record conflict
  - do not create multiple active participations
```

### 5.4 2.0 业务不变量（必须保持）

```
同一志愿者同一时刻最多只有一个活动处于已签到状态
已签到时主按钮 = 签退
签退后不得仍显示可重复签到状态
```

### 5.5 输出要求与验收

后续执行轮 R3 必须生成：

```
reports/attendance_duplicate_remediation_plan.md
mappings/attendance_canonical_preview.ndjson
rejected/attendance_duplicate_rejected.ndjson
```

验收标准：

```
duplicate active check-in = 0 才能进入 staging import
每个重复组必须有 canonical decision
非 canonical 记录必须 archive 或 reject
```

---

## 6. ID MAP COLLISION REMEDIATION PLAN

针对 `legacy_id_maps_preview.ndjson` 中 **73** 个 collision：

```
同一 legacy key 不得映射多个 target
同一 target key 不得被多个不可合并 legacy key 占用
所有 collision 必须 MERGE / ALIAS / REJECT / ARCHIVE
```

- `MERGE`：可合并为同一 canonical（如双名源表同一业务实体）。
- `ALIAS`：保留多源 alias，指向同一 canonical target。
- `REJECT`：无业务价值的冲突 key。
- `ARCHIVE`：保留追溯但不在业务表建映射。

输出要求（后续执行轮 R4）：

```
reports/id_map_collision_remediation_plan.md
mappings/legacy_id_maps_resolved_preview.ndjson
```

验收标准：

```
id mapping critical collision = 0
```

---

## 7. REMEDIATION EXECUTION BATCHES (不执行，仅定义)

> 下列批次为后续 remediation execution 轮的蓝图；本轮不运行任何批次。

| Batch | 输入 | 输出 | 应用规则 | count before | count after | 剩余 blockers | abort condition |
|---|---|---|---|---|---|---|---|
| R0 | WP4-D 快照 (off-host copy) + dry-run 工作目录产物 | blocker inventory 清单 | 加载 arts + 重建指标 | 716/62/91/73 | 同 | 全部 | 快照不可读 → STOP |
| R1 | `jhzy_activity_signups` / `jhzy_attendance_records` 源表 FK 列 + volunteers/users 解析键 | `orphan_fk_relink_preview.ndjson` / `orphan_fk_rejected.ndjson` | §3.1–3.3 | orphan 716 | residual=RELINK+ARCHIVE+REJECT 之和=716 (非 0) | ORPHAN_FK_PRESENT 直到 residual_relinkable→0 | silent drop 出现 → ABORT |
| R2 | `certificates`/`certificate_master`/`exam_certificates` | `certificate_alias_preview.ndjson` / `certificate_collision_rejected.ndjson` | §4.1–4.3 | cert dup 62 | canonical 62, collision alias 保留 | CERT_NO_DUP_PRESENT 直到 collision→0 | 静默覆盖证书号 → ABORT |
| R3 | `jhzy_attendance_records` (按 volunteer+activity 分组) | `attendance_canonical_preview.ndjson` / `attendance_duplicate_rejected.ndjson` | §5.1–5.4 | dup active 91 | canonical 91 | DUP_ACTIVE_CHECKIN_PRESENT 直到 →0 | 生成多个 active participation → ABORT |
| R4 | `legacy_id_maps_preview.ndjson` (73 collision) | `legacy_id_maps_resolved_preview.ndjson` | §6 | collision 73 | resolved 73 | id_map_critical_collision 直到 →0 | 单 legacy→多 target 残留 → ABORT |
| R5 | R1–R4 resolved 映射 | regenerated `transformed/*_preview.ndjson` | 应用 resolved 映射重转换 | — | — | 同 R1–R4 | 转换失败 → ABORT |
| R6 | R5 输出 | regenerated `rejected_rows.ndjson` | 仅含 unresolved | 816 | ≤ unresolved 残留 | 同 | — |
| R7 | R6 输出 | regenerated `dryrun_reconciliation_report.md` | 业务不变式重算 | 三项 FAIL | 三项 PASS 或 FAIL | 决定 Ready | — |
| R8 | R7 报告 | Decision: Ready for staging D1 import? | §8 验收 | — | — | — | 任一 critical≠0 → Ready=NO |

每批必须记录：input files / output files / rules applied / count before / count after / remaining blockers / abort condition（上表已展开）。

---

## 8. RERUN DRY-RUN ACCEPTANCE CRITERIA

后续 remediation execution 后，必须重新 dry-run。通过条件：

```
ORPHAN_FK_PRESENT = NO
CERT_NO_DUP_PRESENT = NO
DUP_ACTIVE_CHECKIN_PRESENT = NO
critical orphan FK = 0
certificate number duplicate = 0
duplicate active check-in = 0
id map critical collisions = 0
rejected critical rows reviewed = YES
GAP-RE-1 critical unresolved = 0
D1 import executed = NO
D1 modified = NO
Migration executed = NO
Cutover executed = NO
```

若通过：

```
Ready for Staging D1 Import = YES
Ready for Production D1 Import = NO
Cutover authorized = NO
```

若未通过：

```
Ready for Staging D1 Import = NO
```

---

## 9. STAGING D1 BOUNDARY

```
当前无 staging D1
Staging D1 Import = NO
Production D1 Import = NO
```

只有满足以下条件后才能考虑 staging：

```
1. blocker remediation dry-run PASS (§8)
2. staging D1 created and explicitly authorized
3. staging import execution gate completed
```

---

## 10. FINAL GATE

```
P9 WP4-E Dry-run Blocker Remediation Planning = PASS (规划完成)
Ready for Blocker Remediation Execution = YES (规划就绪, 待另行显式授权的执行轮)
Ready for Staging D1 Import = NO
Ready for Production D1 Import = NO
Cutover authorized = NO

D1 import executed = NO
D1 modified = NO
Migration executed = NO
Cutover executed = NO
Source data modified = NO
Source schema modified = NO
Worker modified = NO
DNS / route changed = NO
```

### 禁止项遵守确认

本轮未执行：写 D1 / `wrangler d1 execute` / SQL import / 创建·修改 staging D1 / 修改 production D1 / 修改 Worker / 修改 DNS·route / 修改 MySQL·源库 / 重新 mysqldump·snapshot / 修改 snapshot 原件 / 删除·清空·移动·覆盖源数据 / 直接改 `.var/migration-dryrun/` 已有产物作"假修复" / Cutover / Git commit·push。

**STOP** — 下一步须另行显式授权：① Blocker Remediation Execution 轮（R0–R8）；② 创建并授权 staging D1；③ 本规划文档的 Git Closeout；④ 后续 staging import 执行门。
