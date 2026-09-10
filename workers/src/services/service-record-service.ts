/**
 * ServiceRecordService（P22-P2）—— ServiceRecord 结算 use-case 编排层。
 *
 * 设计冻结依据：
 *   P22-DESIGN-REV3 = PASS
 *   P22 IMPLEMENTATION PREFLIGHT REV2 = PASS
 *
 * 职责（本切片范围，P22-P2）：
 * - 生成 public_id（Service 层负责；调用 src/utils/crypto.ts::generateUlid，不引入第二套 ID 生成器）。
 * - 选择 settlement mode（服务器内部常量，绝不读取 request body）。
 * - 暴露 buildSettleStatement() 供 P22-P3 组合进现有 attendance db.batch（强事务）。
 * - 暴露 revokeIfEffective() 供 anomaly CONFIRM / review reject 路径（EFFECTIVE→REVOKED）。
 *
 * 范围纪律（用户 §十 / P22-P2 边界）：本切片【只】实现 settlement core + revoke core。
 * 不实现 listMine / listTeam / findByPublicId 投影 / adjust / routes / read API（留待 P22-P4）。
 * 不修改任何其它文件（attendance-* / app.ts / routes），不碰历史 WIP。
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  ServiceRecordRepository,
  SettlementMode,
  SETTLEMENT_STATUS,
  ServiceRecordView,
  ServiceRecordListFilters,
  AdjustmentRequestRow,
  computePointsUnits,
} from '../repository/service-records';
import { PointsLedgerRepository } from '../repository/points-ledger';
import { generateUlid } from '../utils/crypto';
import {
  authRequired,
  teamScopeRequired,
  notFound,
  invalidParam,
  conflict,
  ConflictReason,
  forbidden,
} from '../utils/errors';

/** adjust 的 effective_minutes 上限（1 年 = 525600 分钟）：防御性上界，保证整数运算安全。 */
const MAX_ADJUST_MINUTES = 525600;
/** reason 最大长度（与 attendance management 的 500 一致）。 */
const REASON_MAX_LENGTH = 500;
/** 列表行数上限（clamp 用；最小实现，不引入游标分页）。 */
export const LIST_LIMIT_MAX = 200;
/** 列表默认行数。 */
export const LIST_LIMIT_DEFAULT = 50;

/** 服务依赖（由路由层从 Context 组装；Service 不接触 HTTP 对象）。 */
export interface ServiceRecordServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

/** settleEligibleSession 结果（changes=0 时的幂等 re-read 视图）。 */
export interface SettleResult {
  /** true=本次新建 EFFECTIVE ServiceRecord；false=未新建（已存在 / 资格未命中 / 被 anomaly 阻断）。 */
  settled: boolean;
  sessionId: number;
  /** 新建时=本次生成的 public_id；未新建时=既有 SR 的 public_id（若存在）。 */
  publicId: string | null;
  mode: SettlementMode;
}

/**
 * P35-C2：服务时长修正申请的对外投影。
 * 刻意【不】暴露 numeric requester_id / reviewer_id / team_id / id（§6 / §15 投影纪律）；
 * 申请人/审批人身份本阶段不扩展为可泄露的显示名（§6：如安全显示名会扩大范围则本阶段不做）。
 */
export interface AdjustmentRequestView {
  public_id: string;
  service_record_public_id: string;
  status: number;
  requested_minutes: number;
  reason: string;
  old_minutes_snapshot: number;
  old_points_awarded_units_snapshot: number;
  old_settlement_status_snapshot: number;
  requested_at: number;
  reviewed_at: number | null;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ServiceRecordService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly repo: ServiceRecordRepository;
  /** P23-P3B：积分账本 repository（复用同一 db/ctx，仅提供 build*Statements）。 */
  private readonly pointsRepo: PointsLedgerRepository;

