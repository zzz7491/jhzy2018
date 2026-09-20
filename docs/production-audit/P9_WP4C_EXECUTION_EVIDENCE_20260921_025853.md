# P9 WP4-C — Execution Evidence（写入冻结 + No-Write 验证 执行证据）

> **阶段**：P9 WP4-C（Maintenance Window / Write Freeze **执行轮**）
> **maintenance_window_id**：`wp4c-mw-20260921`
> **执行日期**：2026-09-21（CST）
> **性质**：在批准维护窗内执行「fresh T0 → 应用写入冻结 → 120s 等待 → T2 → no-write 验证 → 解除冻结」；
> **不进 WP4-D（AUTHORITATIVE_SNAPSHOT）**、不执行 mysqldump、不抓取/拷贝生产备份、不迁库、不写 D1、不改 Worker、不改 DNS/route、不改 MySQL 用户与权限、不 git commit/push。

---

## 1. 窗口与授权

| 项 | 值 |
|---|---|
| maintenance_window_id | `wp4c-mw-20260921` |
| window approved | **YES**（02:00–04:00 CST，≤2h，MG-12） |
| 窗口校核时间 | 生产宿主 `2026-09-21 02:54:52 CST`（落在窗口内 ✅） |
| U-07 Operator | OpenCode 执行助手操作者 — **CONFIRMED** |
| U-08 Approver / U-09 Abort / U-10 Rollback | ming mo — **CONFIRMED** |
| G-2 off-host | **WAIVED**（U-08 书面 waiver；Cutover 前须补 off-host copy，否则 ABORT Cutover） |
| 本轮授权范围 | 冻结 + no-write verification **仅**；**不进 WP4-D** |
| 推荐冻结策略 | A+B；本轮**落地为 B（入口层）**，见 §6 偏差说明 |
| actual_start_time | **2026-09-21 02:58:53 CST**（fresh T0 采集） |
| actual_end_time | **2026-09-21 03:04:32 CST**（解除冻结 / 恢复写服务） |
| 实际冻结时长 | **04m24s**（T1 03:00:08 → resume 03:04:32），远低于 ≤2h 上限 ✅ |

---

## 2. REPO IDENTITY GATE

| 项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| branch | master | `master` | ✅ |
| HEAD | `ae1c3fa` | `ae1c3fa591469f3e1ba0d653a4326ec1ff81e367` | ✅ |
| HEAD == origin/master | YES | `git ls-remote origin master` = `ae1c3fa591469f3e1ba0d653a4326ec1ff81e367` | ✅ |
| staged | 0 | `git diff --cached --name-only | wc -l` = **0** | ✅ |
| 并行改动 | 允许存在、不得处理 | `git status --short` = 293 项，**全程未 touched / 未 add / 未 commit** | ✅ |

**REPO_IDENTITY_GATE = PASS。**

---

## 3. FRESH T0（窗口内新鲜基线，未复用白天旧 T0）

> 旧 T0（2026-09-20 15:07，记录于 `P9_WP4C_EXECUTION.md` §2）**已作废**，本轮按要求在窗口内重采。

- **timestamp_T0 = 2026-09-21 02:58:53 CST**
- **T0 临时文件（生产宿主）**：
  - `/tmp/wp4c_T0_inventory.txt`（131 表清单：`schema|table|UPDATE_TIME|TABLE_ROWS`）
  - `/tmp/wp4c_T0_counts.txt`（**131 表精确 COUNT(*)**）
  - `/tmp/wp4c_T0_active.txt`（109 张有更新列表的 `MAX(updated_at)/MAX(created_at)`）

| 指标 | hash |
|---|---|
| inventory hash（schema\|table 清单） | `4f22f3378f6414d9d45437b8e3cbdd5c10b4bf08b0ec2cafb6a6afce80122739` |
| row count hash（information_schema） | `149690321db086d963de7aff53a95a45c2bee9a19a4021d31c69a9a2e69ef27f` |
| baseline hash（全行摘要） | `933962290ee982b10ba3f37983541c3a40b8d076f528dd8b25f903626946714c` |
| exact COUNT(*) hash（131 表） | `ef3cbba87a16dfb7b62a79c9e72d5c44fb34703e0876e0df2695e15508923956` |
| active updated_at/created_at hash（109 表） | `3125d7f392c738e91b7f1fdb89817396be7242431282850e06e4b782bd3e9c33` |

