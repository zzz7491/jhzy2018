# P8-3 WP1 — Migration Design Master Plan（迁移设计总案）

> **阶段**：P8-3 · WP1（迁移设计总案）
> **日期**：2026-09-18
> **性质**：本文件是 P8-3 的**第一个工作包交付物**，定义 1.0 → 2.0 迁移的**总体设计**。本文件**只设计、不执行**：不写迁移脚本、不执行任何 SQL、不碰生产数据、不部署。
> **层级**：**L3**（实现层设计），接入既有 Authority Chain：
> - **L0**：`PROJECT_CONSTITUTION.md`
> - **L1**：`ARCHITECTURE_FREEZE.md` / `BUSINESS_BOUNDARY.md` / `DATA_GOVERNANCE_FREEZE.md`
> - **L2**：`ADR-DATABASE-MYSQL-TO-D1.md`（ADR-001）/ `P5_FINAL_FREEZE.md` / `ARCHITECTURE_TARGET.md`
> - **L3**：`D1-DATABASE-DESIGN.md` / `D1-RBAC-DESIGN.md` / `PERMISSION-CATALOG` / `ROLE-PERMISSION-MATRIX` / `P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md`（本文件属此层，迁移设计）
> - 本文件不重新定义治理原则、业务域、Core Domain；一律 Refer to L0/L1。

---

## 0. 范围与纪律

- **本轮只做 WP1**（迁移设计总案）。WP2（表映射与 `legacy_id_maps`/`migration_issues` 设计）、WP3（迁移脚本）、WP4（对账脚本）、WP5（回滚预案 + Runbook）、WP6（测试库演练）**不在本轮**。
- **严格只读依据**：P8-1 资产台账（`SYSTEM_MASTER_INVENTORY.md` / `DATABASE_INVENTORY.md`）、P8-2B（20 业务域冻结）、P8-2C（83 权威表归属 + 25 历史表处置）、D1-DATABASE-DESIGN（目标 schema 与 ID 规则）。
- **禁止**：修改 Freeze / Constitution / 业务代码 / schema；写 migration 脚本；改数据库；Git；部署；进入 WP2。
- **生产边界（重申）**：WP1 不碰生产数据、不执行正式迁移、不部署。

---

## 1. Source Systems（数据源）

### 1.1 1.0 数据源总览

| 实例 / 库 | 表数 | 分类 | 是否迁移候选 |
|---|---|---|---|
| **`api_jhzyfw_com`** | **128** | 生产主库（共享，8+ 站点引用） | **是（唯一必须迁移的数据源）** |
| `signup_db` | 3（`events`/`participants`/`users`） | 报名子系统（含独立事实） | **是（数据并入 活动中心/报名/用户中心）** |
| `jhzy_v2` | 36 | 2.0 设计基线 / 过渡 | 否 → ARCHIVE → DELETE（无 training 表，非权威） |
| `api_jhzyfw_v2` | 108 | 过渡运行库 | 否 → ARCHIVE → DELETE |
| `api_jhzyfw_com_dev` | 117 | 开发库 | 否 → ARCHIVE → DELETE |
| `jhzy_new_backup` | 41 | 导航备份（无站点引用） | 否 → ARCHIVE → DELETE |
| `adc_jhzyfw_com` | 15 | 孤立子系统（访问方 UNKNOWN） | 否 → ARCHIVE（不据 UNKNOWN 裁定） |
| `volunteer_exam` | 11 | 考试子系统（访问方 UNKNOWN） | 否 → ARCHIVE（同上） |
| `abc_jhzyfw_com` / `jhzy20_dev` | 0 | 空库 | 否 → DELETE |

### 1.2 迁移候选范围（精确）

- **明确迁移**：`api_jhzyfw_com` 的 128 张表中，除去 25 项历史/备份/临时表后，剩余 **103 张业务表** + `signup_db` 的 **3 张** = **106 张业务源表**参与迁移设计。
- **明确不迁移（ARCHIVE/DELETE）**：`api_jhzyfw_com` 的 **25 项历史/备份/临时/缓存/视图表**（§5.2），以及全部其它 12 个库（§5.3）。
- **迁移源表总数 = 131**（128 + 3）。其中 25 项历史表归入 ARCHIVE/DROP 类，106 项业务表归入 MIGRATE/TRANSFORM/MERGE/UNKNOWN 类。

### 1.3 不迁移的明确理由（冻结依据）

- `api_jhzyfw_com` 作为 MySQL **实例淘汰**（P8-2 §4.2），数据迁出后实例退役；淘汰 ≠ 立即删除（DATA_GOVERNANCE_FREEZE §5.1）。
- 其余 12 库均非权威数据源：`jhzy_v2`/`api_jhzyfw_v2`/`api_jhzyfw_com_dev` 为过渡/开发/备份；`adc`/`volunteer_exam` 访问方 UNKNOWN；`abc`/`jhzy20_dev` 为空库。

---

## 2. Target（目标）

### 2.1 唯一目标数据库

