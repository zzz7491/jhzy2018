# P9 WP4-E — Migration Planning（迁移规划）

> **阶段**：P9 WP4-E（Migration Planning）
> **规划日期**：2026-09-21（CST）
> **性质**：**Planning Only（仅规划：映射 / 批次 / ID 映射 / 校验策略 / 执行边界 / 风险登记；不执行 D1 import、不写 D1、不迁移、不 Cutover、不重新 mysqldump、不重新 snapshot、不修改源库 / Worker / DNS / MySQL、不 git commit（除非另行授权 Git Closeout））**。
> **承接**：`P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_EVIDENCE_20260921_120656.md`（WP4-D PASS / authoritative_snapshot=YES / migration_input=YES / Ready for WP4-E=YES）+ `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md`（§8 WP4-E 约束）+ `D1-SCHEMA-TABLE-MATRIX.md`（62 表处理矩阵）+ `D1-DATABASE-DESIGN.md` / `D1-MIGRATION-DESIGN.md`（D1 目标 schema）+ `workers/migrations/0001..0043`（86 表 frozen schema 权威来源）。
> **纪律**：本轮仅产出规划文档；所有 D1 写入 / 数据导入 / 迁移 / 回滚动作须用户显式授权后，在 WP4-E 执行轮（非本规划轮）进行。

---

## 0. 入口状态

| 项 | 值 |
|---|---|
| 最新远端 commit | `a4359f4`（`docs(migration): record P9 WP4-D authoritative snapshot evidence`，已 `origin/master`） |
| WP4-D Authoritative Snapshot | **EXECUTED + Git Closeout = FINAL PASS** |
| authoritative_snapshot | **YES** |
| migration_input | **YES** |
| Ready for WP4-E Migration Planning | **YES** |
| run_id | `wp4d_authoritative_20260921_120656` |
| D1 import authorized | **NO**（本规划轮不授权） |
| Migration executed | **NO** |
| Cutover executed | **NO** |
| G-2 residual | **仍 OPEN（Cutover 前须补 off-host copy，否则 ABORT Cutover）** |
| 本轮性质 | Planning Only（仅设计，不执行） |

---

## 1. REPO IDENTITY GATE（只读）

| 项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| branch | master | `master` | ✅ |
| HEAD | `a4359f4` | `a4359f4e64735fe6d0ea6a1bb2d9ab2f6ab0bbf5` | ✅ |
| HEAD == origin/master | YES | 上轮 `git push` 已确认 `2e20f3a..a4359f4 master -> master`；本轮 `git ls-remote` 因 shell/PATH 瞬时波动未返回，但 push 成功已实证 `a4359f4` 已落地远端，判定 YES | ✅ |
| staged | 0 | `git diff --cached --name-only` = 空 | ✅ |
| 并行改动 | 允许存在、不得处理 | `git status --short` 含 292+ 项（P1-B2.3 / Lanai365 P8-A / P3 workers 等），全程未 touched / 未 add / 未 commit | ✅ |

**REPO_IDENTITY_GATE = PASS。**

---

## 2. BASELINE（已读取并确认）

| 文档 | 关键确认 |
|---|---|
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION.md` / `..._EVIDENCE_20260921_120656.md` | WP4-D PASS；run_id=`wp4d_authoritative_20260921_120656`；5×`.sql.gz` + sha256 + gzip OK；row counts 131/131、total 619,176；api 128 对象（127 表+1 视图）、signup 3 表；routines 含 `assign_certificate_id`；G-2 WAIVED 已记录 |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_AUTHORIZATION_GATE.md` | WP4-D execution=YES；run dir=READY；C-8 caveat fix=YES；G-2 residual acknowledged；Snapshot run=`wp4d_authoritative_20260921_120656` |
| `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md` | §5 产物结构 / §6 命令设计 / §7 校验 / §8 迁移输入裁定（仅 Validation PASS → migration_input=YES） |
| `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md` | 写入通道清单（nginx 5 vhost + cron）；G-2 residual 仍有效 |
| `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` | §8 WP4-E 硬约束：D1 86 表 frozen schema+seed、B0 SKIP、仅迁业务、SC-01…SC-15、B0–B20；§9 对账 10 维；§10 回滚 CLASS_1-3 |
| `D1-SCHEMA-TABLE-MATRIX.md` | 62 表处理矩阵（原 MySQL 表 → D1 表 1:1；KEEP 56 / DEFER 4 / NEW 1）；tenant scope 与 team_id 纪律 |
| `D1-DATABASE-DESIGN.md` | D1 目标 schema 约定（INTEGER PK + public_id ULID / epoch 时间 / CHECK / FK / TEXT 密文 / JSON=TEXT）；被新蓝图取代但保留历史参考 |
| `D1-MIGRATION-DESIGN.md` | D1 原生 migration 机制；`migrations/0001..` 顺序；B0 种子已载；Time Travel 兜底 |
| `workers/wrangler.jsonc` | D1 绑定 `DB`→`jhzy-v2-db`（id `ea603f43-d076-4df5-b118-3d8a0c245439`）；local 已执行，preview/prod 占位 |
| `workers/migrations/0001..0043` | 86 表 frozen schema 权威来源（比矩阵 62 表更全，含后续新增表） |

