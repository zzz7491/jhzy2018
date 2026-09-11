/**
 * ServiceRecordRepository（P22-P2）—— ServiceRecord 结算（settlement）唯一写入口。
 *
 * 设计冻结依据：
 *   P22-DESIGN-REV3 = PASS
 *   P22 IMPLEMENTATION PREFLIGHT REV2 = PASS
 *   P22-P1 MIGRATION + PERMISSION = PASS（0017 已落地）
 *
 * 强事务架构（P22-P2 硬门禁）：
 * - settlement core 必须能被 P22-P3 组合进【现有】attendance db.batch（attendance transition
 *   与 settlement 同批原子：要么都成功，要么都回滚；杜绝"attendance 成功但 ServiceRecord 永久缺失"）。
 * - 因此本文件提供 build*Statement()：返回已 bind 的 prepared statement，供调用方 push 进自己的 db.batch。
 * - 同时提供 *Atomically() 便捷方法（自行 db.batch），用于 P22-P2 独立验证 / 非组合场景。
 *
 * SQL 纪律（与仓库其它 repo 一致）：
 * - 全部 prepare().bind()，禁止字符串插值用户值。
 * - 仅 MULTIPLIER_BASE / POINTS_BASE_UNITS_PER_HOUR 这类【服务器内部常量】可嵌入 SQL（非用户输入）。
 *
 * settlement 资格（#2）：全部在单条 INSERT...SELECT...WHERE 内由 SQL 重算，避免
 *   "JS 先 SELECT 资格 → 再 INSERT" 的 TOCTOU（attendance 状态 / anomaly / activity policy 竞态）。
 *
 * anomaly mode（#3）：仅服务器内部选择，绝不由 API/request body 传入。
 *   - automatic：存在 anomaly status IN (1,2) → INSERT 0 行（OPEN 与 CONFIRMED 都阻断）。
 *   - review_approved：仅阻断 OPEN(1)，允许 CONFIRMED(2) 最终化。
 */

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { BaseRepository, type RepoDeps } from './base';
import { PointsLedgerRepository } from './points-ledger';
import { conflict, ConflictReason } from '../utils/errors';

/** settlement mode：仅服务器代码选择，永不来自请求体。 */
export type SettlementMode = 'automatic' | 'review_approved';

/** attendance_anomalies.status 字典（与 repository/attendance-anomalies.ts 一致）：1=OPEN / 2=CONFIRMED / 3=DISMISSED。 */
export const ANOMALY_STATUS = {
  OPEN: 1,
  CONFIRMED: 2,
  DISMISSED: 3,
} as const;

/**
 * settlement_status 字典（0017 冻结）：
 * 0 = UNVERIFIED（未认证，下游一律不得消费）
 * 1 = EFFECTIVE（有效，可消费）
 * 2 = REVOKED（已撤销，不可消费）
 */
export const SETTLEMENT_STATUS = {
  UNVERIFIED: 0,
  EFFECTIVE: 1,
  REVOKED: 2,
} as const;

/**
 * 积分倍率百分比基数（points_multiplier_pct 的分母基数 100 = ×1.0）。固定常量，非倍率本身。
 *
 * 【关键】分母 = 60 * MULTIPLIER_BASE，其中 100 是【百分比基数】，【不是】 points_base_units_per_hour。
 * 若误写为 60 * points_base_units_per_hour，则 base 在分子分母中自我抵消，
 * 未来把 base 从 100 改为 200 时结果仍按 1 积分/小时 —— 这是 P22-PREFLIGHT-REV1 修正的逻辑错误。
 */
export const MULTIPLIER_BASE = 100;
/** 冻结 P22 基点：100 units/hour。若未来变更，须同步修改【下方存储列】与【积分公式分子字面量】。 */
const POINTS_BASE_UNITS_PER_HOUR = 100;
/** 积分门槛（分钟）。 */
const POINTS_MIN_MINUTES = 30;

export interface SettlementInput {
  sessionId: number;
  teamId: number;
  mode: SettlementMode;
  /** 由 Service 层（generateUlid）生成后传入，repository 不自行生成 ID。 */
  publicId: string;
  /** Unix epoch seconds（冻结 schema 语义）。 */
  now: number;
  /**
   * P22-P3 transition gate（可空，向后兼容 P22-P2 独立验证）。
   * 非空时 settlement 仅当【同一 db.batch 内】存在 nonce 等于本值的 attendance_events 才插入，
   * 从而证明本次 transfer（checkout/review/anomaly）真实发生 —— 杜绝 changes=0 仍产生副作用。
   * 空 → 关闭 gate（独立调用必须自行保证调用时机）。
   */
  gateNonce?: string | null;
}

export interface RevokeInput {
  serviceRecordId: number;
  teamId: number;
  reason: string;
  operatorId: number;
  traceId: string | null;
  now: number;
  /** P23-P3B：对应 ServiceRecord 的 session_id，用于定位积分账本 selector（与 settlement/adjust 同源）。 */
  sessionId?: number;
  /**
   * P22-P3 transition gate（可空，向后兼容）。非空时仅当同批存在该 nonce 的 transition event 才执行
   * audit + revoke，确保与 anomaly/review 主 transition 严格关联（changes=0 不产生副作用）。
   */
  gateNonce?: string | null;
}

