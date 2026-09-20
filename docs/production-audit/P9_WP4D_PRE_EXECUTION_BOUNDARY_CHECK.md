# P9 WP4-D — Pre-Execution Boundary Check（WP4-D 执行前边界审查）

> **阶段**：P9 WP4-D Pre-Execution Boundary Check
> **执行日期**：2026-09-21 03:21–03:30 CST
> **性质**：**Boundary Check only（只读审查）**。
> 本轮**未**执行维护窗 / 未冻结写入 / 未做 no-write 验证 / 未执行 mysqldump / 未执行 authoritative snapshot /
> 未停止 1.0 / 未锁表 / 未修改 1.0 / 未修改 nginx / 未修改 DNS·route / 未写 D1 / 未 import schema /
> 未迁移 / 未灰度 / 未 Cutover / 未改 Worker / 未改 MySQL 用户或权限。
> **Git**：审查当时未 commit；本文件随后由独立授权的 Git Closeout 轮提交（commit message `docs(migration): add P9 WP4-D boundary check`）。
> **结论：Boundary decision = `MUST_FREEZE`；Ready for WP4-D Execution = `CONDITIONAL_NO`。**
> **credential 处置**：审查过程采集到的数据库口令已在本文件与会话输出中全部脱敏（`***REDACTED***`），未记录明文。

---

## 1. REPO IDENTITY GATE（只读）

| 项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| branch | master | `master` | ✅ |
| HEAD | `cd1af05` | `cd1af050a7e9569ab035aa6c84da41e5a962d431` | ✅ |
| HEAD == origin/master | YES | `git ls-remote origin master` = `cd1af050…` | ✅ |
| HEAD commit | WP4-C evidence | `cd1af05 docs(migration): record P9 WP4-C execution evidence` | ✅ |
| staged | 0 | `git diff --cached --name-only` = 空（0） | ✅ |
| 并行改动 | 允许存在、不得处理 | `git status --short` = **292** 项，全程未 touched / 未 add / 未 commit | ✅ |
| remote | — | `origin` = `https://github.com/zzz7491/jhzy2018.git` | ✅ |

**REPO_IDENTITY_GATE = PASS。**

---