**结论**：authoritative_snapshot=YES；migration_input=YES；Ready for WP4-E=YES；G-2 residual 仍 OPEN；D1 import=NO。

---

## 3. AUTHORITATIVE SNAPSHOT INPUT（只读确认，未修改）

目录：`/www/backup/database/p9-wp4d-authoritative/wp4d_authoritative_20260921_120656/`（0700）

| 文件 | 大小 | sha256(前8) | gzip |
|---|---|---|---|
| api_jhzyfw_com.schema.sql.gz | 19,011 | b67db86e | OK |
| api_jhzyfw_com.data.sql.gz | 9,140,558 | 5850ff6c | OK |
| api_jhzyfw_com.routines.sql.gz | 1,356 | 792b9bda | OK |
| signup_db.schema.sql.gz | 1,008 | 720ec264 | OK |
| signup_db.data.sql.gz | 688 | bfa1cfe9 | OK |
| sha256_manifest.txt / snapshot_manifest.json / row_counts_before.json / table_inventory.json / gzip_check.log / evidence.json / dump_errors/ | — | — | — |

- sha256 与 evidence 一致（已复核 `sha256_manifest.txt`）。
- 未重新生成、未解压覆盖、未导入 D1。
- 源表清单（只读 `information_schema`，2026-09-21）：`api_jhzyfw_com` = **127 BASE TABLE + 1 VIEW**（`v_all_certificates`）；`signup_db` = **3 BASE TABLE**（`events` / `participants` / `users`）。

### 3.1 源表清单（实际，来自 snapshot 时 information_schema）

**api_jhzyfw_com（127 表 + 1 视图）**：
achievements, activities, activity_categories, activity_records, activity_service_certificates, activity_signins, address_coordinates, admins, admins_old_20260214, admin_login_logs, admin_operation_logs, admin_tokens, carousel_images, certificates, certificates_preview, certificate_applications, certificate_applications_backup_20260207, certificate_id_usage_log, certificate_master, certificate_templates, certificate_types, events, exam_certificates, exam_certificates_new, exam_config, exam_questions, exam_questions_backup_20260604, exam_records, exam_sessions, exchange_orders, exchange_products, exchange_records, exchange_verifications, file_uploads, geocode_logs, id_assignments_old_20260214, id_pool, id_pool_old_20260214, jhzy_abnormal_logs, jhzy_activities, jhzy_activities_backup_prelaunch, jhzy_activities_temp, jhzy_activity_cancel_logs, jhzy_activity_checkins, jhzy_activity_checkins_enhanced, jhzy_activity_images, jhzy_activity_locations, jhzy_activity_positions, jhzy_activity_recurrence, jhzy_activity_signin, jhzy_activity_signups, jhzy_activity_signups_bak_20260309, jhzy_activity_signups_old_backup, jhzy_activity_stats_cache, jhzy_activity_time_slots, jhzy_admins_old_20260214, jhzy_attendance_records, jhzy_attendance_records_backup_20260514, jhzy_casual_daily_limit, jhzy_casual_records, jhzy_checkins_v2, jhzy_checkin_codes, jhzy_checkin_history, jhzy_condition_coefficients, jhzy_deleted_users, jhzy_device_logs, jhzy_feedback, jhzy_geofence_logs, jhzy_geo_monitor_logs, jhzy_integration_rules, jhzy_level_records, jhzy_location_monitor, jhzy_new_activities_deleted, jhzy_notifications, jhzy_quick_actions, jhzy_quick_service_records_deprecated, jhzy_reward_penalty_records, jhzy_role_coefficients, jhzy_service_areas, jhzy_serving_progress, jhzy_users_old_20260214, jhzy_volunteers_old_20260214, jhzy_welfare_options, mall_products, notifications, notification_details, notification_master, participants, password_change_logs, points_exchange_records, points_mall, points_transactions, qr_codes, qr_types, qr_usage_logs, question_bank, quick_actions, service_areas, system_config, system_logs, teams, training_chapters, training_courses, training_signatures, training_user_course_status, training_user_progress, training_whitelist, unified_certificates, users, users_old_20260214, user_avatars, user_certificates, user_favorites, user_stats, user_subscribe_settings, user_teams, user_tokens, user_trainings, volunteers, volunteer_activities, volunteer_approvals, volunteer_deleted_logs, volunteer_groups, volunteer_group_members, v_all_certificates(VIEW), welfare_options

