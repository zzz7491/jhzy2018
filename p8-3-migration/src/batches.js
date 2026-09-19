// B0-B20 migration batch order (dependency-respecting, per WP1 §4 / WP2 §2).
// Runner processes batches in this sequence; within a batch, tables run in TABLE_MAP insertion order.
export const BATCHES = [
  'B0', // RBAC seed (roles/permissions/role_permissions) — load before user_roles
  'B1', // identity + user profile + volunteers (users PK needed by downstream FKs)
  'B2', // sessions (from user_tokens/admin_tokens)
  'B3', // teams + team_members (owner_user_id FK -> users)
  'B4', // user_roles (admins -> users+roles) + volunteers_temp archive
  'B5', // activities + categories + service points + address coords + activity drops
  'B6', // activity_signups / participants / time slots
  'B7', // attendance (sessions/events) + geo/device logs
  'B8', // service_records (casual) + quick_actions archive + service drops
  'B9', // points_ledger / points_exchange
  'B10', // growth_records / volunteer_levels / badges / achievements
  'B11', // training (courses/lessons/enrollments/learning) + user_trainings
  'B12', // exam (questions/sessions/answers/papers)
  'B13', // certificates / templates / id_pools / logs
  'B14', // mall (products/orders) + welfare_options
  'B15', // notifications
  'B16', // content (articles/reports/carousel/feedback)
  'B17', // files (uploads/avatars/images) + qr drops
  'B18', // operation_logs / security_events / system_config / admin logs / approvals / drops
  'B19', // reserved (no 1.0 source)
  'B20', // finalize legacy_id_maps / migration_issues integrity + checkpoint close
];

export const BATCH_META = {
  B0: 'RBAC 种子（优先于 user_roles）',
  B1: '身份与用户档案（users PK 先行）',
  B2: '会话（token→sessions）',
  B3: '团队与成员',
  B4: '用户角色 + 临时表归档',
  B5: '活动中心',
  B6: '活动报名',
  B7: '签到签退',
  B8: '服务记录 + quick_actions 归档',
  B9: '积分流水',
  B10: '成长等级',
  B11: '培训中心',
  B12: '考试中心',
  B13: '证书中心',
  B14: '商城中心',
  B15: '通知中心',
  B16: '内容中心',
  B17: '文件中心',
  B18: '系统管理 / 审计 / 安全',
  B19: '保留（无 1.0 源）',
  B20: '收尾（idmap/issues 完整性 + checkpoint 关闭）',
};

// Tables assigned to a batch (excludes EXCLUSIONS).
export function tablesForBatch(tableMap, batch) {
  return Object.entries(tableMap)
    .filter(([, spec]) => spec.batch === batch)
    .map(([srcKey]) => srcKey);
}