/**
 * P22 积分计算（全整数、无浮点）—— 唯一权威实现，service 层必须复用本函数。
 *
 *   minutes < points_min_minutes  →  0
 *   否则 numerator   = minutes * points_base_units_per_hour * points_multiplier_pct
 *       denominator  = 60 * MULTIPLIER_BASE   （=6000；100 是百分比基数，非 base）
 *       units        = floor((numerator + denominator/2) / denominator)
 *
 * 安全整数范围：minutes ≤ 525600(上限) 时 numerator ≤ 525600*200*200 ≈ 2.1e10，
 * 远小于 Number.MAX_SAFE_INTEGER(9e15)，全整数运算无浮点误差。
 */
export function computePointsUnits(
  minutes: number,
  pointsMinMinutes: number,
  pointsBaseUnitsPerHour: number,
  pointsMultiplierPct: number,
): number {
  if (minutes < pointsMinMinutes) return 0;
  const numerator = minutes * pointsBaseUnitsPerHour * pointsMultiplierPct;
  const denominator = 60 * MULTIPLIER_BASE;
  return Math.floor((numerator + denominator / 2) / denominator);
}

/** 对外投影视图：仅 public IDs 与业务字段，零内部 numeric FK（P22-P4 §3）。 */
export interface ServiceRecordView {
  public_id: string;
  minutes: number;
  business_service_date: string | null;
  points_min_minutes: number;
  points_base_units_per_hour: number;
  points_multiplier_pct: number;
  points_awarded_units: number;
  settlement_status: number;
  created_at: number;
  updated_at: number | null;
  user_public_id: string;
  activity_public_id: string;
}

/** 列表过滤（P22-P4 §2）：business_service_date 精确匹配；userPublicId 仅 TEAM 列表可用。 */
export interface ServiceRecordListFilters {
  businessServiceDate?: string | null;
  userPublicId?: string | null;
  /** 硬上限内的行数（调用方 clamp 后传入）。 */
  limit: number;
}

/**
 * 人工修正（adjust）输入（P22-P4 §7/§10）。
 *
 * 并发保护：UPDATE 的 WHERE 必须携带【调用方读到的】expected 快照
 * （minutes / points_awarded_units / settlement_status），形成乐观锁；
 * 并发下的 lost update 会让 changes=0，由 service 层转为 409。
 */
export interface AdjustInput {
  serviceRecordId: number;
  teamId: number;
  /** P23-P3B：对应 ServiceRecord 的 session_id（来自调用方已读取的行；禁止按 id 重复查询或传入 numeric SR id）。 */
  sessionId?: number;
  /** 调用方读到的当前快照（乐观并发判据）。 */
  expectedMinutes: number;
  expectedPoints: number;
  expectedStatus: number;
  newMinutes: number;
  newPoints: number;
  reason: string;
  operatorId: number;
  traceId: string | null;
  now: number;
}

export interface ServiceRecordRow {
  id: number;
  session_id: number;
  user_id: number;
  team_id: number;
  activity_id: number;
  minutes: number;
  source: string;
  status: number;
  review_status: number;
  service_date: number;
  business_service_date: string | null;
  public_id: string | null;
  points_min_minutes: number;
  points_base_units_per_hour: number;
  points_multiplier_pct: number;
  points_awarded_units: number;
  settlement_status: number;
  created_at: number;
  updated_at: number | null;
}

// ==========================================================================
// P35-C2：Service Time Adjustment Request（申请 → 双人审批 工作流）
// ==========================================================================

/** service_record_adjustment_requests 行（0028）。零内部 numeric FK 对外由 service 层投影剥离。 */
export interface AdjustmentRequestRow {
  id: number;
  public_id: string;
  service_record_public_id: string;
  team_id: number;
  requester_id: number;
  /**
   * P35-C3B：申请人「安全公开身份」投影（LEFT JOIN users）。
   * 仅暴露 users.public_id（ULID）+ users.nickname（可空显示名）；
   * 绝不含 numeric requester_id 的对外泄露——requester_id 仅本层内部使用（自审判定 / audit）。
   */
  requester_public_id: string | null;
  requester_nickname: string | null;
  old_minutes_snapshot: number;
  old_points_awarded_units_snapshot: number;
  old_settlement_status_snapshot: number;
  requested_minutes: number;
  reason: string;
  status: number;
  requested_at: number;
  reviewer_id: number | null;
  reviewed_at: number | null;
  review_reason: string | null;
  applied_at: number | null;
  trace_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface InsertAdjustmentRequestInput {
  publicId: string;
  serviceRecordPublicId: string;
  teamId: number;
  requesterId: number;
  oldMinutesSnapshot: number;
  oldPointsAwardedUnitsSnapshot: number;
  oldSettlementStatusSnapshot: number;
  requestedMinutes: number;
  reason: string;
  now: number;
}

export interface ApproveAdjustmentInput {
  adjustmentRequestId: number;
  serviceRecordPublicId: string;
  teamId: number;
  requesterId: number;
  reviewerId: number;
  oldMinutesSnapshot: number;
  oldPointsAwardedUnitsSnapshot: number;
  oldSettlementStatusSnapshot: number;
  newMinutes: number;
  newPoints: number;
  sessionId: number;
  reason: string;
  traceId: string;
  now: number;
}

export interface RejectAdjustmentInput {
  adjustmentRequestId: number;
  teamId: number;
  reviewerId: number;
  reviewReason: string;
  now: number;
}

/** 单条结算 INSERT 的查询列（用于 findBySessionId 投影）。 */
const SR_COLUMNS = `
  id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status,
  service_date, business_service_date, public_id, points_min_minutes,
  points_base_units_per_hour, points_multiplier_pct, points_awarded_units,
  settlement_status, created_at, updated_at`;

export class ServiceRecordRepository extends BaseRepository {
  /** P23-P3B：积分账本 repository（复用同一 db/ctx；仅提供 build*Statements，不自行执行 batch）。 */
  private readonly pointsRepo: PointsLedgerRepository;

