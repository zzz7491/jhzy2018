# P9 WP4-D — Freeze Coverage Closure Definition（冻结覆盖闭合·定义）

> **阶段**：P9 WP4-D Freeze Coverage Closure **Definition**
> **定义日期**：2026-09-21（CST）
> **性质**：**Definition only（只定义 C-1～C-10 的执行方案 / rollback·resume / evidence 模板）**。
> 本轮**不执行** C-1～C-10、**不冻结**任何 vhost、**不停用** cron、**不改** crontab、**不限制** phpMyAdmin、
> **不采集** fresh T0/T2、**不执行** mysqldump、**不生成** authoritative snapshot、不停止 1.0、不锁表、
> 不改 1.0 / nginx / DNS·route / MySQL 用户权限、不写 D1、不 import schema、不迁移、不 Cutover、不改 Worker、
> **不 git commit**（除非另行授权）。
> **结论：Ready for Freeze Coverage Closure Execution = NO（须另行授权执行）；Ready for WP4-D Execution = NO。**

---

## 1. REPO IDENTITY GATE（只读，已执行 2026-09-21 09:42 CST）

| 项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| branch | master | `master` | ✅ |
| HEAD | `f4cbdce` | `f4cbdce5554215455a7e9569ab035aa6c43c701` | ✅ |
| HEAD commit | WP4-D boundary check | `f4cbdce docs(migration): add P9 WP4-D boundary check` | ✅ |
| HEAD == origin/master | YES | `git ls-remote origin master` = `f4cbdce555…` | ✅ |
| staged | 0 | `git diff --cached --name-only` = 空（0） | ✅ |
| 并行改动 | 允许存在、不得处理 | `git status --short` = **292** 项，全程未 touched | ✅ |

**REPO_IDENTITY_GATE = PASS。**

---

## 2. BASELINE（已读取，禁止凭记忆重定义）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md` | Boundary decision = **MUST_FREEZE**；Ready for WP4-D = **CONDITIONAL_NO**；manage / exam / api2 / signup = **MUST_FREEZE**；php-cli cron = **MUST_FREEZE**（`cron_generate_certs.php` 每分钟，nginx 结构性无法覆盖）；signup_db web/app = **SAFE_WITH_LIMITATION**（`/www/wwwroot` 零引用，`/www/wwwroot` 之外 UNKNOWN）；C-1～C-10 已登记未执行 |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md` | ENTRY CRITERIA 11 项；**#8 backup target dir 未建**；run_id = `wp4d_authoritative_<YYYYMMDD_HHMMSS>`；目录 `/www/backup/database/p9-wp4d-authoritative/<run_id>/`；12 项产物；**dump 期间不得解除冻结**；G-1=A（root 捕 routines） |
| `P9_WP4C_EXECUTION.md` | WP4-C Execution = PASS；活动 vhost 目录 = `/www/server/panel/vhost/nginx/`（`/etc/nginx/conf.d/` 为死目录）；freeze strategy = **B-only**；no-write = PASS；resume = PASS |
| `P9_WP4C_EXECUTION_EVIDENCE_20260921_025853.md` | T0 `02:58:53` / T1 `03:00:08` / T2 `03:03:45` / resume `03:04:32`；五组 hash 比对法已实证 |
| `P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md` | U-07=OpenCode 操作员 / U-08·U-09·U-10=ming mo，全 CONFIRMED；**G-2 = WAIVED**（Cutover 前须补 off-host copy，否则 ABORT Cutover） |

**基线确认**：WP4-D authoritative snapshot **不得执行**；C-1～C-10 **必须先定义（本轮）、再另行授权执行**。

---

## 3. FREEZE COVERAGE SCOPE（冻结覆盖总范围）

### 3.1 Web / vhost 通道

| # | 入口 | 活动 vhost 文件 | root | 判定 |
|---|---|---|---|---|
| C-1 | `api.jhzyfw.com` | `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf` | `/www/wwwroot/api.jhzyfw.com` | MUST_FREEZE |
| C-2 | `api2.jhzyfw.com` | `/www/server/panel/vhost/nginx/api2.jhzyfw.com.conf` | `/www/wwwroot/api_jhzyfw_v2` | MUST_FREEZE |
| C-3 | `exam.jhzyfw.com` | `/www/server/panel/vhost/nginx/exam.jhzyfw.com.conf` | `/www/wwwroot/api.jhzyfw.com/exam` | MUST_FREEZE |
| C-4 | `manage.jhzyfw.com` | `/www/server/panel/vhost/nginx/manage.jhzyfw.com.conf` | `/www/wwwroot/manage.jhzyfw.com` | MUST_FREEZE |
| C-5 | `signup.jhzyfw.com` | `/www/server/panel/vhost/nginx/signup.jhzyfw.com.conf` | `/www/wwwroot/signup.jhzyfw.com` | MUST_FREEZE |