**signup_db（3 表）**：events, participants, users

---

## 4. COPY-NOT-CUT PRINCIPLE（硬约束，记录）

```text
迁移 = 复制式迁移，不是剪切。
源端 1.0 原库、原文件、原服务必须保留不动。
WP4-E 只能基于 WP4-D authoritative snapshot 规划迁移，不得直接改源库。
禁止删除、清空、移动、覆盖、破坏 1.0 源数据。
```

- 源库 `api_jhzyfw_com` / `signup_db` 在 WP4-E 全过程中保持只读权威，直至显式 Cutover（属 P9 WP6，不在 WP4）。
- 迁移写入目标 D1 `jhzy-v2-db`；源库零写入。
- 源侧 shadow/legacy 表**仅存档于 snapshot**（不删、不迁、不覆盖）。

---

## 5. SOURCE → TARGET MAPPING（初版映射）

> 目标 D1 表以 `workers/migrations/0001..0043`（86 表 frozen schema）为权威；`D1-SCHEMA-TABLE-MATRIX.md`（62 表）为域映射参考。1.0 源存在「前缀/非前缀混用」（`activities` 与 `jhzy_activities` 并存），**哪一具体表为权威源须在 WP4-E 执行轮由 P8-3 源适配器表解析规则裁定**（见 §5.7 GAP）。

### 5.1 身份 / 志愿者 / 账号域

| 1.0 源表（候选权威） | 2.0 目标表 | 备注 / 变换 |
|---|---|---|
| `users` | `users` | 主体；`uuid`→`public_id`(ULID)；`DATETIME`→epoch；敏感字段 TEXT 密文 |
| `volunteers` | `volunteer_profiles` | 志愿者档案；`user_id` 关联 users |
| `user_teams` | `team_members` + `user_roles`(volunteer) | 团队关系 + 默认绑 team-scoped volunteer 角色（O1） |
| `admins` / `admin_tokens` | `users`(role) + `sessions` | 管理员账号并入 users；token→sessions（NEW 表） |
| `admin_login_logs` / `admin_operation_logs` | `operation_logs` / `security_events` | AUDIT_ONLY |
| `user_favorites` | **EXCLUDE** | P8-3 `EXCLUSIONS=['api.user_favorites']` 恒成立；BCR pending |
| `user_stats` / `user_subscribe_settings` / `user_avatars` | `user_profiles` / `user_preferences` / `files` | 合并或外键 |
| `user_tokens` | `sessions` | 会话令牌 |
| `password_change_logs` | `security_events` / `sensitive_data_access_logs` | 审计 |

### 5.2 活动 / 报名 / 签到 / 服务