- **2.0 唯一权威库 = Cloudflare D1（SQLite 3）**，经 Workers（`/api/v2`）单入口访问（ARCHITECTURE_FREEZE F-DB-1 / F-API-1，单一 DB / 单一 API）。
- **二进制不入库**：文件物理存 R2 单桶，D1 仅存 `files` 元数据（ARCHITECTURE_FREEZE F-DB-7；D1-STORAGE-DESIGN §2）。

### 2.2 对应现有 Core Domain / 业务域

- 目标权威表 = **83 张 D1 权威表**，分布于 **20 个已冻结业务域**（DATA_GOVERNANCE_FREEZE §2.1 / §3.2），逐表归属已冻结且不可变更（O-8：归属变更须走 BCR）。
- **禁止创造第二套数据模型**：所有 1.0 多源并存表（如 `activities`+`jhzy_activities`、`certificates`+`certificate_master`+`unified_certificates`+`exam_certificates`、`jhzy_activity_checkins` 四套签到表）必须**收敛到唯一权威表**，不得新建平行表（BUSINESS_BOUNDARY §2 铁律；DATA_GOVERNANCE_FREEZE §2.2 各域"禁止第二来源"）。

### 2.3 迁移支撑表（DEFER，迁移期专用）

- `legacy_id_maps`、`migration_issues`：归系统管理域，仅 1.0→2.0 迁移期使用，**不得演化为业务表**（DATA_GOVERNANCE_FREEZE O-7；D1-DATABASE-DESIGN §5 O4）。

### 2.4 目标部署拓扑（Target Deployment Topology — 已确认链路）

> 本节显式记录嘉禾志愿 2.0 **已确认的生产访问拓扑**。WP1 只设计数据迁移、**不实施**网络 / 网关 / 部署修改；本节仅作边界记录，防止迁移设计被误解为可改变正式生产访问拓扑。

**中国大陆用户 / 微信小程序 / 管理端** 的正式访问链路（自上而下）：

中国大陆用户 / 微信小程序 / 管理端
→ 国内备案域名
→ 腾讯云国内服务器（国内接入 / 网关 / 反向代理）
→ Cloudflare Worker（`/api/v2` 单入口）
→ Cloudflare D1（2.0 唯一权威业务数据库）
→ R2 / KV 等 Cloudflare 服务（二进制 / KV / Secrets）

**关键边界（5 条，已确认）**：
1. **腾讯云承担中国大陆对外服务入口**：国内用户流量统一经腾讯云国内服务器接入 / 网关 / 反向代理，再转发至 Cloudflare Worker。
2. **腾讯云 MySQL 不作为 2.0 正式业务数据库**：2.0 权威业务数据仅在 Cloudflare D1；腾讯云侧 MySQL（如存在）仅作国内接入 / 网关用途，不持有 2.0 权威业务数据。
3. **Cloudflare D1 保存 2.0 权威业务数据**：与 §2.1 一致，D1 为唯一权威库（ARCHITECTURE_FREEZE F-DB-1 单一 DB）。
4. **客户端不得因迁移设计而绕过腾讯云国内入口直接改变正式生产访问拓扑**：WP1 的迁移映射 / ID 策略 / 批次设计等**不改变**既有访问链路；迁移设计产物（脚本 / 对账 / Runbook）一律经 Worker 单入口访问 D1，不得引入前端直连或第二入口（F-API-1 单一 API）。
5. **WP1 仍只设计数据迁移，不实施网络 / 网关 / 部署修改**：本节拓扑为既成事实记录，非本轮实施对象。

---

## 3. Migration Classification（迁移分类）

**图例**：
- **MIGRATE** — 1.0 规范表 → 2.0 权威表（数据并入 + MySQL→D1 字段级 TRANSFORM）
- **TRANSFORM** — 需结构性重排（拆列/合列/重算余额/类型映射）后并入 2.0 权威表
- **MERGE** — 多张 1.0 表收敛为一张 2.0 权威表（去重/合并）
- **ARCHIVE** — 历史/备份/临时表，转冷存（R2/离线），主库不再持有，随后删除
- **DROP / DO NOT MIGRATE** — 派生/第二来源/缓存/视图，禁止成为权威，不迁移
- **UNKNOWN** — WP1 阶段证据或映射依据不足，尚不能确定 2.0 权威目标（**不代表**必须改 Freeze）；按 §3.3 顺序处置（WP2 澄清 → 可依据 Freeze 解决则正常解决 → 仅确需新增域/改 Core Domain/改 Freeze 才 STOP→BCR/Architecture Change）

### 3.1 分类总表（按 20 业务域）

#### 域1 用户中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `users` | MIGRATE | `users` | 规范主体；pk BIGINT→INTEGER + 生成 public_id ULID |
| `user_stats` | TRANSFORM | `user_profiles` | 统计档案并入资料表 |
| `user_avatars` | TRANSFORM | `files` | 头像元数据→R2；`avatar_file_id` 引用 |
| `user_favorites` | UNKNOWN | — | 收藏，83 权威表无对应域 |
| `user_subscribe_settings` | TRANSFORM | `user_preferences` / `wechat_subscription_consents` | 通知偏好并入 |
| `users_old_20260214` | ARCHIVE→MIGRATE | `users` | 历史#7：去重并入后归档删除 |
| `jhzy_users_old_20260214` | ARCHIVE→MIGRATE | `users` | 历史#5：去重并入后归档删除 |