---

## 4. WRITE FREEZE 执行（策略 B — 入口层写方法拦截）

### 4.1 备份（可逆性控制）
- `/www/server/panel/vhost/nginx/api.jhzyfw.com.conf.wp4c_bak_20260921_025943`

### 4.2 实际施加的冻结块（含 BEGIN/END 标记，server 上下文，位于 `server_name` 之后）

```nginx
# === P9 WP4-C WRITE FREEZE BEGIN (REMOVABLE) ===
if ($request_method !~ ^(GET|HEAD)$) {
    return 503 '{"code":503,"msg":"系统维护中，写操作暂暂停"}';
}
# === P9 WP4-C WRITE FREEZE END ===
```

### 4.3 校验与生效
- `nginx -t` → `syntax is ok` / `test is successful`（exit 0）✅
- `nginx -s reload` → exit 0 ✅
- **timestamp_T1（冻结生效）= 2026-09-21 03:00:08 CST**

---

## 5. FREEZE VERIFICATION（§6）

| 方法 | 实测 code | 期望 | 结果 |
|---|---|---|---|
| GET | 404 | 不被故障页拦截（放行至应用） | ✅ |
| HEAD | 404 | 同上 | ✅ |
| POST | **503** | 写方法拦截 | ✅ |
| PUT | **503** | 写方法拦截 | ✅ |
| PATCH | **503** | 写方法拦截 | ✅ |
| DELETE | **503** | 写方法拦截 | ✅ |

- 维护 JSON 体：`{"code":503,"msg":"系统维护中，写操作暂暂停"}` ✅
- GET/HEAD 返回码与冻结前一致（404 为根路由的应用行为）→ **读请求未被错误拦截** ✅

**freeze verification = PASS。**

---

## 6. 偏差与范围说明（必须记录）

| # | 项 | 说明 | 依据 |
|---|---|---|---|
| D-1 | **vhost 路径纠正** | 先前文档登记 `/etc/nginx/conf.d/api_jhzyfw_com.conf`，但该路径**不被主配置加载**（死文件）。经 `nginx -T` 验证：主配置 `/www/server/nginx/conf/nginx.conf` 仅 include `/www/server/panel/vhost/nginx/*.conf`；活动 vhost 实为 **`/www/server/panel/vhost/nginx/api.jhzyfw.com.conf`**。本轮对活动 vhost 操作，否则冻结对生产流量无效。 | `nginx -T` 实测输出 |
| D-2 | **删除 `add_header` 行** | 该 nginx 禁止在 `if` 块内使用 `add_header`（`nginx -t` 报 "add_header directive is not allowed here"）。已移除该装饰行，保留功能核心 `return 503`；维护 JSON 正常下发，仅 Content-Type 由默认承载。 | `nginx -t` 报错实测 |
| D-3 | **策略落地为 B-only** | 定义为 A+B；本轮按指令「采用策略 B 为主」仅施加 B（入口层）。A（应用层维护标志）需修改 1.0 生产业务代码，本轮未授权不实施；C（全库 read_only）按定义明确不采用。**no-write 验证以实证替代 A 层覆盖证明**（见 §7）。 | 用户本轮指令 + 定义 §4.3 |
| D-4 | **覆盖边界（residual）** | 仅冻结 `api.jhzyfw.com` 入口；同 webroot 的其他 vhost（`manage/exam/api2.jhzyfw.com`）不在本轮授权范围、未冻结。**补偿控制：以两源库全部 131 张表的 5 组 hash + 精确 COUNT(*) 实证判定无写入并 PASS。** | 见 §7 |

---

## 7. NO-WRITE VERIFICATION（§8）

- **timestamp_T2 = 2026-09-21 03:03:45 CST**
- T2 时冻结仍生效：`POST → 503` ✅
- T2 临时文件：`/tmp/wp4c_T2_inventory.txt` / `_counts.txt` / `_active.txt`

| 指标 | T0 | T2 | 结果 |
|---|---|---|---|
| inventory hash | `4f22f337…2739` | `4f22f337…2739` | ✅ 一致 |
| row count hash | `14969032…ef27f` | `14969032…ef27f` | ✅ 一致 |
| baseline hash | `93396229…6714c` | `93396229…6714c` | ✅ 一致 |
| exact COUNT(*) hash | `ef3cbba8…3956` | `ef3cbba8…3956` | ✅ 一致 |
| active ts hash | `3125d7f3…e9c33` | `3125d7f3…e9c33` | ✅ 一致 |
| 表数 | 131 | 131 | ✅ 一致 |