| 1.0 源表 | 2.0 目标表 | 备注 |
|---|---|---|
| `activities` / `jhzy_activities`（裁定其一） | `activities` | `team_id` 派生；JSON 配置（checkin/risk/points/cert） |
| `activity_categories` | `activity_categories` | 引用数据 |
| `activity_signups` / `jhzy_activity_signups` | `activity_signups` | `form_data`→JSON；去冗余 `team_id` |
| `activity_signins` / `jhzy_activity_checkins` / `jhzy_checkins_v2` / `jhzy_checkin_history` | `attendance_sessions` + `attendance_events` | 签到/签退/心跳→append-only 证据 |
| `jhzy_checkin_codes` | `attendance_devices` / `qr_codes` | 设备指纹 / 二维码 |
| `activity_records` / `jhzy_serving_progress` / `jhzy_casual_records` | `service_records` + `service_record_audits` | 权威时长；append-only |
| `jhzy_activity_positions` / `jhzy_activity_time_slots` / `jhzy_activity_locations` / `jhzy_activity_images` | `activities`(JSON) / `files` | 位置/时段/图片→JSON 或 files |
| `activity_service_certificates` | `certificates` + `certificate_logs` | 证书发放 |
| `address_coordinates` | `activities`(lat/long) | 合并入活动 |
| `volunteer_activities` | `activity_signups` / `team_members` | 志愿者活动关联 |

### 5.3 积分 / 证书 / 保险

| 1.0 源表 | 2.0 目标表 | 备注 |
|---|---|---|
| `points_transactions` | `points_ledger` | append-only；`direction`(1收/2支) |
| `points_mall` / `points_exchange_records` | `points_accounts`(快照) / `mall_*`(DEFER) | 余额可重算 |
| `certificates` / `unified_certificates` / `user_certificates` | `certificates` | `cert_no`→`id_pools` 分配 |
| `certificate_templates` / `certificate_master` / `certificate_types` | `certificate_templates` | 模板 |
| `certificate_applications` | `certificate_applications`(若存在) / `certificates` | 申请→证书 |
| `certificate_id_usage_log` | `id_pools`(usage) / `certificate_logs` | 编号池使用 |
| `id_pool` / `id_assignments_old_20260214` | `id_pools` | 编号池平台级 |
| `insurance`（源无独立表） | （2.0 保险目标，源缺）→ 空迁 | 源无保险表，目标可空 |

### 5.4 培训 / 考试

| 1.0 源表 | 2.0 目标表 | 备注 |
|---|---|---|
| `training_courses` / `training_chapters` | `courses` + `course_lessons` | 课程/章节 |
| `training_user_progress` / `training_user_course_status` / `user_trainings` | `course_enrollments` + `learning_records` | 报名/进度 |
| `training_signatures` | `learning_records`(签名) / `files` | 签名 |
| `training_whitelist` | `course_enrollments`(白名单) | 准入 |
| `exam_questions` / `question_bank` | `exam_questions` | 题库 |
| `exam_papers`(若存在) / `exam_config` | `exam_papers` | 试卷 |
| `exam_sessions` / `exam_records` | `exam_sessions` + `exam_answers` | 考试会话/作答 |
| `exam_certificates` / `certificate_applications` | `certificates` | 考试证书 |

### 5.5 动态表单（P20）

| 1.0 源表 | 2.0 目标表 | 备注 |
|---|---|---|
| `activity_signups.form_data`(列) | `activity_signups.form_data`(JSON) | schema_json/answers_json 兼容 |
| 无 schema 的历史表单 | `activity_signups.form_data`(JSON 保留原文) | 无 schema 仍保留原始 JSON，供回看 |
| `jhzy_quick_actions` / `quick_actions` | `quick_actions`(若 2.0 有) / 归档 | 快速行动 |

### 5.6 团队 / 组织 / RBAC

| 1.0 源表 | 2.0 目标表 | 备注 |
|---|---|---|
| `teams` | `teams` | 租户根；平台 `platform_root` 系统行 |
| `user_teams` | `team_members` | 成员关系 |
| `volunteer_groups` / `volunteer_group_members` | （2.0 若无 groups 表）→ 归档或 `team_members` 扩展 | 须 WP4-E 裁定（见 GAP） |
| `admins`(role) | `user_roles` + `roles`(seed) | 不覆盖既有 D1 RBAC seed（B0 SKIP） |
| `jhzy_role_coefficients` / `jhzy_condition_coefficients` / `jhzy_integration_rules` | `growth_rules` / `points_config`(JSON) | 规则→JSON 或 growth_rules |
| `jhzy_reward_penalty_records` | `growth_records` / `points_ledger` | 奖惩→成长/积分 |
| `jhzy_level_records` | `level_change_logs` | 等级变更审计 |