  constructor(deps: RepoDeps) {
    super(deps);
    this.pointsRepo = new PointsLedgerRepository({ db: this.db, ctx: this.ctx });
  }

  /**
   * 构建【单条原子】settlement 语句：INSERT...SELECT...WHERE。
   * 资格链全部在 SQL 内重算（attendance_sessions s → activity_participations p →
   * activity_signups sg → activities a），并带 UNIQUE(session_id) + anomaly 守卫。
   *
   * 返回已 bind 的 D1PreparedStatement，供 P22-P3 追加进现有 attendance db.batch。
   *
   * 注意 public_id / now 由调用方（Service 层）生成并传入——repository 不自行生成 ULID。
   */
  buildSettleStatement(p: SettlementInput): D1PreparedStatement {
    this.ensureTableRead('service_records');

    // anomaly 守卫：按 mode 决定阻断范围（服务器内部选择，非用户输入）。
    const anomalyBlock =
      p.mode === 'automatic'
        ? 'x.status IN (1,2)' // automatic：OPEN 与 CONFIRMED 都阻断
        : 'x.status IN (1)'; // review_approved：仅阻断 OPEN，允许 CONFIRMED 最终化

    const sql = `
      WITH settled AS (
        SELECT
          s.id            AS sid,
          s.user_id       AS uid,
          s.team_id       AS tid,
          s.activity_id   AS aid,
          s.service_date  AS sd,
          s.business_service_date AS bsd,
          COALESCE(a.points_multiplier_pct, ${MULTIPLIER_BASE}) AS pct,
          CASE
            WHEN a.max_session_minutes IS NOT NULL AND a.max_session_minutes > 0
              THEN MIN(MAX(0, CAST((s.checkout_at - s.checkin_at) / 60 AS INTEGER)), a.max_session_minutes)
            ELSE MAX(0, CAST((s.checkout_at - s.checkin_at) / 60 AS INTEGER))
          END AS minutes
        FROM attendance_sessions s
        JOIN activity_participations p  ON p.id = s.participation_id
        JOIN activity_signups sg        ON sg.id = p.signup_id
        JOIN activities a               ON a.id = s.activity_id
        WHERE s.id = ?
          AND s.team_id = ?
          AND s.status = 2                                   -- 已签退
          AND s.checkin_at IS NOT NULL
          AND s.checkout_at IS NOT NULL
          AND s.checkout_at >= s.checkin_at
          AND s.participation_id IS NOT NULL
          AND p.id = s.participation_id
          AND sg.id = p.signup_id
          AND sg.user_id = s.user_id
          AND sg.activity_id = s.activity_id
          AND a.id = s.activity_id
          AND a.team_id = s.team_id                          -- 修正：team 经 activity 派生（activity_signups 无 team_id）
          AND NOT EXISTS (
            SELECT 1 FROM service_records r WHERE r.session_id = s.id
          )                                                  -- UNIQUE(session_id) 幂等
          AND NOT EXISTS (
            SELECT 1 FROM attendance_anomalies x
             WHERE x.session_id = s.id AND ${anomalyBlock}
          )
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM attendance_events e WHERE e.nonce = ?
          ))
      )
      INSERT INTO service_records (
        session_id, user_id, team_id, activity_id, minutes, source,
        service_date, business_service_date,
        points_min_minutes, points_base_units_per_hour, points_multiplier_pct, points_awarded_units,
        settlement_status, public_id, status, review_status, points_revision, created_at, updated_at
      )
      SELECT
        sid, uid, tid, aid, minutes, 'auto',
        sd, bsd,
        ${POINTS_MIN_MINUTES},
        ${POINTS_BASE_UNITS_PER_HOUR},
        COALESCE(pct, ${MULTIPLIER_BASE}),
        CASE
          WHEN minutes < ${POINTS_MIN_MINUTES} THEN 0
          ELSE CAST(
            (minutes * ${POINTS_BASE_UNITS_PER_HOUR} * COALESCE(pct, ${MULTIPLIER_BASE}) + (60 * ${MULTIPLIER_BASE}) / 2)
            / (60 * ${MULTIPLIER_BASE}) AS INTEGER
          )
        END,
        ${SETTLEMENT_STATUS.EFFECTIVE},
        ?,
        ${ /* legacy status/review_status：不赋予新业务语义，沿用既有默认值 */ 1},
        ${0},
        ${ /* P23-P3A：仅真实 INSERT 新 SR 时产生 revision=1（duplicate 走 NOT EXISTS(session_id) 0 行，不动既有 revision） */ 1},
        ?,
        ?
      FROM settled
    `;

    // 绑定顺序（必须严格对齐 SQL 中 ? 的出现顺序）：
    //   1 sessionId (s.id=?) → 2 teamId (s.team_id=?)
    //   3 gateNonce (? IS NULL) → 4 gateNonce (e.nonce=?)
    //   5 publicId (INSERT public_id) → 6 now (created_at) → 7 now (updated_at)
    return this.db
      .prepare(sql)
      .bind(p.sessionId, p.teamId, p.gateNonce ?? null, p.gateNonce ?? null, p.publicId, p.now, p.now);
  }

