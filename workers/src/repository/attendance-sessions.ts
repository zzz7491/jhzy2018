/**
 * AttendanceSessionRepository（S2-6h）—— attendance_sessions 的唯一写入口。
 *
 * scope 事实（S2-3 矩阵 / repository/tenant-scope.ts）：
 * - attendance_sessions = TEAM_SCOPED，且【含显式 team_id 列】→ 直接 WHERE team_id = ? 即可，
 *   无需像 activity_signups 那样经 activities 派生（DERIVED_TEAM_TABLES 不含本表）。
 * - 但签到会话必须【同时属于当前用户（Ownership SELF）】，因此所有查询 WHERE 同时带
 *   user_id = ?（Ownership）与 team_id = ?（Tenant Scope），双保险阻断 IDOR（用户 §十四）。
 * - PermissionProvider 只裁决"当前用户能否签到"，【不】替代租户范围过滤
 *   （用户 §九：PermissionProvider != Tenant filter）。
 *
 * SQL 纪律（用户 §十）：全部 prepare().bind()，禁止字符串插值。
 *   signupId / userId / teamId / activityId / status / eventType / nonce 全部参数化。
 *
 * 并发安全（S2-6h-R2）：同一用户任意时刻至多一条【活跃】会话，由 0004 新增的 partial unique index
 *   uq_active_attendance ON (user_id) WHERE status=1 AND checkout_at IS NULL 强制保证
 *   （取代已移除的 UNIQUE(signup_id)）。该约束同时覆盖"跨活动不能同时活跃"（R1 背景第 5 条）。
 *   预检 SELECT（找同报名的活跃会话）只是快路径（给出稳定的 409 reason）；
 *   INSERT 命中 uq_active_attendance 时也收敛为 409（不泄露 SQL 原文），作为并发兜底。
 * 注意：已签退（status=2）的会话不再阻止再次签到 —— 这是 R2 修复"一次报名=一次参加"1:1 误绑的核心。
 *
 * 证据链（用户已授权 phase gate：写最小 attendance_events）：
 * - checkin / checkout 各 append 一条 attendance_events（event_type = 'checkin' / 'checkout'）。
 * - nonce UNIQUE 保证幂等；风险/设备/位置字段本切片留空（OPEN BUSINESS RULE，后续 anomaly/risk 切片填充）。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired, conflict, ConflictReason } from '../utils/errors';

export interface AttendanceSessionRow {
  id: number;
  signup_id: number;
  activity_id: number;
  user_id: number;
  team_id: number;
  service_date: number;
  slot: string;
  checkin_at: number | null;
  checkout_at: number | null;
  status: number;
  review_status: number;
  created_at: number;
  updated_at: number | null;
  /** 业务自然日（Asia/Shanghai YYYY-MM-DD），来源 = checkin_at；新增于 0005，可为 NULL。 */
  business_service_date: string | null;
}

/**
 * attendance_sessions.status 字典（OPEN BUSINESS RULE，仓库内无文档出处，按可操作生命周期约定）。
 * 0 未签到 / 1 已签到 / 2 已签退 / 3 异常 / 4 取消。
 * 本切片只写 1（签到）与 2（签退）；3/4 属后续 anomaly/force 切片。
 */
export const ATTENDANCE_STATUS = {
  NOT_CHECKED_IN: 0,
  CHECKED_IN: 1,
  CHECKED_OUT: 2,
  ANOMALY: 3,
  CANCELLED: 4,
} as const;

/** attendance_events.event_type 允许值（S2-6h 本人签到/签退；与 Schema CHECK 一致）。 */
export type AttendanceEventType = 'checkin' | 'checkout';

/** SQLite/D1 UNIQUE 冲突错误特征（仅服务端判定使用，不向客户端回显）。 */
const UNIQUE_VIOLATION_RE = /unique\s+constraint\s+failed/i;

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return UNIQUE_VIOLATION_RE.test(msg);
}