### 5.7 源表分类（127 基表中的剩余项）

**A. 明确 SHADOW / LEGACY / BACKUP（EXCLUDE + 存档于 snapshot，不迁移）** —— 24 张：

```
admins_old_20260214
certificate_applications_backup_20260207
exam_certificates_new
exam_questions_backup_20260604
id_assignments_old_20260214
id_pool_old_20260214
jhzy_activities
jhzy_activities_backup_prelaunch
jhzy_activities_temp
jhzy_activity_cancel_logs
jhzy_activity_checkins_enhanced
jhzy_activity_recurrence
jhzy_activity_signin
jhzy_activity_signups_bak_20260309
jhzy_activity_signups_old_backup
jhzy_activity_stats_cache
jhzy_admins_old_20260214
jhzy_checkins_v2
jhzy_new_activities_deleted
jhzy_users_old_20260214
jhzy_volunteers_old_20260214
users_old_20260214
volunteers_old_20260214
volunteers_temp
```
+ `v_all_certificates`（VIEW，派生视图，不迁移）。

**B. 待 WP4-E 裁定权威源的双名表（GAP-RE-1）**：`activities` vs `jhzy_activities`、`activity_signups` vs `jhzy_activity_signups`、`volunteers` vs `jhzy_volunteers*`、`users` vs `jhzy_users*`、`attendance` 系列、`certificates` 系列。→ 由 P8-3 源适配器 `srcKey` 解析规则裁定（工具链已知）。

**C. 1.0 有但 2.0 无直接对应（ARCHIVE 或映射到 JSON/审计）**：`achievements`、`address_coordinates`、`carousel_images`、`certificates_preview`、`certificate_id_usage_log`、`exchange_*`、`geocode_logs`、`notification_details`、`notification_master`、`qr_*`、`service_areas`/`jhzy_service_areas`、`system_config`、`welfare_options`/`jhzy_welfare_options`、`jhzy_abnormal_logs`、`jhzy_casual_daily_limit`、`jhzy_device_logs`、`jhzy_feedback`、`jhzy_geofence_logs`、`jhzy_geo_monitor_logs`、`jhzy_location_monitor`、`jhzy_quick_service_records_deprecated`、`training_signatures`。→ 按 P8-3 EXCLUSIONS/archive 规则处理（保留于 snapshot，按业务价值归档或丢弃，落 `migration_issues`）。

---

## 6. MIGRATION BATCH DESIGN（B0–B20，不执行）

> 沿用 `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md` §8.2 批次顺序；工具链 `p8-3-migration`（runner/reconcile/rollback）。`run_id` 贯穿 `legacy_id_maps` / `migration_issues` / reconcile / rollback / evidence。