> **五个入口全部连 `api_jhzyfw_com`，DB 账号 `api_jhzyfw_com` 对源库有 `ALL PRIVILEGES`（@localhost 与 @%）**——
> 任一入口漏冻结 = 快照窗口内存在有效写入通道。

### 3.2 非 nginx 通道

| # | 通道 | 判定 | 覆盖手段 |
|---|---|---|---|
| C-6 | PHP CLI cron（`cron_generate_certs.php` 每分钟写源库） | MUST_FREEZE | **crontab 注释**（nginx 无法覆盖） |
| C-7 | phpMyAdmin / 888（DB 管理面） | MUST_FREEZE（建议） | 端口来源限制 / 人工确认 |
| C-8 | 冻结后 fresh T0 → wait → T2 no-write 验证 | 必做 | MySQL 只读 + 五组 hash |
| C-9 | WP4-D authoritative snapshot 目录就绪 | 必做 | mkdir only，**不 dump** |
| C-10 | G-2 waiver residual 写入 evidence | 必做 | 文档 |

### 3.3 明确排除（不冻结、不改）

- **不**使用 MySQL `global read_only` / `FLUSH TABLES WITH READ LOCK`（WP4-C 定义已排除；锁表会影响只读业务且回滚面大）。
- **不**修改任何业务代码（1.0 / api / manage / exam / signup 的 PHP 源码）。
- **不**修改 MySQL 用户或权限。
- **不**改 DNS / route / Worker / D1。
- **不**长期保留冻结块：冻结时长上限 = WP4-D dump 完成即刻解除；硬上限 **≤2h**（与维护窗一致）。

### 3.4 执行轮预检（PRE-FLIGHT，必须先确认再动手）

| # | 预检项 | 为什么 |
|---|---|---|
| P-1 | 每个 vhost 文件内**实际 server 块数量**与端口（80 / 443） | 冻结必须逐 server 块插入，漏块 = 漏冻结 |
| P-2 | 冻结插入点之前是否已有 `return` / `rewrite`（尤其 manage 80 块的 `return 301`） | 若已存在，冻结块须移到其**之前**，否则 301 先命中、503 不生效 |
| P-3 | 888 / phpMyAdmin 的实际提供者（aaPanel 内置服务 vs 主 nginx server 块） | 决定 C-7 选 A 还是 B |
| P-4 | `crontab -l` 实际行（含 `/etc/cron.d/`）与源库相关性 | 决定 C-6 注释清单 |
| P-5 | 各入口 pre-freeze 响应矩阵（GET/HEAD/POST/PUT/PATCH/DELETE 状态码） | 冻结后必须能区分「app 自身 404」与「冻结 503」 |

---

## 4. C-1～C-5 VHOST FREEZE PLAN

### 4.0 通用冻结块（沿用 WP4-C 实证版本）

```nginx
    # === P9 WP4-D WRITE FREEZE START (removable) ===
    if ($request_method !~ ^(GET|HEAD)$) {
        return 503 '{"code":503,"msg":"系统维护中，写操作暂暂停"}';
    }
    # === P9 WP4-D WRITE FREEZE END ===
```

**三条硬约束（WP4-C 实测踩坑，必须遵守）**：

1. 该 nginx **禁止在 `if` 块内使用 `add_header`**（`nginx -t` 报 `add_header directive is not allowed here`）→ 块内**不得**出现 `add_header`。
2. 块**必须显式写 closing `}`**——漏写会把其后的 `root` / `location` 吞进未闭合 `if`，`nginx -t` 报 `"root" directive is not allowed here`。
3. 插入点 = **server 块内 `server_name` 行之后**；如该块内在插入点前有 `return` / `rewrite`，须把冻结块移到这些指令**之前**（见 P-2）。

**逐 server 块插入**：一个 vhost 文件若含 80 与 443 两个 server 块，**两个块都要插**；只插 80 = 443 侧写请求完全绕过冻结。

### 4.1 通用执行 / 验证 / 回滚规则

