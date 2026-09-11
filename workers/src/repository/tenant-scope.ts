import type { AuthContext, TenantScope } from '../types/auth';

/**
 * 租户作用域（Tenant Scope）基础层（S2-4 骨架）。
 *
 * 核心纪律（S2-3 §7 / 矩阵 §0）：
 * - 禁止把所有表的隔离都写成 `WHERE team_id = ?` 然后一律套用。
 * - 必须按 S2-3 表矩阵判定每张表的 scope，分别强制 team / user / platform / audit 上下文。
 * - 四类 scope：PLATFORM_GLOBAL / TEAM_SCOPED / USER_SCOPED / AUDIT_ONLY。
 * - 禁止 team_id DEFAULT 0 哨兵；TEAM_SCOPED 必须有真实 team_id（或派生，见下）。
 *
 * 下表与 docs/architecture/D1-SCHEMA-TABLE-MATRIX.md §2 完全对应（63 表）。
 */

export const TABLE_SCOPE: Record<string, TenantScope> = {
  // ===== PLATFORM_GLOBAL (16) =====
  users: 'PLATFORM_GLOBAL',
  roles: 'PLATFORM_GLOBAL',
  permissions: 'PLATFORM_GLOBAL',
  role_permissions: 'PLATFORM_GLOBAL',
  user_roles: 'PLATFORM_GLOBAL',
  teams: 'PLATFORM_GLOBAL',
  activity_categories: 'PLATFORM_GLOBAL',
  attendance_devices: 'PLATFORM_GLOBAL',
  exam_questions: 'PLATFORM_GLOBAL',
  certificate_templates: 'PLATFORM_GLOBAL',
  id_pools: 'PLATFORM_GLOBAL',
  growth_rules: 'PLATFORM_GLOBAL',
  volunteer_levels: 'PLATFORM_GLOBAL',
  content_categories: 'PLATFORM_GLOBAL',
  message_templates: 'PLATFORM_GLOBAL',
  legacy_id_maps: 'PLATFORM_GLOBAL',

  // ===== TEAM_SCOPED (36) =====
  team_members: 'TEAM_SCOPED',
  team_invites: 'TEAM_SCOPED',
  activities: 'TEAM_SCOPED',
  activity_signups: 'TEAM_SCOPED',
  // S2-NEW-ARCH-P11：参与/排班相关表（team 经 activities 派生，见 DERIVED_TEAM_TABLES）
  activity_occurrences: 'TEAM_SCOPED',
  activity_positions: 'TEAM_SCOPED',
  activity_participation_slots: 'TEAM_SCOPED',
  occurrence_positions: 'TEAM_SCOPED',
  participation_slot_positions: 'TEAM_SCOPED',
  activity_participations: 'TEAM_SCOPED',
  attendance_sessions: 'TEAM_SCOPED',
  attendance_events: 'TEAM_SCOPED',
  attendance_anomalies: 'TEAM_SCOPED',
  // S2-NEW-ARCH-P20：通用动态表单引擎——definitions/bindings 持有真实 team_id；
  // versions/submissions 无 team_id，经 form_definitions 派生（见 DERIVED_TEAM_TABLES）。
  form_definitions: 'TEAM_SCOPED',
  form_bindings: 'TEAM_SCOPED',
  form_definition_versions: 'TEAM_SCOPED',
  form_submissions: 'TEAM_SCOPED',
  service_records: 'TEAM_SCOPED',
  service_record_adjustment_requests: 'TEAM_SCOPED',
  service_record_audits: 'TEAM_SCOPED',
  courses: 'TEAM_SCOPED',
  course_lessons: 'TEAM_SCOPED',
  course_enrollments: 'TEAM_SCOPED',
  exam_papers: 'TEAM_SCOPED',
  exam_sessions: 'TEAM_SCOPED',
  exam_answers: 'TEAM_SCOPED',
  certificates: 'TEAM_SCOPED',
  certificate_logs: 'TEAM_SCOPED',
  mall_products: 'TEAM_SCOPED',
  mall_orders: 'TEAM_SCOPED',
  honors: 'TEAM_SCOPED',
  badges: 'TEAM_SCOPED',
  content_articles: 'TEAM_SCOPED',
  content_comments: 'TEAM_SCOPED',
  content_likes: 'TEAM_SCOPED',
  content_reports: 'TEAM_SCOPED',
  content_attachments: 'TEAM_SCOPED',
  files: 'TEAM_SCOPED',
  notifications: 'TEAM_SCOPED',
  ai_conversations: 'TEAM_SCOPED',
  ai_usage_logs: 'TEAM_SCOPED',

  // ===== USER_SCOPED (9 + sessions NEW = 10) =====
  user_identities: 'USER_SCOPED',
  user_profiles: 'USER_SCOPED',
  volunteer_profiles: 'USER_SCOPED',
  identity_verifications: 'USER_SCOPED', // P0-A：身份核验事实（单一事实来源），仅本人可读写
  phone_verifications: 'USER_SCOPED', // P0-B：微信可信手机号绑定事实（独立 SSOT），仅本人可读写
  user_preferences: 'USER_SCOPED',
  learning_records: 'USER_SCOPED',
  points_ledger: 'USER_SCOPED',
  points_accounts: 'USER_SCOPED',
  growth_records: 'USER_SCOPED',
  user_badges: 'USER_SCOPED',
  sessions: 'USER_SCOPED',

  // ===== AUDIT_ONLY (7) =====
  level_change_logs: 'AUDIT_ONLY',
  content_audit_logs: 'AUDIT_ONLY',
  operation_logs: 'AUDIT_ONLY',
  security_events: 'AUDIT_ONLY',
  sensitive_data_access_logs: 'AUDIT_ONLY',
  client_errors: 'AUDIT_ONLY',
  migration_issues: 'AUDIT_ONLY',
};

