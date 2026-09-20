# P9 WP4-A — G-10 Readonly Account Closure（G-10 只读账号关闭执行）

> **阶段**：P9 WP4-A（执行）
> **执行日期**：2026-09-20（CST）
> **性质**：**执行 G-10 关闭** —— 为未来生产迁移预检与 snapshot 操作准备最小权限 MySQL 只读账号。
> **纪律**：仅创建只读账号 + `SELECT` 两源库；未执行 mysqldump / 实际备份 / 锁表 / 停止 1.0 / 修改 1.0 / 修改腾讯云 nginx / 修改 DNS·route / 写 D1 / import schema / 迁移 / 灰度 / Cutover / 修改 Worker / redeploy；未授予写权限 / 全局权限 / GRANT OPTION；密码不落 Git / 文档 / 聊天。
> **承接**：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §4（G-10 closure plan）。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| P9 WP4 Definition | FINAL PASS（commit `6600b46`，HEAD == origin/master） |
| G-10（进入前） | **OPEN**（`jhzy20_readonly@127.0.0.1` 仅 `SELECT ON jhzy20_dev.*`，不含权威源库） |
| 执行目标 | 关闭 G-10：建专用只读账号，仅 `SELECT` 于 `api_jhzyfw_com` + `signup_db` |

---

## 1. 权威基线（已读取）

| 文档 | 用途 |
|---|---|
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | WP4 定义（§4 G-10 关闭方案） |
| `P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md` | WP3 §2（G-10 现状：`jhzy20_readonly` 仅 dev） |
| `P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` | WP2 §3–§4（源库 / 备份计划） |

---

## 2. 前置审计（只读，2026-09-20）

| 项 | 实测值 |
|---|---|
| MySQL version | `5.7.44` |
| 执行上下文 CURRENT_USER | `root@localhost`（unix_socket，仅用于建账号与核查） |
| 目标账号 `jhzy_mig_ro@127.0.0.1` | **NOT_EXISTS**（可干净创建） |
| 现有 `jhzy20_readonly@127.0.0.1` grants | `USAGE ON *.*` + `SELECT ON jhzy20_dev.*`（**不含 `api_jhzyfw_com` / `signup_db`**）→ 证实 G-10 缺口 |
| 源库存在性 | `api_jhzyfw_com` ✅ / `signup_db` ✅ |

---

## 3. 执行（CREATE minimal readonly account）

| 项 | 值 |
|---|---|
| 账号 | `jhzy_mig_ro`@`127.0.0.1` |
| 权限 | `SELECT ON api_jhzyfw_com.*`；`SELECT ON signup_db.*`（无 `*.*` / 无写 / 无 GRANT OPTION） |
| host 限制 | `127.0.0.1` only（迁移工具链在 production 主机本地运行） |
| 密码 | 现场安全生成（`/dev/urandom` 32 字符，含字母数字+符号）；**不落 Git / 文档 / 聊天** |
| 密码存储 | 生产宿主 `/root/.jhzy_mig_ro.cnf`（`chmod 600`）；本文仅记录路径，无明文 |

执行的 SQL（密码以 `<REDACTED>` 表示，真实密码未出现）：