| 环节 | 规则 |
|---|---|
| 备份 | `cp <vhost> <vhost>.wp4d_bak_<YYYYMMDD_HHMMSS>`（每个文件单独备份，改前必做） |
| 插入 | 用 python3 按 `server_name` 行定位插入，带 START/END marker，便于精确移除 |
| 校验 | `nginx -t`；**失败 → 恢复该文件备份 → 重新 `nginx -t` → ABORT** |
| 生效 | 全部 5 个 vhost 改完后**统一执行一次** `nginx -s reload`（避免多次 reload） |
| 回滚（首选） | 删除 `START`→`END`（含标记行）之间全部行 → `nginx -t` → reload |
| 回滚（兜底） | `cp <vhost>.wp4d_bak_<ts> <vhost>` → `nginx -t` → reload |
| 验证回滚完整性 | `diff -q <vhost> <vhost>.wp4d_bak_<ts>` 须 IDENTICAL；`nginx -T \| grep -c "WRITE FREEZE"` 须 = 0 |

**验证命令（必须带 `Host:` 头，直连 127.0.0.1 不带 Host 会打到 default server，返回误导性 404）**：

```bash
# 80 块
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Host: <server_name>" http://127.0.0.1/
# 443 块（必须单独测，不能只测 80）
curl -sk --resolve <server_name>:443:127.0.0.1 \
     -o /dev/null -w "%{http_code}\n" -X POST https://<server_name>/
```

### 4.2 逐入口定义

#### C-1 `api.jhzyfw.com`

| 项 | 值 |
|---|---|
| active vhost file | `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf` |
| server_name / 端口 | `api.jhzyfw.com` — 80 **+ 443 ssl**（两个 server 块，都要插） |
| root | `/www/wwwroot/api.jhzyfw.com` |
| PHP 处理 | `location ~ \.php$ {` → `unix:/tmp/php-cgi-74.sock` |
| freeze method | §4.0 块，插入两个 server 块 |
| verification | 80 与 443 各跑 GET/HEAD/POST/PUT/PATCH/DELETE 矩阵 |
| rollback | §4.1 |
| expected pre-freeze response | **执行轮先采基线**：根路径历史上为 `404`（app 自身行为）；写方法为 app 自身响应 |
| expected frozen write response | POST/PUT/PATCH/DELETE → **503** + `{"code":503,"msg":"系统维护中，写操作暂暂停"}` |
| expected resumed response | 与 pre-freeze 基线**逐项一致** |

#### C-2 `api2.jhzyfw.com`

| 项 | 值 |
|---|---|
| active vhost file | `/www/server/panel/vhost/nginx/api2.jhzyfw.com.conf` |
| server_name / 端口 | `api2.jhzyfw.com` — **仅 80**（1 个 server 块） |
| root | `/www/wwwroot/api_jhzyfw_v2`（api webroot 的**整目录副本**，非软链，独立可写） |
| freeze method / verification / rollback | 同 §4.0 / §4.1 |
| expected pre-freeze response | 执行轮先采基线 |
| expected frozen write response | 503 + 维护 JSON |
| expected resumed response | = pre-freeze 基线 |

#### C-3 `exam.jhzyfw.com`

| 项 | 值 |
|---|---|
| active vhost file | `/www/server/panel/vhost/nginx/exam.jhzyfw.com.conf` |
| server_name / 端口 | `exam.jhzyfw.com` — 80 **+ 443 ssl**（两个 server 块，都要插） |
| root | `/www/wwwroot/api.jhzyfw.com/exam`（api webroot 子路径，但由**独立 server 块**服务） |
| 备注 | 该文件另有 `/.well-known/`、`/cert_new/`、`/certificates/`、`/js/` alias；server 级 `if` 对所有 location 生效，无需额外处理 |
| freeze method / verification / rollback | 同 §4.0 / §4.1 |
| expected frozen write response | 503 + 维护 JSON |
| expected resumed response | = pre-freeze 基线 |

#### C-4 `manage.jhzyfw.com`

| 项 | 值 |
|---|---|
| active vhost file | `/www/server/panel/vhost/nginx/manage.jhzyfw.com.conf` |
| server_name / 端口 | `manage.jhzyfw.com` — **80 = `return 301` 跳 https** / **443 ssl**（两个 server 块，都要插） |
| root | `/www/wwwroot/manage.jhzyfw.com` |
| ⚠️ 特别注意 | 80 块内存在 `return 301` → 冻结块**必须插在 `return 301` 之前**，否则 301 先命中、503 不生效（见 P-2） |
| 写入实际路径 | 管理端写操作走 **443**；443 块必须单独用 `--resolve` 实测，80 块即使测通也不代表 443 已冻结 |
| freeze method / verification / rollback | 同 §4.0 / §4.1 |
| expected frozen write response | 443 侧 POST/PUT/PATCH/DELETE → 503 + 维护 JSON（80 侧 GET 仍应 301） |
| expected resumed response | = pre-freeze 基线（含 80 侧 301） |

