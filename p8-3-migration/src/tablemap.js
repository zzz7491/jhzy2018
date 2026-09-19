// TABLE_MAP — faithful encoding of P8-3 WP2 §2 (131 source objects).
// 130 mapped (MIGRATE/TRANSFORM/MERGE/ARCHIVE/DROP); user_favorites EXCLUDED (BCR pending).
// srcKey format: '<srcDb>.<table>'  (api => api_jhzyfw_com, signup_db => signup_db)
// spec: { batch, kind, transform? | target? | targets?, publicId?, columns?, note? }

// user_favorites: REMAIN UNKNOWN per WP2 §3 / P8-3 Definition Freeze — explicitly EXCLUDED.
// Not migrated, not dropped, not auto-archived, not guessed; awaits BCR result.
export const EXCLUSIONS = ['api.user_favorites'];

// Source system name by srcKey prefix.
export function sourceSystemOf(srcKey) {
  const db = srcKey.split('.')[0];
  return db === 'signup_db' ? 'signup_db' : 'api_jhzyfw_com';
}

export const TABLE_MAP = {
  // EXCLUDED (recognized source object, never migrated — see EXCLUSIONS / WP2 §3)
  'api.user_favorites': { batch: 'B0', kind: 'EXCLUDED', note: 'REMAIN UNKNOWN / BCR pending — see WP2 §3' },
  // ---- 2.1 用户中心 ----
  'api.users': { batch: 'B1', kind: 'MIGRATE', transform: 'users', note: '规范主体' },
  'api.user_stats': {
    batch: 'B1',
    kind: 'TRANSFORM',
    target: 'user_profiles',
    columns: { user_id: 'user_id', gender: 'gender', birthday: 'birthday', region_code: 'region_code', bio: 'bio' },
    note: '统计档案并入 user_profiles',
  },
  'api.user_avatars': {
    batch: 'B17',
    kind: 'TRANSFORM',
    target: 'files',
    columns: { id: 'id', user_id: 'user_id', storage_path: 'path', mime_type: 'mime', checksum: 'checksum' },
    note: '头像元数据→files',
  },
  'api.user_subscribe_settings': {
    batch: 'B1',
    kind: 'TRANSFORM',
    targets: [
      { table: 'user_preferences', columns: { user_id: 'user_id', notify_settings: 'notify_settings' } },
      { table: 'wechat_subscription_consents', columns: { user_id: 'user_id', subscribe_status: 'status' } },
    ],
    note: '订阅设置拆分',
  },
  'api.users_old_20260214': { batch: 'B1', kind: 'MIGRATE', transform: 'users_dedup', note: '历史去重并入' },
  'api.jhzy_users_old_20260214': { batch: 'B1', kind: 'MIGRATE', transform: 'users_dedup', note: '历史去重并入' },
  'api.jhzy_deleted_users': { batch: 'B18', kind: 'ARCHIVE', note: '删除留痕(仅归档源)' },
  'signup_db.users': { batch: 'B1', kind: 'MERGE', transform: 'signup_users', note: 'signup 用户去重并入 users' },

  // ---- 2.2 身份认证 / 账号收敛 ----
  'api.user_tokens': { batch: 'B2', kind: 'TRANSFORM', transform: 'user_tokens_to_sessions', note: 'token→sessions' },
  'api.admin_tokens': { batch: 'B2', kind: 'MERGE', transform: 'admin_tokens_to_sessions', note: '双 token 合并' },
  'api.password_change_logs': {
    batch: 'B18',
    kind: 'MERGE',
    targets: [
      { table: 'operation_logs', columns: { operator_id: 'user_id', module: () => 'user', action: () => 'password_change' } },
      { table: 'identity_verifications', columns: { user_id: 'user_id' } },
    ],
    note: '审计+验证',
  },
  'api.admins': { batch: 'B1', kind: 'MERGE', transform: 'admins', note: '后台账号→users+user_roles' },
  'api.admins_old_20260214': { batch: 'B1', kind: 'ARCHIVE', note: '历史管理员留痕' },
  'api.jhzy_admins_old_20260214': { batch: 'B1', kind: 'ARCHIVE', note: '历史管理员留痕' },

  // ---- 2.3 团队管理 ----
  'api.teams': { batch: 'B3', kind: 'MIGRATE', transform: 'teams', note: '租户根' },
  'api.volunteer_groups': { batch: 'B3', kind: 'MERGE', transform: 'volunteer_groups', note: '第二组织收敛为 teams' },
  'api.volunteer_group_members': {
    batch: 'B3',
    kind: 'MERGE',
    target: 'team_members',
    columns: { group_id: 'team_id', user_id: 'user_id', join_status: 'join_status', joined_at: 'joined_at' },
    note: '成员关系收敛',
  },
  'api.user_teams': {
    batch: 'B3',
    kind: 'MERGE',
    target: 'team_members',
    columns: { team_id: 'team_id', user_id: 'user_id', join_status: 'join_status' },
    note: '成员关系收敛',
  },

  // ---- 2.4 志愿者档案 ----
  'api.volunteers': { batch: 'B1', kind: 'MIGRATE', transform: 'volunteers', note: '高敏密文' },
  'api.volunteers_old_20260214': { batch: 'B1', kind: 'MIGRATE', transform: 'volunteers_dedup', note: '历史去重' },
  'api.jhzy_volunteers_old_20260214': { batch: 'B1', kind: 'MIGRATE', transform: 'volunteers_dedup', note: '历史去重' },
  'api.volunteers_temp': { batch: 'B4', kind: 'ARCHIVE', note: '临时表归档删除' },

  // ---- 2.5 活动中心 ----
  'api.activities': { batch: 'B5', kind: 'MIGRATE', transform: 'activities', note: 'canonical' },
  'api.activity_categories': { batch: 'B5', kind: 'MIGRATE', target: 'activity_categories', note: '字典直迁' },
  'api.jhzy_activities': { batch: 'B5', kind: 'MERGE', transform: 'activities_merge', note: '第二活动表收敛' },
  'api.jhzy_activities_backup_prelaunch': { batch: 'B5', kind: 'ARCHIVE', note: '历史备份' },
  'api.jhzy_activities_temp': { batch: 'B5', kind: 'ARCHIVE', note: '历史临时' },
  'api.jhzy_new_activities_deleted': { batch: 'B5', kind: 'ARCHIVE', note: '历史删除' },
  'api.activity_records': { batch: 'B5', kind: 'MERGE', target: 'activity_occurrences', note: '场次收敛' },
  'api.jhzy_activity_recurrence': { batch: 'B5', kind: 'MERGE', target: 'activity_occurrences', note: '周期→场次' },
  'api.jhzy_activity_positions': { batch: 'B5', kind: 'MIGRATE', target: 'activity_positions', note: '岗位目录' },
  'api.jhzy_activity_locations': {
    batch: 'B5',
    kind: 'MIGRATE',
    target: 'activity_service_points',
    columns: { lat: 'latitude', lng: 'longitude', address: 'address' },
    note: '服务点',
  },
  'api.jhzy_activity_time_slots': { batch: 'B6', kind: 'MERGE', target: 'activity_participation_slots', note: '时段' },
  'api.jhzy_activity_images': {
    batch: 'B17',
    kind: 'TRANSFORM',
    targets: [
      { table: 'files', columns: { id: 'id', path: 'storage_path' } },
      { table: 'content_attachments', columns: { activity_id: 'activity_id' } },
    ],
    note: '活动图→files+附件',
  },
  'api.jhzy_activity_cancel_logs': {
    batch: 'B18',
    kind: 'MERGE',
    target: 'operation_logs',
    columns: { operator_id: 'user_id', module: () => 'activity', action: () => 'cancel' },
    note: '取消留痕',
  },
  'api.activity_service_certificates': { batch: 'B13', kind: 'MERGE', target: 'certificates', transform: 'certificates', note: '收敛为 certificates' },
  'api.activity_signins': {
    batch: 'B7',
    kind: 'MERGE',
    target: 'attendance_sessions',
    columns: { activity_id: 'activity_id', user_id: 'user_id', team_id: 'team_id', checkin_at: 'started_at' },
    note: '签到会话',
  },
  'api.jhzy_activity_signin': {
    batch: 'B7',
    kind: 'MERGE',
    target: 'attendance_sessions',
    columns: { activity_id: 'activity_id', user_id: 'user_id' },
    note: '重复表去重',
  },
  'api.volunteer_activities': { batch: 'B6', kind: 'MERGE', target: 'activity_signups', transform: 'signups', note: '报名收敛' },
  'api.events': { batch: 'B5', kind: 'MIGRATE', transform: 'activities', note: '主库 events→activities' },
  'signup_db.events': { batch: 'B5', kind: 'MIGRATE', transform: 'activities', note: 'signup events→activities' },

  // ---- 2.6 活动报名 ----
  'api.jhzy_activity_signups': { batch: 'B6', kind: 'MIGRATE', target: 'activity_signups', transform: 'signups', note: 'canonical 报名' },
  'api.jhzy_activity_signups_old_backup': { batch: 'B6', kind: 'MIGRATE', target: 'activity_signups', transform: 'signups', note: '历史差异并入' },
  'api.jhzy_activity_signups_bak_20260309': { batch: 'B6', kind: 'MIGRATE', target: 'activity_signups', transform: 'signups', note: '历史差异并入' },
  'api.participants': { batch: 'B6', kind: 'MIGRATE', target: 'activity_signups', transform: 'participants', note: '主库 participants' },
  'signup_db.participants': { batch: 'B6', kind: 'MIGRATE', target: 'activity_signups', transform: 'participants', note: 'signup participants' },

  // ---- 2.7 签到签退 ----
  'api.jhzy_activity_checkins': { batch: 'B7', kind: 'MERGE', transform: 'checkins', note: '主签到表' },
  'api.jhzy_activity_checkins_enhanced': { batch: 'B7', kind: 'MERGE', transform: 'checkins', note: '历史并入' },
  'api.jhzy_checkins_v2': { batch: 'B7', kind: 'MERGE', transform: 'checkins', note: '同上' },
  'api.jhzy_attendance_records': {
    batch: 'B7',
    kind: 'MERGE',
    target: 'attendance_events',
    columns: { activity_id: 'activity_id', user_id: 'user_id', event_type: () => 'checkin', occurred_at: 'created_at' },
    note: '事件',
  },
  'api.jhzy_attendance_records_backup_20260514': { batch: 'B7', kind: 'ARCHIVE', note: '历史备份' },
  'api.jhzy_checkin_codes': {
    batch: 'B7',
    kind: 'MERGE',
    target: 'attendance_sessions',
    columns: { activity_id: 'activity_id', code: 'qr_time_slot' },
    note: '签到码',
  },
  'api.jhzy_checkin_history': {
    batch: 'B7',
    kind: 'MERGE',
    target: 'attendance_events',
    columns: { activity_id: 'activity_id', user_id: 'user_id', occurred_at: 'created_at' },
    note: '事件',
  },
  'api.jhzy_casual_daily_limit': {
    batch: 'B8',
    kind: 'MERGE',
    target: 'service_records',
    columns: { user_id: 'user_id', date: () => 'service_date', limit_value: 'daily_limit' },
    note: '临时服务',
  },
  'api.jhzy_casual_records': {
    batch: 'B8',
    kind: 'MERGE',
    target: 'service_records',
    columns: { user_id: 'user_id', activity_id: 'activity_id', minutes: 'minutes', occurred_at: 'created_at' },
    note: '临时服务',
  },
  'api.jhzy_quick_service_records_deprecated': { batch: 'B8', kind: 'DROP', note: '废弃删除' },

  // ---- 2.8 服务记录 ----
  'api.jhzy_serving_progress': { batch: 'B8', kind: 'DROP', note: '双汇总删除' },
  'api.jhzy_activity_stats_cache': { batch: 'B8', kind: 'DROP', note: '派生缓存删除' },
  'api.service_areas': { batch: 'B5', kind: 'DROP', note: '地理冗余丢弃' },
  'api.jhzy_service_areas': { batch: 'B5', kind: 'DROP', note: '原型重复表' },

  // ---- 2.9 成长等级 ----
  'api.jhzy_level_records': { batch: 'B10', kind: 'MERGE', transform: 'growth_level_records', note: '成长' },
  'api.jhzy_reward_penalty_records': { batch: 'B10', kind: 'MERGE', target: 'growth_records', transform: 'growth_level_records', note: '奖惩=成长动作' },
  'api.jhzy_role_coefficients': {
    batch: 'B10',
    kind: 'TRANSFORM',
    target: 'growth_rules',
    columns: { name: 'action_type', params: () => '{"type":"contribution"}' },
    note: '角色系数→规则',
  },
  'api.jhzy_condition_coefficients': {
    batch: 'B10',
    kind: 'TRANSFORM',
    target: 'growth_rules',
    columns: { name: 'action_type', params: () => '{}' },
    note: '条件系数→规则',
  },
  'api.jhzy_welfare_options': { batch: 'B14', kind: 'DROP', note: 'V2 原型重复' },
  'api.welfare_options': { batch: 'B14', kind: 'MERGE', transform: 'mall_products', note: '福利→商城' },
  'api.achievements': { batch: 'B10', kind: 'MERGE', transform: 'badges', note: '成就→勋章' },

  // ---- 2.10 培训中心 ----
  'api.training_courses': { batch: 'B11', kind: 'MIGRATE', target: 'courses', note: '课程' },
  'api.training_chapters': { batch: 'B11', kind: 'MIGRATE', target: 'course_lessons', note: '章节' },
  'api.training_user_course_status': { batch: 'B11', kind: 'MIGRATE', target: 'course_enrollments', note: '选课' },
  'api.training_user_progress': { batch: 'B11', kind: 'MIGRATE', target: 'learning_records', note: '进度' },
  'api.training_signatures': {
    batch: 'B11',
    kind: 'MERGE',
    target: 'learning_records',
    columns: { user_id: 'user_id', course_id: 'course_id' },
    note: '凭证并入',
  },
  'api.training_whitelist': {
    batch: 'B11',
    kind: 'MERGE',
    target: 'course_enrollments',
    columns: { user_id: 'user_id', course_id: 'course_id' },
    note: '白名单并入',
  },

  // ---- 2.11 考试中心 ----
  'api.exam_questions': { batch: 'B12', kind: 'MIGRATE', target: 'exam_questions', note: '题库' },
  'api.exam_questions_backup_20260604': { batch: 'B12', kind: 'ARCHIVE', note: '历史备份' },
  'api.exam_records': {
    batch: 'B12',
    kind: 'MIGRATE',
    targets: [
      { table: 'exam_answers', columns: { question_id: 'question_id', user_id: 'user_id', answer: 'answer' } },
      { table: 'exam_sessions', columns: { user_id: 'user_id', exam_id: 'exam_id' } },
    ],
    note: '答卷',
  },
  'api.exam_sessions': { batch: 'B12', kind: 'MIGRATE', target: 'exam_sessions', note: '会话' },
  'api.exam_config': { batch: 'B12', kind: 'MERGE', target: 'exam_papers', columns: { pick_rule: 'pick_rule' }, note: '配置→试卷' },
  'api.question_bank': {
    batch: 'B12',
    kind: 'MERGE',
    target: 'exam_questions',
    columns: { content: 'content', answer: 'answer', options: 'options' },
    note: '题库去重',
  },

  // ---- 2.12 证书中心 ----
  'api.certificates': { batch: 'B13', kind: 'MIGRATE', transform: 'certificates', note: 'canonical 证书' },
  'api.certificate_templates': { batch: 'B13', kind: 'MIGRATE', target: 'certificate_templates', columns: { layout: 'layout' }, note: '模板' },
  'api.certificate_types': { batch: 'B13', kind: 'MERGE', target: 'certificate_templates', columns: { type_name: 'cert_type' }, note: '类型→模板' },
  'api.certificate_master': { batch: 'B13', kind: 'MERGE', transform: 'certificates', note: '四套证书收敛' },
  'api.unified_certificates': { batch: 'B13', kind: 'MERGE', transform: 'certificates', note: '同上' },
  'api.exam_certificates': { batch: 'B13', kind: 'MERGE', transform: 'certificates', note: 'source_type=exam' },
  'api.exam_certificates_new': { batch: 'B13', kind: 'MERGE', transform: 'certificates', note: '含明文身份证脱敏' },
  'api.user_certificates': { batch: 'B13', kind: 'MERGE', transform: 'certificates', note: '同上' },
  'api.certificate_applications': {
    batch: 'B13',
    kind: 'MIGRATE',
    targets: [
      { table: 'certificates', transform: 'certificates' },
      { table: 'certificate_logs', columns: { cert_id: 'cert_id', action: () => 'apply' } },
    ],
    note: '申请',
  },
  'api.certificate_applications_backup_20260207': {
    batch: 'B13',
    kind: 'MIGRATE',
    targets: [
      { table: 'certificates', transform: 'certificates' },
      { table: 'certificate_logs', columns: { action: () => 'apply' } },
    ],
    note: '历史差异并入',
  },
  'api.certificates_preview': { batch: 'B13', kind: 'ARCHIVE', note: '预览归档' },
  'api.certificate_id_usage_log': {
    batch: 'B13',
    kind: 'MERGE',
    target: 'certificate_logs',
    columns: { cert_id: 'cert_id', action: () => 'issue' },
    note: '编号使用留痕',
  },
  'api.id_pool': { batch: 'B13', kind: 'MIGRATE', target: 'id_pools', columns: { pool_type: 'pool_type', code: 'code', status: 'status' }, note: '编号池' },
  'api.id_pool_old_20260214': { batch: 'B13', kind: 'ARCHIVE', note: '历史归档' },
  'api.id_assignments_old_20260214': { batch: 'B13', kind: 'ARCHIVE', note: '历史归档' },

  // ---- 2.13 积分中心 ----
  'api.points_transactions': { batch: 'B9', kind: 'MIGRATE', transform: 'points_ledger', note: 'canonical 流水' },
  'api.points_exchange_records': {
    batch: 'B9',
    kind: 'MERGE',
    targets: [
      { table: 'points_ledger', transform: 'points_ledger' },
      { table: 'mall_orders', columns: { user_id: 'user_id', product_id: 'product_id', status: 'status' } },
    ],
    note: '双写',
  },
  'api.points_mall': { batch: 'B14', kind: 'MERGE', transform: 'mall_products', note: '积分商城商品' },

  // ---- 2.14 商城中心 ----
  'api.mall_products': { batch: 'B14', kind: 'MIGRATE', target: 'mall_products', columns: { points_price: 'points_price', stock: 'stock' }, note: '直迁' },
  'api.exchange_products': { batch: 'B14', kind: 'MERGE', transform: 'mall_products', note: '商品收敛' },
  'api.exchange_orders': {
    batch: 'B14',
    kind: 'MERGE',
    target: 'mall_orders',
    columns: { user_id: 'user_id', product_id: 'product_id', status: 'status', created_at: 'created_at' },
    note: '订单',
  },
  'api.exchange_records': {
    batch: 'B14',
    kind: 'MERGE',
    targets: [
      { table: 'mall_orders', columns: { user_id: 'user_id', product_id: 'product_id' } },
      { table: 'points_ledger', transform: 'points_ledger' },
    ],
    note: '兑换记录',
  },
  'api.exchange_verifications': {
    batch: 'B14',
    kind: 'MERGE',
    target: 'mall_orders',
    columns: { order_id: 'id', verified_by: 'verified_by', verified_at: 'verified_at' },
    note: '核销',
  },

  // ---- 2.15 通知中心 ----
  'api.notifications': { batch: 'B15', kind: 'MIGRATE', target: 'notifications', columns: { notif_type: 'notif_type', title: 'title', content: 'content', target: 'target' }, note: 'canonical' },
  'api.jhzy_notifications': { batch: 'B15', kind: 'MERGE', target: 'notifications', columns: { notif_type: 'notif_type', title: 'title', content: 'content' }, note: '并行通知' },
  'api.notification_master': {
    batch: 'B15',
    kind: 'MERGE',
    targets: [
      { table: 'notifications', columns: { title: 'title', content: 'content' } },
      { table: 'notification_recipients', columns: { notification_id: 'id', user_id: 'user_id' } },
    ],
    note: '收件收敛',
  },
  'api.notification_details': {
    batch: 'B15',
    kind: 'MERGE',
    targets: [
      { table: 'notifications', columns: { title: 'title', content: 'content' } },
      { table: 'notification_recipients', columns: { user_id: 'user_id' } },
    ],
    note: '同上',
  },

  // ---- 2.16 内容中心 ----
  'api.carousel_images': {
    batch: 'B16',
    kind: 'MERGE',
    targets: [
      { table: 'content_articles', columns: { title: 'title', content: 'content' } },
      { table: 'files', columns: { path: 'storage_path' } },
    ],
    note: '轮播→内容/附件',
  },
  'api.jhzy_feedback': { batch: 'B16', kind: 'MERGE', target: 'content_reports', columns: { user_id: 'user_id', content: 'content', type: 'type' }, note: '反馈→举报' },
  'api.system_config': { batch: 'B18', kind: 'TRANSFORM', target: 'kv', columns: { key: 'key', value: 'value' }, note: '配置→KV(非 D1 表)' },

  // ---- 2.17 文件中心 ----
  'api.file_uploads': {
    batch: 'B17',
    kind: 'MIGRATE',
    target: 'files',
    columns: { storage_path: 'storage_path', mime_type: 'mime_type', checksum: 'checksum', size_bytes: 'size', original_name: 'original_name' },
    note: '文件元数据',
  },
  'api.qr_codes': { batch: 'B17', kind: 'DROP', note: '二维码可重生成' },
  'api.qr_types': { batch: 'B17', kind: 'DROP', note: '枚举内嵌' },
  'api.qr_usage_logs': { batch: 'B17', kind: 'DROP', note: '扫码日志派生' },

  // ---- 2.19 系统管理 + RBAC ----
  'api.roles': { batch: 'B0', kind: 'MIGRATE', target: 'roles', columns: { code: 'code', name: 'name', scope: 'scope', is_system: 'is_system', status: 'status' }, note: 'RBAC 种子优先' },
  'api.permissions': { batch: 'B0', kind: 'MIGRATE', target: 'permissions', columns: { code: 'code', name: 'name', perm_group: 'perm_group', risk_level: 'risk_level' }, note: 'RBAC 种子优先' },
  'api.role_permissions': { batch: 'B0', kind: 'MIGRATE', target: 'role_permissions', columns: { role_id: 'role_id', permission_id: 'permission_id' }, note: 'RBAC 种子优先' },
  'api.user_roles': { batch: 'B4', kind: 'MIGRATE', target: 'user_roles', columns: { user_id: 'user_id', role_id: 'role_id', scope_team_id: 'scope_team_id', granted_by: 'granted_by' }, note: '1.0 历史映射' },

  // ---- 2.20 跨域残留 ----
  'api.address_coordinates': { batch: 'B5', kind: 'MERGE', target: 'activity_service_points', columns: { lat: 'latitude', lng: 'longitude', address: 'address' }, note: '坐标并入' },
  'api.geocode_logs': { batch: 'B5', kind: 'DROP', note: '地理编码缓存丢弃' },
  'api.jhzy_abnormal_logs': {
    batch: 'B18',
    kind: 'MERGE',
    targets: [
      { table: 'security_events', columns: { event_type: () => 'abnormal', detail: 'detail' } },
      { table: 'operation_logs', columns: { module: () => 'system', action: () => 'abnormal' } },
    ],
    note: '异常日志',
  },
  'api.jhzy_geo_monitor_logs': {
    batch: 'B7',
    kind: 'MERGE',
    targets: [
      { table: 'attendance_anomalies', columns: { activity_id: 'activity_id', user_id: 'user_id' } },
      { table: 'security_events', columns: { event_type: () => 'geofence', detail: 'detail' } },
    ],
    note: '围栏',
  },
  'api.jhzy_geofence_logs': {
    batch: 'B7',
    kind: 'MERGE',
    targets: [
      { table: 'attendance_anomalies', columns: { activity_id: 'activity_id' } },
      { table: 'security_events', columns: { event_type: () => 'geofence' } },
    ],
    note: '同上',
  },
  'api.jhzy_device_logs': { batch: 'B7', kind: 'MERGE', target: 'attendance_devices', columns: { user_id: 'user_id', fp_hash: 'fp_hash' }, note: '设备指纹' },
  'api.jhzy_location_monitor': { batch: 'B18', kind: 'MERGE', target: 'security_events', columns: { event_type: () => 'location', detail: 'detail' }, note: '位置监控' },
  'api.jhzy_integration_rules': { batch: 'B18', kind: 'DROP', note: '无 integration 域' },
  'api.quick_actions': { batch: 'B8', kind: 'ARCHIVE', note: 'DEFERRED_V2_GAP 冷存' },
  'api.jhzy_quick_actions': { batch: 'B8', kind: 'DROP', note: 'V2 原型重复' },
  'api.user_trainings': {
    batch: 'B11',
    kind: 'MERGE',
    targets: [
      { table: 'course_enrollments', columns: { user_id: 'user_id', course_id: 'course_id' } },
      { table: 'learning_records', columns: { user_id: 'user_id', course_id: 'course_id' } },
    ],
    note: '培训并入',
  },
  'api.volunteer_approvals': {
    batch: 'B18',
    kind: 'MERGE',
    targets: [
      { table: 'operation_logs', columns: { operator_id: 'reviewer_id', module: () => 'user', action: () => 'approve' } },
      { table: 'volunteer_profiles', columns: { cert_status: 'cert_status' } },
    ],
    note: '审批→日志+认证状态',
  },
  'api.volunteer_deleted_logs': {
    batch: 'B18',
    kind: 'MERGE',
    target: 'operation_logs',
    columns: { operator_id: 'user_id', module: () => 'user', action: () => 'delete' },
    note: '删除审计',
  },
};

// Sanity: mapped count (excludes EXCLUSIONS).
export function mappedCount() {
  return Object.keys(TABLE_MAP).filter((k) => !EXCLUSIONS.includes(k)).length;
}