#### 域2 身份认证
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `user_tokens` | TRANSFORM | `sessions` | 拆分为 `token_hash`（单向）+ device/platform/ip/userAgent |
| `admin_tokens` | MERGE | `sessions` | 双 token 体系合并为统一会话（F-AUTH-1） |
| `password_change_logs` | MERGE | `operation_logs` / `identity_verifications` | 密码变更留痕 |
| `identity_verifications` / `phone_verifications` | —（2.0 NEW） | 同 | 1.0 无对应 SSOT 事实表；2.0 冻结新建，源数据缺失 → 由注册/绑定流程重建（不属迁移对象） |

#### 域3 团队管理
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `teams` | MIGRATE | `teams` | 租户根规范表 |
| `volunteer_groups` | MERGE | `teams` | 第二组织表收敛（禁止第二来源） |
| `volunteer_group_members` | MERGE | `team_members` | 成员关系收敛 |
| `user_teams` | MERGE | `team_members` | 成员关系收敛 |
| `team_invites` | —（2.0 NEW） | 同 | 1.0 无；新建 |

#### 域4 志愿者档案
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `volunteers` | MIGRATE | `volunteer_profiles` | 规范档案；高敏字段密文 |
| `volunteers_old_20260214` | ARCHIVE→MIGRATE | `volunteer_profiles` | 历史#8 |
| `jhzy_volunteers_old_20260214` | ARCHIVE→MIGRATE | `volunteer_profiles` | 历史#6 |
| `volunteers_temp` | ARCHIVE | — | 历史#16：归档删除 |

#### 域5 活动中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `activities` | MIGRATE | `activities` | 规范活动主表（canonical） |
| `activity_categories` | MIGRATE | `activity_categories` | 分类字典 |
| `jhzy_activities` | MERGE | `activities` | 第二活动表，按冻结 2.2.5 以 `activities` 为权威，残差归档 |
| `jhzy_activities_backup_prelaunch` | ARCHIVE | — | 历史#12 |
| `jhzy_activities_temp` | ARCHIVE | — | 历史#15 |
| `jhzy_new_activities_deleted` | ARCHIVE | — | 历史#24 |
| `activity_records` | MERGE | `activity_occurrences` | 并行活动记录收敛为场次 |
| `volunteer_activities` | MERGE | `activity_signups` | 并行报名表收敛 |
| `events`（`signup_db`） | MIGRATE | `activities` | 报名子系统独立事实并入 |
| `jhzy_activity_positions` | MIGRATE | `activity_positions` | 岗位目录 |
| `jhzy_activity_locations` | MIGRATE | `activity_service_points` | 物理服务点 |
| `jhzy_activity_recurrence` | MERGE | `activity_occurrences` | 周期→场次 |
| `jhzy_activity_time_slots` | MERGE | `activity_participation_slots` | 时段定义 |
| `jhzy_activity_images` | TRANSFORM | `files` + `content_attachments` | 活动图元数据→R2 |
| `jhzy_activity_cancel_logs` | MERGE | `operation_logs` | 取消留痕 |

#### 域6 活动报名
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `jhzy_activity_signups` | MIGRATE | `activity_signups` | 1.0 规范报名表 |
| `jhzy_activity_signups_old_backup` | ARCHIVE→MIGRATE | `activity_signups` | 历史#9：差异比对并入 |
| `jhzy_activity_signups_bak_20260309` | ARCHIVE→MIGRATE | `activity_signups` | 历史#13 |
| `participants`（`signup_db`） | MIGRATE | `activity_signups` / `activity_participations` | 报名子系统 |
| `form_definitions` 等 | —（2.0 NEW） | 同 | 动态表单引擎 2.0 新建；1.0 报名 `form_data` JSON 为唯一来源线索 |

#### 域7 签到签退
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `jhzy_activity_checkins` | MERGE | `attendance_sessions` / `attendance_events` | 四套签到表收敛 |
| `jhzy_checkins_v2` | MERGE | `attendance_*` | 同上 |
| `jhzy_attendance_records` | ARCHIVE→MERGE | `attendance_events` | 历史#14：并入后归档 |
| `jhzy_checkin_codes` | MERGE | `attendance_sessions` | 签到码 |
| `jhzy_checkin_history` | ARCHIVE→MERGE | `attendance_events` | 历史#18 |
| `jhzy_activity_checkins_enhanced` | ARCHIVE→MERGE | `attendance_*` | 历史#22 |
| `activity_signins` | MERGE | `attendance_sessions` | 签到记录 |
| `jhzy_casual_daily_limit` / `jhzy_casual_records` | MERGE | `service_records` / `quick_actions`（UNKNOWN 待裁） | 临时/ casual 服务 |