#### C-5 `signup.jhzyfw.com`

| 项 | 值 |
|---|---|
| active vhost file | `/www/server/panel/vhost/nginx/signup.jhzyfw.com.conf` |
| server_name / 端口 | `signup.jhzyfw.com` — 80 **+ 443 ssl + http2**（两个 server 块，都要插） |
| root | `/www/wwwroot/signup.jhzyfw.com` |
| PHP 处理 | `include enable-php-74.conf`（与其余入口的 `location ~ \.php$` 写法不同，但 server 级 `if` 同样生效） |
| ⚠️ 命名陷阱 | 名字像 `signup_db`，**实测连的是 `api_jhzyfw_com`**（写 `events` / `participants`）→ 必须冻结，不得按域名推断放过 |
| freeze method / verification / rollback | 同 §4.0 / §4.1 |
| expected frozen write response | 503 + 维护 JSON |
| expected resumed response | = pre-freeze 基线 |

### 4.3 冻结验证矩阵（5 入口 × 6 方法 × 2 端口）

| 方法 | 期望（冻结后） |
|---|---|
| GET | 与 pre-freeze 基线一致（**不得**变 503） |
| HEAD | 与 pre-freeze 基线一致（**不得**变 503） |
| POST | **503** |
| PUT | **503** |
| PATCH | **503** |
| DELETE | **503** |

> 任一入口的任一写方法未返回 503 → 该 C-x = FAIL → 走 §11 ABORT（恢复全部、不留冻结）。

---

## 5. C-6 PHP CLI CRON FREEZE PLAN

### 5.1 为什么必须单独处置

`cron_generate_certs.php` 以 **PHP CLI** 方式执行，**完全不经过 nginx**——任何 nginx 层写方法冻结对它无效。
它是「条件触发式」写入器（存在 `status=2 且 certificate_id 为空` 的考勤记录即写），平峰期日志恒为 `No pending records.`，
**因此「当前没写」不等于「没有通道」**；WP4-D 的 dump 窗口更长，一旦触发即污染快照，且 `--single-transaction` 无法补救。

### 5.2 备份（改前必做）

```bash
TS=$(date +%Y%m%d_%H%M%S)
crontab -l > /root/crontab.wp4d.freeze.${TS}.bak
cp -a /var/spool/cron/root /root/crontab.wp4d.freeze.${TS}.spool.bak   # 原始文件兜底
# 同时备份 /etc/cron.d/ 下相关文件
ls -la /root/crontab.wp4d.freeze.${TS}.bak    # 留证：文件存在且非空
```

### 5.3 必须注释（源库写入相关）

| cron 行含 | 调度 | 与源库关系 | 处置 |
|---|---|---|---|
| `cron_generate_certs.php` | `* * * * *`（每分钟） | 直写 `api_jhzyfw_com`（`INSERT activity_service_certificates` / `UPDATE id_pool` / `UPDATE jhzy_attendance_records`） | **必须注释** |
| `cron_check_location_anomaly.php` | `*/5 * * * *` | 同源库（`UPDATE jhzy_attendance_records` / `jhzy_location_monitor`；当前 PDO 报错未成功写入） | **必须注释**（不得以「当前报错」为由放过） |
| `daily_cleanup.php` | `05 0 * * *` | 同源库（`UPDATE jhzy_attendance_records`），调度在窗外但**仍属源库写入** | **必须注释**（防御性：执行窗可能变更） |
| `daily_force_checkout.php` | `0 0 * * *` | 同源库；字面写语句未检出但语义为强制签退 | **必须注释**（防御性） |

### 5.4 检查后记录为 excluded（不处理）

| cron 行含 | 判定 | 依据 |
|---|---|---|
| `geofence_monitor` / `checkout_pattern_monitor` / `check_geo_compliance` | **no-op**（脚本不存在） | 边界审查实测；执行轮须复验脚本仍不存在 |
| `auto_checkout.php`（`api1.jhzyfw.com`） | **excluded** | 连 `jhzy_v2`，非 `api_jhzyfw_com` / `signup_db` |

### 5.5 修改方式

- 仅**注释**（行首加 `# WP4D-FREEZE `），**不删行**——保证可逆、可 diff。
- 同时处理 root crontab **与** `/etc/cron.d/` 下匹配文件（各自备份）。
- 改完必须 `crontab -l` 留证：相关行均以 `# WP4D-FREEZE ` 开头。