  /**
   * 独立原子结算（P22-P2 验证 / 非组合场景）。
   * @returns INSERT 实际变更行数（1=本次创建；0=本次未创建，幂等或资格未命中）。
   */
  async settleEligibleSessionAtomically(p: SettlementInput): Promise<number> {
    const stmt = this.buildSettleStatement(p);
    // P23-P3B：积分三件套（S0→S1→S2）作为同一 atomically batch 追加在 settlement 之后（强事务）。
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId: p.sessionId,
      now: p.now,
      remark: 'checkout',
      operatorId: null,
    });
    const results = await this.db.batch([stmt, ...pts.statements]);
    return Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0);
  }

  /**
   * 按 session 定位 ServiceRecord（changes=0 后的幂等 re-read 由 Service 层调用）。
   * 仅 TEAM 作用域（WHERE team_id=?），不构成 cross-team existence oracle。
   */
  async findBySessionId(sessionId: number, teamId: number): Promise<ServiceRecordRow | null> {
    this.ensureTableRead('service_records');
    return this.first<ServiceRecordRow>(
      `SELECT ${SR_COLUMNS} FROM service_records WHERE session_id = ? AND team_id = ?`,
      [sessionId, teamId],
    );
  }

  /** P0-C：取会话归属用户 id（TEAM 作用域，仅作资格门禁输入；不泄露 cross-team 存在性）。 */
  async findSessionUserId(sessionId: number, teamId: number): Promise<number | null> {
    this.ensureTableRead('attendance_sessions');
    const r = await this.first<{ user_id: number }>(
      `SELECT user_id FROM attendance_sessions WHERE id = ? AND team_id = ?`,
      [sessionId, teamId],
    );
    return r?.user_id ?? null;
  }

  /**
   * 构建 revoke 语句集（[audit INSERT, revoke UPDATE]）。
   * 两条语句共享同一 PRE-state 谓词（settlement_status = 1），保证原子性：
   *   stmt[0] audit（SELECT 自当前行，不改 status）→ stmt[1] revoke UPDATE 仍命中同一行。
   * 对 UNVERIFIED(0) / REVOKED(2) / 不存在 → 两条语句均 0 命中（无副作用）。
   *
   * 返回已 bind 的 D1PreparedStatement[]，供 P22-P3 组合进 attendance db.batch。
   */
  buildRevokeStatementSet(p: RevokeInput): D1PreparedStatement[] {
    this.ensureTableRead('service_records');
    this.ensureTableRead('service_record_audits');

    // stmt[0]：审计快照（old == new，revoke 不改分钟/积分）。仅当 EFFECTIVE 且 gateNonce 命中本批 transition event。
    const auditStmt = this.db
      .prepare(
        `INSERT INTO service_record_audits (
           service_record_id, team_id, old_minutes, new_minutes,
           old_points_awarded_units, new_points_awarded_units,
           reason, operator_id, approved_by, trace_id, created_at
         )
         SELECT id, team_id, minutes, minutes,
                points_awarded_units, points_awarded_units,
                ?, ?, NULL, ?, ?
           FROM service_records
          WHERE id = ? AND team_id = ? AND settlement_status = ${SETTLEMENT_STATUS.EFFECTIVE}
            AND (? IS NULL OR EXISTS (SELECT 1 FROM attendance_events e WHERE e.nonce = ?))`,
      )
      .bind(p.reason, p.operatorId, p.traceId, p.now, p.serviceRecordId, p.teamId, p.gateNonce ?? null, p.gateNonce ?? null);

    // stmt[1]：仅 EFFECTIVE(1) → REVOKED(2)。同一 gate 保证与 transition 严格关联。
    // P23-P3A：真实 changes=1 时推进 points_revision（repeat revoke / UNVERIFIED / 不存在 → 0 行 → revision 不变）。
    const revokeStmt = this.db
      .prepare(
        `UPDATE service_records
            SET settlement_status = ${SETTLEMENT_STATUS.REVOKED},
                points_revision = points_revision + 1,
                updated_at = ?
          WHERE id = ? AND team_id = ? AND settlement_status = ${SETTLEMENT_STATUS.EFFECTIVE}
            AND (? IS NULL OR EXISTS (SELECT 1 FROM attendance_events e WHERE e.nonce = ?))`,
      )
      .bind(p.now, p.serviceRecordId, p.teamId, p.gateNonce ?? null, p.gateNonce ?? null);

    return [auditStmt, revokeStmt];
  }

  /**
   * 独立原子 revoke（P22-P2 验证）。
   * @returns revoke UPDATE 实际变更行数（1=本次撤销；0=无 EFFECTIVE 记录可撤销）。
   */
  async revokeAtomically(p: RevokeInput): Promise<number> {
    const [auditStmt, revokeStmt] = this.buildRevokeStatementSet(p);
    // P23-P3B：积分三件套（S0→S1→S2）作为同一 atomically batch 追加在 revoke 之后（强事务）。
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId: p.sessionId ?? 0,
      now: p.now,
      remark: 'revoke',
      operatorId: p.operatorId,
    });
    const results = await this.db.batch([auditStmt, revokeStmt, ...pts.statements]);
    return Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }

  // ==========================================================================
  // P22-P4：读取（SELF / TEAM / 详情）+ 人工修正（adjust）
  // ==========================================================================

  /**
   * 对外投影 SELECT 列（零内部 numeric FK）。
   * 关联只取 public_id：users.public_id / activities.public_id。
   * 【刻意不返回 session_public_id】—— attendance_sessions 无 public_id 列，不硬造（P22-P4 §3）。
   */
  private static readonly VIEW_COLUMNS = `
    sr.public_id, sr.minutes, sr.business_service_date,
    sr.points_min_minutes, sr.points_base_units_per_hour, sr.points_multiplier_pct,
    sr.points_awarded_units, sr.settlement_status, sr.created_at, sr.updated_at,
    u.public_id AS user_public_id,
    a.public_id AS activity_public_id`;

  /** 投影的固定 FROM/JOIN（users 为 PLATFORM_GLOBAL、activities 为 TEAM_SCOPED，均已在 TABLE_SCOPE 登记）。 */
  private static readonly VIEW_FROM = `
    FROM service_records sr
    JOIN users u      ON u.id = sr.user_id
    JOIN activities a ON a.id = sr.activity_id`;

  private async selectViews(whereSql: string, binds: unknown[]): Promise<ServiceRecordView[]> {
    this.ensureTableRead('service_records');
    this.ensureTableRead('users');
    this.ensureTableRead('activities');
    return this.all<ServiceRecordView>(
      `SELECT ${ServiceRecordRepository.VIEW_COLUMNS} ${ServiceRecordRepository.VIEW_FROM} ${whereSql}`,
      binds,
    );
  }

  /**
   * SELF 列表：严格限定【当前用户本人】且在本团队内。
   * 不接受任何"查别人"的参数——userId 来自 auth，teamId 来自 TenantContext（P22-P4 §4）。
   */
  async listMine(
    userId: number,
    teamId: number,
    filters: ServiceRecordListFilters,
  ): Promise<ServiceRecordView[]> {
    return this.selectViews(
      `WHERE sr.user_id = ? AND sr.team_id = ?
         AND (? IS NULL OR sr.business_service_date = ?)
       ORDER BY sr.id DESC
       LIMIT ?`,
      [userId, teamId, filters.businessServiceDate ?? null, filters.businessServiceDate ?? null, filters.limit],
    );
  }

  /**
   * TEAM 列表：本团队全部记录；可按 business_service_date / user_public_id 过滤。
   * 跨团队记录因 WHERE team_id=? 天然不可见（不存在条，统一 404 语义由详情端点承载）。
   */
  async listTeam(teamId: number, filters: ServiceRecordListFilters): Promise<ServiceRecordView[]> {
    return this.selectViews(
      `WHERE sr.team_id = ?
         AND (? IS NULL OR sr.business_service_date = ?)
         AND (? IS NULL OR u.public_id = ?)
       ORDER BY sr.id DESC
       LIMIT ?`,
      [
        teamId,
        filters.businessServiceDate ?? null,
        filters.businessServiceDate ?? null,
        filters.userPublicId ?? null,
        filters.userPublicId ?? null,
        filters.limit,
      ],
    );
  }

  /**
   * 按 public_id 取对外投影视图（TEAM 作用域）。
   * 跨团队 / 不存在 → null（调用方统一 404，不区分，避免 existence oracle）。
   */
  async findByPublicId(publicId: string, teamId: number): Promise<ServiceRecordView | null> {
    const rows = await this.selectViews('WHERE sr.public_id = ? AND sr.team_id = ?', [publicId, teamId]);
    return rows[0] ?? null;
  }

  /**
   * 按 public_id 取内部行（含 numeric id 与冻结政策快照），仅供 adjust 的读-改-写使用。
   * 不对外暴露；调用方必须自行做投影后再返回客户端。
   */
  async findRowByPublicId(publicId: string, teamId: number): Promise<ServiceRecordRow | null> {
    this.ensureTableRead('service_records');
    return this.first<ServiceRecordRow>(
      `SELECT ${SR_COLUMNS} FROM service_records WHERE public_id = ? AND team_id = ?`,
      [publicId, teamId],
    );
  }

  /**
   * 人工修正（adjust）原子写：[audit INSERT, UPDATE] 同一 db.batch（P22-P4 §8/§10）。
   *
   * 两条语句共享完全相同的 PRE-state 谓词：
   *     P := (id = ? AND team_id = ? AND minutes = ? AND points_awarded_units = ? AND settlement_status = ?)
   * stmt[0] audit 只 INSERT service_record_audits，不触碰 service_records ⇒ 不改变 P 的真值；
   * db.batch 为单写事务 ⇒ stmt[1] 求值 P 时真值与 stmt[0] 一致。
   *
   * 因此：P 真 → 恰好 1 条 audit + 恰好 1 行 UPDATE（不存在"UPDATE 成功但 audit 失败"）；
   *       P 假（并发下他人已改 / 记录不存在 / 跨团队）→ 0 audit + 0 行（无假审计）。
   *
   * adjust 是人工重新认证：目标状态恒为 EFFECTIVE(1)（UNVERIFIED/REVOKED 均可被重新认证）。
   *
   * @returns UPDATE 实际变更行数（1=本次修正成功；0=快照已过期或记录不可见）。
   */
  async adjustAtomically(p: AdjustInput): Promise<number> {
    this.ensureTableRead('service_records');
    this.ensureTableRead('service_record_audits');

    // stmt[0]：审计快照（old 取自当前行，new 为本次目标值）。
    const auditStmt = this.db
      .prepare(
        `INSERT INTO service_record_audits (
           service_record_id, team_id, old_minutes, new_minutes,
           old_points_awarded_units, new_points_awarded_units,
           reason, operator_id, approved_by, trace_id, created_at
         )
         SELECT id, team_id, minutes, ?, points_awarded_units, ?, ?, ?, NULL, ?, ?
           FROM service_records
          WHERE id = ? AND team_id = ?
            AND minutes = ? AND points_awarded_units = ? AND settlement_status = ?`,
      )
      .bind(
        p.newMinutes,
        p.newPoints,
        p.reason,
        p.operatorId,
        p.traceId,
        p.now,
        p.serviceRecordId,
        p.teamId,
        p.expectedMinutes,
        p.expectedPoints,
        p.expectedStatus,
      );

    // stmt[1]：条件 UPDATE（同一谓词 P）+ 重新认证为 EFFECTIVE。
    // P23-P3A：真实 changes=1 时推进 points_revision（stale/no-change → 0 行 → revision 不变）。
    // re-finalize（UNVERIFIED/REVOKED → EFFECTIVE）复用本 UPDATE，一次真实 mutation 恰好 +1，无二次推进。
    const updateStmt = this.db
      .prepare(
        `UPDATE service_records
            SET minutes = ?, points_awarded_units = ?,
                settlement_status = ${SETTLEMENT_STATUS.EFFECTIVE},
                points_revision = points_revision + 1,
                updated_at = ?
          WHERE id = ? AND team_id = ?
            AND minutes = ? AND points_awarded_units = ? AND settlement_status = ?`,
      )
      .bind(
        p.newMinutes,
        p.newPoints,
        p.now,
        p.serviceRecordId,
        p.teamId,
        p.expectedMinutes,
        p.expectedPoints,
        p.expectedStatus,
      );

    // P23-P3B：积分三件套（S0→S1→S2）作为同一 atomically batch 追加在 adjust UPDATE 之后（强事务）。
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId: p.sessionId ?? 0,
      now: p.now,
      remark: 'adjust',
      operatorId: p.operatorId,
    });
    const results = await this.db.batch([auditStmt, updateStmt, ...pts.statements]);
    return Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }

  // ==========================================================================
  // P35-C2：Service Time Adjustment Request（申请 / 列表 / 审批 / 拒绝）
  // ==========================================================================

  /**
   * 按 public_id 取申请行（团队作用域）。跨团队 / 不存在 → null（调用方统一 404）。
   *
   * P35-C3B：LEFT JOIN users 取申请人「安全公开身份」（public_id + nickname）。
   * 仍以 r.team_id = ? 收口团队隔离；users 为 PLATFORM_GLOBAL，仅取公开列，不扩大读取面。
   */
  async findAdjustmentByPublicId(publicId: string, teamId: number): Promise<AdjustmentRequestRow | null> {
    this.ensureTableRead('service_record_adjustment_requests');
    this.ensureTableRead('users');
    return this.first<AdjustmentRequestRow>(
      `SELECT r.*,
              u.public_id AS requester_public_id,
              u.nickname  AS requester_nickname
         FROM service_record_adjustment_requests r
         LEFT JOIN users u ON u.id = r.requester_id
        WHERE r.public_id = ? AND r.team_id = ?`,
      [publicId, teamId],
    );
  }

  /**
   * 列出某 service record 的全部修正申请（newest first）。团队作用域。
   *
   * P35-C3B：同样 LEFT JOIN users 投影申请人安全公开身份。排序键统一以 r. 限定。
   */
  async listAdjustmentRequests(serviceRecordPublicId: string, teamId: number): Promise<AdjustmentRequestRow[]> {
    this.ensureTableRead('service_record_adjustment_requests');
    this.ensureTableRead('users');
    return this.all<AdjustmentRequestRow>(
      `SELECT r.*,
              u.public_id AS requester_public_id,
              u.nickname  AS requester_nickname
         FROM service_record_adjustment_requests r
         LEFT JOIN users u ON u.id = r.requester_id
        WHERE r.service_record_public_id = ? AND r.team_id = ?
        ORDER BY r.requested_at DESC, r.id DESC`,
      [serviceRecordPublicId, teamId],
    );
  }

  /**
   * 插入一条 PENDING 申请（status=0）。
   * 并发最终保证 = 0028 部分唯一索引 uq_one_pending（WHERE status=0）；
   * 若同一 service record 已存在 PENDING，sqlite 抛 UNIQUE 约束 → 转 409 ADJUSTMENT_PENDING_EXISTS。
   */
  async insertAdjustmentRequest(p: InsertAdjustmentRequestInput): Promise<void> {
    this.ensureTableRead('service_record_adjustment_requests');
    try {
      await this.db
        .prepare(
          `INSERT INTO service_record_adjustment_requests (
             public_id, service_record_public_id, team_id, requester_id,
             old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
             requested_minutes, reason, status, requested_at, trace_id, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
        )
        .bind(
          p.publicId,
          p.serviceRecordPublicId,
          p.teamId,
          p.requesterId,
          p.oldMinutesSnapshot,
          p.oldPointsAwardedUnitsSnapshot,
          p.oldSettlementStatusSnapshot,
          p.requestedMinutes,
          p.reason,
          p.now,
          p.publicId,
          p.now,
          p.now,
        )
        .run();
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      // 部分唯一索引（status=0）命中 → 第二个 PENDING 被拒；先验的 exists 检查仅为 best-effort。
      if (/UNIQUE|constraint|uq_one_pending/i.test(msg)) {
        throw conflict(ConflictReason.ADJUSTMENT_PENDING_EXISTS);
      }
      throw e;
    }
  }

  /**
   * 原子审批落地（P35-C2 §9）：同一 db.batch 内完成
   *   stmt[0] audit INSERT（old/new 取自当前 SR；operator_id=requester, approved_by=reviewer, trace_id=adjustment public_id）
   *   stmt[1] service_records UPDATE（minutes/points/settlement_status=EFFECTIVE/source='correction'/points_revision+1）
   *   stmt[2] request UPDATE（status=APPROVED + reviewer 字段）
   *   stmt[3..5] buildServicePointsStatements（SR_CTE target-net 复用，绝不复制积分算法）
   *
   * 原子性机制 = 【全语句统一谓词门控】，而非依赖 D1 batch 回滚：
   *   D1 db.batch 仅在【真实 SQL 错误】时整批回滚；UPDATE 命中 0 行【不会】抛错、也【不会】回滚
   *   （已用 disposable probe 实证：batch([INSERT, UPDATE 0 rows]) → 前置 INSERT 照常提交）。
   *   因此不能依赖“changes=0 ⇒ 已回滚”。本方法改为让【每一条】写语句都受同一完整谓词
   *   P = (SR == old 快照: minutes ∧ points ∧ settlement_status) ∧ (request 仍 PENDING) 门控：
   *     - P 成立：stmt[0]/[1] 命中，stmt[2] 在 SR 已被 [1] 改写为新目标态后命中，积分三件套因
   *       points_revision 递增而命中 → 四处全部落地（全成立）。
   *     - P 不成立（SR 并发漂移 或 request 已被并发 APPROVED/REJECTED）：
   *       stmt[0]/[1] 0 行；stmt[2] 以「status=0 ∧ 新目标态 EXISTS」为闸门 → 0 行；
   *       积分三件套以 revision 幂等守卫（request_id NOT EXISTS）→ revision 未变 → 0 行。
   *       → 四组语句【全部 0 行】= 零业务副作用（request 保持 PENDING/REJECTED，SR/audit/ledger 均不变）。
   *   request 状态门控（status=0）额外封堵 approve 与 reject 并发时的窗口：若 request 已被并发置为
   *   REJECTED，SR/audit/ledger 亦不落地（否则会“请求已拒但时长仍被改”的部分提交）。
   *
   * @returns SR UPDATE 实际变更行数（1=成功落地；0=谓词落空，调用方应转 409 STALE_REQUEST）。
   */
  async approveAdjustmentAtomically(p: ApproveAdjustmentInput): Promise<number> {
    this.ensureTableRead('service_records');
    this.ensureTableRead('service_record_adjustment_requests');
    this.ensureTableRead('service_record_audits');

    // stmt[0]：审计快照（operator_id=申请人，approved_by=审批人，trace_id=申请 public_id）。
    const auditStmt = this.db
      .prepare(
        `INSERT INTO service_record_audits (
           service_record_id, team_id, old_minutes, new_minutes,
           old_points_awarded_units, new_points_awarded_units,
           reason, operator_id, approved_by, trace_id, created_at
         )
         SELECT id, team_id, minutes, ?,
                points_awarded_units, ?, ?, ?, ?, ?, ?
           FROM service_records
          WHERE public_id = ? AND team_id = ?
            AND minutes = ? AND points_awarded_units = ? AND settlement_status = ?
            AND EXISTS (
              SELECT 1 FROM service_record_adjustment_requests
               WHERE id = ? AND status = 0
            )`,
      )
      .bind(
        p.newMinutes,
        p.newPoints,
        p.reason,
        p.requesterId,
        p.reviewerId,
        p.traceId,
        p.now,
        p.serviceRecordPublicId,
        p.teamId,
        p.oldMinutesSnapshot,
        p.oldPointsAwardedUnitsSnapshot,
        p.oldSettlementStatusSnapshot,
        p.adjustmentRequestId,
      );

    // stmt[1]：条件 UPDATE（同一快照谓词）+ 重新认证为 EFFECTIVE + source='correction'。
    const updateStmt = this.db
      .prepare(
        `UPDATE service_records
            SET minutes = ?,
                points_awarded_units = ?,
                settlement_status = ${SETTLEMENT_STATUS.EFFECTIVE},
                source = 'correction',
                points_revision = points_revision + 1,
                updated_at = ?
          WHERE public_id = ? AND team_id = ?
            AND minutes = ? AND points_awarded_units = ? AND settlement_status = ?
            AND EXISTS (
              SELECT 1 FROM service_record_adjustment_requests
               WHERE id = ? AND status = 0
            )`,
      )
      .bind(
        p.newMinutes,
        p.newPoints,
        p.now,
        p.serviceRecordPublicId,
        p.teamId,
        p.oldMinutesSnapshot,
        p.oldPointsAwardedUnitsSnapshot,
        p.oldSettlementStatusSnapshot,
        p.adjustmentRequestId,
      );

    // stmt[2]：仅 PENDING → APPROVED。并发闸门以【更新后的目标态】作 EXISTS 子查询——
    // updateStmt 已在本语句之前把 SR 改为新 minutes/points/settlement_status=EFFECTIVE；
    // 仅当该 UPDATE 真的命中（乐观谓词未被并发漂移打破）时，此处 EXISTS 才成立，
    // 否则子查询为空 → 0 行 → request 保持 PENDING（与 SR 零副作用一致）。
    // 注意：不能用 old 快照作 EXISTS——updateStmt 已先改写了 SR，old 快照在此时已不成立。
    const reqStmt = this.db
      .prepare(
        `UPDATE service_record_adjustment_requests
            SET status = 1,
                reviewer_id = ?,
                reviewed_at = ?,
                applied_at = ?,
                updated_at = ?
          WHERE id = ? AND status = 0
            AND EXISTS (
              SELECT 1 FROM service_records
               WHERE public_id = ? AND team_id = ?
                 AND minutes = ? AND points_awarded_units = ? AND settlement_status = ${SETTLEMENT_STATUS.EFFECTIVE}
            )`,
      )
      .bind(
        p.reviewerId,
        p.now,
        p.now,
        p.now,
        p.adjustmentRequestId,
        p.serviceRecordPublicId,
        p.teamId,
        p.newMinutes,
        p.newPoints,
      );

    // stmt[3..5]：积分三件套（SR_CTE target-net reconciliation），仅当 SR 已被更新后读取。
    const pts = this.pointsRepo.buildServicePointsStatements({
      sessionId: p.sessionId,
      now: p.now,
      remark: 'correction',
      operatorId: p.requesterId,
    });

    const results = await this.db.batch([auditStmt, updateStmt, reqStmt, ...pts.statements]);
    return Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }

  /**
   * 拒绝（P35-C2 §11）：仅更新 request 行（status=REJECTED + reviewer 字段）。
   * 不修改 service_records / points / settlement_status / points ledger / service_record_audits。
   *
   * @returns request UPDATE 实际变更行数（1=成功；0=非 PENDING，调用方应转 409 INVALID_TRANSITION）。
   */
  async rejectAdjustmentAtomically(p: RejectAdjustmentInput): Promise<number> {
    this.ensureTableRead('service_record_adjustment_requests');
    const res = await this.db
      .prepare(
        `UPDATE service_record_adjustment_requests
            SET status = 2,
                reviewer_id = ?,
                reviewed_at = ?,
                review_reason = ?,
                updated_at = ?
          WHERE id = ? AND team_id = ? AND status = 0`,
      )
      .bind(p.reviewerId, p.now, p.reviewReason, p.now, p.adjustmentRequestId, p.teamId)
      .run();
    return Number((res as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }
}
