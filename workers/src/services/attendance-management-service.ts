/**
 * AttendanceManagementService（S2-6i）—— 考勤管理操作（Review 审核 / Force Checkout 强制签退）。
 *
 * 与 S2-6h 的 AttendanceService（SELF 本人签到/签退）严格正交：
 * - S2-6h = USER scope，本人资源，走 AttendanceSessionOwnershipPolicy（SELF）。
 * - S2-6i = TEAM scope，管理员操作【他人】考勤会话，绝不使用 SELF ownership policy（§八/§十四）。
 *
 * 租户隔离（§八/§九）：资源判定完全下推到 Repository 的 `WHERE id = ? AND team_id = ?`；
 * service / route 层【不】先 SELECT 再比较 team_id（那会构成 cross-team existence oracle）。
 * 跨团队 sessionId 在 Repository 层即返回 null → 统一 404（不泄露存在性）。
 *
 * 权限（唯一事实 = permission-catalog.json，本切片不新增/不改 permission）：
 * - attendance.record.review  —— TEAM scope（team_owner / team_admin / team_auditor 持有；volunteer/PSA 受限）
 * - attendance.record.force   —— TEAM scope（team_owner / team_admin 持有；team_auditor / volunteer 受限）
 * 授权裁决由 middleware(requirePermission) 经 D1PermissionProvider 完成；本 service 只负责
 * 业务不变式 + 租户范围 + 原子编排。PSA 即便 catalog 持有该权限，也因 TenantContext.teamId=null
 * 在 requireActor() 处被拒为 403 TEAM_SCOPE_REQUIRED（已知 architecture gap，不在本阶段修复）。
 *
 * 范围纪律（用户 §一）：本切片【只】实现 Review + Force Checkout。
 * 不实现 anomaly / risk / heartbeat / 设备 / effective_minutes / service_records / 积分 / 证书 /
 * 时间校验 / 位置校验 / 班次调度 / 活动状态机 / 平台跨团队管理 / 新迁移 / 新权限 / catalog 变更。
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import type { Env } from '../env';
import { AttendanceSessionRepository, ATTENDANCE_STATUS } from '../repository/attendance-sessions';
import { ServiceRecordService } from '../services/service-record-service';
import {
  authRequired,
  conflict,
  notFound,
  teamScopeRequired,
  invalidParam,
  ConflictReason,
} from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装；service 不接触 HTTP 对象）。 */
export interface AttendanceManagementDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env: Env;
}

/** Review 决策（冻结：仅 approve / reject）。 */
export type ReviewDecision = 'approve' | 'reject';

/** Review/Force 操作成功后的会话视图（仅回显必要字段，不泄露内部/敏感信息）。 */
export interface AttendanceManagementView {
  session_id: number;
  activity_id: number;
  user_id: number;
  team_id: number;
  status: number;
  review_status: number;
  checkin_at: number | null;
  checkout_at: number | null;
  updated_at: number | null;
}

const REASON_MAX = 500;

/**
 * 故障注入模式 2 专用的越界状态值（TEST-ONLY，仅 local + JHZY_FAULT_INJECT=2 可达）。
 * 同时越出 attendance_sessions.status CHECK (0..4) 与 review_status CHECK (0..2)，
 * 使 batch 的 stmt[1]（UPDATE）必然失败，从而验证 stmt[0] 已执行的 INSERT 被真实回滚。
 */
const FAULT_OUT_OF_RANGE = 9;