```sql
CREATE USER IF NOT EXISTS 'jhzy_mig_ro'@'127.0.0.1' IDENTIFIED BY '<REDACTED>';
GRANT SELECT ON api_jhzyfw_com.* TO 'jhzy_mig_ro'@'127.0.0.1';
GRANT SELECT ON signup_db.*     TO 'jhzy_mig_ro'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 3.1 执行异常与纠正（重要，如实记录）

首次 CREATE + GRANT 后核查发现两项**非预期状态**（疑似验证连接以 root 身份执行、导致负向测试语句实际生效）：

1. `SHOW GRANTS FOR 'jhzy_mig_ro'@'127.0.0.1'` 出现 `GRANT SELECT ON *.*`（全局 SELECT，违反最小权限 `MG-03`）；`mysql.user.Select_priv=Y` 佐证。
2. 负向测试中的 `CREATE TABLE` / `ALTER TABLE` 实际执行，于 `api_jhzyfw_com` 留下 `_mig_probe` 表与 `id_pool._mig_probe` 列 —— **属禁止的生产 schema 变更**。

**立即纠正（root 执行，rollback 本次意外）**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| ① 回滚生产结构 | `DROP TABLE IF EXISTS api_jhzyfw_com._mig_probe;` `ALTER TABLE api_jhzyfw_com.id_pool DROP COLUMN _mig_probe;` | 列/表均 **GONE**（结构恢复原始） |
| ② DROP USER | `DROP USER IF EXISTS 'jhzy_mig_ro'@'127.0.0.1';` `FLUSH PRIVILEGES;` | 清除全局 SELECT 及全部授权 |
| ③ 干净重建 | 仅 `GRANT SELECT` 于两库；`FLUSH PRIVILEGES;` | 见 §4/§6 |
| ④ 强制身份重测 | `mysql -u jhzy_mig_ro -p -h 127.0.0.1`（`CURRENT_USER=jhzy_mig_ro@127.0.0.1`） | 见 §4/§5 |

> 根因：验证阶段使用 `mysql --defaults-extra-file` 连接，实际以 root 身份执行（CURRENT_USER 经强制 TCP 显式测试方确认）；已改用显式 `-u jhzy_mig_ro -p -h 127.0.0.1` 重测，结果可信。生产结构已确认无残留变更。

---

## 4. 正向验证（PASS）

| 验证 | 结果 |
|---|---|
| 连接身份 | `SELECT CURRENT_USER()` = `jhzy_mig_ro@127.0.0.1` ✅ |
| `SELECT` `api_jhzyfw_com` | `COUNT(*) FROM id_pool` = `450000` ✅ |
| `SELECT` `signup_db` | `COUNT(*) FROM users` = `1` ✅ |
| table inventory | `information_schema.tables WHERE table_schema='api_jhzyfw_com'` → 128 表 ✅ |
| row count / metadata | `information_schema` 可读 ✅ |

---

## 5. 负向验证（PASS — 全部拒绝）

| 操作 | 结果 |
|---|---|
| `CREATE TABLE` | **ERROR 1142 (42000)** |
| `INSERT` | **ERROR 1142 (42000)** |
| `UPDATE` | **ERROR 1142 (42000)** |
| `DELETE` | **ERROR 1142 (42000)** |
| `ALTER` | **ERROR 1142 (42000)** |
| `DROP` | **ERROR 1142 (42000)** |
| `GRANT` | **ERROR 1045 (28000)**（无 GRANT OPTION） |

> 全部写操作被拒（exit=1）；生产结构残留核查 = CLEAN（无 `_mig_probe` 表/列）。

---

## 6. 最终 GRANTS（`jhzy_mig_ro@127.0.0.1`）

```sql
GRANT USAGE ON *.* TO 'jhzy_mig_ro'@'127.0.0.1'                       -- 无实际全局权限（CREATE USER 默认）
GRANT SELECT ON `signup_db`.* TO 'jhzy_mig_ro'@'127.0.0.1'
GRANT SELECT ON `api_jhzyfw_com`.* TO 'jhzy_mig_ro'@'127.0.0.1'
```

---

## 7. 证据登记

| 字段 | 值 |
|---|---|
| execution timestamp | 2026-09-20（CST） |
| operator role | Migration Operator（ROLE 占位，具名待 U-07） |
| target account | `jhzy_mig_ro@127.0.0.1` |
| host restriction | `127.0.0.1` only |
| password generated | **YES** |
| password stored in Git/chat | **NO**（存于生产宿主 `/root/.jhzy_mig_ro.cnf`，`chmod 600`；仅路径记录） |
| grants applied | `SELECT` on `api_jhzyfw_com.*` + `signup_db.*`（无全局 / 写 / GRANT OPTION） |
| positive SELECT verification | **PASS** |
| negative write verification | **PASS**（1142 / 1045） |
| source DB untouched | **YES**（结构已回滚至原始；`id_pool` 行数 `450000` 不变） |
| Production business data modified | **NO** |
| Production schema temporarily modified | **YES**（首轮误以 root 身份执行负向测试，曾创建 `api_jhzyfw_com._mig_probe` 表、新增 `api_jhzyfw_com.id_pool._mig_probe` 列） |
| Temporary schema changes reverted | **YES**（root 执行 `DROP TABLE` + `DROP COLUMN`，验证 GONE / CLEAN） |
| Residual schema artifacts | **NO**（生产结构已恢复至原始状态） |
| **G-10 final status** | **CLOSED** |

---

## 8. 纪律声明（P9 WP4-A）

| 项 | 状态 |
|---|---|
| 执行 mysqldump / 实际备份生产库 | ❌ 无 |
| 锁表 / 停止 1.0 / 修改 1.0 | ❌ 无 |
| 修改腾讯云 nginx / DNS / route | ❌ 无 |
| 写 D1 / import schema / 迁移数据 | ❌ 无 |
| 灰度 / Cutover | ❌ 无 |
| 修改 Worker / 重新部署 Worker | ❌ 无 |
| 授予写权限 / 全局权限 / GRANT OPTION | ❌ 无 |
| 生产业务数据修改 | ❌ **NO** |
| 生产结构临时修改 | ✅ **YES**（首轮误以 root 身份执行负向测试，曾创建 `_mig_probe` 表、新增 `id_pool._mig_probe` 列） |
| 临时结构变更已回滚 | ✅ **YES**（root `DROP TABLE` + `DROP COLUMN`，验证 GONE / CLEAN） |
| 残留结构产物 | ❌ **NO**（结构已恢复原始状态） |
| Git 提交 | ❌ 无（待用户授权后提交） |

---

## 9. FINAL GATE（P9 WP4-A）

| Gate 项 | 结果 |
|---|---|
| Repo identity confirmed | **YES**（master / `6600b46` / HEAD==origin/master / staged=0） |
| Baseline read | **YES**（WP4 §4 / WP3 §2 / WP2 §3–§4） |
| Current grants audited | **YES**（`jhzy20_readonly` 仅 dev；目标账号初始 NOT_EXISTS） |
| Readonly account created | **YES**（`jhzy_mig_ro@127.0.0.1`） |
| SELECT on `api_jhzyfw_com` granted | **YES** |
| SELECT on `signup_db` granted | **YES** |
| Global privilege granted | **NO**（最终 = `USAGE ON *.*` 默认，无实际全局权限） |
| Write privilege granted | **NO**（INSERT/UPDATE/DELETE/ALTER/DROP/CREATE 全拒 1142） |
| GRANT OPTION granted | **NO**（GRANT 拒 1045） |
| Password exposed in chat/Git | **NO** |
| Positive SELECT verification | **PASS** |
| Negative write verification | **PASS**（1142 / 1045） |
| **G-10** | **CLOSED** |
| Production dump executed | **NO** |
| Production backup executed | **NO** |
| Production write freeze executed | **NO** |
| Production business data modified | **NO** |
| Production schema temporarily modified | **YES**（首轮误以 root 身份执行负向测试，曾创建 `_mig_probe` 表、新增 `id_pool._mig_probe` 列） |
| Temporary schema changes reverted | **YES**（root `DROP TABLE` + `DROP COLUMN`，验证 GONE / CLEAN） |
| Residual schema artifacts | **NO**（结构已恢复原始状态） |
| D1 modified | **NO** |
| Worker modified | **NO** |
| DNS / route changed | **NO** |
| Migration executed | **NO** |
| Cutover executed | **NO** |

### **P9 WP4-A Gate = PASS**

### **Ready for P9 WP4-A Git Closeout = YES**（提交 `P9_WP4A_G10_READONLY_ACCOUNT_CLOSURE.md` + 最小更新 WP4 定义文档 G-10→CLOSED，须用户授权）

---

## 引用

- G-10 closure plan：`P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §4。
- G-10 现状：`P9_WP3_PRODUCTION_MIGRATION_PREFLIGHT.md` §2（实测 `jhzy20_readonly` 仅 dev）。
- 源库 / 备份计划：`P9_WP2_PRODUCTION_SOURCE_SNAPSHOT_AND_BACKUP_PLAN.md` §3–§4。
- 安全门 MG-03（最小权限）：`P9_PRODUCTION_MIGRATION_AND_CUTOVER_DEFINITION.md` §6。
