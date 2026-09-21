# P9 WP4-D Freeze Coverage Closure — Execution Authorization Gate

> **性质**：**Execution Authorization Gate only（本轮只确认是否允许进入 C-1～C-10 执行轮，不实际执行任何冻结 / 快照 / 迁移）**。
> **生成时间**：2026-09-21 10:46 CST（China Standard Time, GMT+8）
> **生成者**：WorkBuddy（Agent / execution owner）
> **承接**：`P9_WP4D_FREEZE_COVERAGE_CLOSURE_DEFINITION.md`（Git Closeout = PASS, commit `fb21f08`）

---

## 1. Repo Identity

| 项 | 值 | 判定 |
|---|---|---|
| branch | `master` | PASS |
| HEAD | `fb21f08` | PASS |
| origin/master | `fb21f08` | PASS |
| HEAD == origin/master | YES | PASS |
| staged files | 0 | PASS |
| parallel changes (untouched) | 292 项 | 允许存在，未处理 |

Repo Identity Gate = **PASS**。

---

## 2. Baseline

读取并确认以下基线文件：

- `P9_WP4D_FREEZE_COVERAGE_CLOSURE_DEFINITION.md`
- `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md`
- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md`
- `P9_WP4C_EXECUTION.md`
- `P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md`

确认项：

| 基线事实 | 状态 |
|---|---|
| Boundary decision = `MUST_FREEZE` | ✅ 确认 |
| Ready for WP4-D Execution = `CONDITIONAL_NO` | ✅ 确认 |
| C-1～C-10 已定义但未执行 | ✅ 确认 |
| manage / exam / api2 / signup / php-cli cron = `MUST_FREEZE` | ✅ 确认 |
| signup_db web/app = `SAFE_WITH_LIMITATION`（`/www/wwwroot` 零引用；之外 UNKNOWN） | ✅ 确认 |
| G-2 = `WAIVED`（U-08 书面 waiver；residual：Cutover 前须补 off-host copy，否则 ABORT Cutover） | ✅ 确认 |
| WP4-D authoritative snapshot 不得在本轮执行 | ✅ 确认（仅为定义草案，未执行任何快照、未进入 WP4-D 执行） |

Baseline read = **YES**。

---

## 3. Execution Scope Authorization

后续执行轮（若授权）的范围**仅限**以下，且完成后必须 STOP：

| ID | 范围 | 通道 |
|---|---|---|
| C-1 | 冻结 `api.jhzyfw.com` | nginx |
| C-2 | 冻结 `api2.jhzyfw.com` | nginx |
| C-3 | 冻结 `exam.jhzyfw.com`（80+443 双块） | nginx |
| C-4 | 冻结 `manage`（block 插在 `return 301` 前） | nginx |
| C-5 | 冻结 `signup.jhzyfw.com` | nginx |
| C-6 | 暂停相关 PHP CLI cron（crontab 注释 + 备份） | 非 nginx |
| C-7 | 限制 / 确认 phpMyAdmin / 888 | 防火墙/人工 |
| C-8 | full no-write verification（T0→wait→T2） | MySQL 只读 |
| C-9 | 准备 WP4-D authoritative 目录（mkdir only，不 dump） | 文件系统 |
| C-10 | 记录 G-2 waiver residual evidence | 文档 |

**明确禁止后续执行轮自动进入**（须另行授权）：

- WP4-D authoritative snapshot
- mysqldump / schema / data / routines dump
- migration
- D1 import
- Cutover

Execution scope authorized = **YES（范围已界定；个别组件授权状态见 §11 矩阵）**。

---

## 4. Maintenance Window Decision

| 字段 | 值 |
|---|---|
| maintenance_window_id | `P9-WP4D-FCC-MW-20260921`（**PROPOSED**，待 U-08 显式批准） |
| approved date | 2026-09-21（**PROPOSED**） |
| approved time range | 02:00–04:00 CST（**建议值**，待批准） |
| timezone | CST / China Standard Time (GMT+8) |
| max duration | 2 hours |
| approver | U-08 (ming mo)（**PROPOSED**） |
| execution owner | WorkBuddy (agent) |

**当前时间判定**：生成本文档时 = **2026-09-21 10:46 CST**，**不在** 02:00–04:00 批准窗口内。

> **规则适用**：当前时间不在批准窗口内 → 只允许完成授权文档，**不得进入 Execution**。

Maintenance window approved = **NO（当前时间窗外；建议窗口待 U-08 显式批准）**。

---

## 5. C-1～C-5 Vhost Authorization

允许后续执行轮临时修改以下 vhost（执行后必须恢复）：

| vhost | 真实配置文件 |
|---|---|
| `api.jhzyfw.com` | `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf` |
| `api2.jhzyfw.com` | `/www/server/panel/vhost/nginx/api2.jhzyfw.com.conf` |
| `exam.jhzyfw.com` | `/www/server/panel/vhost/nginx/exam.jhzyfw.com.conf` |
| `manage` | `/www/server/panel/vhost/nginx/manage.jhzyfw.com.conf` |
| `signup.jhzyfw.com` | `/www/server/panel/vhost/nginx/signup.jhzyfw.com.conf` |

**强制要求（执行轮须遵守）**：

- 每个 vhost 修改前先 `cp` 备份；
- 80 / 443 双 server 块都要插入冻结块；
- `manage` 的冻结块必须插在 `return 301` **之前**；
- 443 必须单独 `curl --resolve` 实测（仅 curl 127.0.0.1 不带 Host 会打到 default server，误导）；
- 插入后 `nginx -t` 必须 PASS；
- `nginx -s reload` 必须 PASS；
- 失败立即恢复备份（见 §10）。

C-1～C-5 freeze = **AUTHORIZED（参数已界定，待维护窗内执行）**。

---

## 6. C-6 PHP CLI Cron Authorization

允许后续执行轮临时备份并注释 root crontab 中源库相关 PHP CLI cron，须包括：

- `cron_generate_certs.php`（每分钟，写 `activity_service_certificates` / `id_pool` / `jhzy_attendance_records`）
- `cron_check_location_anomaly.php`（每 5 分钟）
- `daily_cleanup`
- `daily_force_checkout`

**强制要求**：

- 修改前备份 root crontab（`crontab -l > backup`）；
- 只注释源库相关 PHP CLI cron，不处理无关 cron；
- 验证 `crontab` 已生效；
- 观察相关 cron 日志（如 `cron_cert.log`）≥ 5 分钟；
- 执行后恢复 root crontab。

> **门控规则**：如不允许修改 crontab → C-6 = NOT AUTHORIZED → Ready for Freeze Coverage Closure Execution = NO。
> 本轮**未收到**明确的「允许修改 crontab」授权 → C-6 = **NOT_AUTHORIZED（待 U-08 显式批准）**。

---

## 7. C-7 phpMyAdmin / 888 Decision

三选一：

- **Option A** — 临时限制 888 来源（首选；需备份防火墙规则、窗内限制、结束恢复、验证生效）。
- **Option B** — nginx / aaPanel 访问限制（仅当确认 888 由该入口控制时使用）。
- **Option C** — U-08 书面确认维护窗内无人使用（人工控制；须记录 confirmer=ming mo、confirmation text、residual risk、compensating control=C-8 hash verification）。

> **门控规则**：如 A/B 不可行且**没有 Option C 书面确认** → C-7 = FAIL → Ready for Freeze Coverage Closure Execution = NO。
> 本轮**未选择** A/B/C 任一方案，亦无 Option C 书面确认 → C-7 = **FAIL（待 U-08 选择方案并确认）**。

---

## 8. No-Write Verification Parameters

确认（执行轮须遵守）：

- T0 必须在 **C-1～C-7 全部生效后**采集；
- T1 = 全通道冻结完成时间；
- wait period ≥ 120 秒，**推荐 300 秒**；
- T2 采集后比对：
  - inventory hash
  - row count hash
  - exact `COUNT(*)` hash
  - active timestamp hash
  - baseline hash
  - `UPDATE_TIME > T1` 查询须为空集；
- 任一不一致即 **ABORT**。

C-8 full no-write verification = **AUTHORIZED（参数已界定，待执行轮运行）**。

---

## 9. WP4-D Directory Prep Authorization

允许后续执行轮：

- 创建 WP4-D authoritative 目录；
- 权限设为 `0700`；
- 目录已存在即 **ABORT**；
- 只创建目录与 evidence，**不执行 dump**。

目录格式：

```
/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_<YYYYMMDD_HHMMSS>/
```

C-9 WP4-D directory readiness = **AUTHORIZED（mkdir only，不 dump）**。

---

## 10. Abort / Resume Acknowledgement

出现以下任一情况立即 **ABORT** 并恢复：

- nginx test fail；
- vhost 冻结不生效；
- crontab 修改失败；
- cron 仍在写；
- phpMyAdmin 限制失败且无确认；
- hash 不一致；
- 目录创建失败；
- 任一不确定项。

恢复必须包括：

- 移除所有 freeze blocks；
- 恢复 vhost 备份；
- 恢复 root crontab；
- 撤销 phpMyAdmin 限制；
- `nginx -t`；
- `reload nginx`；
- 验证服务恢复；
- 记录 resume timestamp。

Abort/resume acknowledged = **YES**。

---

## 11. Authorization Matrix

```text
C-1 api.jhzyfw.com freeze = AUTHORIZED
C-2 api2.jhzyfw.com freeze = AUTHORIZED
C-3 exam.jhzyfw.com freeze = AUTHORIZED
C-4 manage freeze = AUTHORIZED
C-5 signup.jhzyfw.com freeze = AUTHORIZED
C-6 php-cli cron freeze = NOT_AUTHORIZED
C-7 phpMyAdmin restriction = FAIL
C-8 full no-write verification = AUTHORIZED
C-9 WP4-D directory readiness = AUTHORIZED
C-10 G-2 residual evidence = AUTHORIZED
WP4-D authoritative snapshot = NOT_AUTHORIZED
Migration = NOT_AUTHORIZED
Cutover = NOT_AUTHORIZED
```

---

## 12. Final Gate

```text
Repo identity confirmed = YES
Baseline read = YES
Execution scope authorized = YES
Maintenance window approved = NO
C-1 api.jhzyfw.com freeze authorized = YES
C-2 api2.jhzyfw.com freeze authorized = YES
C-3 exam.jhzyfw.com freeze authorized = YES
C-4 manage freeze authorized = YES
C-5 signup.jhzyfw.com freeze authorized = YES
C-6 php-cli cron freeze authorized = NO
C-7 phpMyAdmin decision = FAIL
C-8 full no-write verification authorized = YES
C-9 WP4-D directory readiness authorized = YES
C-10 G-2 residual evidence authorized = YES
Abort/resume acknowledged = YES