#### 域8 服务记录
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `jhzy_serving_progress` | DROP | — | 双汇总（2.2.8 禁止第二时长），由 `service_records` 重算 |
| `jhzy_activity_stats_cache` | DROP | — | 历史#17：派生缓存删除 |
| `service_areas` / `jhzy_service_areas` | UNKNOWN | — | 地理服务区，83 权威表无对应 |

#### 域9 成长等级
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `jhzy_level_records` | MERGE | `growth_records` / `volunteer_levels` | 等级记录收敛 |
| `jhzy_reward_penalty_records` | MERGE | `growth_records` | 奖惩=成长动作 |
| `jhzy_role_coefficients` / `jhzy_condition_coefficients` | TRANSFORM | `growth_rules` | 系数→规则 |
| `jhzy_welfare_options` / `welfare_options` | UNKNOWN | — | 福利，83 权威表无对应 |

#### 域10 培训中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `training_courses` | MIGRATE | `courses` | 课程 |
| `training_chapters` | MIGRATE | `course_lessons` | 章节 |
| `training_user_course_status` | MIGRATE | `course_enrollments` | 选课 |
| `training_user_progress` | MIGRATE | `learning_records` | 学习进度 |
| `training_signatures` | MERGE | `learning_records` | 学习凭证 |
| `training_whitelist` | MERGE | `course_enrollments` | 白名单 |

#### 域11 考试中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `exam_questions` | MIGRATE | `exam_questions` | 题库 |
| `exam_questions_backup_20260604` | ARCHIVE | — | 历史#11 |
| `exam_records` | MIGRATE | `exam_answers` / `exam_sessions` | 答卷 |
| `exam_sessions` | MIGRATE | `exam_sessions` | 考试会话 |
| `exam_config` | MERGE | `exam_papers` | 配置→试卷 |
| `question_bank` | MERGE | `exam_questions` | 题库并行 |

#### 域12 证书中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `certificates` | MIGRATE | `certificates` | 规范证书 |
| `certificate_templates` | MIGRATE | `certificate_templates` | 模板 |
| `certificate_types` | MERGE | `certificate_templates` | 类型→模板 |
| `certificate_master` | MERGE | `certificates` | 四套证书收敛 |
| `unified_certificates` | MERGE | `certificates` | 同上 |
| `exam_certificates` | MERGE | `certificates` | 同上 |
| `user_certificates` | MERGE | `certificates` | 同上 |
| `activity_service_certificates` | MERGE | `certificates` | 同上 |
| `certificate_applications` | MIGRATE | `certificates` / `certificate_logs` | 申请事实 |
| `certificate_applications_backup_20260207` | ARCHIVE→MIGRATE | `certificates` | 历史#10 |
| `certificates_preview` | ARCHIVE | — | 历史#20 |
| `certificate_id_usage_log` | MERGE | `certificate_logs` | 编号使用留痕 |
| `id_pool` | MIGRATE | `id_pools` | 编号池规范表 |
| `id_pool_old_20260214` | ARCHIVE | — | 历史#3 |
| `id_assignments_old_20260214` | ARCHIVE | — | 历史#2（id 分配，无当前表） |
| `exam_certificates_new` | ARCHIVE→MIGRATE | `certificates` | 历史#21：⚠️ 含明文身份证，迁移须脱敏 |
| `achievements` | UNKNOWN | — | 成就，83 权威表无对应（honors/badges 映射不清） |

#### 域13 积分中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `points_transactions` | MIGRATE | `points_ledger` | 规范流水（append-only，重算 balance_after） |
| `points_exchange_records` | MERGE | `points_ledger` + `mall_orders` | 兑换=积分流出 |
| `points_mall` | MERGE | `mall_products` | 积分商城=商品 |
| `jhzy_points_log` / `jhzy_points_records` | MERGE | `points_ledger` | 并行流水收敛 |
| `jhzy_points_stats` | DROP | — | 派生余额快照，重算 |
| `jhzy_points_rules` / `jhzy_point_rules` / `jhzy_point_types` | UNKNOWN | — | 积分规则，2.0 积分中心无 rules 表（83 无对应） |

#### 域14 商城中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `mall_products` | MIGRATE | `mall_products` | DEFER（非 MVP） |
| `exchange_products` | MERGE | `mall_products` | 商品收敛 |
| `exchange_orders` | MERGE | `mall_orders` | 订单 |
| `exchange_records` | MERGE | `mall_orders` / `points_ledger` | 兑换记录 |
| `exchange_verifications` | MERGE | `mall_orders` | 核销 |

#### 域15 通知中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `notifications` | MIGRATE | `notifications` | 规范站内通知 |
| `jhzy_notifications` | MERGE | `notifications` | 并行通知收敛 |
| `notification_master` / `notification_details` | MERGE | `notifications` / `notification_recipients` | 收件/明细收敛 |
| `message_templates` 等 | —（2.0 NEW） | 同 | 1.0 无，新建 |

#### 域16 内容中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `carousel_images` | MERGE | `content_articles` / `files` | 轮播=内容/附件 |
| `jhzy_feedback` | MERGE | `content_reports` | 反馈=举报/内容 |
| `system_config` | TRANSFORM | KV / Secrets（非 D1 表） | 一配置=KV（ARCHITECTURE_FREEZE A-CFG-1） |