### 5.6 验证

| # | 验证 | PASS 标准 |
|---|---|---|
| V-1 | `crontab -l` | 5.3 全部行已注释；5.4 excluded 行未被改动 |
| V-2 | `stat -c %y /www/wwwroot/api.jhzyfw.com/api/cron_cert.log` | **观察 ≥5 分钟**，mtime 未推进（冻结前先记 baseline mtime） |
| V-3 | `ps -eo pid,etime,cmd \| grep -E "cron_generate_certs\|cron_check_location_anomaly"` | 无新增常驻/新起进程（冻结前已存在的须等其退出） |

**任一不满足 → C-6 = FAIL。**
补充兜底：`cron_check_location_anomaly` 的错误日志增长**不**直接等同 DB 写入，该通道的最终判定交由 **C-8 五组 hash** 兜底。

### 5.7 恢复

```bash
crontab /root/crontab.wp4d.freeze.${TS}.bak     # 或用 .spool.bak 覆盖 /var/spool/cron/root
crontab -l                                       # 确认 5.3 各行恢复存在、无 # WP4D-FREEZE 前缀
date "+RESUME_CRON=%Y-%m-%d %H:%M:%S CST"        # 记录 resume timestamp
```

---

## 6. C-7 PHPMYADMIN / 888 FREEZE PLAN

### 6.1 方法选择（执行轮按序尝试，第一个可行者即 chosen）

| 序 | 方法 | 说明 | 回滚 |
|---|---|---|---|
| **A（首选）** | 临时限制 888 端口来源 | 仅允许 `127.0.0.1` / 运维可信源；firewalld rich rule 或 iptables。**改前须 `iptables-save > /root/iptables.wp4d.<ts>.bak`** | 删除该规则（或 `iptables-restore < 备份`） |
| **B（次选）** | nginx / aaPanel 访问限制 | **仅当** P-3 确认 888 由主 nginx 提供时可用：在对应 server 块加 `allow/deny`。改主 `nginx.conf` 风险较高 → 须先备份 + `nginx -t` | 恢复备份 + reload |
| **C（降级，须书面确认）** | 人工确认维护窗内无人使用 | 仅当 A/B 均不可行时；须 **U-08 书面确认**并写入 evidence。属**人工控制**而非技术控制，须在 residual 中明示 | 无需回滚，记录恢复时间 |
| **D** | 停止入口 | **排除**（aaPanel 面板可用性依赖，影响面大于收益）；仅在 U-08 显式批准时方可考虑 | — |

### 6.2 验证 / 回滚 / residual

| 项 | 定义 |
|---|---|
| verification（A/B） | 从非信任源 `curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://<host>:888/` → 拒绝或超时；从 `127.0.0.1` 仍可达（确认未误伤面板自身） |
| verification（C） | evidence 中记录 U-08 书面确认（含时间、内容、确认人） |
| rollback（A） | 删除临时规则 → 复测可达 |
| rollback（B） | 恢复 nginx 备份 → `nginx -t` → reload |
| **residual risk** | ① A/B 仅限制来源，**同机 root 或本地进程经 socket 仍可写库**（含已知的 `root` 硬编码建连 PHP）→ 由「窗内无人操作 + C-8 hash 验证」兜底；② C 为人工控制，无技术阻断力 |
| **FAIL 判定** | A/B 均不可行 **且** 未取得 U-08 书面确认 → **C-7 = FAIL → WP4-D 不得执行** |

---

## 7. C-8 FULL NO-WRITE VERIFICATION PLAN

> 必须在 **C-1～C-7 全部完成并验证通过之后**执行。

### 7.1 时间标记

| 标记 | 定义 |
|---|---|
| **T1** | **全通道冻结完成时间戳**（C-1～C-5 验证通过 + C-6 已注释 + C-7 已限制，三项齐备的时刻） |
| **T0** | T1 之后的 fresh 基线采集（**不得**复用白天或 WP4-C 旧基线） |
| **wait** | ≥ **120 秒**（硬下限；**推荐 300 秒**——分钟级 cron 至少覆盖 5 个周期，证据更强） |
| **T2** | 等待结束后的复采 |

### 7.2 采集对象

`api_jhzyfw_com` + `signup_db` 全部 **131 个源对象**（api_jhzyfw_com 128 = 127 表 + 1 视图；signup_db 3 表）。

### 7.3 五组 hash + 一项查询