| Batch | 内容 | 输入源表（代表） | 输出目标 | 依赖 | 校验 | 回滚/重试 | Abort |
|---|---|---|---|---|---|---|---|
| B0 | RBAC 种子 | — | （SKIP，D1 已 seed） | — | B0 确认 skip | — | 若误插 seed → ABORT |
| B1 | 身份与用户档案 | users, volunteers, user_*, admin_* | users, volunteer_profiles, user_profiles, user_preferences, user_identities | B0 | 行数/identity 唯一 | 单批 CLASS_1 | SC-01/02 |
| B2 | 会话 | admin_tokens, user_tokens | sessions | B1 | token_hash 唯一 | CLASS_1 | SC-01 |
| B3 | 团队与成员 | teams, user_teams, volunteer_groups* | teams, team_members | B1 | team 唯一 | CLASS_1 | SC-03 |
| B4 | 用户角色 + 临时表归档 | admins, user_teams | user_roles（**不覆盖 seed**） | B1,B3 | role 绑定一致 | CLASS_1 | SC-03 |
| B5 | 活动中心 | activities(+jhzy_activities), activity_categories | activities, activity_categories | B3 | activity 唯一 | CLASS_1 | SC-04 |
| B6 | 活动报名 | activity_signups(+jhzy_*), form_data | activity_signups | B5 | (user,activity) 唯一 | CLASS_1 | SC-03 |
| B7 | 签到签退 | activity_signins, jhzy_activity_checkins*, jhzy_checkin_history, jhzy_checkins_v2 | attendance_sessions, attendance_events, attendance_anomalies | B6 | nonce 幂等 | CLASS_1 | SC-03 |
| B8 | 服务记录 + quick_actions 归档 | activity_records, jhzy_serving_progress, jhzy_casual_records | service_records, service_record_audits | B7 | 时长合计 | CLASS_1 | SC-05 |
| B9 | 积分流水 | points_transactions | points_ledger, points_accounts | B1 | 余额一致 | CLASS_1 | SC-05 |
| B10 | 成长等级 | jhzy_level_records, jhzy_reward_penalty_records, jhzy_role_coefficients | growth_records, growth_rules, volunteer_levels | B1 | 成长合计 | CLASS_1 | SC-05 |
| B11 | 培训中心 | training_courses, training_chapters, training_user_progress, training_whitelist | courses, course_lessons, course_enrollments, learning_records | B3 | 进度一致 | CLASS_1 | SC-06 |
| B12 | 考试中心 | exam_questions, exam_config, exam_sessions, exam_records, question_bank | exam_questions, exam_papers, exam_sessions, exam_answers | B3 | 作答一致 | CLASS_1 | SC-06 |
| B13 | 证书中心 | certificates, certificate_templates, certificate_master, certificate_applications, id_pool, exam_certificates, unified_certificates | certificates, certificate_templates, id_pools, certificate_logs | B5,B9 | cert_no 唯一（id_pool） | CLASS_1 | SC-06 |
| B14 | 商城中心 | mall_products, exchange_*, points_mall, points_exchange_records | mall_products(DEFER), mall_orders(DEFER) | B1 | DEFER 仅结构 | CLASS_1 | SC-01 |
| B15 | 通知中心 | notifications, jhzy_notifications, notification_master, notification_details | notifications, message_templates | B1 | 通知唯一 | CLASS_1 | SC-01 |
| B16 | 内容中心 | carousel_images, content*（源若含） | content_articles, content_comments, files | B3 | 内容唯一 | CLASS_1 | SC-07 |
| B17 | 文件中心 | file_uploads | files（R2 元数据） | B1 | file 唯一 | CLASS_1 | SC-07 |
| B18 | 系统管理/审计/安全 | system_logs, admin_operation_logs, jhzy_abnormal_logs, jhzy_device_logs, jhzy_geofence_logs, password_change_logs | operation_logs, security_events, sensitive_data_access_logs, client_errors | B1 | 审计完整 | CLASS_1 | SC-08 |
| B19 | 保留（无 1.0 源） | — | ai_conversations, ai_usage_logs 等 NEW/空 | — | 空批 | — | — |
| B20 | 收尾 | — | legacy_id_maps, migration_issues 完整性 + checkpoint 关闭 | 全部 PASS | 全量 reconcile | CLASS_2/3 | SC-15 |

每批通用：Preconditions = preflight PROCEED + 上一批 checkpoint 且 reconcile PASS；Procedure = `runMigration({source, target, opts:{batch, checkpoint, runId}})`；单行失败记 `migration_issues` 不中断整批；Reconciliation = 9 维（P8-3）。

---

## 7. ID MAPPING STRATEGY（不执行）

| 项 | 规划 |
|---|---|
| legacy table | 1.0 源表（如 `api_jhzyfw_com.users`） |
| legacy primary key | 1.0 `id`（BIGINT UNSIGNED AUTO_INCREMENT） |
| new table | 2.0 D1 表（如 `users`） |
| new primary key | D1 `id INTEGER PRIMARY KEY`（rowid）+ `public_id TEXT(ULID)` |
| stable mapping table | `legacy_id_maps`（DEFER，仅迁移期；`uk_legacy`, `ix_new`） |
| collision handling | 主键冲突 → 跳过并记 `migration_issues`(severity=error)；public_id 冲突 → ABORT（SC-02） |
| duplicate handling | 同 legacy 多行 → 按业务键去重（openid/unionid/手机号）；孤儿行 → `migration_issues` |
| missing FK handling | 缺失父行 → 建占位或记孤儿（SC-03）；`team_id` 缺失 → 归 `platform_root` |
| orphan records | 落 `migration_issues`；不静默丢弃 |
| idempotent rerun | `legacy_id_maps` + `doneTables` checkpoint；重跑跳过已迁表 |
| 临时表 | 仅迁移期使用；不污染正式业务表；独立授权说明（本规划轮不建） |

