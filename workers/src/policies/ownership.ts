/**
 * Ownership Policy（S2-6g ~ S2-6h）—— 资源归属判定最小接口。
 *
 * 纪律（用户 §五 / §六 / §七）：
 * - S2-6g 实现 ActivitySignupOwnershipPolicy；S2-6h 实现 AttendanceSessionOwnershipPolicy。
 * - 不实现 CertificateOwnershipPolicy / PointsOwnershipPolicy / ProfileOwnershipPolicy；
 *   不建立通用 policy registry / DSL / policy engine / 注解扫描（避免过度抽象，§五）。
 * - Ownership 与 Permission 严格正交（§六）：Permission granted 并不自动意味着
 *   可以操作他人资源；判定链始终是 Permission AND Tenant Scope AND Ownership。
 *
 * 规则来源（唯一事实）：docs/architecture/RESOURCE-OWNERSHIP-RULES.md §3「SELF 归属清单」
 *   | signup.signup.create | activity_signups.user_id | 报名写入的 user_id 必须等于当前用户 |
 *   | signup.signup.cancel | activity_signups.user_id | 仅取消本人报名；且受 activities.allow_cancel 约束 |
 * 同文件 §3 明确禁止为表达"本人"创造 signup.signup.cancel.self 之类的权限码。
 *
 * S2-6h 的签到 SELF 归属：attendance_sessions.user_id === auth.userId。
 * 依据：attendance_sessions 是 activity_signups 的下游（UNIQUE(signup_id)），归属链与报名一致——
 * 本人报名 ⇒ 本人考勤。当前仓库内 RESOURCE-OWNERSHIP-RULES.md 缺失（§只读事实 #4 记录的文档缺口），
 * 故此归属按"与报名 SELF 规则同构"的冻结惯例实现，并在报告中标记为 OPEN 待文档补全。
 *
 * 冻结边界（§七）：冻结目录中 attendance.record.checkin / checkout 为 USER scope，
 * 仅 volunteer / platform_super_admin 持有；team_owner / team_admin 持有的是 force/review/anomaly
 * （TEAM scope），并不包含 checkin/checkout。因此本切片没有角色因"管理员"身份而获得签到/签退他人
 * 会话的能力——取消/签退他人考勤属后续 force/review 切片，不在本阶段。
 */

import type { AuthContext } from '../types/auth';

/** 最小归属策略接口（本阶段唯一实现 = ActivitySignupOwnershipPolicy）。 */
export interface OwnershipPolicy<T> {
  /**
   * 当前身份是否可对该资源执行动作。
   * - 纯判定：无 I/O、无副作用、不修改数据库（§十九：归属失败必须零写入）。
   * - 默认拒绝：任何不确定情形一律 false。
   */
  canAct(resource: T, auth: AuthContext): boolean;
}

/** activity_signups 行的归属判定视图（只含判定所需字段，避免耦合整行结构）。 */
export interface OwnedSignupResource {
  user_id: number;
}

/**
 * activity_signups —— SELF 归属策略。
 *
 * 规则：signup.user_id === auth.userId（RESOURCE-OWNERSHIP-RULES §3）。
 * - 未认证 / 无 userId / 资源缺失 → false（P8 默认拒绝）。
 * - 无角色名特判：team_owner / team_admin / platform_super_admin 一律不豁免。
 */
export class ActivitySignupOwnershipPolicy implements OwnershipPolicy<OwnedSignupResource> {
  canAct(resource: OwnedSignupResource, auth: AuthContext): boolean {
    if (!auth.authenticated || auth.userId == null) return false;
    if (resource == null || typeof resource.user_id !== 'number') return false;
    return resource.user_id === auth.userId;
  }
}

/** attendance_sessions 行的归属判定视图（只含判定所需字段）。 */
export interface OwnedAttendanceResource {
  user_id: number;
}

/**
 * attendance_sessions —— SELF 归属策略（S2-6h）。
 *
 * 规则：session.user_id === auth.userId（与报名 SELF 规则同构；见文件头说明）。
 * - 未认证 / 无 userId / 资源缺失 → false（默认拒绝）。
 * - 无角色名特判：team_owner / team_admin / platform_super_admin 一律不豁免
 *   （checkin / checkout 为 USER 权限，管理员仅通过 force/review 覆盖他人，属后续切片）。
 */
export class AttendanceSessionOwnershipPolicy implements OwnershipPolicy<OwnedAttendanceResource> {
  canAct(resource: OwnedAttendanceResource, auth: AuthContext): boolean {
    if (!auth.authenticated || auth.userId == null) return false;
    if (resource == null || typeof resource.user_id !== 'number') return false;
    return resource.user_id === auth.userId;
  }
}