#### 域17 文件中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `file_uploads` | MIGRATE | `files` | 规范文件元数据→R2 |
| `user_avatars` | 见域1 | `files` | 见域1 |
| `jhzy_activity_images` | 见域5 | `files` | 见域5 |
| `qr_codes` / `qr_types` / `qr_usage_logs` | UNKNOWN | — | 二维码，83 权威表无对应 |

#### 域18 AI 中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| （无） | —（2.0 NEW） | `ai_conversations` / `ai_usage_logs` | 1.0 无生产 AI 实现，新建空表 |

#### 域19 运营中心
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| （无） | — | — | 跨域只读聚合，无自有表（禁止产生权威数据） |

#### 域20 系统管理
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `admins` | MERGE | `users` + `user_roles` | 后台账号收敛为用户+角色 |
| `admin_levels` | MERGE | `roles` / `volunteer_levels` | 等级→角色/等级 |
| `admin_operation_logs` | MERGE | `operation_logs` | 日志收敛 |
| `admin_login_logs` | MERGE | `operation_logs` / `security_events` | 登录留痕 |
| `system_logs` | MERGE | `operation_logs` / `security_events` | 系统日志收敛 |
| `roles` / `permissions` / `role_permissions` / `user_roles` | MIGRATE | 同 | 1.0 权限数据并入；**2.0 RBAC 以冻结 seed（6 角色/104 权限）为准**，1.0 数据仅作 `user_roles` 历史映射 |
| `client_errors` | —（2.0 NEW） | 同 | 1.0 无，新建 |
| `legacy_id_maps` / `migration_issues` | —（2.0 NEW） | 同 | 迁移期填充 |

#### 跨域 / 系统残留（属 128 表内）
| 源表 | 分类 | 2.0 目标 | 说明 |
|---|---|---|---|
| `address_coordinates` | MERGE | `activity_service_points` | 坐标并入服务点 |
| `geocode_logs` | DROP | — | 地理编码缓存，丢弃 |
| `jhzy_abnormal_logs` | MERGE | `security_events` / `operation_logs` | 异常日志 |
| `jhzy_geo_monitor_logs` / `jhzy_geofence_logs` | MERGE | `attendance_anomalies` / `security_events` | 地理围栏 |
| `jhzy_device_logs` | MERGE | `attendance_devices` | 设备指纹 |
| `jhzy_location_monitor` | MERGE | `security_events` | 位置监控 |
| `jhzy_integration_rules` | UNKNOWN | — | 集成规则，83 无对应 |
| `quick_actions` / `jhzy_quick_actions` | UNKNOWN | — | 快捷服务，83 无对应 |
| `user_trainings` | MERGE | `course_enrollments` / `learning_records` | 用户培训 |
| `volunteer_approvals` | UNKNOWN | — | 志愿者审批，映射不清 |
| `volunteer_deleted_logs` | MERGE | `operation_logs` | 删除审计（§5.2 注：非历史表） |
| `v_all_certificates` | DROP | — | 历史#25：视图，删除 |

### 3.2 分类计数（基于 131 个迁移源对象）

| 分类 | 数量 | 说明 |
|---|---|---|
| MIGRATE | ~58 | 规范表直接并入 |
| TRANSFORM | ~10 | 结构性重排（user_tokens→sessions、points_transactions→points_ledger、system_config→KV 等） |
| MERGE | ~45 | 多源收敛（四套签到、四套证书、双 token、双组织、双积分流水等） |
| ARCHIVE | 24 | 25 历史表项中除 1 项纯 DROP 外，均先归档 |
| DROP / DO NOT MIGRATE | ~9 | 派生/缓存/视图/第二来源（jhzy_serving_progress、jhzy_activity_stats_cache、geocode_logs、v_all_certificates 等） |
| UNKNOWN | 16 | 见 §3.3 |
| **合计** | **131** | 128（主库）+ 3（signup_db） |

### 3.3 UNKNOWN 清单（16 项 — WP1 尚不能确定迁移映射；按下列顺序处置，禁自动升级 BCR）

1. `user_favorites` — 收藏，无对应权威域
2. `service_areas` — 地理服务区
3. `jhzy_service_areas` — 同上
4. `jhzy_welfare_options` — 福利
5. `welfare_options` — 同上
6. `achievements` — 成就（honors/badges 映射不清）
7. `jhzy_points_rules` — 积分规则（2.0 无 rules 表）
8. `jhzy_point_rules` — 同上
9. `jhzy_point_types` — 同上
10. `qr_codes` — 二维码
11. `qr_types` — 同上
12. `qr_usage_logs` — 同上
13. `quick_actions` — 快捷服务
14. `jhzy_quick_actions` — 同上
15. `jhzy_integration_rules` — 集成规则
16. `volunteer_approvals` — 志愿者审批