/**
 * TEAM_SCOPED 但【不直接持有 team_id 列】的表（scope 由父表派生）。
 * activity_signups：team 由 activity_id → activities.team_id 派生，
 * repository 层查询必须 JOIN activities 以获得 team 隔离，不能简单 WHERE team_id=?。
 * activity_participations（S2-NEW-ARCH-P11）：team 由 signup_id → activity_signups → activities.team_id 派生，
 * 无 team_id / activity_id / user_id 冗余列，查询必须 JOIN activity_signups + activities 派生隔离。
 */
export const DERIVED_TEAM_TABLES = new Set<string>([
  'activity_signups',
  'activity_participations',
  'activity_occurrences',
  'activity_participation_slots',
  'occurrence_positions',
  'participation_slot_positions',
  'activity_positions',
  // S2-NEW-ARCH-P20：form 引擎派生表（team 经 form_definition_versions/form_submissions → form_definitions → team_id）
  'form_definition_versions',
  'form_submissions',
]);

/** 读取审计日志所需的授权角色（AUDIT_ONLY 不得被普通团队上下文错误暴露）。 */
const AUDIT_READER_ROLES = new Set(['platform_super_admin', 'platform_operator', 'team_auditor']);

export interface ScopeCheck {
  ok: boolean;
  reason?: string;
}

/** 校验当前 AuthContext 是否可读取某张表（骨架级读权限判定）。 */
export function checkReadAccess(table: string, auth: AuthContext): ScopeCheck {
  const scope = TABLE_SCOPE[table];
  if (!scope) return { ok: false, reason: `unknown_table:${table}` };

  switch (scope) {
    case 'PLATFORM_GLOBAL':
      // 平台级引用数据：已认证即可（具体写权限由后续 RBAC 目录裁决）。
      return auth.authenticated ? { ok: true } : { ok: false, reason: 'unauthenticated' };

    case 'TEAM_SCOPED':
      // 必须处于某团队上下文。
      return auth.teamId != null ? { ok: true } : { ok: false, reason: 'team_scope_required' };

    case 'USER_SCOPED':
      // 必须处于某用户上下文。
      return auth.userId != null ? { ok: true } : { ok: false, reason: 'user_scope_required' };

    case 'AUDIT_ONLY':
      // 审计日志：仅平台角色或团队审计员可读，普通成员上下文不得暴露（S2-6f：以 roles 列表判定）。
      if (auth.roles.some((b) => AUDIT_READER_ROLES.has(b.role))) return { ok: true };
      return { ok: false, reason: 'audit_read_requires_auditor' };
  }
}

/** 取表 scope（未登记返回 undefined）。 */
export function getScope(table: string): TenantScope | undefined {
  return TABLE_SCOPE[table];
}
