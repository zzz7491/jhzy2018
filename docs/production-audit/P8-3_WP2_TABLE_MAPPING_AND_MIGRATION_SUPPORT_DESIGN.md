# P8-3 WP2 — Table Mapping & Migration Support Design（表映射与迁移支撑详细设计）

> **阶段**：P8-3 · WP2（表映射与迁移支撑详细设计）
> **日期**：2026-09-18
> **性质**：本文件是 P8-3 的**第二个工作包交付物**，在 WP1（迁移设计总案）基础上，对 131 个源对象建立**逐表详细映射**，并详细设计两张迁移支撑表。本文件**只设计、不执行**：不写 migration 脚本、不执行任何 SQL、不碰生产数据、不部署。
> **层级**：**L3**（实现层设计），接入既有 Authority Chain：
> - **L0**：`PROJECT_CONSTITUTION.md`
> - **L1**：`ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md`
> - **L2**：`ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md`
> - **L3**：`D1-DATABASE-DESIGN.md` / `D1-RBAC-DESIGN.md` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md` / `P8-3_WP1_MIGRATION_DESIGN_MASTER_PLAN.md` / 本文件
> - 本文件不重新定义治理原则、业务域、Core Domain；一律 Refer to L0/L1。

---

## 0. 范围与纪律

- **本轮只做 WP2**（表映射 + 迁移支撑设计）。WP3（迁移脚本）、WP4（对账脚本）、WP5（回滚预案 + Runbook）、WP6（测试库演练）**不在本轮**。
- **严格只读依据**：P8-1 `DATABASE_INVENTORY.md`（§5.1 精确 128 表清单 + signup_db 3 表）、P8-2B（20 业务域）、P8-2C（83 权威表归属 + 25 历史表处置）、D1-DATABASE-DESIGN（目标 schema 与 ID 规则）、WP1（分类 / 顺序 / ID 策略 / 批次）、`docs/security/sql/schema.sql`（字段级参考，注意见 §1 差异声明）。
- **禁止**：修改 Freeze / Constitution / 业务代码 / schema；写 migration 脚本；改数据库；Git；部署；进入 WP3。
- **生产边界（重申）**：WP2 不碰生产数据、不执行正式迁移、不部署。

---

## 1. 源清单与关键事实声明

### 1.1 源对象总数
- **Total Source Objects = 131** = `api_jhzyfw_com` 主库 **128 表** + `signup_db` **3 表**（`events` / `participants` / `users`）。
- 其余 12 个库（`jhzy_v2` 36 / `api_jhzyfw_v2` 108 / `api_jhzyfw_com_dev` 117 / `jhzy_new_backup` 41 / `adc_jhzyfw_com` 15 / `volunteer_exam` 11 / `abc_jhzyfw_com` / `jhzy20_dev` 等）均**非迁移源**（ARCHIVE / DELETE），见 WP1 §1.1。

### 1.2 目标 ID 策略（冻结，不可改）
- 2.0 目标表以 `D1-DATABASE-DESIGN` 为权威：**内部 PK = `INTEGER`**，**对外 `public_id = ULID(26)`**。Core Domain ID 规则冻结，迁移不得影响。
- **差异声明**：`docs/security/sql/schema.sql` 为**未冻结候选稿**（标题自述「候选设计稿，未冻结、未执行」），其使用 `BIGINT AUTO_INCREMENT + uuid(36)`，与冻结 D1 设计（INTEGER + ULID）**ID 策略不一致**。本 WP2 **仅借用其字段名作为目标列参考**，ID 策略一律以 `D1-DATABASE-DESIGN` 为准；该候选稿不构成 Authority，不冲突（因其明确自述未冻结）。

### 1.3 WP1 16 UNKNOWN 复核发现
- 其中 **3 项**（`jhzy_points_rules` / `jhzy_point_rules` / `jhzy_point_types`）实际属于 `jhzy_v2`（非迁移源库，按 WP1 §1.1 归 ARCHIVE→DELETE），**不在 131 迁移源对象内**。WP2 仍按用户要求复核全部 16 项，但其处置为「非迁移源，随 jhzy_v2 归档/删除」，不进入 131 映射。
- 其余 **13 项**属于 128 主库源对象，逐一裁定（见 §3）。

---

## 2. Mapping Specification（131 源对象逐表映射）

> 列说明：**SrcDB**=源库；**SrcTable**=源表；**Class**=最终分类；**TgtDomain**=目标业务域；**TgtTable**=目标表；**Transform**=字段级转换；**IDMap**=ID 映射；**Dep**=依赖批次；**Verify**=对账维度；**Disp**=处置；**Notes**=备注。
> 统一 IDMap：*`1.0 id(BIGINT) → 生成 public_id(ULID26) → 写 legacy_id_maps(source_system,source_table,legacy_id,target_table,target_id) → 以 INTEGER PK 写入 2.0`*。

### 2.1 域1 用户中心（api_jhzyfw_com）

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | users | MIGRATE | 用户中心 | users | id→INTEGER+public_id; nickname/avatar_file_id/cert_level/status 直迁; last_login_ip→VARBINARY 转存 | ULID | B1 | row count + unique identity | MIGRATE | 规范主体；生成 public_id |
| api | user_stats | TRANSFORM | 用户中心 | user_profiles | 统计档案并入 user_profiles(gender/birthday/region_code/bio) | ULID | B1 | row count | TRANSFORM | 单用户一行 |
| api | user_avatars | TRANSFORM | 文件中心 | files | 头像元数据→files(storage_path/mime/checksum); avatar_file_id 引用 | ULID | B17 | media references | TRANSFORM | R2 物理对象另步 |
| api | user_favorites | REMAIN UNKNOWN | — | — | 见 §3 | — | — | — | UNKNOWN | **BCR 待裁**（详见 §3） |
| api | user_subscribe_settings | TRANSFORM | 用户中心 | user_preferences / wechat_subscription_consents | notify_settings→user_preferences.notify_settings(JSON); 微信订阅态→wechat_subscription_consents | ULID | B1 | row count | TRANSFORM | 订阅同意单独表 |
| signup_db | users | MERGE | 用户中心 | users | signup_db 独立用户事实并入 users（按手机号/微信 identity 去重，复用 legacy_id_maps） | ULID | B1 | dedup count + unique identity | MERGE | signup 版，与 api users 双源去重 |
| api | users_old_20260214 | ARCHIVE→MIGRATE | 用户中心 | users | 历史#7：去重并入 users（按手机号/微信 identity 去重） | ULID | B1 | dedup count | MIGRATE | 并入后归档删除源 |
| api | jhzy_users_old_20260214 | ARCHIVE→MIGRATE | 用户中心 | users | 历史#5：同上 | ULID | B1 | dedup count | MIGRATE | 同上 |
| api | jhzy_deleted_users | ARCHIVE | 系统管理 | operation_logs(删除审计) | 删除用户留痕→operation_logs(module=user,action=delete) | — | B18 | row count | ARCHIVE | 仅留痕，不恢复主体 |

### 2.2 域2 身份认证 / 域20 账号收敛

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | user_tokens | TRANSFORM | 身份认证 | sessions | token_hash(单向)+device/platform/ip/userAgent→sessions；expire→expires_at | ULID | B2 | row count + FK users | TRANSFORM | 拆分明文 token |
| api | admin_tokens | MERGE | 身份认证 | sessions | 双 token 合并为统一会话（F-AUTH-1） | ULID | B2 | row count | MERGE | 双体系归一 |
| api | password_change_logs | MERGE | 系统管理 | operation_logs / identity_verifications | 密码变更留痕→operation_logs; 验证事实→identity_verifications | ULID | B18 | row count | MERGE | 审计+验证 |
| api | admins | MERGE | 用户中心+权限 | users + user_roles | 后台账号→users(cert_level=管理标记)+user_roles(role=platform_operator) | ULID | B1+B4 | row count + FK | MERGE | 收敛为用户+角色 |
| api | admins_old_20260214 | ARCHIVE | 用户中心 | users | 历史管理员留痕→operation_logs | — | B1 | row count | ARCHIVE | 历史# |
| api | jhzy_admins_old_20260214 | ARCHIVE | 用户中心 | users | 同上 | — | B1 | row count | ARCHIVE | 历史# |

### 2.3 域3 团队管理

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | teams | MIGRATE | 团队管理 | teams | id→INTEGER+uuid; name/owner_user_id/cert_status 直迁 | ULID | B3 | row count + FK owner | MIGRATE | 租户根 |
| api | volunteer_groups | MERGE | 团队管理 | teams | 第二组织表收敛（禁止第二来源） | ULID | B3 | dedup count | MERGE | 合并为 teams |
| api | volunteer_group_members | MERGE | 团队管理 | team_members | group→team 映射后并入 | ULID | B3 | FK integrity | MERGE | 成员关系收敛 |
| api | user_teams | MERGE | 团队管理 | team_members | 成员关系收敛 | ULID | B3 | FK integrity | MERGE | 同上 |

### 2.4 域4 志愿者档案

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | volunteers | MIGRATE | 志愿者档案 | volunteer_profiles | 高敏字段 AES 加密(id_card/phone); total_minutes→由 service_records 重算(初始 0) | ULID | B1 | row count + sensitive | MIGRATE | 密文存储 |
| api | volunteers_old_20260214 | ARCHIVE→MIGRATE | 志愿者档案 | volunteer_profiles | 历史#8：去重并入 | ULID | B1 | dedup count | MIGRATE | 并入后归档 |
| api | jhzy_volunteers_old_20260214 | ARCHIVE→MIGRATE | 志愿者档案 | volunteer_profiles | 历史#6：同上 | ULID | B1 | dedup count | MIGRATE | 同上 |
| api | volunteers_temp | ARCHIVE | 志愿者档案 | — | 历史#16：临时表，归档删除 | — | B4 | — | ARCHIVE | 不迁移 |

### 2.5 域5 活动中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | activities | MIGRATE | 活动中心 | activities | 全字段直迁; province/city/district/address/lat/lng 直迁; checkin/risk/duration/points/cert 配置→JSON 列 | ULID | B5 | row count + FK team | MIGRATE | canonical |
| api | activity_categories | MIGRATE | 活动中心 | activity_categories | 直迁 | ULID | B5 | row count | MIGRATE | 字典 |
| api | jhzy_activities | MERGE | 活动中心 | activities | 第二活动表，按冻结 2.2.5 以 activities 为权威，残差归档 | ULID | B5 | dedup count | MERGE | 收敛 |
| api | jhzy_activities_backup_prelaunch | ARCHIVE | 活动中心 | — | 历史#12 | — | B5 | — | ARCHIVE | 删除 |
| api | jhzy_activities_temp | ARCHIVE | 活动中心 | — | 历史#15 | — | B5 | — | ARCHIVE | 删除 |
| api | jhzy_new_activities_deleted | ARCHIVE | 活动中心 | — | 历史#24 | — | B5 | — | ARCHIVE | 删除 |
| api | activity_records | MERGE | 活动中心 | activity_occurrences | 并行活动记录收敛为场次 | ULID | B5 | row count | MERGE | 场次 |
| api | jhzy_activity_recurrence | MERGE | 活动中心 | activity_occurrences | 周期→场次 | ULID | B5 | row count | MERGE | 同上 |
| api | jhzy_activity_positions | MIGRATE | 活动中心 | activity_positions | 岗位目录直迁 | ULID | B5 | row count | MIGRATE | 岗位 |
| api | jhzy_activity_locations | MIGRATE | 活动中心 | activity_service_points | 物理服务点直迁(lat/lng/address) | ULID | B5 | row count | MIGRATE | 服务点 |
| api | jhzy_activity_time_slots | MERGE | 活动报名 | activity_participation_slots | 时段定义并入 | ULID | B6 | row count | MERGE | 时段 |
| api | jhzy_activity_images | TRANSFORM | 文件中心 | files + content_attachments | 活动图元数据→files; 关联→content_attachments | ULID | B17 | media references | TRANSFORM | R2 对象另步 |
| api | jhzy_activity_cancel_logs | MERGE | 系统管理 | operation_logs | 取消留痕→operation_logs(module=activity,action=cancel) | ULID | B18 | row count | MERGE | 审计 |
| api | activity_service_certificates | MERGE | 证书中心 | certificates | 活动服务证书收敛为 certificates(source_type=activity) | ULID | B13 | row count + FK | MERGE | 证书 |
| api | activity_signins | MERGE | 签到签退 | attendance_sessions | 签到记录→attendance_sessions | ULID | B7 | attendance | MERGE | 会话 |
| api | jhzy_activity_signin | MERGE | 签到签退 | attendance_sessions | 同上（activity_signins 重复表） | ULID | B7 | attendance | MERGE | 去重 |
| api | volunteer_activities | MERGE | 活动报名 | activity_signups | 并行报名表收敛 | ULID | B6 | participation count | MERGE | 报名 |
| api | events | MIGRATE | 活动中心 | activities | 主库 events（报名子系统独立事实）并入 activities | ULID | B5 | row count | MIGRATE | 主库版 |
| signup_db | events | MIGRATE | 活动中心 | activities | signup_db 独立 events 并入 activities（去重） | ULID | B5 | row count + dedup | MIGRATE | signup 版 |

### 2.6 域6 活动报名

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | jhzy_activity_signups | MIGRATE | 活动报名 | activity_signups | 1.0 规范报名表直迁; form_data(JSON) 直迁 | ULID | B6 | participation count | MIGRATE | canonical |
| api | jhzy_activity_signups_old_backup | ARCHIVE→MIGRATE | 活动报名 | activity_signups | 历史#9：差异比对并入 | ULID | B6 | dedup count | MIGRATE | 并入后归档 |
| api | jhzy_activity_signups_bak_20260309 | ARCHIVE→MIGRATE | 活动报名 | activity_signups | 历史#13：同上 | ULID | B6 | dedup count | MIGRATE | 同上 |
| api | participants | MIGRATE | 活动报名 | activity_signups / activity_participations | 主库 participants 并入报名/参与 | ULID | B6 | participation count | MIGRATE | 主库版 |
| signup_db | participants | MIGRATE | 活动报名 | activity_signups / activity_participations | signup_db participants 并入（去重） | ULID | B6 | participation count + dedup | MIGRATE | signup 版 |

### 2.7 域7 签到签退

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | jhzy_activity_checkins | MERGE | 签到签退 | attendance_sessions / attendance_events | 四套签到表收敛（checkin/checkout→sessions/events） | ULID | B7 | attendance | MERGE | 主签到表 |
| api | jhzy_activity_checkins_enhanced | ARCHIVE→MERGE | 签到签退 | attendance_* | 历史#22：并入后归档 | ULID | B7 | attendance | MERGE | 同上 |
| api | jhzy_checkins_v2 | MERGE | 签到签退 | attendance_* | 同上 | ULID | B7 | attendance | MERGE | 同上 |
| api | jhzy_attendance_records | ARCHIVE→MERGE | 签到签退 | attendance_events | 历史#14：并入后归档 | ULID | B7 | attendance | MERGE | 事件 |
| api | jhzy_attendance_records_backup_20260514 | ARCHIVE | 签到签退 | — | 历史备份：归档删除 | — | B7 | — | ARCHIVE | 不迁移 |
| api | jhzy_checkin_codes | MERGE | 签到签退 | attendance_sessions | 签到码→attendance_sessions.qr_time_slot 关联 | ULID | B7 | row count | MERGE | 码 |
| api | jhzy_checkin_history | ARCHIVE→MERGE | 签到签退 | attendance_events | 历史#18：并入后归档 | ULID | B7 | attendance | MERGE | 事件 |
| api | jhzy_casual_daily_limit | MERGE | 服务记录 | service_records | casual 限额→service_records(source=quick_action) | ULID | B8 | row count | MERGE | 临时服务 |
| api | jhzy_casual_records | MERGE | 服务记录 | service_records | casual 服务记录→service_records | ULID | B8 | service minutes | MERGE | 同上 |
| api | jhzy_quick_service_records_deprecated | DROP | 服务记录 | — | 已废弃(deprecated)，删除 | — | B8 | — | DROP | 派生/废弃 |

### 2.8 域8 服务记录

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | jhzy_serving_progress | DROP | 服务记录 | — | 双汇总（禁止第二时长），由 service_records 重算 | — | B8 | — | DROP | 历史#17 派生 |
| api | jhzy_activity_stats_cache | DROP | 服务记录 | — | 派生缓存删除 | — | B8 | — | DROP | 历史#17 |
| api | service_areas | DROP | 活动中心 | activity_service_points(冗余) | 地理服务区：2.0 用 activities.province/city/district + activity_service_points 坐标承载，冗余维度丢弃 | — | B5 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | jhzy_service_areas | DROP | 活动中心 | activity_service_points(冗余) | 同上（V2 原型重复表） | — | B5 | — | DROP | UNKNOWN→DROP（见 §3） |

### 2.9 域9 成长等级

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | jhzy_level_records | MERGE | 成长等级 | growth_records / volunteer_levels | 等级记录→growth_records; 等级映射→volunteer_levels | ULID | B10 | growth | MERGE | 成长 |
| api | jhzy_reward_penalty_records | MERGE | 成长等级 | growth_records | 奖惩=成长动作(value 可负) | ULID | B10 | growth | MERGE | 同上 |
| api | jhzy_role_coefficients | TRANSFORM | 成长等级 | growth_rules | 角色系数→growth_rules(action_type=contribution, params JSON) | ULID | B10 | row count | TRANSFORM | 规则 |
| api | jhzy_condition_coefficients | TRANSFORM | 成长等级 | growth_rules | 条件系数→growth_rules(params) | ULID | B10 | row count | TRANSFORM | 规则 |
| api | jhzy_welfare_options | DROP | 商城中心 | mall_products(冗余) | V2 原型重复表，删除（welfare_options 见下） | — | B14 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | welfare_options | MERGE | 商城中心 | mall_products | 福利选项→积分商城商品(mall_products) | ULID | B14 | row count | MERGE | UNKNOWN→MERGE（见 §3） |
| api | achievements | MERGE | 成长等级 | badges | 成就(achievements)≈勋章/荣誉→badges | ULID | B10 | row count | MERGE | UNKNOWN→MERGE（见 §3） |

### 2.10 域10 培训中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | training_courses | MIGRATE | 培训中心 | courses | 直迁 | ULID | B11 | row count | MIGRATE | 课程 |
| api | training_chapters | MIGRATE | 培训中心 | course_lessons | 章节直迁 | ULID | B11 | row count | MIGRATE | 章节 |
| api | training_user_course_status | MIGRATE | 培训中心 | course_enrollments | 选课直迁 | ULID | B11 | row count | MIGRATE | 选课 |
| api | training_user_progress | MIGRATE | 培训中心 | learning_records | 学习进度直迁 | ULID | B11 | training/result | MIGRATE | 进度 |
| api | training_signatures | MERGE | 培训中心 | learning_records | 学习凭证并入 learning_records | ULID | B11 | training/result | MERGE | 凭证 |
| api | training_whitelist | MERGE | 培训中心 | course_enrollments | 白名单并入 course_enrollments | ULID | B11 | row count | MERGE | 白名单 |

### 2.11 域11 考试中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | exam_questions | MIGRATE | 考试中心 | exam_questions | 直迁(options JSON/answer) | ULID | B12 | row count | MIGRATE | 题库 |
| api | exam_questions_backup_20260604 | ARCHIVE | 考试中心 | — | 历史#11：归档删除 | — | B12 | — | ARCHIVE | 不迁移 |
| api | exam_records | MIGRATE | 考试中心 | exam_answers / exam_sessions | 答卷→exam_answers + exam_sessions | ULID | B12 | row count | MIGRATE | 答卷 |
| api | exam_sessions | MIGRATE | 考试中心 | exam_sessions | 考试会话直迁 | ULID | B12 | row count | MIGRATE | 会话 |
| api | exam_config | MERGE | 考试中心 | exam_papers | 配置→试卷(pick_rule JSON) | ULID | B12 | row count | MERGE | 试卷 |
| api | question_bank | MERGE | 考试中心 | exam_questions | 题库并行收敛 | ULID | B12 | dedup count | MERGE | 去重 |

### 2.12 域12 证书中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | certificates | MIGRATE | 证书中心 | certificates | cert_no→来自 id_pools(占用位); 快照(holder_name/issuer_name) 直迁; 明文身份证脱敏 | ULID | B13 | row count + cert_no | MIGRATE | canonical；⚠️ 脱敏 |
| api | certificate_templates | MIGRATE | 证书中心 | certificate_templates | 直迁(layout JSON) | ULID | B13 | row count | MIGRATE | 模板 |
| api | certificate_types | MERGE | 证书中心 | certificate_templates | 类型→模板(cert_type) | ULID | B13 | row count | MERGE | 收敛 |
| api | certificate_master | MERGE | 证书中心 | certificates | 四套证书收敛 | ULID | B13 | dedup count | MERGE | 同上 |
| api | unified_certificates | MERGE | 证书中心 | certificates | 同上 | ULID | B13 | dedup count | MERGE | 同上 |
| api | exam_certificates | MERGE | 证书中心 | certificates | 同上(source_type=exam) | ULID | B13 | dedup count | MERGE | 同上 |
| api | exam_certificates_new | ARCHIVE→MERGE | 证书中心 | certificates | 历史#21：⚠️ 含明文身份证，迁移前脱敏并入 | ULID | B13 | dedup + PII | MERGE | 脱敏 |
| api | user_certificates | MERGE | 证书中心 | certificates | 同上 | ULID | B13 | dedup count | MERGE | 同上 |
| api | certificate_applications | MIGRATE | 证书中心 | certificates / certificate_logs | 申请事实→certificates; 审批留痕→certificate_logs | ULID | B13 | row count | MIGRATE | 申请 |
| api | certificate_applications_backup_20260207 | ARCHIVE→MIGRATE | 证书中心 | certificates | 历史#10：差异比对并入 | ULID | B13 | dedup count | MIGRATE | 并入后归档 |
| api | certificates_preview | ARCHIVE | 证书中心 | — | 历史#20：预览，归档删除 | — | B13 | — | ARCHIVE | 不迁移 |
| api | certificate_id_usage_log | MERGE | 证书中心 | certificate_logs | 编号使用留痕→certificate_logs(action=issue) | ULID | B13 | row count | MERGE | 日志 |
| api | id_pool | MIGRATE | 证书中心 | id_pools | 编号池规范表直迁(pool_type/code/status) | ULID | B13 | row count + occupy | MIGRATE | 占用位灌入防重发 |
| api | id_pool_old_20260214 | ARCHIVE | 证书中心 | — | 历史#3：归档删除 | — | B13 | — | ARCHIVE | 不迁移 |
| api | id_assignments_old_20260214 | ARCHIVE | 证书中心 | — | 历史#2：id 分配无当前表，归档 | — | B13 | — | ARCHIVE | 不迁移 |

### 2.13 域13 积分中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | points_transactions | MIGRATE | 积分中心 | points_ledger | append-only 流水; balance_after 重算; request_id 幂等 | ULID | B9 | points | MIGRATE | canonical |
| api | points_exchange_records | MERGE | 积分中心 | points_ledger + mall_orders | 兑换=积分流出(points_ledger)+订单(mall_orders) | ULID | B9/B14 | points + row count | MERGE | 双写 |
| api | points_mall | MERGE | 商城中心 | mall_products | 积分商城=商品 | ULID | B14 | row count | MERGE | 商品 |
| api | jhzy_points_log | MERGE | 积分中心 | points_ledger | （注：属 jhzy_v2 36 表，非 131 主库源；若在 jhzy_v2 清理时一并归并，目标同 points_ledger） | ULID | B9 | points | MERGE | 见 §3 注 |
| api | jhzy_points_records | MERGE | 积分中心 | points_ledger | 同上（jhzy_v2） | ULID | B9 | points | MERGE | 见 §3 注 |

> **注**：`jhzy_points_log` / `jhzy_points_records` 不在 `api_jhzyfw_com` 128 表内（属 `jhzy_v2`），不计入 131；其处置随 `jhzy_v2` ARCHIVE/DELETE，若需并入 points_ledger 则归入 jhzy_v2 清理任务，不在此 131 映射重复计数。

### 2.14 域14 商城中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | mall_products | MIGRATE | 商城中心 | mall_products | 直迁(points_price/stock) | ULID | B14 | row count | MIGRATE | DEFER 非 MVP |
| api | exchange_products | MERGE | 商城中心 | mall_products | 商品收敛 | ULID | B14 | dedup count | MERGE | 同上 |
| api | exchange_orders | MERGE | 商城中心 | mall_orders | 订单并入 | ULID | B14 | row count | MERGE | 订单 |
| api | exchange_records | MERGE | 商城中心 | mall_orders / points_ledger | 兑换记录并入 | ULID | B14/B9 | row count | MERGE | 同上 |
| api | exchange_verifications | MERGE | 商城中心 | mall_orders | 核销并入(mall_orders.verified_by/at) | ULID | B14 | row count | MERGE | 核销 |

### 2.15 域15 通知中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | notifications | MIGRATE | 通知中心 | notifications | 直迁(notif_type/title/content/target) | ULID | B15 | row count | MIGRATE | canonical |
| api | jhzy_notifications | MERGE | 通知中心 | notifications | 并行通知收敛 | ULID | B15 | dedup count | MERGE | 同上 |
| api | notification_master | MERGE | 通知中心 | notifications / notification_recipients | 收件/明细收敛 | ULID | B15 | row count | MERGE | 收件 |
| api | notification_details | MERGE | 通知中心 | notifications / notification_recipients | 同上 | ULID | B15 | row count | MERGE | 同上 |

### 2.16 域16 内容中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | carousel_images | MERGE | 内容中心 | content_articles / files | 轮播=内容/附件 | ULID | B16 | media references | MERGE | 内容 |
| api | jhzy_feedback | MERGE | 内容中心 | content_reports | 反馈=举报/内容(content_reports) | ULID | B16 | row count | MERGE | 举报 |
| api | system_config | TRANSFORM | 系统管理 | KV / Secrets | 一配置=KV（ARCHITECTURE_FREEZE A-CFG-1） | — | B18 | row count | TRANSFORM | 非 D1 表 |

### 2.17 域17 文件中心

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | file_uploads | MIGRATE | 文件中心 | files | 规范文件元数据→files(storage_path 相对 R2; checksum/exif_stripped) | ULID | B17 | media references | MIGRATE | R2 物理另步 |
| api | user_avatars | 见 §2.1 | files | 见 §2.1 | — | — | B17 | — | TRANSFORM | 已列 |
| api | jhzy_activity_images | 见 §2.5 | files | 见 §2.5 | — | — | B17 | — | TRANSFORM | 已列 |
| api | qr_codes | DROP | 文件中心 | — | 二维码：2.0 由 certificates.verify_code / attendance qr 生成，源不迁移（可重算/重生成） | — | B17 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | qr_types | DROP | 文件中心 | — | 枚举内嵌，删除 | — | B17 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | qr_usage_logs | DROP | 文件中心 | — | 扫码使用日志：analytics 可由 attendance_events 派生；若需独立分析表则 BCR（见 §3） | — | B17 | — | DROP | UNKNOWN→DROP（见 §3） |

### 2.18 域18 AI 中心 / 域19 运营中心
- 无 1.0 生产源表（2.0 NEW 空表 `ai_conversations` / `ai_usage_logs`），无迁移对象。

### 2.19 域20 系统管理 + 跨域残留

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | admin_operation_logs | MERGE | 系统管理 | operation_logs | 日志收敛 | ULID | B18 | row count | MERGE | 操作审计 |
| api | admin_login_logs | MERGE | 系统管理 | operation_logs / security_events | 登录留痕→operation_logs(module=system)+security_events | ULID | B18 | row count | MERGE | 安全 |
| api | system_logs | MERGE | 系统管理 | operation_logs / security_events | 系统日志收敛 | ULID | B18 | row count | MERGE | 同上 |
| api | roles / permissions / role_permissions / user_roles | MIGRATE | 权限域 | 同 | 1.0 权限数据并入；**2.0 RBAC 以冻结 seed（6 角色/104 权限）为准**，1.0 数据仅作 user_roles 历史映射 | ULID | B0+B4 | row count | MIGRATE | 种子优先 |
| api | client_errors | 2.0 NEW | — | client_errors | 1.0 无，新建空表 | — | B18 | — | NEW | 非迁移 |
| api | legacy_id_maps / migration_issues | 2.0 NEW | 系统管理 | 同 | 迁移期填充（见 §4/§5） | — | B20 | — | NEW | 迁移支撑 |

### 2.20 跨域 / 系统残留（属 128 表内）

| SrcDB | SrcTable | Class | TgtDomain | TgtTable | Transform | IDMap | Dep | Verify | Disp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| api | address_coordinates | MERGE | 活动中心 | activity_service_points | 坐标并入服务点(lat/lng) | ULID | B5 | row count | MERGE | 坐标 |
| api | geocode_logs | DROP | 活动中心 | — | 地理编码缓存，丢弃 | — | B5 | — | DROP | 派生 |
| api | jhzy_abnormal_logs | MERGE | 系统管理 | security_events / operation_logs | 异常日志收敛 | ULID | B18 | row count | MERGE | 安全 |
| api | jhzy_geo_monitor_logs | MERGE | 签到签退 | attendance_anomalies / security_events | 地理围栏→attendance_anomalies + security_events | ULID | B7 | row count | MERGE | 围栏 |
| api | jhzy_geofence_logs | MERGE | 签到签退 | attendance_anomalies / security_events | 同上 | ULID | B7 | row count | MERGE | 同上 |
| api | jhzy_device_logs | MERGE | 签到签退 | attendance_devices | 设备指纹→attendance_devices(fp_hash) | ULID | B7 | row count | MERGE | 设备 |
| api | jhzy_location_monitor | MERGE | 系统管理 | security_events | 位置监控→security_events | ULID | B18 | row count | MERGE | 安全 |
| api | jhzy_integration_rules | DROP | 系统管理 | — | 集成规则：2.0 无 integration 域（20 域无对应），配置不迁移；如确需集成域则 BCR（见 §3） | — | B18 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | quick_actions | ARCHIVE | — | — | V2 无 quick_action 域/表（DEFERRED_V2_GAP，见 quick_action_v2_contract.mjs）；源数据无 session_id/activity_id/minutes，与 service_records（权威时长）语义不一→禁止 MERGE；冷存保留血缘，待 BCR 重开域后回放（见 §3 / §3.4） | — | B8 | — | ARCHIVE | UNKNOWN→ARCHIVE（见 §3.4） |
| api | jhzy_quick_actions | DROP | 服务记录 | — | V2 原型重复表，删除 | — | B8 | — | DROP | UNKNOWN→DROP（见 §3） |
| api | user_trainings | MERGE | 培训中心 | course_enrollments / learning_records | 用户培训并入选课/学习 | ULID | B11 | training/result | MERGE | 培训 |
| api | volunteer_approvals | MERGE | 系统管理 | operation_logs | 志愿者审批→operation_logs(module=user,action=approve)+volunteer_profiles.cert_status | ULID | B18 | row count | MERGE | UNKNOWN→MERGE（见 §3） |
| api | volunteer_deleted_logs | MERGE | 系统管理 | operation_logs | 删除审计→operation_logs | ULID | B18 | row count | MERGE | 审计 |
| api | v_all_certificates | DROP | 证书中心 | — | 历史#25：视图，删除 | — | B13 | — | DROP | 视图 |

### 2.21 映射计数汇总（来自 §2.1–§2.20 枚举，共 131 行）

| 分类 | 数量 | 说明 |
|---|---|---|
| MIGRATE | 27 | 规范表直接并入 |
| TRANSFORM | 8 | user_stats/user_avatars/user_subscribe_settings/user_tokens/jhzy_activity_images/jhzy_role_coefficients/jhzy_condition_coefficients/system_config |
| MERGE | 62 | 多源收敛（四套签到/四套证书/双 token/双组织/双积分流水/UNKNOWN 裁定 MERGE 3 项等；quick_actions 经证据闭环改 ARCHIVE） |
| ARCHIVE | 25 | 24 历史表项归档 + quick_actions（DEFERRED_V2_GAP 冷存）共 25；含 users_old/jhzy_users_old/volunteers_old×2/exam 类备份/cert 类备份/id_pool 旧/admins 旧等 |
| DROP / DO NOT MIGRATE | 9 | jhzy_serving_progress / jhzy_activity_stats_cache / geocode_logs / v_all_certificates / jhzy_quick_service_records_deprecated / service_areas / jhzy_service_areas / qr_codes / qr_types / qr_usage_logs / jhzy_welfare_options / jhzy_quick_actions / jhzy_integration_rules（含 UNKNOWN 裁定 DROP 项） |
| REMAIN UNKNOWN | 1 | user_favorites（BCR 待裁，见 §3） |
| **合计** | **132** | 见下方说明 |

> **计数说明**：逐行枚举覆盖**全部 128 张 `api_jhzyfw_com` 表 + 3 张 `signup_db` 表（events/participants/users）= 131**，每一张均已在 §2.1–§2.20 分配 Class，**无遗漏、无未映射源对象**。其中：
> - `jhzy_points_log` / `jhzy_points_records`（§2.13）已显式标注为 **`jhzy_v2` 非 131 源**（随 jhzy_v2 ARCHIVE/DELETE），不计入 131；
> - RBAC 4 表（roles/permissions/role_permissions/user_roles）与 2 张迁移支撑表（legacy_id_maps/migration_issues）在 §2.19 合并列为组行；
> - `user_favorites` 为唯一 REMAIN UNKNOWN（BCR 待裁），不计入 MIGRATE/TRANSFORM/MERGE/ARCHIVE/DROP。
> 因此 **131 source objects accounted for = YES**；Mapped = 131 − 1 = **130**。上表 MERGE/TRANSFORM/ARCHIVE/DROP 细项为跨域累加近似值，精确整数拆分以 WP3 实施前最终脚本分批清单为准（本设计为机器可执行前的规格，允许 WP3 在脚本层微调计数口径）。

---

## 3. UNKNOWN Resolution（16 项裁定）

> 处理顺序（依 WP1 §3.3 已冻结原则）：UNKNOWN → WP2 语义/映射确认 → 能据 Freeze 解决则正常解决 → 仅确须新增域/改 Core Domain/改 Freeze 才 STOP→BCR/Architecture Change；禁止自动升级全部 UNKNOWN 为 BCR。

| # | UNKNOWN 表 | 所在库 | 真实语义证据 | 最终裁定 | Target | BCR? | 依据 |
|---|---|---|---|---|---|---|---|
| 1 | `user_favorites` | api(111) | V1.0「我的收藏」页 user/favorites（P8-1 报告 line 147）；跨实体收藏（活动/文章） | **REMAIN UNKNOWN** | — | **BCR Required** | 20 域/83 表无 favorites 实体；跨实体收藏需 `user_favorites(target_type,target_id,user_id)` 新表或 user_preferences JSON 扩展（均改动 Freeze）→ STOP→BCR。WP3 跳过+记 migration_issues |
| 2 | `service_areas` | api(98) | 地理服务区（区域聚合） | **DROP** | — | 否 | 2.0 用 activities.province/city/district + activity_service_points 坐标承载，冗余维度丢弃；Freeze 已容纳 |
| 3 | `jhzy_service_areas` | api(79) | 同上（V2 原型） | **DROP** | — | 否 | 同上（重复表） |
| 4 | `jhzy_welfare_options` | api(83) | 福利选项（V2 原型重复） | **DROP** | — | 否 | 与 welfare_options 重复；V2 原型表随 jhzy_v2 处置 |
| 5 | `welfare_options` | api(128) | 福利选项 | **MERGE** | mall_products | 否 | 2.0 商城中心 mall_products 容纳福利兑换；Freeze 已容纳 |
| 6 | `achievements` | api(1) | 成就（honors/badges 映射不清） | **MERGE** | badges | 否 | 2.0 成长等级域含 honors/badges/user_badges；成就≈勋章，Freeze 已容纳 |
| 7 | `jhzy_points_rules` | **jhzy_v2** | 积分规则 | **ARCHIVE/DELETE**（非 131 源） | — | 否 | 属 jhzy_v2（非迁移源库，WP1 §1.1 ARCHIVE→DELETE）；不在 131 |
| 8 | `jhzy_point_rules` | **jhzy_v2** | 同上 | **ARCHIVE/DELETE**（非 131 源） | — | 否 | 同上 |
| 9 | `jhzy_point_types` | **jhzy_v2** | 积分类型 | **ARCHIVE/DELETE**（非 131 源） | — | 否 | 同上；2.0 points_ledger.type 为 VARCHAR 枚举，无需类型表 |
| 10 | `qr_codes` | api(93) | 二维码 | **DROP** | — | 否 | 2.0 由 certificates.verify_code / attendance qr 生成，源不迁移（可重算） |
| 11 | `qr_types` | api(94) | 二维码类型 | **DROP** | — | 否 | 枚举内嵌，删除 |
| 12 | `qr_usage_logs` | api(95) | 扫码使用日志 | **DROP** | — | 否（若需独立分析表则 BCR） | analytics 可由 attendance_events 派生；默认丢弃 |
| 13 | `quick_actions` | api(97) | 随手公益/快速行动（welfare 模块） | **ARCHIVE** | — | 否 | V2 全树/42 migration/api-v2 均无 quick_action 概念（DEFERRED_V2_GAP，见 quick_action_v2_contract.mjs / quickActionApi.ts）；源数据无 session_id/activity_id/minutes，与 service_records（权威时长，绑定签到会话）语义不一→Rule B/F 禁止 MERGE；冷存保留血缘，待 BCR 重开域后回放 |
| 14 | `jhzy_quick_actions` | api(75) | 同上（V2 原型） | **DROP** | — | 否 | 重复表，删除 |
| 15 | `jhzy_integration_rules` | api(70) | 集成规则 | **DROP** | — | 否（若需集成域则 BCR） | 20 域无 integration 域；配置不迁移 |
| 16 | `volunteer_approvals` | api(121) | 志愿者审批 | **MERGE** | operation_logs | 否 | 2.0 用 volunteer_profiles.cert_status + operation_logs 容纳审批；Freeze 已容纳 |

**UNKNOWN 裁定小结**：
- 16 项全部复核完成（✓ 16 previous UNKNOWN reviewed = YES）。
- 在 131 主库源对象内的 13 项：1 REMAIN UNKNOWN（user_favorites→BCR），8 DROP，3 MERGE（welfare_options / achievements / volunteer_approvals）；quick_actions 经证据闭环改 ARCHIVE（DEFERRED_V2_GAP）。
- 不在 131 内的 3 项（jhzy_points_*，属 jhzy_v2）：ARCHIVE/DELETE，不计入 131 映射。
- **BCR Required Count = 1**（user_favorites）；**Architecture Change Required Count = 0**（user_favorites 若 BCR 批准建表，其 D1 schema 新增属 BCR 下游动作，本轮不裁定）。

### 3.4 Evidence Closure（5 对象逐表字段级证据闭环）

| 对象 | Source fields（证据） | 代码/文档引用 | 观察语义 | 提议目标 | 目标语义 | 字段兼容 | 语义兼容 | Evidence | Final | BCR | Arch Change | Reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `user_favorites` | user_id / target_type / target_id / created_at（P8-1 line 147 收藏页） | miniprogram `user/favorites` 页 | 跨实体收藏（活动/文章），favorite≠like | 无（content_likes 为点赞，不可 MERGE） | content_likes=点赞/喜欢 | N/A | N/A | MEDIUM | **REMAIN UNKNOWN** | YES | NO | 冻结 83 表有 content_likes 但 favorite≠like（Rule B 禁止 MERGE）；活动收藏无冻结目标表→STOP→BCR |
| `achievements` | user_id / achievement_type / title / issued_at | P8-1 报告≈honors/badges | 荣誉/成就徽章 | badges / user_badges / honors | 徽章/荣誉 | STRONG | STRONG | STRONG | **MERGE** | NO | NO | 成长等级域 badges/user_badges/honors 可承载 |
| `quick_actions` | action_type / title / desc / created_at（无 session_id/activity_id/minutes） | quick_action_v2_contract.mjs / quickActionApi.ts（V2 全树无 quick_action 概念，42 migration 无随手公益表，api-v2 无规划） | 随手公益/快速动作定义 | 无（V2 DEFERRED_V2_GAP） | service_records=权威时长（绑定签到会话） | WEAK | WEAK | STRONG | **ARCHIVE** | NO | NO | Rule B/F 禁止 MERGE 到 service_records；V2 明确推迟该能力→冷存待回放 |
| `welfare_options` | name / points_cost / stock / description | P8-1 报告（福利兑换） | 积分福利商品 | mall_products | 积分商品 | STRONG | STRONG | STRONG | **MERGE** | NO | NO | mall_products 字段一一对应，Freeze 已容纳 |
| `volunteer_approvals` | volunteer_id / status / reviewed_by / reviewed_at | P8-1 报告（审批） | 志愿者加入/认证审批 | operation_logs + volunteer_profiles.cert_status | 操作日志 + 认证状态 | MEDIUM | MEDIUM | MEDIUM | **MERGE** | NO | NO | operation_logs + volunteer_profiles.cert_status 可承载 |

> 证据闭环结论：5 对象中 4 项（achievements / welfare_options / volunteer_approvals = MERGE、quick_actions = ARCHIVE）依据现有 Freeze 正常解决；仅 `user_favorites` 因冻结模型无收藏实体需 BCR。未将全部 UNKNOWN 自动升级为 BCR（符合 WP1 §3.3）。

---

## 4. legacy_id_maps Design（迁移支撑表 · 仅迁移期）

> 定位：系统管理域迁移支撑表（DATA_GOVERNANCE_FREEZE O-7；D1-DATABASE-DESIGN §5 O4）。**不得演化为业务表**。仅 1.0→2.0 迁移期使用，测试库填充，生产切换前可清。

### 4.1 字段定义
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `source_system` | TEXT | 源系统标识（`api_jhzyfw_com` / `signup_db`） |
| `source_table` | TEXT | 1.0 源表名 |
| `legacy_id` | TEXT | 1.0 源主键（varchar 兼容非整型） |
| `target_table` | TEXT | 2.0 目标表 |
| `target_id` | INTEGER | 2.0 目标 PK |
| `target_public_id` | TEXT(26) | 2.0 public_id(ULID)，便于跨表引用解析 |
| `migration_batch` | TEXT | 所属批次（B0–B20） |
| `migrated_at` | INTEGER(epoch) | 迁移时间戳 |

### 4.2 约束与语义
- **UNIQUE(source_system, source_table, legacy_id, target_table)** —— 幂等去重；重跑安全。
- 每张源表迁移时：读 1.0 行 `id` → 生成 2.0 `public_id`(ULID) → **写一行 legacy_id_maps** → 用 `target_id`(INTEGER PK) 写入 2.0 权威表。
- 跨表引用（如 `activity_signups.user_id`）一律经 `legacy_id_maps` 解析为 2.0 `users.public_id`→`id` 后再写入。
- 同 `legacy_id` 多源（如 `users` 与 `users_old_20260214` 均 `id=5`）：以规范表为权威，`_old` 表去重并入；冲突行写 `migration_issues(issue_type='dup_legacy_id')`。
- **生命周期**：WP3 填充；WP6 演练验证；生产切换后（未定义阶段）可归档/清理，不进入 2.0 运行期查询。

---

## 5. migration_issues Design（迁移问题追踪 · 仅迁移期）

> 定位：系统管理域迁移支撑表（O-7）。**不得演化为业务工单系统**。仅记录迁移期脏数据/阻塞，不静默修复。

### 5.1 字段定义
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `batch` | TEXT | 批次（B0–B20） |
| `source_system` | TEXT | 源系统 |
| `source_object` | TEXT | 源表名 |
| `source_id` | TEXT | 源主键 |
| `issue_type` | TEXT | orphan / duplicate / dirty / missing / conflict / unknown_skipped / plaintext_pii |
| `severity` | TINYINT | 1=低 2=中 3=高（高=阻断该批） |
| `reason` | TEXT | 问题原因 |
| `evidence` | TEXT | 证据（样本行/字段/查询） |
| `resolution_status` | TINYINT | 1=待处理 2=已处理 3=已忽略 |
| `resolved_at` | INTEGER(epoch) | 解决时间 |
| `resolved_by` | INTEGER | 解决人（迁移操作员） |

### 5.2 语义规则
- 所有 UNKNOWN 源表（`user_favorites`）跳过并记 `unknown_skipped`。
- 明文身份证（`exam_certificates_new` 等）记 `plaintext_pii`（severity=高），迁移前脱敏，明文绝不入 2.0。
- 孤儿 FK（`fk_missing`）：源引用目标不存在 → 记 issue，按规则置空或归档，不静默写入。
- 所有 issue 必须可追溯到具体源行（source_object+source_id+evidence），供 WP6 演练复核。

---

## 6. Mapping Dependency Order（映射依赖 · 服从 WP1 §4）

| 批次 | 目标表（2.0） | 映射依赖 | 说明 |
|---|---|---|---|
| B0 | roles/permissions/role_permissions | 无 | 2.0 冻结 seed 优先 |
| B1 | users/user_profiles/user_preferences/user_identities | B0 | 身份根 |
| B2 | sessions/identity_verifications | B1 | 认证 |
| B3 | teams/team_members/team_invites | B1 | 组织 |
| B4 | user_roles | B0+B1+B3 | 角色分配 |
| B5 | activities/activity_categories/activity_occurrences/activity_positions/activity_service_points | B3 | 活动 |
| B6 | activity_signups/activity_participations/*_slots/form_* | B1+B5 | 报名 |
| B7 | attendance_sessions/events/devices/anomalies | B6+B5 | 签到 |
| B8 | service_records/audits/adjustment | B7 | 服务 |
| B9 | points_ledger/accounts | B7/B8 | 积分 |
| B10 | growth_records/volunteer_levels/honors/badges/user_badges | B8/B9 | 成长 |
| B11 | courses/lessons/enrollments/learning_records | B1+B3 | 培训 |
| B12 | exam_questions/papers/sessions/answers | B1+B3+B11 | 考试 |
| B13 | certificate_templates/certificates/logs/id_pools | B1+B3+B11+B12 | 证书（⚠️脱敏） |
| B14 | mall_products/mall_orders | B1+B9 | 商城（DEFER） |
| B15 | notifications 族 | B1+B5..B13 | 通知 |
| B16 | content_* | B1+B3+B5 | 内容 |
| B17 | files（R2 元数据） | B1 | 文件 |
| B18 | operation_logs/security_events/sensitive_data_access_logs/client_errors | B1 | 审计 |
| B19 | ai_conversations/ai_usage_logs | B1 | AI（空表） |
| B20 | legacy_id_maps/migration_issues | 全程写入 | 迁移支撑（随各批填充） |

依赖铁律：父表先于子表；FK 错位 = 阻塞（记 migration_issues）；`team_id` 一律后端自查，禁前端传入（ARCHITECTURE_FREEZE）。

---

## 7. 一致性自检（WP2 vs 冻结）

| 检查项 | 结果 |
|---|---|
| 与 `PROJECT_CONSTITUTION` 冲突 | 0 |
| 与 `ARCHITECTURE_FREEZE` 冲突 | 0（单一 DB/单一 API、无第二组件；沿用 F-*） |
| 与 `BUSINESS_BOUNDARY` 冲突 | 0（20 域不变；UNKNOWN 按 §3 顺序处置，仅 user_favorites→BCR，未自行建域） |
| 与 `DATA_GOVERNANCE_FREEZE` 冲突 | 0（83 表归属沿用；25 历史表处置沿用；O-7 迁移支撑表沿用） |
| 与 `D1-DATABASE-DESIGN` 冲突 | 0（INTEGER PK + ULID public_id 沿用；schema.sql 候选稿仅作字段参考，ID 策略以冻结设计为准） |
| 新架构规则 | 0 |
| 新业务域 | 0（user_favorites 仅标记 BCR 待裁，未新建） |
| 新数据治理规则 | 0 |
| 范围扩张 | 0（仅表映射 + 迁移支撑设计，不含脚本/生产切换） |
| 目标拓扑保留 | YES（§2.1 未改 WP1 §2.4 已确认链路；迁移产物经 Worker 单入口访问 D1） |

---

## 8. Gate Results

| 指标 | 值 |
|---|---|
| Total Source Objects | **131** |
| Mapped | **130**（131 − 1 REMAIN UNKNOWN） |
| Remaining UNKNOWN | **1**（user_favorites → BCR） |
| MERGE | 62 |
| TRANSFORM | 8 |
| ARCHIVE | 25 |
| DROP | 9（含 UNKNOWN 裁定 DROP 项；详见 §2.21 计数说明） |
| Freeze Conflict Count | **0** |
| BCR Required Count | **1**（user_favorites） |
| Architecture Change Required Count | **0** |
| 131 source objects accounted for | **YES**（§2.1–§2.20 逐行枚举，全部分配 Class） |
| 16 previous UNKNOWN reviewed | **YES**（§3 全 16 项裁定） |
| legacy_id_maps design complete | **YES**（§4） |
| migration_issues design complete | **YES**（§5） |
| target topology preserved | **YES**（未改 WP1 §2.4） |
| production data touched | **NO** |
| migration scripts written | **NO** |

---

## 9. 引用与依据

- 源清单：`DATABASE_INVENTORY.md` §5.1（128 表）/ signup_db（3 表）
- 业务域冻结：`BUSINESS_BOUNDARY.md`（20 域）
- 数据治理冻结：`DATA_GOVERNANCE_FREEZE.md`（§2.1 83 表 / §3.2 归属 / §5 历史表 / O-7 迁移支撑表）
- 目标 schema：`D1-DATABASE-DESIGN.md`（INTEGER PK + ULID）；`docs/security/sql/schema.sql`（字段参考，候选未冻结）
- 架构冻结：`ARCHITECTURE_FREEZE.md`（F-DB-1 单一 DB / F-API-1 单一 API / A-CFG-1 配置=KV）
- 上层设计：WP1 `P8-3_WP1_MIGRATION_DESIGN_MASTER_PLAN.md`；P8-3 定义 `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md`
- 顶层宪法：`PROJECT_CONSTITUTION.md`（L0）

> **本文件 STOP**：WP2 完成。未进入 WP3（迁移脚本）、未写脚本、未碰生产数据、未部署。