export class AttendanceSessionRepository extends BaseRepository {
  /** 当前租户团队 id；缺失即拒绝（TEAM_SCOPED 表必须有真实团队上下文）。 */
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();
    return teamId;
  }

  /**
   * 查询本人名下、某报名对应的【活跃】考勤会话（status=1 且 checkout_at IS NULL）。
   * WHERE 同时带 signup_id（归属锚点）+ user_id（SELF）+ team_id（租户）+ 活跃条件。
   * 已签退（status=2）的会话不命中 —— 这是 R2 修复"一次报名=一次参加"1:1 误绑的关键：
   * 签退后即可再次签到（创建新会话，service_date/slot 区分每次参加实例）。
   * 跨活动的同时活跃由 uq_active_attendance（user_id 维度）兜底，无需在此额外判定。
   */
  async findOwnActiveSession(signupId: number, userId: number): Promise<AttendanceSessionRow | null> {
    this.ensureTableRead('attendance_sessions');
    const teamId = this.requireTeamId();

    return this.first<AttendanceSessionRow>(
      `SELECT id, signup_id, activity_id, user_id, team_id, service_date, slot,
              checkin_at, checkout_at, status, review_status, created_at, updated_at,
              business_service_date
         FROM attendance_sessions
        WHERE signup_id = ? AND user_id = ? AND team_id = ?
          AND status = ? AND checkout_at IS NULL`,
      [signupId, userId, teamId, ATTENDANCE_STATUS.CHECKED_IN],
    );
  }

  /**
   * 创建签到会话（INSERT）。
   * - signup_id 来自调用方（Service 经 ActivitySignupRepository 查得，绝不来自请求体）。
   * - status = CHECKED_IN(1)；checkin_at = now；service_date/slot 锚定本次参加实例。
   * - 并发重复签到（同报名并发，或该用户已有活跃会话）→ uq_active_attendance 兜底 → 409，不泄露 SQL 原文。
   */
  async insertCheckIn(
    signupId: number,
    activityId: number,
    userId: number,
    teamId: number,
    serviceDate: number,
    slot: string,
    businessServiceDate: string,
    now: number,
  ): Promise<number> {
    this.ensureTableRead('attendance_sessions');

    try {
      const res = await this.run(
        `INSERT INTO attendance_sessions
           (signup_id, activity_id, user_id, team_id, service_date, slot,
            business_service_date, status, checkin_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [signupId, activityId, userId, teamId, serviceDate, slot, businessServiceDate, ATTENDANCE_STATUS.CHECKED_IN, now, now, now],
      );
      const id = Number(res.meta?.last_row_id ?? 0);
      if (id <= 0) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN);
      return id;
    } catch (err) {
      // 并发重复签到：uq_active_attendance（per-user 单一活跃会话）是唯一真相 → 收敛为 409。
      if (isUniqueViolation(err)) throw conflict(ConflictReason.ATTENDANCE_ALREADY_CHECKED_IN);
      throw err;
    }
  }

  /**
   * 签退（原子 UPDATE）。
   * WHERE 同时带 signup_id + user_id + team_id + status=CHECKED_IN(1)：
   * - 跨团队 / 非本人 / 未签到的会话 0 命中（no side effect，§十九）。
   * - 已签退（status=2）0 命中 → 上层返回 409 ALREADY_CHECKED_OUT。
   * - 并发双签退：第二个请求 status 已不是 1 → 0 命中。
   */
  async checkOut(signupId: number, userId: number, teamId: number, now: number): Promise<boolean> {
    this.ensureTableRead('attendance_sessions');

    const res = await this.run(
      `UPDATE attendance_sessions
          SET status = ?, checkout_at = ?, updated_at = ?
        WHERE signup_id = ? AND user_id = ? AND team_id = ? AND status = ?`,
      [ATTENDANCE_STATUS.CHECKED_OUT, now, now, signupId, userId, teamId, ATTENDANCE_STATUS.CHECKED_IN],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * 写最小考勤事件证据行（append-only）。
   * - event_type = 'checkin' | 'checkout'
   * - nonce UNIQUE 幂等（格式：${sessionId}:${eventType}:${now}）
   * - S2-6k2：latitude/longitude/accuracy 可选落库（GCJ-02 契约；仅 check-in 路径传入，
   *   check-out 保持 NULL）。distance 列【始终】不写入（= NULL）：本切片不计算距离，
   *   也不读取 activity 地理配置；distance 计算属 Detector Core 后续切片。
   * - 风险/设备/位置之外的字段仍留空（OPEN BUSINESS RULE）。
   *
   * @param lat  GCJ-02 纬度（number | null）
   * @param lng  GCJ-02 经度（number | null）
   * @param accuracy 客户端精度半径（米，number | null；未提供为 null）
   */
  async insertEvent(
    sessionId: number,
    activityId: number,
    userId: number,
    teamId: number,
    eventType: AttendanceEventType,
    now: number,
    operatorId: number,
    nonce: string,
    lat: number | null = null,
    lng: number | null = null,
    accuracy: number | null = null,
  ): Promise<number> {
    this.ensureTableRead('attendance_events');

    const res = await this.run(
      `INSERT INTO attendance_events
         (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, occurred_at, created_at,
          latitude, longitude, accuracy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, activityId, userId, teamId, eventType, nonce, operatorId, now, now, lat, lng, accuracy],
    );
    return Number(res.meta?.last_row_id ?? 0);
  }

  /**
   * 审核（Review）原子写：audit event INSERT + 条件 UPDATE 在单次 db.batch 内完成（§10 原子性硬门禁）。
   *
   * ── 原子守卫设计（S2-6i-R1 重构；不再依赖时间戳唯一性）──────────────────────────
   * 语句顺序刻意为「先 INSERT 后 UPDATE」，且两条语句使用【完全相同的 PRE-state 谓词】：
   *
   *     P := (id = ? AND team_id = ? AND review_status = 0)
   *
   * 正确性论证：
   * 1) stmt[0]（INSERT...SELECT）只写 attendance_events，【不触碰 attendance_sessions】，
   *    因此它不会改变 P 的真值；
   * 2) db.batch 是单个写事务、语句顺序执行并持有 SQLite 写锁，批内不存在其它写者穿插；
   * 3) 故 stmt[1]（UPDATE）求值 P 时，其真值与 stmt[0] 求值时【必然相同】。
   *
   * 由 (1)(2)(3) 得到确定性结论（非概率性）：
   *   P 为真  → 恰好写入 1 条 event 且恰好更新 1 行（成功路径必写且只写一个 event）；
   *   P 为假  → 0 条 event 且 0 行更新（已审核 / 跨团队 / 不存在 → conflict 不写 event）。
   *
   * 关键收益：该结构【完全不依赖 updated_at 的取值或唯一性】做 transaction marker，
   * 因此 updated_at / occurred_at 一律保持冻结 schema 的 Unix epoch **seconds** 语义
   * （调用方传入 Math.floor(Date.now()/1000)）。updated_at 是业务字段，不是 transaction nonce。
   *
   * 原子性：任一语句失败（含故障注入）→ 整批回滚。两种故障均已被测试覆盖：
   *   - 故障注入在 stmt[0]（event_type CHECK 违例）→ UPDATE 从未生效，会话状态与 updated_at 保持原值；
   *   - 故障注入在 stmt[1]（review_status CHECK 违例）→ 已执行的 INSERT 被回滚，event 不存在
   *     （这一路证明 batch 是【真实事务回滚】，而非仅"短路未执行"）。
   *
   * @param newReviewStatus 目标 review_status（正常为 1/2；测试故障模式 2 会传入越界值以违反 CHECK）。
   * @param now Unix epoch **seconds**（禁止毫秒）。
   * @returns UPDATE 实际变更行数（0 = 守卫未命中，调用方据 findTeamSession 区分 404 / 409）。
   */
  async reviewSessionAtomically(
    sessionId: number,
    teamId: number,
    newReviewStatus: number,
    eventType: string,
    reason: string,
    rawJson: string,
    operatorId: number,
    now: number,
  ): Promise<number> {
    this.ensureTableRead('attendance_sessions');
    this.ensureTableRead('attendance_events');

    const nonce = `review:${sessionId}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;
    // stmt[0]：审计事件，守卫 = PRE-state 谓词 P（与下方 UPDATE 完全一致）。
    // session_id 取 a.id（而非重复绑定入参），确保证据行严格绑定到被命中的那一行。
    const insertStmt = this.db
      .prepare(
        `INSERT INTO attendance_events
           (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, reason, raw, occurred_at, created_at)
         SELECT a.id, a.activity_id, a.user_id, a.team_id, ?, ?, ?, ?, ?, ?, ?
           FROM attendance_sessions a
          WHERE a.id = ? AND a.team_id = ? AND a.review_status = 0`,
      )
      .bind(eventType, nonce, operatorId, reason, rawJson, now, now, sessionId, teamId);
    // stmt[1]：条件 UPDATE，守卫 = 同一 PRE-state 谓词 P（避免 SELECT→UPDATE 的 TOCTOU；
    // WHERE 直接带 team_id，§八/§九 租户隔离下推到 Repository）。
    const updateStmt = this.db
      .prepare(
        `UPDATE attendance_sessions
            SET review_status = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND review_status = 0`,
      )
      .bind(newReviewStatus, now, sessionId, teamId);

    const results = await this.db.batch([insertStmt, updateStmt]);
    return Number(results[1]?.meta?.changes ?? 0);
  }

  /**
   * 强制签退（Force Checkout）原子写：与 reviewSessionAtomically 同构（先 INSERT 后 UPDATE，
   * 两条语句共享同一 PRE-state 谓词），同样【不依赖时间戳唯一性】。
   *
   *     P := (id = ? AND team_id = ? AND status = 1 AND checkout_at IS NULL)
   *
   * stmt[0] 不触碰 attendance_sessions → stmt[1] 求值 P 时真值必然一致 ⇒
   *   P 真 → 1 event + 1 行 CHECKED_IN→CHECKED_OUT；P 假 → 0 event + 0 行（409/404 不写 event）。
   *
   * @param newStatus 目标 status（正常为 ATTENDANCE_STATUS.CHECKED_OUT=2；
   *                  测试故障模式 2 传入越界值以违反 status CHECK，用于证明真实事务回滚）。
   * @param now Unix epoch **seconds**（禁止毫秒；写入 checkout_at / updated_at / occurred_at）。
   * @returns UPDATE 实际变更行数（0 = 守卫未命中，调用方据 findTeamSession 区分 404 / 409）。
   */
  async forceCheckoutAtomically(
    sessionId: number,
    teamId: number,
    now: number,
    eventType: string,
    reason: string,
    rawJson: string,
    operatorId: number,
    newStatus: number = ATTENDANCE_STATUS.CHECKED_OUT,
  ): Promise<number> {
    this.ensureTableRead('attendance_sessions');
    this.ensureTableRead('attendance_events');

    const nonce = `force:${sessionId}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;
    // stmt[0]：审计事件，守卫 = PRE-state 谓词 P（与下方 UPDATE 完全一致）。
    const insertStmt = this.db
      .prepare(
        `INSERT INTO attendance_events
           (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, reason, raw, occurred_at, created_at)
         SELECT a.id, a.activity_id, a.user_id, a.team_id, ?, ?, ?, ?, ?, ?, ?
           FROM attendance_sessions a
          WHERE a.id = ? AND a.team_id = ? AND a.status = 1 AND a.checkout_at IS NULL`,
      )
      .bind(eventType, nonce, operatorId, reason, rawJson, now, now, sessionId, teamId);
    // stmt[1]：条件 UPDATE，守卫 = 同一 PRE-state 谓词 P。
    const updateStmt = this.db
      .prepare(
        `UPDATE attendance_sessions
            SET status = ?, checkout_at = ?, updated_at = ?
          WHERE id = ? AND team_id = ? AND status = 1 AND checkout_at IS NULL`,
      )
      .bind(newStatus, now, now, sessionId, teamId);

    const results = await this.db.batch([insertStmt, updateStmt]);
    return Number(results[1]?.meta?.changes ?? 0);
  }

  /**
   * TEAM 作用域定位（§八/§九）：仅当 id 同时属于当前租户 team_id 时才返回行。
   * 跨团队 / 不存在的 sessionId 一律返回 null —— 上层据此对两者统一返回 404，
   * 不构成 cross-team existence oracle（§八）。
   */
  async findTeamSession(sessionId: number, teamId: number): Promise<AttendanceSessionRow | null> {
    this.ensureTableRead('attendance_sessions');
    return this.first<AttendanceSessionRow>(
      `SELECT id, signup_id, activity_id, user_id, team_id, service_date, slot,
              checkin_at, checkout_at, status, review_status, created_at, updated_at,
              business_service_date
         FROM attendance_sessions
        WHERE id = ? AND team_id = ?`,
      [sessionId, teamId],
    );
  }
}