## 2. BASELINE（已读取）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4C_EXECUTION.md` | **WP4-C Execution = PASS**；fresh T0（`2026-09-21 02:58:53`）已替代旧白天 T0；活动 vhost = `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf`；旧 `/etc/nginx/conf.d/api_jhzyfw_com.conf` **为死文件**；freeze strategy = **B-only（nginx method block）**；no-write = PASS；resume = PASS；Ready for WP4-D = YES；WP4-D entered = NO；Authoritative snapshot = NO；Migration = NO；Cutover = NO |
| `P9_WP4C_EXECUTION_EVIDENCE_20260921_025853.md` | T0 `02:58:53` / T1 freeze `03:00:08` / T2 `03:03:45` / resume `03:04:32`；freeze applied=YES；freeze verification=PASS；no-write=PASS；resume=PASS；dump/backup/snapshot/D1/Worker/DNS/Migration/Cutover/WP4-D 全 = NO |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md` | §4 ENTRY CRITERIA 11 项；#2 freeze applied、#3 no-write PASS 现均已满足；#8 backup target dir 未建；**明确：dump 期间不得解除冻结**；G-1=A（root 捕 routines） |
| `P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md` | U-07=OpenCode 操作员 / U-08·U-09·U-10=ming mo，**全 CONFIRMED**；Recommended = A+B；**G-2 = WAIVED**；residual：Cutover 前须补 off-host copy，否则 ABORT Cutover |

确认结论：

- WP4-C Execution = **PASS**
- Ready for WP4-D Execution = **YES**（定义门层面）
- WP4-D Execution **未授权**
- Authoritative snapshot **未执行**
- residual 已记录：`manage / exam / api2.jhzyfw.com` 未冻结
- **G-2 waiver 仍有效**；Cutover 前必须补 off-host copy，否则 ABORT Cutover

---

## 3. NGINX / ROUTE INVENTORY（只读，`nginx -T` 实测）

主配置 `/www/server/nginx/conf/nginx.conf` 第 **106** 行 `include /www/server/panel/vhost/nginx/*.conf;`
→ 仅该目录为活动 vhost；`/etc/nginx/conf.d/` **不被加载**（历史死目录，堆满 `.bak/.backup`）。生效配置共 **686** 行。

### 3.1 活动入口清单

| # | server_name | 端口 | vhost 文件 | root | PHP 处理 | 备注 |
|---|---|---|---|---|---|---|
| 1 | **api.jhzyfw.com** | 80 / 443 ssl | `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf` | `/www/wwwroot/api.jhzyfw.com` | `location ~ \.php$` → `unix:/tmp/php-cgi-74.sock` | WP4-C 已冻结对象 |
| 2 | **api2.jhzyfw.com** | 80 | `/www/server/panel/vhost/nginx/api2.jhzyfw.com.conf` | `/www/wwwroot/api_jhzyfw_v2` | 同上（php-cgi-74） | **未冻结** |
| 3 | **exam.jhzyfw.com** | 80 / 443 ssl | `/www/server/panel/vhost/nginx/exam.jhzyfw.com.conf` | `/www/wwwroot/api.jhzyfw.com/exam` | 同上（php-cgi-74） | **未冻结**；root 是 api webroot 的**子路径**，但由**独立 server 块**服务 |
| 4 | **manage.jhzyfw.com** | 80(301) / 443 ssl | `/www/server/panel/vhost/nginx/manage.jhzyfw.com.conf` | `/www/wwwroot/manage.jhzyfw.com` | 同上（php-cgi-74） | **未冻结** |
| 5 | **signup.jhzyfw.com** | 80 / 443 ssl + http2 | `/www/server/panel/vhost/nginx/signup.jhzyfw.com.conf` | `/www/wwwroot/signup.jhzyfw.com` | `include enable-php-74.conf` | **未冻结**；**原 residual 清单未包含此入口（新发现）** |
| 6 | `_`（default） | 80 | 主配置 | `/www/server/nginx/html` | — | 与应用无关 |
| 7 | `phpmyadmin` | 80 / 888 | 主配置 | `/www/server/phpmyadmin` | php sock | **DB 管理面，具备写能力**（会话评注，见 §7） |

### 3.2 其它 vhost 文件（存在但当前**未生效**）

- `/www/server/panel/vhost/nginx/` 内：`bt.jhzyfw.com.conf.bak.old`、`jhzyfw.com.conf.bak.before_fix`、`jhzyfw.com.conf.loop`、多个 `new-api.jhzyfw.com.conf.bak*`、`api.jhzyv2.com.conf.bak.*`、`api.jhzyfw.com.conf.bak / .before_cors_fix / .current` —— 均为 `.bak/.old`，未 include；`admin.jhzyfw.com` / `id.jhzyfw.com` / `chat.jhzyfw.com` / `push.jhzyfw.com` **无对应活动 .conf**。
- `extension/*/` 下均为 `site_total.conf.bak(.bak)` —— **已禁用**。
- `proxy/push.jhzyfw.com` —— 未被任何 `include` 引用（死配置）。

### 3.3 exam 的 alias 外挂（同样存在于 exam vhost）

```
location /.well-known/     -> /www/wwwroot/exam.jhzyfw.com/.well-known/
location /cert_new/        -> /www/wwwroot/exam.jhzyfw.com/cert_new/
location /certificates/    -> /www/wwwroot/exam.jhzyfw.com/data/certificates/
location /js/              -> /www/wwwroot/api.jhzyfw.com/exam/js/
```

**Nginx / route inventory = COMPLETE。** 未修改任何 nginx 配置。

---

## 4. WEBROOT / ENTRYPOINT INVENTORY（只读）

| 入口 | webroot | 关键目录 | 是否 PHP 入口 | 与主 webroot 关系 |
|---|---|---|---|---|
| api | `/www/wwwroot/api.jhzyfw.com` | `config/`、`api/`、`lib/`、`v2_api/`、`exam/`、`certificates/`、`uploads/`、`scripts/` | YES（`index.php`、`points.php`、`register.php`→`api/register.php`、`wxlogin.php`） | 生产主入口 |
| api2 | `/www/wwwroot/api_jhzyfw_v2` | 与 api **同结构副本**：`config/`、`api/`、`lib/`、`exam/`… | YES（`index.php`、`points.php`、`register.php`） | **整目录副本**，非符号链接，独立可写 |
| exam | `/www/wwwroot/api.jhzyfw.com/exam` | `admin-api.php`、`api.php`、`certificate_*.php`、`api_certificate_*.php`、`export_records.php`… | YES（20+ 独立 PHP 端点） | **api webroot 子路径**，同时被独立 vhost 服务 |
| manage | `/www/wwwroot/manage.jhzyfw.com` | `includes/config.php`、`api/`、`modules/`、`login.php`、`index.php` | YES | 独立 webroot |
| signup | `/www/wwwroot/signup.jhzyfw.com` | `api.php`、`admin/index.html`、`uploads/` | YES（`api.php`） | 独立 webroot |

另存在同级历史/影子目录（无活动 vhost 指向，但处于同一文件系统）：`api1.jhzyfw.com`、`api-dev.jhzyfw.com`、`new-api.jhzyfw.com`、`admin.jhzyfw.com`、`id.jhzyfw.com`、`exam-system`、`jhzyfw.com`、`test.exam.jhzyfw.com` 等。

**Webroot / entrypoint inventory = COMPLETE。** 未新增/修改任何文件。

---

## 5. DATABASE CONNECTION AUDIT（只读，口令已脱敏）

### 5.1 每个入口的连接目标

| 入口 | 配置文件 | DB_HOST | **DB_NAME** | DB_USER | 写权限（MySQL grants） | Confidence |
|---|---|---|---|---|---|---|
| **api.jhzyfw.com** | `api.jhzyfw.com/config/database.php` | localhost | **`api_jhzyfw_com`** | `api_jhzyfw_com` | `ALL PRIVILEGES ON api_jhzyfw_com.*`（`@localhost` 与 `@%` 均有） | **HIGH**（实测 `SHOW GRANTS`） |
| **api2.jhzyfw.com** | `api_jhzyfw_v2/config/database.php`（同 api 版本，1155B，08-28 更新） | localhost | **`api_jhzyfw_com`** | `api_jhzyfw_com` | 同上 | **HIGH** |
| **manage.jhzyfw.com** | `manage.jhzyfw.com/includes/config.php` | localhost | **`api_jhzyfw_com`** | `api_jhzyfw_com` | 同上 | **HIGH** |
| **exam.jhzyfw.com** | `api.jhzyfw.com/exam/config.php` | localhost | **`api_jhzyfw_com`** | (REDACTED) | 同上 | **HIGH** |
| **signup.jhzyfw.com** | `signup.jhzyfw.com/api.php` | localhost | **`api_jhzyfw_com`** | `api_jhzyfw_com` | 同上 | **HIGH** |
| cron（PHP CLI） | `api.jhzyfw.com/api/db_config.php` | localhost | **`api_jhzyfw_com`** | `api_jhzyfw_com` + mysqli 同库 | 同上 | **HIGH** |

> 注意：**`signup.jhzyfw.com` 名称上像 `signup_db`，实测连接的是 `api_jhzyfw_com`**，不能按域名推断。

### 5.2 字面量统计（每个 webroot 内 `dbname=` 出现次数）

| webroot | `dbname=api_jhzyfw_com` | `dbname=api_jhzyfw_com_dev` | `dbname=api_jhzyfw_com_dev_dev` |
|---|---|---|---|
| `/www/wwwroot/api.jhzyfw.com` | **66** | 1 | 2 |
| `/www/wwwroot/api_jhzyfw_v2` | **66** | 1 | 2 |
| `/www/wwwroot/manage.jhzyfw.com` | 0（用 `DB_NAME` 常量 = `api_jhzyfw_com`） | — | — |
| `/www/wwwroot/signup.jhzyfw.com` | 0（用 `$dbname` 变量 = `api_jhzyfw_com`） | — | — |

（含 `.bak` 文件；`*_dev*` 为开发库字面量，不在本次源库范围）

### 5.3 `signup_db` 归属审查

```
grep -RIl "signup_db" /www/wwwroot  -> （空）
grep -RIn "signup_db" /www/wwwroot  -> （空）
```

**结论：`/www/wwwroot` 全路径无任何代码引用 `signup_db`。**
未发现 `signup_db` 的写入入口。Confidence = **HIGH**（范围内）。
⚠️ Residual：本次 grep 范围为 `/www/wwwroot`；**未扫描** `/opt`、`/root`、`/home` 及可能的 Node/Python 服务目录。若 `signup_db` 由 `/www/wwwroot` 之外的组件写入，本次无法排除（见 §7.4 UNKNOWN 保留项）。

**DB connection audit = COMPLETE。** 未输出任何口令明文；未修改任何配置。

---

## 6. WRITE PATH AUDIT（只读）

### 6.1 nginx 入口侧写入密度

| webroot | INSERT INTO | UPDATE | DELETE FROM | REPLACE | ALTER TABLE | CREATE TABLE | DROP TABLE |
|---|---|---|---|---|---|---|---|
| api.jhzyfw.com | 287 | 272 | 49 | 0 | 212 | 112 | 106 |
| api_jhzyfw_v2（api2） | 287 | 272 | 49 | 0 | 212 | 112 | 106 |
| manage.jhzyfw.com | 3 | 1 | 0 | 0 | 0 | 0 | 0 |
| signup.jhzyfw.com | 2 | 1 | 1 | 0 | 0 | 0 | 0 |

> 统计已排除 `.log/.zip/.bak*/.backup*`；`CREATE/ALTER/DROP` 多来自一次性迁移/修复脚本。
> exam 为 `api.jhzyfw.com` 子目录，其写入已包含在 api 统计中。

### 6.2 具体写入目标（命中两源库 = YES）

| 入口 | 文件 | 写入语句 | 目标表 | affects source DB |
|---|---|---|---|---|
| **manage** | `api/generate_certificate.php:50` | INSERT INTO | `exam_records` | **YES** |
| **manage** | `api/generate_certificate.php:87` | INSERT INTO | `activity_service_certificates` | **YES** |
| **manage** | `api/generate_social_certificate.php:69` | UPDATE | `id_pool`（`status='assigned'`） | **YES** |
| **manage** | `api/generate_social_certificate.php:95` | INSERT INTO | `activity_service_certificates` | **YES** |
| **signup** | `api.php:80` | INSERT INTO | `events` | **YES** |
| **signup** | `api.php:109` | UPDATE | `events` | **YES** |
| **signup** | `api.php:116` | DELETE FROM | `events` | **YES** |
| **signup** | `api.php:145` | INSERT INTO | `participants` | **YES** |
| **exam** | `exam/*.php`（60 处 INSERT） | INSERT INTO | 证书批次 / 考试记录相关 | **YES** |
| **exam** | `exam/*.php` | UPDATE | `id_pool`(3)、`volunteers`(7)、`exam_sessions`(6)、`exam_records`(6)、`question_bank`(4)、`exam_questions`、`exam_certificates(_new)`、`certificate_applications`、`certificates`(2)、`admins`(1) | **YES** |
| **exam** | `exam/*.php`（31 处 DELETE） | DELETE FROM | 证书/考试相关 | **YES** |
| **api2** | `api/my_activities_fixed.php:6` | `new PDO(dbname=api_jhzyfw_com, root, REDACTED)` | 活动/签到相关 | **YES**（且以 `root` 身份建连） |
| **api2** | `api/test_points_insert.php` | SELECT/INSERT | `jhzy_points_records` | **YES** |
| api（已知） | `api/activities.php:6` | `new PDO(dbname=api_jhzyfw_com, root, REDACTED)` | 活动相关 | YES（同样 `root` 建连） |

> ⚠️ 安全旁注：api / api2 中存在以 **`root`** 硬编码建连的 PHP 文件（非本次授权范围，仅记录不处置）。

### 6.3 **非 nginx 写入通道（本次最关键发现）**

以下由 **PHP CLI / cron** 直接执行，**完全不经过 nginx**，因此 **nginx 级写方法冻结对该通道无效**：

| cron | 调度 | 脚本 | DB | 写入语句 | 实测状态 |
|---|---|---|---|---|---|
| root crontab | **`* * * * *`（每分钟）** | `/www/wwwroot/api.jhzyfw.com/api/cron_generate_certs.php` | `api_jhzyfw_com`（经 `api/db_config.php`，`$dbname="api_jhzyfw_com"`） | `INSERT INTO activity_service_certificates`、`UPDATE id_pool`、`UPDATE jhzy_attendance_records` | **运行中**：`cron_cert.log` 时间戳 `03:28`（审查当时刚写入），当前输出 `No pending records.`（**条件触发**：存在 `status=2 且 certificate_id 为空` 的考勤记录即写） |
| root crontab | `*/5 * * * *` | `/www/wwwroot/api.jhzyfw.com/cron_check_location_anomaly.php` | `api_jhzyfw_com`（`require __DIR__.'/api/db_config.php'`） | `UPDATE jhzy_attendance_records`、`UPDATE jhzy_location_monitor` | 运行中但**当前报错**（PDO prepare 异常，22MB 错误日志）→ 暂未成功写入 |
| `/etc/cron.d/jhzy-geofence` | `*/5 * * * *`（重复 3 行） | `api.jhzyfw.com/api/cron/geofence_monitor.php` | — | — | **脚本不存在** → no-op |
| `/etc/cron.d/jhzy-checkout-pattern` | `0 2 * * *` | `api.jhzyfw.com/api/cron/checkout_pattern_monitor.php` | — | — | **脚本不存在** → no-op |
| root crontab | `05 0 * * *` | `api.jhzyfw.com/api/daily_cleanup.php` | `api_jhzyfw_com` | `UPDATE jhzy_attendance_records` | 每日一次，维护窗(02:00–04:00)**内会落到 00:05？不会**（00:05 在窗外） |
| root crontab | `0 0 * * *` | `api.jhzyfw.com/api/daily_force_checkout.php` | `api_jhzyfw_com` | 未检出字面写语句 | 00:00，窗外 |
| root crontab | `*/10 * * * *` | `check_geo_compliance.php` | — | — | **脚本不存在** → no-op |

**源库之外**（不构成本次风险，列出以界定边界）：

- `api1.jhzyfw.com/cron/auto_checkout.php`（`0 0 * * *` 与 `*/5 * * * *`）→ `$dbname = 'jhzy_v2'` → **非 `api_jhzyfw_com` / `signup_db`**，对本次源库无影响。

### 6.4 长驻非 nginx 服务（是否触碰源库）

| 进程 | 路径 | DB 目标探测 | 结论 |
|---|---|---|---|
| `node /www/wwwroot/jhzyfw.com/wx-push/server.js` | jhzyfw.com | 未检出 mysql/PDO 连接 | 未发现 → UNKNOWN（低） |
| `uvicorn app.main:app :8000` | `/www/wwwroot/id.jhzyfw.com/venv` | 命中 `DATABASE_URL="postgres..."` | **PostgreSQL**，与 MySQL 源库无关 → 低风险 |
| `node /www/wwwroot/exam-system/backend/server.js` | exam-system | 未检出 MySQL 源库连接 | UNKNOWN（低） |
| `python3 pdf_compressor.py`（×2） | — | 文件处理 | UNKNOWN（低） |

### 6.5 当前静止度支持观测

```
UPDATE_TIME >= NOW() - INTERVAL 1 HOUR  ->  （空集）
activity_service_certificates rows = 77
id_pool: available=448317 / assigned=1656 / reserved=27
```

→ 近 1 小时两源库无表被写入（与 WP4-C no-write PASS 一致）。
**但这不代表无写入通道**——每分钟 cron 是「条件触发式」写入器，只在有待处理证书任务时才落盘。

**Write path audit = COMPLETE。** 未执行任何写操作。

---

## 7. BOUNDARY DECISION

### 7.1 逐入口判定

| 入口 | 连源库 | 可写 | nginx 冻结覆盖 | 判定 | 依据 |
|---|---|---|---|---|---|
| **manage.jhzyfw.com** | YES（`api_jhzyfw_com`） | **YES**（INSERT `exam_records` / `activity_service_certificates`；UPDATE `id_pool`） | ❌ 未覆盖 | **MUST_FREEZE** | §5.1 + §6.2 |
| **exam.jhzyfw.com** | YES（`api_jhzyfw_com`） | **YES**（60 INSERT / 31 DELETE / UPDATE `id_pool`·`volunteers`·`exam_records`·`certificates`…） | ❌ 未覆盖（独立 server 块）；仅「直接访问 `api.jhzyfw.com/exam/*.php`」路径被 api 冻结部分覆盖 | **MUST_FREEZE** | §3.1 + §6.2 |
| **api2.jhzyfw.com** | YES（`api_jhzyfw_com`） | **YES**（整 webroot 副本，287 INSERT / 272 UPDATE / 49 DELETE；且存在以 `root` 建连） | ❌ 完全未覆盖 | **MUST_FREEZE** | §4 + §5.1 + §6.1 |
| **signup.jhzyfw.com** | YES（`api_jhzyfw_com`） | **YES**（INSERT/UPDATE/DELETE `events`、`participants`） | ❌ 未覆盖（**且不在原 residual 清单内，本次新发现**） | **MUST_FREEZE** | §5.1 + §6.2 |
| **cron（PHP CLI）** | YES（`api_jhzyfw_com`） | **YES**（每分钟 `cron_generate_certs.php`；每 5 分钟 `cron_check_location_anomaly.php`） | ❌ **nginx 层无法覆盖** | **MUST_FREEZE**（须单独停用/禁用，而非 nginx） | §6.3 |
| phpmyadmin | 可达实例 | YES（人工） | ❌ | 建议一并限制 | §3.1 |
| api.jhzyfw.com | YES | YES | ✅ WP4-C 已冻结（已解除） | 已知，非 residual | — |
| api1.jhzyfw.com 相关 cron → `jhzy_v2` | 否（不同库） | — | — | **SAFE（本次范围外）** | §6.3 |

### 7.2 `signup_db` 判定

`/www/wwwroot` 内 **零引用** → 未发现 web/app 写入路径 → **SAFE**。
但因未扫描 `/www/wwwroot` 之外的全部路径（`/opt`、`/root`、容器化/常驻 Node·Python 服务），保留 **UNKNOWN（低概率）** 作为 residual，建议在 WP4-D 前用一次「系统级全盘 grep」或直接依赖 no-write 验证兜底。

### 7.3 总判定

**Boundary decision = `MUST_FREEZE`**

满足判定 B 的条件：
- 任一入口连接并写入 `api_jhzyfw_com` → **成立**（manage / exam / api2 / signup 全部成立）
- 存在后台写入 / 考试提交 / 管理修改 / 日志写入 → **成立**（exam 提交、manage 管理操作、`id_pool` 分配、每分钟 cron 证书生成）

⇒ **Ready for WP4-D Execution = `CONDITIONAL_NO`**，直至冻结覆盖面扩展至 §8 所列全部通道。

### 7.4 residual 更新（替换 WP4-C 记录的版本）

1. `manage.jhzyfw.com` / `exam.jhzyfw.com` / `api2.jhzyfw.com` —— 未冻结且**确认写 `api_jhzyfw_com``**。
2. **新增** `signup.jhzyfw.com` —— 未冻结且**确认写 `api_jhzyfw_com`**（原 residual 清单遗漏）。
3. **新增** PHP CLI cron 通道 —— nginx 冻结**结构性无法覆盖**，须单独处置。
4. `phpmyadmin`（888 端口 TCP）—— DB 管理面写通道，建议纳入。
5. `signup_db` —— 未发现写入路径（SAFE），但 `UNKNOWN` 保留在 `/www/wwwroot` 之外。
6. G-2 = WAIVED 不变：**Cutover 前须补 off-host copy，否则 ABORT Cutover**。

---

## 8. REQUIRED CLOSURE BEFORE WP4-D

进入 WP4-D **Execution** 前，须完成并留证（**本轮不执行，仅登记**）：

| # | 必办项 | 类型 | 完成后如何验证 |
|---|---|---|---|
| C-1 | 冻结 `api.jhzyfw.com`（B 方法块，活动 vhost `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf`） | nginx | POST/PUT/PATCH/DELETE → 503 |
| C-2 | 冻结 `api2.jhzyfw.com`（`/www/server/panel/vhost/nginx/api2.jhzyfw.com.conf`） | nginx | 同上（须带 `Host:` 头实测） |
| C-3 | 冻结 `exam.jhzyfw.com`（`exam.jhzyfw.com.conf`，两个 server 块 80+443） | nginx | 同上 |
| C-4 | 冻结 `manage.jhzyfw.com`（`manage.jhzyfw.com.conf`，443 块） | nginx | 同上 |
| C-5 | 冻结 `signup.jhzyfw.com`（`signup.jhzyfw.com.conf`） | nginx | 同上 |
| C-6 | **停用 php-cli cron**（至少 `cron_generate_certs.php` 与 `cron_check_location_anomaly.php`；建议窗口内注释 root crontab 相关行并备份 crontab） | **非 nginx** | `crontab -l` 无相关行；观察 5 分钟 `cron_cert.log` 无新时间戳 |
| C-7 | 建议一并限制 `phpmyadmin`(888) 与其它可达库的管理面 | nginx/防火墙 | 无法从非信任源访问 |
| C-8 | 冻结后重跑 **fresh T0 → 等待 → T2** no-write 验证，覆盖 `api_jhzyfw_com` + `signup_db` 全部 131 对象 | MySQL 只读 | 五组 hash 全同 + `UPDATE_TIME > T1` 空集 |
| C-9 | 创建 backup target dir `/www/backup/database/p9-wp4d-authoritative/<run_id>/`（WP4-D ENTRY #8 尚未就绪） | 文件系统 | 目录存在且可写 |
| C-10 | G-2 waiver residual risk（Cutover 前须补 off-host copy）写入 WP4-D evidence | 文档 | evidence 含该字段 |

> 冻结块写法注意沿用 WP4-C 实测结论：活动 vhost 目录为 `/www/server/panel/vhost/nginx/`；
> 该 nginx **禁止在 `if` 块内 `add_header`**；冻结块必须显式写 closing `}`。

---

## 9. FINAL GATE

```text
Repo identity confirmed = YES
Baseline read = YES
Nginx / route inventory complete = YES
Webroot / entrypoint inventory complete = YES
DB connection audit complete = YES
Write path audit complete = YES

manage write risk = MUST_FREEZE
exam write risk = MUST_FREEZE
api2.jhzyfw.com write risk = MUST_FREEZE
signup.jhzyfw.com write risk = MUST_FREEZE
php-cli cron write risk = MUST_FREEZE
signup_db web/app write risk = SAFE_WITH_LIMITATION

Boundary decision = MUST_FREEZE
Required closure before WP4-D = C-1..C-10（见 §8）
Ready for WP4-D Execution = CONDITIONAL_NO

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

### 结论

**P9 WP4-D Pre-Execution Boundary Check = COMPLETE（判定 MUST_FREEZE）。
Ready for WP4-D Execution = `CONDITIONAL_NO`，直至 §8 冻结覆盖补足（尤其 C-6 cron 通道）。**

---

## 10. 纪律声明（本轮）

| 项 | 状态 |
|---|---|
| 执行维护窗 / 实际冻结写入 | ❌ 无（边界审查 only） |
| 执行 no-write verification | ❌ 无 |
| 执行 mysqldump / 权威快照 / 生产备份 | ❌ 无 |
| 停止 1.0 / 锁表 / 修改 1.0 代码 | ❌ 无 |
| 修改腾讯云 nginx vhost | ❌ 无（仅 `nginx -T` / `cat` / `ls` 只读） |
| 修改 DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / redeploy | ❌ 无 |
| 修改 MySQL 用户或权限 | ❌ 无（仅 `SHOW GRANTS` 只读） |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git commit / push | 审查轮 ❌ NO（HEAD 仍 `cd1af05`，staged=0，并行改动未 touched）；本文件由后续独立 Git Closeout 轮单独 commit + push（仅此 1 个文件） |
| 口令泄露控制 | ✅ 会话与本文全部 `***REDACTED***` 脱敏 |

**STOP — 未进入 WP4-D Execution，未执行快照，未迁移，未 Cutover。**
是否执行 §8 的 Closure Actions（需在维护窗内回填）或进入 WP4-D，须 **U-08 另行显式授权**。

---

## 引用

- `P9_WP4C_EXECUTION.md`（WP4-C PASS 主文档）
- `P9_WP4C_EXECUTION_EVIDENCE_20260921_025853.md`（WP4-C 执行证据）
- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md`（WP4-D 定义草案 / ENTRY CRITERIA）
- `P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md`（U-07~U-10 / G-2 WAIVED）