> **处理原则（修正）**：UNKNOWN 首先表示 "**WP1 尚不能确定迁移映射**"，**不代表**必须新建业务域或修改 Freeze。处置顺序严格如下：
> 1. **UNKNOWN**（WP1 阶段，映射未定）
> 2. → **WP2** 做源表语义澄清 + 目标表映射确认（读源表结构 / 样本，对照 20 域与 83 权威表归属）。
> 3. → 若**能依据现有 Freeze / 83 权威表归属**确定目标（并入现有域，或确认确为丢弃 / 归档），则**正常解决**，不升级。
> 4. → 仅当确认**确实要求新增业务域 / 改变 Core Domain / 修改 Freeze / 数据治理 / 架构**时，才 **STOP → BCR（BUSINESS_BOUNDARY §8）或 Architecture Change（ARCHITECTURE_FREEZE §5）**。
> 5. **禁止把全部 UNKNOWN 自动升级为 BCR**：绝大多数 UNKNOWN 应在 WP2 依据 Freeze 澄清归位；只有真正触及治理 / 架构边界的极少数才走裁定流程。
> 实施约束：WP3 执行时 UNKNOWN 源表**暂不迁移**、保留血缘（默认 ARCHIVE 冷存）、记 `migration_issues(issue_type='unknown_skipped')`；待 WP2 / BCR 结论后补迁或确认丢弃。

---

## 4. Migration Order（迁移顺序）

> 顺序依据：严格遵循外键依赖与业务域权威链（DATA_GOVERNANCE_FREEZE §2.2 域定义 + D1-DATABASE-DESIGN §2 FK）。每个批次对应一个 WP3 脚本；批次间依赖不可颠倒。

| 批次 | 域 | 目标表（2.0） | 依赖 |
|---|---|---|---|
| B0 | 系统/RBAC 种子 | `roles`/`permissions`/`role_permissions` | 无（2.0 冻结 seed） |
| B1 | 身份（用户中心） | `users`/`user_profiles`/`user_preferences` | B0 |
| B2 | 身份认证 | `sessions`/`user_identities` | B1 |
| B3 | 团队管理 | `teams`/`team_members`/`team_invites` | B1 |
| B4 | RBAC 分配 | `user_roles` | B0+B1+B3 |
| B5 | 活动中心 | `activities`/`activity_categories`/`activity_occurrences`/`activity_positions`/`activity_service_points` | B3 |
| B6 | 活动报名 | `activity_signups`/`activity_participations`/`*_slots`/`form_*` | B1+B5 |
| B7 | 签到签退 | `attendance_sessions`/`attendance_events`/`attendance_devices`/`attendance_anomalies` | B6+B5 |
| B8 | 服务记录 | `service_records`/`service_record_audits`/`service_record_adjustment_requests` | B7 |
| B9 | 积分中心 | `points_ledger`/`points_accounts` | B7/B8 |
| B10 | 成长等级 | `growth_records`/`volunteer_levels`/`honors`/`badges`/`user_badges` | B8/B9 |
| B11 | 培训中心 | `courses`/`course_lessons`/`course_enrollments`/`learning_records` | B1+B3 |
| B12 | 考试中心 | `exam_questions`/`exam_papers`/`exam_sessions`/`exam_answers` | B1+B3+B11 |
| B13 | 证书中心 | `certificate_templates`/`certificates`/`certificate_logs`/`id_pools` | B1+B3+B11+B12（⚠️ 脱敏） |
| B14 | 商城中心 | `mall_products`/`mall_orders` | B1+B9（DEFER） |
| B15 | 通知中心 | `notifications` 族 | B1+B5..B13 |
| B16 | 内容中心 | `content_*` | B1+B3+B5 |
| B17 | 文件中心 | `files`（R2 元数据） | B1 |
| B18 | 审计/安全 | `operation_logs`/`security_events`/`sensitive_data_access_logs`/`client_errors` | B1 |
| B19 | AI 中心 | `ai_conversations`/`ai_usage_logs` | B1 |
| B20 | 迁移支撑 | `legacy_id_maps`/`migration_issues` | 全程写入（DEFER 表，随各批填充） |

> 与用户示例顺序一致：identity → organization/team → activity → participation → attendance → points/growth → training → notifications/media。

---

## 5. Dependency Map（依赖映射）

| 依赖维度 | 关键关系 | 迁移含义 |
|---|---|---|
| **PK / FK** | 2.0 启用 FK（`ON DELETE RESTRICT/CASCADE`）；`team_id` 一律后端自查，禁前端传入 | 迁移须先建父（users/teams/activities），再建子；FK 错位=阻塞 |
| **legacy ID** | `legacy_id_maps(legacy_type, legacy_id) → public_id` | 每张源表迁移时写映射；跨表引用改由 2.0 `public_id`/`id` 解析 |
| **用户身份** | `users.id` ← `user_identities.user_id`；`admins`→`users`+`user_roles` | B1 先于 B2/B4；admin 账号须重映射为 user+role |
| **微信身份** | `user_identities(identity_type='wechat_openid', identity_hash)` | openid 须 HMAC 哈希后入库；明文不入 |
| **活动/报名/签到** | `activities.id` → `activity_signups.activity_id` → `attendance_sessions.signup_id` → `attendance_events.session_id` → `service_records` | B5→B6→B7→B8 严格链路 |
| **积分/成长** | `points_ledger.user_id`、`growth_records.user_id` 依赖 B8/B7 结算结果 | B9/B10 在 B8 后；**余额/成长值由流水重算**，不直抄 1.0 汇总 |
| **媒体引用** | `files.id` ← `user_avatars`/`jhzy_activity_images`/`file_uploads`；R2 物理对象 | B17 与 B1/B5 协同；URL 重写为 `file_id` |
| **审计关系** | `operation_logs.operator_id`→`users.id`；`security_events.user_id`→`users.id` | B18 最后，operator 须已存在 |