| # | 指标 | 说明 |
|---|---|---|
| H-1 | inventory hash | `schema|table_name` 清单 |
| H-2 | row count hash | `information_schema.TABLE_ROWS` |
| H-3 | baseline hash | 完整行 `schema|table|UPDATE_TIME|TABLE_ROWS` |
| H-4 | **exact COUNT(\*) hash** | 逐表精确 `COUNT(*)`（131 表） |
| H-5 | active timestamp hash | 逐表 `MAX(updated_at, created_at)`（历史实测 109 表含时间戳列） |
| Q-1 | `UPDATE_TIME > T1` | 须返回**空集** |

### 7.4 PASS 条件（全部满足）

- [ ] H-1～H-5 全部 T0 == T2；
- [ ] Q-1 空集；
- [ ] T0/T2 三份基线文件 `diff` 结果 IDENTICAL；
- [ ] 无关键表 `updated_at/created_at > T1`；
- [ ] 无新增 / 减少记录；
- [ ] `cron_cert.log` 在窗口内无新时间戳（C-6 有效）；
- [ ] 所有冻结入口（5 入口 × 2 端口）写请求返回 **503**；
- [ ] phpMyAdmin 限制有效（或已取得 U-08 书面确认）。

### 7.5 FAIL 条件（任一触发 → ABORT）

- 任一写入通道仍可写（写方法未返回 503）；
- H-1～H-5 任一变化；
- `cron_cert.log` 时间戳推进；
- crontab 未正确暂停；
- phpMyAdmin 无法限制且无法确认无人使用；
- `nginx -t` 失败或 reload 失败。

---

## 8. C-9 WP4-D DIRECTORY READINESS PLAN（只准备目录，不 dump）

| 项 | 定义 |
|---|---|
| 目录 | `/www/backup/database/p9-wp4d-authoritative/<run_id>/` |
| **run_id 格式** | `wp4d_authoritative_<YYYYMMDD_HHMMSS>`（沿用 WP4-D Definition §5，例 `wp4d_authoritative_20260921_020500`） |
| 子目录 | `<run_id>/dump_errors/`（每个 dump 命令的 stderr） |
| mkdir 权限 | `root:root`，目录 `0700`（隔离；快照含生产数据，不得 world-readable） |
| disk space check | `df -h /www` → 可用空间须 **≥ 2× 预估产物体积**（源约 131MB，实测可用 21G，远超阈值）；< 2× → ABORT |
| **expected artifacts（12 项，仅登记不生成）** | `api_jhzyfw_com.schema.sql.gz`、`api_jhzyfw_com.data.sql.gz`、`api_jhzyfw_com.routines.sql.gz`、`signup_db.schema.sql.gz`、`signup_db.data.sql.gz`、`sha256_manifest.txt`、`snapshot_manifest.json`、`row_counts_before.json`、`table_inventory.json`、`gzip_check.log`、`dump_errors/*.err`、`evidence.json` |
| **no overwrite rule** | 若 `<run_id>` 目录**已存在 → ABORT**，禁止复用 / 覆盖既有 run；禁止写入任何其它 run 目录 |
| evidence path | 本地 `docs/production-audit/P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_<YYYYMMDD_HHMMSS>.md` |
| **abort rule** | mkdir 失败 / 磁盘不足 / 目录已存在 / 权限设置失败 → **ABORT**（恢复全部冻结） |
| **硬边界** | C-9 **只建目录 + 记录就绪状态**；**不执行 mysqldump、不生成任何 .sql.gz、不生成 authoritative snapshot** |

---

## 9. C-10 G-2 WAIVER RESIDUAL EVIDENCE PLAN

必须写入 evidence 的字段：

| 字段 | 值 |
|---|---|
| G-2 status | **WAIVED** |
| waiver approver | **ming mo**（U-08） |
| reason | NAS down / 本轮无可用的异地（off-host）目标 |
| **residual risk** | authoritative snapshot **初始仅存在于腾讯云宿主本地**，未形成异地副本 |
| compensating controls | ① gzip 完整性校验（`gzip -t` 全 OK）；② sha256 manifest 覆盖全部产物；③ 本地隔离路径 `0700`；④ **Cutover 前必须重试 off-host copy**；⑤ **若 Cutover 前无法完成 off-host copy → ABORT Cutover** |
| expiry condition | **在 Cutover 之前失效**，除非 off-host copy 成功完成 |

> 该字段缺失 = WP4-D Definition §7 FAIL 条件之一 → `migration_input = NO`。

---