  constructor(deps: ServiceRecordServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.repo = new ServiceRecordRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.pointsRepo = new PointsLedgerRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /**
   * 冻结 schema 时间语义：所有 timestamp = INTEGER Unix epoch **seconds**（与兄弟 service 一致）。
   */
  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** 公共前置：已认证 + 有合法团队上下文（TEAM_SCOPED 资源要求）。 */
  private requireActor(): { userId: number; teamId: number } {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: this.auth.userId, teamId: this.tenant.teamId };
  }

  /**
   * 独立原子结算（P22-P2 验证 / 非组合场景）。
   *
   * mode 为服务器内部常量，默认 'automatic'。
   * - 'automatic'：normal checkout / force-checkout / anomaly dismiss 调用，受 OPEN+CONFIRMED anomaly 阻断。
   * - 'review_approved'：CONFIRMED anomaly 经 review approve 后的人工最终化，仅受 OPEN anomaly 阻断。
   *
   * @returns changes=1 → 本次创建；changes=0 → 幂等/资格未命中（re-read 后返回既有 public_id）。
   */
  async settleEligibleSession(
    sessionId: number,
    opts: { mode?: SettlementMode } = {},
  ): Promise<SettleResult> {
    const { teamId } = this.requireActor();
    const mode: SettlementMode = opts.mode ?? 'automatic';
    const publicId = generateUlid();
    const now = this.nowSeconds();

    const changes = await this.repo.settleEligibleSessionAtomically({
      sessionId,
      teamId,
      mode,
      publicId,
      now,
    });

    if (changes === 1) {
      return { settled: true, sessionId, publicId, mode };
    }
    // changes=0：幂等（已结算）或资格未命中。re-read 取既有 SR（如有）。
    const existing = await this.repo.findBySessionId(sessionId, teamId);
    return { settled: false, sessionId, publicId: existing?.public_id ?? null, mode };
  }

  /**
   * 构建 settlement prepared statement 供 P22-P3 组合进【现有】attendance db.batch。
   *
   * 强事务（P22-P2 硬门禁）：attendance transition 与 settlement 同批原子提交/回滚。
   * Public id 在本层生成（Service 层拥有 ID 生成职责），调用方须将返回的 statement 追加进其 batch，
   * 【不得】单独 run（否则破坏强事务）。
   *
   * @param sessionId  目标会话
   * @param teamId     租户团队（REVIEW 调用方负责提供，已通过 TEAM 作用域校验）
   * @param mode       服务器内部 mode（绝不来自请求体）
   * @param gateNonce  transition-gate：本批 transition event 的 unique nonce；仅当同批存在该 event 才插入。
   */
  buildSettleStatement(
    sessionId: number,
    teamId: number,
    mode: SettlementMode,
    gateNonce?: string | null,
    opts?: { now?: number; publicId?: string },
  ): D1PreparedStatement {
    const publicId = opts?.publicId ?? generateUlid();
    const now = opts?.now ?? this.nowSeconds();
    return this.repo.buildSettleStatement({ sessionId, teamId, mode, publicId, now, gateNonce });
  }