---

## 6. ID Strategy（ID 策略）

### 6.1 目标 ID 规则（冻结，不可改）
- 2.0 对外 ID = `public_id TEXT(ULID, 26字符)`；内部 PK = `INTEGER PRIMARY KEY`（D1-DATABASE-DESIGN §1）。**Core Domain ID 规则属冻结，迁移不得影响**。

### 6.2 legacy_id_maps 使用原则
- 结构：`(legacy_type TEXT, legacy_id TEXT, public_id TEXT, target_table TEXT, migrated_at INTEGER, batch TEXT)`，`UNIQUE(legacy_type, legacy_id)`。
- 每张源表迁移时：读取 1.0 行 `id`（BIGINT）→ 生成 2.0 `public_id`（ULID）→ **写一行 `legacy_id_maps`** → 用 `public_id` 写入 2.0 权威表。
- 跨表引用（如 `activity_signups.user_id`）一律经 `legacy_id_maps` 解析为 2.0 `users.public_id`→`id` 后再写入。

### 6.3 原 ID 保留 / 转换原则
- **原 1.0 `id`（BIGINT）不带入 2.0 PK**（避免 53-bit 与冲突）；仅存于 `legacy_id_maps` 作血缘。
- **`public_id` 全新建**（ULID 可排序、无冲突）；不沿用 1.0 `uuid`/`cert_no` 作主键（cert_no 仍存 `certificates.cert_no` 业务编号，但非 PK）。
- 编号池 `id_pools`：`cert_no`/`verify_code` 由 2.0 编号池生成；1.0 已用编号须先灌入 `id_pools` 占用位（防重发，对应附录一 U-01 域归属冲突待裁）。

### 6.4 冲突处理
- **同 `legacy_id` 多源**（如 `users` 与 `users_old_20260214` 均 `id=5`）：以**规范表为权威**（`users`），`_old` 表去重并入；冲突行写 `migration_issues(issue_type='dup_legacy_id')`。
- **PK 跨表撞名**：1.0 多表共享 `id` 命名无碍（各表独立 `legacy_type` 区分）。
- **cert_no 重复**（多套证书表）：合并时按 `cert_no` 去重，重复项写 `migration_issues` 并保留最早一条。
- **明文身份证**（exam_certificates_new 等）：迁移前脱敏，明文**绝不**入 2.0（DATA_CLASSIFICATION 第 4 条）。

---

## 7. Batch Strategy（批次策略）

- **批次划分**：20 个批次（§4），每批对应一个 WP3 脚本 + 一个 `legacy_id_maps.batch` 标记。
- **可重入（Idempotent）**：每张目标表以 `public_id` UNIQUE 做 `INSERT OR IGNORE`；`legacy_id_maps` 以 `UNIQUE(legacy_type, legacy_id)` 去重；重跑安全。
- **Checkpoint（断点续传）**：`legacy_id_maps` 同时作检查点——重跑时跳过已映射 `legacy_id`；每批完成写 `migration_issues(batch_done)` 标记。
- **Failure Isolation（故障隔离）**：每批独立事务；单批失败仅回滚该批，记录 `migration_issues(issue_type, status='open', detail)`，其余批次继续。
- **migration_issues 记录原则**：`(batch, legacy_type, legacy_id, target_table, issue_type, status, detail, created_at)`；`issue_type ∈ {dup_legacy_id, fk_missing, transform_error, plaintext_pii, unknown_skipped, ...}`；所有 UNKNOWN 源表跳过并记 `unknown_skipped`。

---

## 8. Verification Strategy（对账维度）

> 以下维度在 **WP4（对账脚本）** 实现，在 **WP6（测试库演练）** 执行。WP1 仅定义维度。

| 维度 | 对账方法 | 容差 |
|---|---|---|
| **row count** | 每源表计数 vs 2.0 目标计数（考虑 MERGE/DEDUP） | MERGE 表允许 < 源和（去重）；MIGRATE 应相等 |
| **unique identity** | `public_id` 全表唯一；`legacy_id_maps` 无重复 `legacy_id` | 0 重复 |
| **relationship integrity** | 全 FK 可解析（无孤儿）；`team_id`/`user_id`/`activity_id` 引用存在 | 0 孤儿 |
| **participation count** | `activity_participations` 数 vs 1.0 `jhzy_activity_signups` 求和 | 相等（去重后） |
| **attendance** | `attendance_events` 数 vs 1.0 四套签到表合计 | 相等（合并后） |
| **points** | `points_ledger` 求和 `balance_after` == `points_accounts.balance`；vs 1.0 `points_transactions` 总和 | 一致（重算后） |
| **growth** | `growth_records` 求和 == `volunteer_profiles.growth_value`；vs 1.0 `jhzy_level_records` | 一致 |
| **training/result** | `learning_records` vs 1.0 `training_user_progress`/`training_user_course_status` | 一致 |
| **media references** | `files` 数 vs 1.0 `file_uploads`+`user_avatars`+`jhzy_activity_images`；R2 物理对象存在性 | 元数据一致 + R2 对象可达 |
| **cert_no 占用** | `id_pools` 占用位覆盖 1.0 已发 `cert_no` | 0 重发风险 |