> 注意：不得污染正式业务表；如需临时表，须在后续执行授权中单独说明。本轮只规划。

---

## 8. VALIDATION / RECONCILIATION PLAN（不执行）

### 8.1 Row count reconciliation
- source rows（snapshot `row_counts_before.json`）vs transformed vs inserted vs skipped vs rejected vs archived vs expected difference。
- 剔除 EXCLUDED（`user_favorites` 等 shadow/legacy）→ 行守恒：`源参与迁移行 = migrated + archived + dropped + failed`。

### 8.2 Hash / checksum
- source logical hash（snapshot 已钉死 sha256）→ target logical hash（迁移后重算）。
- 稳定排序 hash；可空/生成字段（created_at 默认值、updated_at 触发器）排除。

### 8.3 Referential integrity
- 孤儿 participation / attendance / certificate / points / training 记录；
- 缺失 user / activity / occurrence；
- 重复 active check-in 违规（见 §8.4）。

### 8.4 Business invariants（必须检查）
```text
同一志愿者同一时刻最多只有一个活动处于已签到状态
已签到时主按钮=签退
签退后不得仍显示可重复签到状态
证书编号不得重复（id_pool 唯一）
积分总和与明细一致
历史报名/签到记录不得丢失
```

### 8.5 对账维度（10 维，PASS 判定）
行守恒 / 身份 / 关系 / 活动链 / 积分成长 / 培训结果 / 媒体引用 / 审计 / user_favorites 排除 / schema·版本·快照一致性（SC-01…SC-15 全清）→ **NO CUTOVER unless PASS**。

---

## 9. D1 IMPORT EXECUTION BOUNDARY（本轮只规划）

```text
D1 import authorized = NO
D1 import executed = NO
Migration executed = NO
Cutover executed = NO
```

后续 WP4-F（reconciliation）或实际 import 阶段方可授权：dry-run import / staging D1 import / production D1 import / reconciliation / Worker route switch / Cutover。**本轮不得提前执行。**

---

## 10. G-2 OFF-HOST COPY BLOCKER PLAN（记录）

```text
G-2 residual remains OPEN for Cutover.
Current snapshot is local-only on Tencent host (/www/backup/database/.../wp4d_authoritative_20260921_120656/).
Before Cutover, off-host copy must be completed and verified.
If off-host copy cannot be completed before Cutover, ABORT Cutover.
```

后续补录规划：
1. retry NAS（`/opt/backup_db_to_nas.sh` 或 `rsync/scp` 到另一服务器）；
2. sha256 校验 after copy（比对 `sha256_manifest.txt`）；
3. 生成 off-host copy evidence 文档；
4. 经独立 Git Closeout 提交；
5. 标记 G-2 residual CLOSED（仅 Cutover 前完成方可）。

---

## 11. ABORT RULES FOR FUTURE MIGRATION（定义后续 ABORT 条件）

- snapshot sha256 mismatch / snapshot missing file；
- row count file invalid（`row_counts_before.json` 缺失/损坏）；
- schema mismatch（源表清单与预期 131 对象不符）；
- target D1 schema 不匹配预期 86 表 frozen schema；
- id mapping collision unresolved（public_id 冲突）；
- orphan record rate 超阈值；
- duplicate active check-in 违规；
- certificate id collision；
- source/target reconciliation mismatch（10 维任一 FAIL）；
- **G-2 off-host missing before Cutover** → ABORT Cutover；
- 任何 destructive source operation 尝试 → ABORT；
- 任何 unapproved D1 write 尝试 → ABORT；
- evidence incomplete → ABORT。

---

## 12. FINAL GATE（P9 WP4-E Migration Planning）