Ready for Freeze Coverage Closure Execution = NO
Ready for WP4-D Execution = NO

Maintenance window executed = NO
Write freeze executed = NO
No-write verification executed = NO
Authoritative snapshot executed = NO
Production dump executed = NO
Production backup executed = NO
Production data modified = NO
Production schema modified = NO
D1 modified = NO
Worker modified = NO
DNS / route changed = NO
Migration executed = NO
Cutover executed = NO
Entered WP4-D = NO
Document created = YES
```

---

## 结论与下一步（STOP）

- **本轮仅完成授权门文档，未执行 C-1～C-10，未冻结、未快照、未迁移。**
- Ready for Freeze Coverage Closure Execution = **NO**，阻塞于三项：
  1. **维护窗**：当前 10:46 CST 在 02:00–04:00 窗外；须 U-08 批准具体窗口（建议 02:00–04:00 CST ≤2h）。
  2. **C-6**：未收到修改 crontab 的显式授权 → NOT_AUTHORIZED。
  3. **C-7**：未选择 A/B/C 方案且无 Option C 书面确认 → FAIL。
- 待上述三项齐备后，方可进入 C-1～C-10 执行轮（窗内运行，完成后 STOP）。
- G-2 = WAIVED 持续有效；Cutover 前须补 off-host copy，否则 ABORT Cutover。