---

## 9. Rollback Design（回滚设计 — 仅设计，不执行）

> 范围：仅 **测试库（D1 测试实例）** 迁移演练失败后的恢复。生产回滚不属于 P8-3（生产切换为未定义阶段）。

- **测试库隔离**：WP6 演练在独立 D1 测试库，不影响生产（E-3 只读例外除外）。
- **回滚方式**：
  1. **整批回滚**：失败批事务回滚（D1 `ROLLBACK`），该批 2.0 数据清空，`legacy_id_maps` 对应批行删除，状态复位。
  2. **全量重置**：重新执行 `workers/migrations/0001–0043` 建 schema 基线（已验证 43 迁移可执行），清空 `legacy_id_maps`/`migration_issues`，从头重跑。
  3. **幂等保障**：因 INSERT OR IGNORE + checkpoint，重跑不产生重复。
- **瞬时表清理**：迁移 D1 重建模式产生的 `*_new`/`*_old` 中间表，成功后必须 DROP（F-DB-9/F-DB-10）；中途失败由迁移工具保证清理。
- **不触及生产**：回滚仅作用于测试库；生产 `api_jhzyfw_com` 全程只读（迁移期 E-3 例外），回滚不影响。

---

## 10. Production Boundary（生产边界 — 重申）

- **WP1 不碰生产数据**：本文件为设计，不读取/不写入生产 `api_jhzyfw_com`。
- **不执行正式迁移**：迁移脚本（WP3）、对账（WP4）、回滚演练（WP6）均仅在测试库；正式生产迁移属**未定义的生产切换阶段**，须另行通过 Definition Gate。
- **不部署**：不发布任何 Worker / 不改生产 D1 schema / 不切换域名或小程序版本 / 不灰度放量。
- 任何需求触及生产切换 → STOP（P8-3 Freeze §10），转独立生产切换阶段 Definition Gate。

---

## 11. 一致性自检（WP1 vs 冻结）

| 检查项 | 结果 |
|---|---|
| 与 `PROJECT_CONSTITUTION` 冲突 | 0 |
| 与 `ARCHITECTURE_FREEZE` 冲突 | 0（单一 DB/单一 API、无第二组件，仅消费 F-*） |
| 与 `BUSINESS_BOUNDARY` 冲突 | 0（20 域不变；UNKNOWN 项按 §3.3 顺序处置——WP2 先做语义/映射确认，能依据现有 Freeze 解决则正常解决，仅确认需新增业务域/改 Core Domain/改 Freeze/改数据治理或架构才 STOP→BCR/Architecture Change，禁止自动升级全部 UNKNOWN 为 BCR，未自行建域） |
| 与 `DATA_GOVERNANCE_FREEZE` 冲突 | 0（83 表归属沿用；25 历史表处置沿用；O-7 迁移支撑表沿用） |
| 与 `D1-DATABASE-DESIGN` 冲突 | 0（public_id ULID / INTEGER PK / epoch 时间 规则沿用） |
| 新架构规则 | 0 |
| 新业务域 | 0 |
| 新数据治理规则 | 0 |
| 范围扩张 | 0（仅迁移设计，不含生产切换） |

---

## 12. 引用与依据

- 1.0 资产：`SYSTEM_MASTER_INVENTORY.md` / `DATABASE_INVENTORY.md`（P8-1，STRICT READ ONLY）
- 业务域冻结：`BUSINESS_BOUNDARY.md`（20 域，§2）
- 数据治理冻结：`DATA_GOVERNANCE_FREEZE.md`（§2.1 83 表 / §3.2 归属 / §5 历史表处置 / O-7 迁移支撑表）
- 目标 schema：`D1-DATABASE-DESIGN.md`（§1 ID 规则 / §2 域模型 / §5 O4 迁移支撑表）
- 架构冻结：`ARCHITECTURE_FREEZE.md`（F-DB-1 单一 DB / F-API-1 单一 API / F-DB-7 二进制不入库 / F-DB-9/F-DB-10 瞬时表）
- 迁移定义：`P8-3_MIGRATION_CUTOVER_DESIGN_FREEZE.md`（本文件上层 L3 定义）
- 顶层宪法：`PROJECT_CONSTITUTION.md`（L0）

> **本文件 STOP**：WP1 完成。未进入 WP2（表映射与 `legacy_id_maps`/`migration_issues` 详细设计）、未写脚本、未碰生产数据、未部署。