```text
Repo identity confirmed = YES
Baseline read = YES
Authoritative snapshot input confirmed = YES
Copy-not-cut principle recorded = YES
Source → target mapping drafted = YES
Migration batch design drafted = YES
ID mapping strategy drafted = YES
Validation / reconciliation plan drafted = YES
D1 import boundary recorded = YES
G-2 off-host copy blocker recorded = YES
Future abort rules recorded = YES
Planning document created = YES

WP4-E Migration Planning = PASS
Ready for WP4-E Planning Git Closeout = YES
Ready for D1 Import = NO
D1 import executed = NO
Migration executed = NO
Cutover executed = NO
Source data modified = NO
Source schema modified = NO
D1 modified = NO
Worker modified = NO
DNS / route changed = NO
```

---

## 13. 纪律声明（本轮）

| 项 | 状态 |
|---|---|
| 执行 D1 import / SQL import / 写 D1 | ❌ NO |
| 修改源库 / 源结构 / 源数据 | ❌ NO |
| 重新 mysqldump / 重新 snapshot | ❌ NO |
| 迁移数据 / Cutover / 灰度 | ❌ NO |
| 修改 Worker / DNS·route / MySQL 用户权限 | ❌ NO |
| 删除 / 清空 / 移动 / 覆盖源数据 | ❌ NO |
| Git 提交 | ❌ NO（待用户授权后 Git Closeout） |
| 生产数据 / schema 修改 | ❌ **NO** |

**STOP — 不得进入 D1 import、不得迁移、不得 Cutover、不得 commit。** 下一步须用户另行显式授权：WP4-E Planning Git Closeout、WP4-E 实际执行轮（D1 import / 迁移）、或 G-2 off-host copy 补录。

---

## 引用

- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION.md` / `..._EVIDENCE_20260921_120656.md`
- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_EXECUTION_AUTHORIZATION_GATE.md`
- `P9_WP4D_AUTHORITATIVE_SNAPSHOT_DEFINITION.md`
- `P9_WP4D_PRE_EXECUTION_BOUNDARY_CHECK.md`
- `P9_WP4_PRODUCTION_MIGRATION_EXECUTION_DEFINITION.md`（§8 WP4-E / §9 对账 / §10 回滚）
- `D1-SCHEMA-TABLE-MATRIX.md` / `D1-DATABASE-DESIGN.md` / `D1-MIGRATION-DESIGN.md`
- `workers/wrangler.jsonc` / `workers/migrations/0001..0043`


## 13.1 SCOPE AUDIT COMPLIANCE（P9 WP4-E Planning Closeout 验收）

本轮为 **Planning only**（仅规划，不执行）。以下为验收清单逐条记录：

| 验收项 | 值 |
|---|---|
| P9 WP4-E Migration Planning | = PASS |
| Planning only | = YES（本轮仅规划，未导入/未迁移/未 Cutover/未 commit） |
| Ready for WP4-E Planning Git Closeout | = YES |
| Ready for D1 Import | = NO |
| D1 import executed | = NO |
| Migration executed | = NO |
| Cutover executed | = NO |
| Source data modified | = NO |
| Source schema modified | = NO |
| D1 modified | = NO |
| Worker modified | = NO |
| DNS / route changed | = NO |
| copy-not-cut principle | = recorded（§4 COPY-NOT-CUT PRINCIPLE） |
| authoritative snapshot input confirmed | = YES（§3，run_id=wp4d_authoritative_20260921_120656） |
| run_id | = wp4d_authoritative_20260921_120656 |
| source objects | = api 127 tables + 1 view + signup 3 tables = 131 objects |
| D1 target baseline | = 86 frozen schema tables（workers/migrations/0001..0043） |
| RBAC seed preserved / B0 SKIP | = YES（§6 B0 跳过，不覆盖 D1 既有 seed） |
| source to target mapping drafted | = YES（§5.1-5.7） |
| migration batch design | = B0-B20（§6） |
| ID mapping strategy | = drafted（§7） |
| validation / reconciliation plan | = drafted（§8，10 维对账） |
| D1 import boundary recorded | = YES（§9，D1 import authorized=NO） |
| G-2 off-host copy blocker recorded | = YES（§10，Cutover 前须补 off-host copy，否则 ABORT Cutover） |
| future abort rules recorded | = YES（§11，12 类 ABORT 条件） |
| GAP-RE-1 recorded | = YES（§5.7，双名源表 / srcKey 裁定） |
| SHADOW/LEGACY excluded tables recorded | = YES（§5.7，24 张 EXCLUDE 存档） |