- **字节级比对**：`diff` T0/T2 三份文件 → `inventory: IDENTICAL` / `counts: IDENTICAL` / `active: IDENTICAL` ✅
- **定义 §5.3 判定查询**：`SELECT … WHERE table_schema IN ('api_jhzyfw_com','signup_db') AND UPDATE_TIME > '2026-09-21 03:00:08';` → **空集**（无任何表在 T1 之后被写入）✅

**no-write verification = PASS**（未触发 AF-02 / AF-04）。

---

## 8. RESUME / UNFREEZE（§9）

| 步骤 | 结果 |
|---|---|
| 移除 BEGIN/END 冻结块 | `RESULT:REMOVED`；剩余标记 **0** |
| `nginx -t` | `syntax is ok` / exit 0 ✅ |
| `nginx -s reload` | exit 0 ✅ |
| **timestamp_resume = 2026-09-21 03:04:32 CST** | ✅ |
| 解除后方法实测 | GET 404 / HEAD 404 / **POST 404** / PUT 405 / DELETE 405（**均非 503** → 写请求已放行至应用）✅ |
| 生效配置残留标记 | `nginx -T | grep -c "P9 WP4-C WRITE FREEZE"` = **0** ✅ |
| 可逆性证明 | `diff -q` 活动 vhost vs `wp4c_bak_20260921_025943` → **逐字节一致** ✅ |

**resume / unfreeze = PASS；1.0 正常写服务已恢复。**

---

## 9. FINAL GATE

| Gate 项 | 结果 |
|---|---|
| maintenance_window_id | `wp4c-mw-20260921` |
| window approved | **YES** |
| Repo identity confirmed | **YES** |
| Window check | **PASS** |
| Baseline read | **YES**（Authorization Closure / Readiness+ G-2 / Definition / WP4-D Definition 全读） |
| Fresh T0 captured | **YES**（窗口内 02:58:53，非白天旧 T0） |
| **freeze method** | **nginx method block（策略 B，入口层）** |
| freeze applied | **YES** |
| freeze verification | **PASS** |
| wait period completed | **YES**（120s） |
| T2 captured | **YES**（03:03:45） |
| no-write verification | **PASS** |
| freeze removed / service resumed | **PASS**（03:04:32） |
| abort_status | **PASS**（未触发 AF-01…AF-08） |
| resume_status | **ok** |
| G-2 waiver active | **YES** |
| evidence document created | **YES** |
| Maintenance window used | YES |
| Write freeze executed | **YES** |
| Production dump executed | **NO** |
| Production backup executed | **NO**（仅可逆 nginx vhost 文件备份，未触碰数据库） |
| Authoritative snapshot executed | **NO** |
| Production data modified | **NO** |
| Production schema modified | **NO** |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| MySQL 用户/权限 modified | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |
| Entered WP4-D | **NO** |
| git commit / push | **NO**（执行轮内未提交；本文件与 `P9_WP4C_EXECUTION.md` 由后续独立 Git Closeout 提交，仅含该 2 个文件） |

### **final decision = FROZEN_OK / PASS（已恢复写入）**
### **Ready for WP4-D Execution = YES**（前置条件 1/2/3/5/8/9 现已满足：窗批准 ✅、冻结已应用 ✅、no-write PASS ✅、G-2 WAIVED ✅、roles 具名 ✅）
> 但 **本轮不进入 WP4-D**；是否进入须 U-08 另行显式授权。

---

## 10. 关联文件

- 执行主文档：`P9_WP4C_EXECUTION.md`（已同步更新 §2/§3/§7/§8）
- 本轮更早一次窗口内执行（2026-09-21 02:00 起）：`P9_WP4C_EXECUTION_EVIDENCE_20260921T020046.md`
- 授权：`P9_WP4C_EXECUTION_AUTHORIZATION_CLOSURE.md`
- 就绪/G-2：`P9_WP4C_EXECUTION_READINESS_AND_G2_CLOSURE.md`
- 定义：`P9_WP4C_MAINTENANCE_WINDOW_AND_WRITE_FREEZE_DEFINITION.md`