## 10. EXECUTION ORDER（执行顺序）

| # | 步骤 | 产出/判定 |
|---|---|---|
| 1 | Repo identity gate + 维护窗校核 | 不在窗内 → STOP，不冻结 |
| 2 | **备份全部目标 vhost（5 个）+ root crontab + `/etc/cron.d/` 相关文件 + iptables** | 备份路径留证；任一备份失败 → STOP |
| 3 | 采集 **pre-freeze 响应矩阵**（5 入口 × 6 方法 × 2 端口） | baseline 留证（用于区分 app 404 与冻结 503） |
| 4 | Apply C-1～C-5 vhost freeze（逐 server 块插入） | START/END marker 就位 |
| 5 | `nginx -t` | 失败 → 恢复全部 vhost 备份 → reload → ABORT |
| 6 | `nginx -s reload`（**统一一次**） | 记录 T_freeze_reload |
| 7 | Verify all frozen vhosts（§4.3 矩阵） | 任一写方法非 503 → ABORT |
| 8 | Apply C-6 cron freeze（注释 + 备份） | `crontab -l` 留证 |
| 9 | Verify cron freeze（≥5 分钟观察） | 日志时间戳推进 → ABORT |
| 10 | Apply C-7 phpMyAdmin restriction | A → B → C 顺序 |
| 11 | Verify phpMyAdmin restriction | A/B 拒绝或 C 书面确认；否则 ABORT |
| 12 | **记录 T1**（全通道冻结完成） | — |
| 13 | Capture fresh **T0** | 五组 hash |
| 14 | Wait ≥120s（推荐 300s） | — |
| 15 | Capture **T2** | 五组 hash |
| 16 | Run C-8 no-write verification | PASS 方可继续；否则 ABORT |
| 17 | Prepare C-9 WP4-D directory（mkdir only） | 目录就绪 |
| 18 | Record C-10 G-2 waiver residual | evidence 字段齐备 |
| 19 | Final gate | — |
| 20 | **STOP before WP4-D authoritative snapshot** | **不执行 dump、不生成快照** |

---

## 11. ABORT / RESUME RULES

### 11.1 ABORT 触发（任一 → 恢复全部并 ABORT）

| 触发 | 动作 |
|---|---|
| `nginx -t` 失败 | 恢复全部 vhost 备份 → reload → ABORT（reason=`nginx-t-fail`） |
| 任一冻结入口仍接受写请求 | 恢复全部 → ABORT（reason=`freeze-not-effective-<entry>`） |
| crontab 编辑失败 | 恢复 crontab 备份 → 恢复全部 vhost → ABORT |
| cron 仍在写入（日志时间戳推进） | 恢复全部 → ABORT（reason=`cron-still-writing`） |
| phpMyAdmin 限制失败且无书面确认 | 恢复全部 → ABORT（reason=`pma-unrestricted`） |
| T0/T2 五组 hash 任一不一致 | 恢复全部 → ABORT（reason=`no-write-fail`） |
| C-9 目录准备失败 | 恢复全部 → ABORT（reason=`dir-not-ready`） |
| **任何不确定** | **ABORT**（不得带疑点前进） |

### 11.2 RESUME（恢复步骤，ABORT 与正常结束都须执行）

1. 移除全部冻结块（删 `START`→`END` 含标记行）；异常时用备份 `cp` 覆盖；
2. 恢复 root crontab（`crontab /root/crontab.wp4d.freeze.<ts>.bak`）→ `crontab -l` 确认行已恢复；
3. 撤销 phpMyAdmin 限制（删除 iptables 规则 / 恢复 nginx 备份）；
4. `nginx -t`；
5. `nginx -s reload`；
6. 验证：5 入口响应矩阵 == pre-freeze baseline；写方法不再返回 503；
7. `nginx -T | grep -c "WRITE FREEZE"` 须 = **0**；
8. `diff -q <vhost> <vhost>.wp4d_bak_<ts>` 须 IDENTICAL；
9. 记录 `resume_timestamp`。

> **系统必须在轮次结束时处于未冻结状态**（PASS 已 resume，ABORT 已恢复）。

---

## 12. EVIDENCE TEMPLATE（未来执行轮）

**文件名**：
```text
docs/production-audit/P9_WP4D_FREEZE_COVERAGE_CLOSURE_EVIDENCE_<YYYYMMDD_HHMMSS>.md
```

**必须记录字段**：