  /**
   * P23-P3B：settlement + 积分三件套组合为同一批 statements（供 P22-P3 追加进 attendance db.batch）。
   * 顺序固定：settleStmt → S0 → S1 → S2；now 单一来源，确保积分与 settlement 时间语义一致。
   */
  buildSettleStatementWithPoints(
    sessionId: number,
    teamId: number,
    mode: SettlementMode,
    gateNonce?: string | null,
    remark?: string | null,
    operatorId?: number | null,
  ): D1PreparedStatement[] {
    const now = this.nowSeconds();
    const settleStmt = this.buildSettleStatement(sessionId, teamId, mode, gateNonce, { now });
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId,
      now,
      remark: remark ?? 'checkout',
      operatorId: operatorId ?? null,
    });
    return [settleStmt, ...pts.statements];
  }

  /**
   * 为 P22-P3 组合 revoke 语句集进 attendance/anomaly db.batch。
   *
   * 先按 session 定位 EFFECTIVE ServiceRecord（re-read 取 id）；若不存在或非 EFFECTIVE 则返回空数组
   * （该路径不产生任何批内语句，由调用方作为 extraStatements 传入）。
   * 返回的 [audit INSERT, revoke UPDATE] 已带 `gateNonce` 关联 gate，确保仅当本批 transition 真实发生时才撤销。
   *
   * @param gateNonce 同批 transition event 的 unique nonce（来自 review reject / anomaly confirm 调用方生成）。
   */
  async buildRevokeStatementsForSession(
    sessionId: number,
    opts: { reason?: string; operatorId?: number; traceId?: string | null; gateNonce: string; now?: number },
  ): Promise<D1PreparedStatement[]> {
    const { userId, teamId } = this.requireActor();
    const now = opts.now ?? this.nowSeconds();
    const sr = await this.repo.findBySessionId(sessionId, teamId);
    if (sr == null || sr.settlement_status !== SETTLEMENT_STATUS.EFFECTIVE) return [];
    return this.repo.buildRevokeStatementSet({
      serviceRecordId: sr.id,
      teamId,
      reason: opts.reason ?? 'post-settlement anomaly confirmed',
      operatorId: opts.operatorId ?? userId,
      traceId: opts.traceId ?? null,
      now,
      gateNonce: opts.gateNonce,
    });
  }

  /**
   * P23-P3B：revoke + 积分三件套组合为同一批 statements（供 P22-P3 追加进 attendance/anomaly db.batch）。
   * 顺序固定：audit → revoke → S0 → S1 → S2。若无非 EFFECTIVE ServiceRecord 则直接返回空数组（与后端一致）。
   */
  async buildRevokeStatementsForSessionWithPoints(
    sessionId: number,
    opts: {
      reason?: string;
      operatorId?: number;
      traceId?: string | null;
      gateNonce: string;
      remark?: string | null;
    },
  ): Promise<D1PreparedStatement[]> {
    const now = this.nowSeconds();
    const revokeSet = await this.buildRevokeStatementsForSession(sessionId, { ...opts, now });
    if (revokeSet.length === 0) return [];
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId,
      now,
      remark: opts.remark ?? 'revoke',
      operatorId: opts.operatorId ?? null,
    });
    return [...revokeSet, ...pts.statements];
  }

  /**
   * 若 session 已有 EFFECTIVE ServiceRecord，则撤销为 REVOKED（供 anomaly CONFIRM 钩子 / review reject 调用）。
   * 对 UNVERIFIED(0) / REVOKED(2) / 不存在 → 0（无副作用）。
   *
   * @returns revoke 实际变更行数（1=已撤销；0=无 EFFECTIVE 可撤销）。
   */
  async revokeIfEffective(
    sessionId: number,
    opts: { reason?: string; operatorId?: number; traceId?: string | null } = {},
  ): Promise<number> {
    const { userId, teamId } = this.requireActor();
    const sr = await this.repo.findBySessionId(sessionId, teamId);
    if (sr == null || sr.settlement_status !== 1) return 0; // 无需撤销
    return this.repo.revokeAtomically({
      serviceRecordId: sr.id,
      teamId,
      sessionId: sr.session_id,
      reason: opts.reason ?? 'post-settlement anomaly confirmed',
      operatorId: opts.operatorId ?? userId,
      traceId: opts.traceId ?? null,
      now: this.nowSeconds(),
    });
  }

  // ==========================================================================
  // P22-P4：读取（SELF / TEAM / 详情）
  // ==========================================================================

  /**
   * 解析并 clamp 列表行数（最小实现：无游标分页，仅防御性上限）。
   * 非法（非整数 / <1）→ 400 INVALID_PARAM，与页面参数校验同风格。
   */
  private parseLimit(raw: string | undefined): number {
    if (raw == null || raw.trim() === '') return LIST_LIMIT_DEFAULT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw invalidParam('limit', 'must be a positive integer');
    return Math.min(n, LIST_LIMIT_MAX);
  }

  /** 归一化可选过滤值：空串 / undefined 一律视为"不过滤"。 */
  private normalizeFilter(raw: string | undefined): string | null {
    if (raw == null) return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * SELF 列表（GET /service-records/mine）。
   *
   * 硬约束（P22-P4 §4）：userId 只来自 auth、teamId 只来自 TenantContext；
   * 【不接受】任何"查询他人"的参数——路由层也不暴露此类 query。
   * 历史 UNVERIFIED(0) / REVOKED(2) 记录【可见】，且 settlement_status 字段如实返回；
   * 可见 ≠ 可消费：下游统计/积分仍只消费 EFFECTIVE(1)。
   */
  async listMine(query: { businessServiceDate?: string; limit?: string } = {}): Promise<ServiceRecordView[]> {
    const { userId, teamId } = this.requireActor();
    const filters: ServiceRecordListFilters = {
      businessServiceDate: this.normalizeFilter(query.businessServiceDate),
      limit: this.parseLimit(query.limit),
    };
    return this.repo.listMine(userId, teamId, filters);
  }

  /**
   * TEAM 列表（GET /service-records）。
   * 可选过滤：business_service_date、user_public_id（ULID，非法 → 400）。
   */
  async listTeam(
    query: { businessServiceDate?: string; userPublicId?: string; limit?: string } = {},
  ): Promise<ServiceRecordView[]> {
    const { teamId } = this.requireActor();
    const userPublicId = this.normalizeFilter(query.userPublicId);
    // user_public_id 若提供必须是合法 ULID（users.public_id 为 ULID），否则 400（先于任何 DB 访问）。
    if (userPublicId != null && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(userPublicId)) {
      throw invalidParam('user_public_id', 'must be a 26-char ULID');
    }
    const filters: ServiceRecordListFilters = {
      businessServiceDate: this.normalizeFilter(query.businessServiceDate),
      userPublicId,
      limit: this.parseLimit(query.limit),
    };
    return this.repo.listTeam(teamId, filters);
  }

  /**
   * TEAM 详情（GET /service-records/:publicId）。
   * 跨团队与不存在【统一 404】（不区分，避免 existence oracle）。
   */
  async getByPublicId(publicId: string): Promise<ServiceRecordView> {
    const { teamId } = this.requireActor();
    const view = await this.repo.findByPublicId(publicId, teamId);
    if (view == null) throw notFound('ServiceRecord');
    return view;
  }

  // ==========================================================================
  // P35-C2：服务时长人工修正「申请 → 双人审批」工作流（仅 backend）
  // ==========================================================================

  /**
   * 提交修正申请（POST /:serviceRecordPublicId/adjustments）。
   *
   * 契约（§3/§4/§5）：body 只允许 { requested_minutes: integer 0..525600, reason: 1..500 }。
   * 客户端不得提交 status / 快照字段 / requester / reviewer / team / points / settlement_status /
   * 任何 numeric ID / 任何 approval 字段（由路由层显式 400，此处不再重复）。
   *
   * 资格（§4）：目标 SR 必须同团队且 settlement_status = EFFECTIVE(1)；否则 404（cross-team/not-found）
   * 或 409 ADJUSTMENT_NOT_ALLOWABLE（不可调整状态）。同一 SR 最多 1 个 PENDING：第二个由
   * 0028 部分唯一索引作最终并发保证（insertAdjustmentRequest 捕获 UNIQUE → 409）。
   *
   * 创建即原子捕获三快照（old_minutes / old_points_awarded_units / old_settlement_status），
   * 客户端无法控制；创建后 service_record 与 points 完全不变。
   */
  async requestAdjustment(
    serviceRecordPublicId: string,
    body: { requestedMinutes: number; reason: string },
  ): Promise<AdjustmentRequestView> {
    const { userId, teamId } = this.requireActor();

    // 1) 业务校验（先于 DB 写）。
    if (!Number.isInteger(body.requestedMinutes)) {
      throw invalidParam('requested_minutes', 'must be an integer');
    }
    if (body.requestedMinutes < 0) {
      throw invalidParam('requested_minutes', 'must be >= 0');
    }
    if (body.requestedMinutes > MAX_ADJUST_MINUTES) {
      throw invalidParam('requested_minutes', `must be <= ${MAX_ADJUST_MINUTES}`);
    }
    const reason = body.reason?.trim() ?? '';
    if (reason === '') {
      throw invalidParam('reason', 'must be a non-empty string');
    }
    if (reason.length > REASON_MAX_LENGTH) {
      throw invalidParam('reason', `must be <= ${REASON_MAX_LENGTH} characters`);
    }

    // 2) 读目标 SR（团队作用域）。跨团队 / 不存在 → 404。
    const current = await this.repo.findRowByPublicId(serviceRecordPublicId, teamId);
    if (current == null) throw notFound('ServiceRecord');

    // 3) 资格：仅 EFFECTIVE(1) 可发起修正申请。
    if (current.settlement_status !== SETTLEMENT_STATUS.EFFECTIVE) {
      throw conflict(ConflictReason.ADJUSTMENT_NOT_ALLOWABLE);
    }

    // 4) 原子捕获三快照 + 插入 PENDING（public_id 由 Service 层生成）。
    const publicId = generateUlid();
    const now = this.nowSeconds();
    await this.repo.insertAdjustmentRequest({
      publicId,
      serviceRecordPublicId,
      teamId,
      requesterId: userId,
      oldMinutesSnapshot: current.minutes,
      oldPointsAwardedUnitsSnapshot: current.points_awarded_units,
      oldSettlementStatusSnapshot: current.settlement_status,
      requestedMinutes: body.requestedMinutes,
      reason,
      now,
    });

    // 5) 回读投影返回（零内部 numeric FK）。
    const row = await this.repo.findAdjustmentByPublicId(publicId, teamId);
    if (row == null) throw notFound('AdjustmentRequest');
    return this.toAdjustmentView(row);
  }

  /**
   * 列出某 service record 的修正申请历史（GET /:serviceRecordPublicId/adjustments，newest first）。
   * 团队作用域；跨团队 / 不存在的 SR → 404。投影不含任何 numeric 内部 id。
   */
  async listAdjustments(serviceRecordPublicId: string): Promise<AdjustmentRequestView[]> {
    const { teamId } = this.requireActor();
    const sr = await this.repo.findRowByPublicId(serviceRecordPublicId, teamId);
    if (sr == null) throw notFound('ServiceRecord');
    const rows = await this.repo.listAdjustmentRequests(serviceRecordPublicId, teamId);
    return rows.map((r) => this.toAdjustmentView(r));
  }

  /**
   * 审批通过（POST /service-record-adjustments/:adjustmentPublicId/approve）。
   *
   * 顺序（§7/§8/§9）：
   *   1) 申请必须 PENDING，否则 409 INVALID_TRANSITION；
   *   2) reviewer(当前 auth.userId) != requester，否则 403（含 platform_super_admin，无 bypass）；
   *   3) stale：当前 SR 三字段 == 申请快照 且 快照=EFFECTIVE(1)，否则 409 STALE（零业务效果，保持 PENDING）；
   *   4) 复用 computePointsUnits（项目唯一权威积分实现，绝不复制算法）算新 points；
   *   5) 同一 db.batch 原子完成 audit + SR UPDATE(source='correction') + request APPROVED + 积分三件套；
   *      快照谓词保证并发漂移时 audit/SR/request 三者皆 0 行 → 零副作用。
   */
  async approveAdjustment(adjustmentPublicId: string): Promise<ServiceRecordView> {
    const { userId, teamId } = this.requireActor();

    const req = await this.repo.findAdjustmentByPublicId(adjustmentPublicId, teamId);
    if (req == null) throw notFound('AdjustmentRequest');
    if (req.status !== 0) throw conflict(ConflictReason.ADJUSTMENT_INVALID_TRANSITION);

    // 申请人不得审核自己（super admin 亦无 bypass）。
    if (req.requester_id === userId) throw forbidden();

    // stale 预检：当前 SR 必须与申请快照一致且快照为 EFFECTIVE。
    const current = await this.repo.findRowByPublicId(req.service_record_public_id, teamId);
    if (current == null) throw notFound('ServiceRecord');
    if (
      current.minutes !== req.old_minutes_snapshot ||
      current.points_awarded_units !== req.old_points_awarded_units_snapshot ||
      current.settlement_status !== req.old_settlement_status_snapshot ||
      req.old_settlement_status_snapshot !== SETTLEMENT_STATUS.EFFECTIVE
    ) {
      throw conflict(ConflictReason.ADJUSTMENT_STALE);
    }

    // 复用项目唯一权威积分算法（target-net 由 SR_CTE 在 points 层完成，本处只算目标值）。
    const newPoints = computePointsUnits(
      req.requested_minutes,
      current.points_min_minutes,
      current.points_base_units_per_hour,
      current.points_multiplier_pct,
    );

    const now = this.nowSeconds();
    const changes = await this.repo.approveAdjustmentAtomically({
      adjustmentRequestId: req.id,
      serviceRecordPublicId: req.service_record_public_id,
      teamId,
      requesterId: req.requester_id,
      reviewerId: userId,
      oldMinutesSnapshot: req.old_minutes_snapshot,
      oldPointsAwardedUnitsSnapshot: req.old_points_awarded_units_snapshot,
      oldSettlementStatusSnapshot: req.old_settlement_status_snapshot,
      newMinutes: req.requested_minutes,
      newPoints,
      sessionId: current.session_id,
      reason: req.reason,
      traceId: req.public_id,
      now,
    });

    // 并发漂移（in-batch 快照谓词落空）→ 0 行 → 视为 stale，保持 PENDING。
    if (changes === 0) throw conflict(ConflictReason.ADJUSTMENT_STALE);

    const view = await this.repo.findByPublicId(req.service_record_public_id, teamId);
    if (view == null) throw notFound('ServiceRecord');
    return view;
  }

  /**
   * 拒绝（POST /service-record-adjustments/:adjustmentPublicId/reject）。
   *
   * 仅更新 request 行（status=REJECTED + reviewer 字段）；不触碰 service_records / points /
   * settlement_status / points ledger / service_record_audits。
   * 申请人不得拒绝自己申请（403）；非 PENDING → 409 INVALID_TRANSITION。
   */
  async rejectAdjustment(adjustmentPublicId: string, reviewReason: string): Promise<void> {
    const { userId, teamId } = this.requireActor();

    const req = await this.repo.findAdjustmentByPublicId(adjustmentPublicId, teamId);
    if (req == null) throw notFound('AdjustmentRequest');
    if (req.status !== 0) throw conflict(ConflictReason.ADJUSTMENT_INVALID_TRANSITION);

    // 申请人不得拒绝自己申请。
    if (req.requester_id === userId) throw forbidden();

    const reason = reviewReason?.trim() ?? '';
    if (reason === '') throw invalidParam('reason', 'must be a non-empty string');
    if (reason.length > REASON_MAX_LENGTH) {
      throw invalidParam('reason', `must be <= ${REASON_MAX_LENGTH} characters`);
    }

    const now = this.nowSeconds();
    const changes = await this.repo.rejectAdjustmentAtomically({
      adjustmentRequestId: req.id,
      teamId,
      reviewerId: userId,
      reviewReason: reason,
      now,
    });
    if (changes === 0) throw conflict(ConflictReason.ADJUSTMENT_INVALID_TRANSITION);
  }

  /** 投影：AdjustmentRequestRow → AdjustmentRequestView（剥离一切 numeric 内部 id）。 */
  private toAdjustmentView(row: AdjustmentRequestRow): AdjustmentRequestView {
    return {
      public_id: row.public_id,
      service_record_public_id: row.service_record_public_id,
      status: row.status,
      requested_minutes: row.requested_minutes,
      reason: row.reason,
      old_minutes_snapshot: row.old_minutes_snapshot,
      old_points_awarded_units_snapshot: row.old_points_awarded_units_snapshot,
      old_settlement_status_snapshot: row.old_settlement_status_snapshot,
      requested_at: row.requested_at,
      reviewed_at: row.reviewed_at,
      applied_at: row.applied_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