export class AttendanceManagementService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly env: Env;
  private readonly repo: AttendanceSessionRepository;
  private readonly srService: ServiceRecordService;

  constructor(deps: AttendanceManagementDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.env = deps.env;
    this.repo = new AttendanceSessionRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.srService = new ServiceRecordService({ db: this.db, auth: this.auth, tenant: this.tenant });
  }

  /**
   * 公共前置：已认证 + 有 userId + 有合法团队上下文（TEAM scope 强制要求）。
   * - 未认证 → 401；无团队上下文（含 platform 角色）→ 403 TEAM_SCOPE_REQUIRED。
   */
  private requireActor(): { userId: number; teamId: number } {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: this.auth.userId, teamId: this.tenant.teamId };
  }

  /**
   * 本地故障注入模式（§10 / §17-L 原子性证据）：仅 local 环境 + 显式 JHZY_FAULT_INJECT 时启用，
   * 生产（非 local）永不触发，无任何副作用。
   *
   * - 0 = 关闭（默认，正常业务路径）。
   * - 1 = 令 batch 的 **stmt[0]（audit event INSERT）** 失败：event_type='__FAULT__' 违反
   *       attendance_events.event_type CHECK 约束。证明：整批失败 → UPDATE 从未生效
   *       → 会话状态 / updated_at 保持原值 / event 不存在（§4 字面要求）。
   * - 2 = 令 batch 的 **stmt[1]（条件 UPDATE）** 失败：写入越界的 review_status / status
   *       违反对应 CHECK 约束。此时 stmt[0] 的 INSERT 已成功执行，故该模式证明
   *       【已执行语句被真实回滚】（event 不存在），即 db.batch 是真事务、而非"短路未执行"。
   *
   * 读取顺序（local 测试通道）：先 c.env（来自 wrangler 配置的 vars），回退 process.env。
   * 实测结论（wrangler 4.127.1 local）：只有配置文件 vars 能进入 c.env，`--var` 不进入。
   */
  private faultMode(): 0 | 1 | 2 {
    if ((this.env?.ENVIRONMENT ?? 'local') !== 'local') return 0;
    const v = this.env?.JHZY_FAULT_INJECT ?? (globalThis as any).process?.env?.JHZY_FAULT_INJECT;
    if (v === '1') return 1;
    if (v === '2') return 2;
    return 0;
  }

  /**
   * 冻结 schema 时间语义（嘉禾志愿 2.0）：所有 timestamp 列 = INTEGER Unix epoch **seconds**。
   *
   * 该方法是本 service 唯一的时间源，禁止在别处使用裸 Date.now()（13 位毫秒会污染
   * attendance_sessions.updated_at / checkout_at 与 attendance_events.occurred_at）。
   * 与兄弟切片 S2-6h（attendance-service.ts）完全一致的项目既有写法。
   */
  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * reason 规范化（§3 / §5）：
   * - 非 string / 空 → 若 required 则 400，否则按空处理。
   * - 去首尾空白后为空 → 同上。
   * - 长度 > 500 → 400（禁止 unbounded input）。
   */
  private normalizeReason(reason: unknown, required: boolean): string {
    if (reason == null || typeof reason !== 'string') {
      if (required) throw invalidParam('reason', 'required');
      return '';
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      if (required) throw invalidParam('reason', 'required');
      return '';
    }
    if (trimmed.length > REASON_MAX) throw invalidParam('reason', 'too_long_max_500');
    return trimmed;
  }

  /** 将 Repository 行映射为对外视图。 */
  private toView(row: {
    id: number;
    activity_id: number;
    user_id: number;
    team_id: number;
    status: number;
    review_status: number;
    checkin_at: number | null;
    checkout_at: number | null;
    updated_at: number | null;
  }): AttendanceManagementView {
    return {
      session_id: row.id,
      activity_id: row.activity_id,
      user_id: row.user_id,
      team_id: row.team_id,
      status: row.status,
      review_status: row.review_status,
      checkin_at: row.checkin_at,
      checkout_at: row.checkout_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 审核考勤记录（POST /api/v2/attendance-sessions/:sessionId/review）。
   *
   * 顺序（§3 / §9 / §10）：
   * 1) 身份 + 团队上下文（requireActor）。
   * 2) decision 枚举校验（approve|reject），否则 400。
   * 3) reason 规范化：reject 必须非空（§3 建议）；approve 可选；统一 500 截断。
   * 4) 原子 batch：UPDATE review_status(0→1/2) + INSERT event('manual')，二者同批原子。
   *    UPDATE 的 WHERE 含 id + team_id + review_status=0，未命中（已审核/跨团队）→ changes=0。
   * 5) changes=0 → 经 Repository 的 TEAM 作用域再查（findTeamSession）区分：
   *      行存在（review_status!=0）→ 409 ATTENDANCE_ALREADY_REVIEWED（禁止 1↔2 / 回退）；
   *      行不存在（跨团队/不存在）→ 404 NOT_FOUND（不泄露存在性）。
   * 6) 仅修改 review_status；绝不改 status / checkin_at / checkout_at / effective_minutes /
   *    risk / device / service_date / slot（§3）。
   */
  async reviewSession(
    sessionId: number,
    body: { decision?: unknown; reason?: unknown },
  ): Promise<AttendanceManagementView> {
    const actor = this.requireActor();

    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      throw invalidParam('decision', 'must be approve|reject');
    }
    const newReviewStatus = decision === 'approve' ? 1 : 2;
    // reject 建议要求非空 reason（§3）；approve 的 reason 可选。
    const reason = this.normalizeReason(body.reason, decision === 'reject');

    const now = this.nowSeconds(); // 冻结 schema：Unix epoch seconds（绝不写入毫秒）
    const fault = this.faultMode();
    // 故障模式 1 → stmt[0] INSERT 违反 event_type CHECK；模式 2 → stmt[1] UPDATE 违反 review_status CHECK。
    const eventType = fault === 1 ? '__FAULT__' : 'manual';
    const writeReviewStatus = fault === 2 ? FAULT_OUT_OF_RANGE : newReviewStatus;
    const raw = JSON.stringify({ action: 'review', decision });

    // P22-P3：将 settlement/revoke 组合进【同一】review db.batch（强事务）。
    // nonce 作为 transition-gate：仅当本次 review 真实 transition（review_status 0→approved/rejected）
    // 才创建/撤销 ServiceRecord；重复 review（changes=0）不写 event ⇒ gate 不命中 ⇒ 无 SR 副作用。
    const nonce = `review:${sessionId}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;
    let reviewExtra: D1PreparedStatement[] = [];
    if (decision === 'approve') {
      reviewExtra = await this.srService.buildSettleStatementWithPoints(sessionId, actor.teamId, 'review_approved', nonce, 'review_approve', actor.userId);
    } else {
      reviewExtra = await this.srService.buildRevokeStatementsForSessionWithPoints(sessionId, {
        reason: reason || 'review rejected',
        operatorId: actor.userId,
        gateNonce: nonce,
        remark: 'review_reject',
      });
    }
    const changes = await this.repo.reviewSessionAtomically(
      sessionId,
      actor.teamId,
      writeReviewStatus,
      eventType,
      reason,
      raw,
      actor.userId,
      now,
      { nonce, extraStatements: reviewExtra },
    );

    if (changes === 0) {
      const row = await this.repo.findTeamSession(sessionId, actor.teamId);
      if (row == null) throw notFound('Attendance session');
      // 行存在但 guard 未命中 → 已处于审核终态（review_status != 0），禁止重复/回退。
      throw conflict(ConflictReason.ATTENDANCE_ALREADY_REVIEWED);
    }

    const row = await this.repo.findTeamSession(sessionId, actor.teamId);
    if (row == null) throw notFound('Attendance session'); // 理论不可达（changes>0 即存在）
    return this.toView(row);
  }

  /**
   * 强制签退（POST /api/v2/attendance-sessions/:sessionId/force-checkout）。
   *
   * 顺序（§5 / §6 / §9 / §10）：
   * 1) 身份 + 团队上下文（requireActor）。
   * 2) reason 必填非空、≤500（§5）。
   * 3) 原子 batch：UPDATE status(1→2) + checkout_at=now + INSERT event('force_checkout')，同批原子。
   *    UPDATE 的 WHERE 含 id + team_id + status=1 + checkout_at IS NULL，未命中 → changes=0。
   * 4) changes=0 → 经 Repository 的 TEAM 作用域再查区分 404 / 409：
   *      行存在但 status!=1 或 checkout_at 已非 NULL → 409 ATTENDANCE_NOT_ACTIVE（status 0/2/3/4 / 已签退）。
   *      行不存在（跨团队/不存在）→ 404。
   * 5) 仅做状态迁移（CHECKED_IN→CHECKED_OUT）+ 审计事件；绝不改 review_status / effective_minutes /
   *    risk / device / service_date / slot；绝不生成/更新 service_records / 积分 / 证书 / anomaly（§6）。
   * 6) 不使用 status=4（CANCELLED/INVALIDATED 保留给后续切片，本阶段不用）。
   */
  async forceCheckout(
    sessionId: number,
    body: { reason?: unknown },
  ): Promise<AttendanceManagementView> {
    const actor = this.requireActor();
    const reason = this.normalizeReason(body.reason, true);

    const now = this.nowSeconds(); // 冻结 schema：Unix epoch seconds（绝不写入毫秒）
    const fault = this.faultMode();
    // 故障模式 1 → stmt[0] INSERT 违反 event_type CHECK；模式 2 → stmt[1] UPDATE 违反 status CHECK。
    const eventType = fault === 1 ? '__FAULT__' : 'force_checkout';
    const writeStatus = fault === 2 ? FAULT_OUT_OF_RANGE : ATTENDANCE_STATUS.CHECKED_OUT;
    const raw = JSON.stringify({ action: 'force_checkout' });

    // P22-P3：settlement 组合进同一 force-checkout db.batch（强事务）.
    const nonce = `force:${sessionId}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;
    const settleStmts = await this.srService.buildSettleStatementWithPoints(sessionId, actor.teamId, 'automatic', nonce, 'force_checkout', null);
    const changes = await this.repo.forceCheckoutAtomically(
      sessionId,
      actor.teamId,
      now,
      eventType,
      reason,
      raw,
      actor.userId,
      writeStatus,
      { nonce, extraStatements: settleStmts },
    );

    if (changes === 0) {
      const row = await this.repo.findTeamSession(sessionId, actor.teamId);
      if (row == null) throw notFound('Attendance session');
      // 行存在但 guard 未命中 → 非活跃会话（status!=1 / 已签退），拒绝并 409。
      throw conflict(ConflictReason.ATTENDANCE_NOT_ACTIVE);
    }

    const row = await this.repo.findTeamSession(sessionId, actor.teamId);
    if (row == null) throw notFound('Attendance session');
    return this.toView(row);
  }
}