| # | 字段 |
|---|---|
| 1 | `maintenance_window_id` |
| 2 | `operator`（U-07）/ `approver`（U-08） |
| 3 | C-1～C-10 各自 status（PASS / FAIL / SKIPPED + reason） |
| 4 | all vhost files（5 个活动 vhost 路径 + 实际插入的 server 块数） |
| 5 | vhost backup paths（5 个 `<vhost>.wp4d_bak_<ts>`） |
| 6 | crontab backup path（`/root/crontab.wp4d.freeze.<ts>.bak` + `.spool.bak`） |
| 7 | phpMyAdmin restriction method（A / B / C + 验证结果） |
| 8 | pre-freeze 响应矩阵 + frozen 响应矩阵 + resumed 响应矩阵 |
| 9 | T0 / T1 / T2 timestamps |
| 10 | all hash values（H-1～H-5，T0 与 T2 各一组） |
| 11 | `UPDATE_TIME > T1` 查询结果 |
| 12 | cron log verification（baseline mtime / 观察时长 / 结果） |
| 13 | freeze verification matrix（5 入口 × 6 方法 × 2 端口） |
| 14 | resume verification（含 `nginx -T` marker 计数 = 0、`diff -q` IDENTICAL） |
| 15 | C-9 run_id + 目录路径 + 磁盘检查 + 就绪状态 |
| 16 | G-2 waiver residual（§9 全部字段） |
| 17 | final decision + `Ready for WP4-D Execution = YES / NO` |

---

## 13. FINAL GATE（P9 WP4-D Freeze Coverage Closure Definition）

```text
Repo identity confirmed = YES
Baseline read = YES
Freeze coverage scope defined = YES
C-1 api.jhzyfw.com plan = YES
C-2 api2.jhzyfw.com plan = YES
C-3 exam.jhzyfw.com plan = YES
C-4 manage plan = YES
C-5 signup.jhzyfw.com plan = YES
C-6 php-cli cron plan = YES
C-7 phpMyAdmin plan = YES
C-8 full no-write verification plan = YES
C-9 WP4-D directory readiness plan = YES
C-10 G-2 residual evidence plan = YES
Execution order defined = YES
Abort/resume rules defined = YES
Evidence template defined = YES
Document created = YES

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

P9 WP4-D Freeze Coverage Closure Definition = PASS
Ready for Freeze Coverage Closure Execution = NO
Ready for WP4-D Execution = NO
```

### 结论

**定义已完成，但执行闸门仍关闭。**
C-1～C-10 须 **U-08 另行显式授权**方可执行；执行完成后 `Ready for WP4-D Execution` 才可能转为 YES，
且仍受 G-2 residual（Cutover 前须补 off-host copy，否则 ABORT Cutover）约束。

---

## 14. 纪律声明（本轮 Definition only）

| 项 | 状态 |
|---|---|
| 执行 C-1～C-10 | ❌ 无（仅定义） |
| 冻结任何 vhost / 修改 nginx | ❌ 无 |
| 停用 cron / 修改 crontab | ❌ 无 |
| 限制 phpMyAdmin | ❌ 无 |
| 采集 fresh T0/T2 / 执行 no-write 验证 | ❌ 无 |
| 执行 mysqldump / authoritative snapshot / 生产备份 | ❌ 无 |
| 停止 1.0 / 锁表 / 修改 1.0 代码 | ❌ 无 |
| 修改 DNS / route / MySQL 用户权限 / Worker / D1 | ❌ 无 |
| 迁移 / Cutover / import schema | ❌ 无 |
| 生产数据 / schema 修改 | ❌ **NO** |
| Git commit / push | ❌ **NO**（HEAD 仍 `f4cbdce`，staged=0，292 项并行改动未 touched） |
| 远程只读探测（SSH `nginx -T` / `crontab -l` 等） | ❌ **无**（本轮未对生产宿主发起任何连接，定义全部基于已归档的边界审查证据） |

**STOP — 未执行 C-1～C-10，未冻结，未快照，未迁移，未 Cutover。**
是否进入 Freeze Coverage Closure **Execution**，须 **U-08 另行显式授权**。

---

## 引用

- `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md`（MUST_FREEZE 判定 / 5 入口 / cron 通道 / C-1～C-10 登记）
- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md`（ENTRY CRITERIA 11 项 / run_id / 目录 / 12 产物 / G-1=A / G-2）
- `P9_WP4C_EXECUTION.md` + `P9_WP4C_EXECUTION_EVIDENCE_20260921_025853.md`（冻结块实证 / 死 vhost 路径 / 五组 hash 法）
- `P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md`（U-07～U-10 / G-2 WAIVED）
