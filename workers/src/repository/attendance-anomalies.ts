/**
 * AttendanceAnomalyRepository（S2-6j）：attendance_anomalies 的唯一写/读入口。
 *
 * scope（repository/tenant-scope.ts）：attendance_anomalies = TEAM_SCOPED，含显式 team_id 列
 * → 直接 WHERE team_id = ? 即可（与 attendance_sessions 同思路，不依赖经 activities 派生）。
 *
 * 设计纪律（用户 §9 / §15 / §16 / §21）：
 * - 租户隔离在 Repository 层收口：list / find / resolve 的 SQL 全部带 team_id = ?，
 *   绝不先 findById 再比较 team_id（那会构成 cross-team existence oracle）。
 * - 跨团队 / 不存在统一返回 null → 上层 404（不泄露存在性，§9）。
 * - 无 updated_at / user_id / activity_id 列；需 user/activity 时经 attendance_sessions JOIN。
 * - 不新增 migration、不改 schema、不触碰 0004 冻结 SHA。
 */

import { BaseRepository } from './base';

/** 冻结 7 类 anomaly_type（与 0004 CHECK 完全一致）。 */
export const ANOMALY_TYPES = [
  'out_of_range',
  'device_switch',
  'multi_account',
  'replay',
  'cross_day',
  'overlong',
  'reverse_time',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

/** attendance_anomalies.status 字典（S2-6j §1 冻结）：1=OPEN / 2=CONFIRMED / 3=DISMISSED。 */
export const ANOMALY_STATUS = {
  OPEN: 1,
  CONFIRMED: 2,
  DISMISSED: 3,
} as const;

/** 列表最小返回字段（§11：不返回 detail / 敏感字段）。 */
export interface AnomalyListRow {
  id: number;
  session_id: number;
  anomaly_type: string;
  status: number;
  created_at: number;
  handled_at: number | null;
}

/** 详情返回（§12：含托管 session 视图；敏感字段 raw / 设备指纹 / 网络指纹一律不出现）。 */
export interface AnomalyDetailRow {
  id: number;
  session_id: number;
  anomaly_type: string;
  status: number;
  detail: string | null;
  created_at: number;
  handled_by: number | null;
  handled_at: number | null;
  resolution: string | null;
  // 关联 session（§12，敏感字段排除）
  activity_id: number | null;
  user_id: number | null;
  checkin_at: number | null;
  checkout_at: number | null;
  attendance_status: number | null;
  review_status: number | null;
  service_date: number | null;
  slot: string | null;
}

const ANOMALY_TYPE_SET = new Set<string>(ANOMALY_TYPES);

export function isAnomalyType(v: unknown): v is AnomalyType {
  return typeof v === 'string' && ANOMALY_TYPE_SET.has(v);
}

export class AttendanceAnomalyRepository extends BaseRepository {
  /** 当前租户团队 id；缺失即拒绝（TEAM_SCOPED 表必须有真实团队上下文）。 */
  private requireTeamId(): number {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw new Error('TEAM_SCOPE_REQUIRED');
    return teamId;
  }

  /**
   * 列表（TEAM 作用域；status / anomaly_type 可选过滤；limit 已由调用方 clamp；
   * cursor 基于 (created_at, id) DESC 严格小于上一页最后一行）。
   */
  async listAnomalies(params: {
    teamId: number;
    status?: number;
    anomalyType?: string;
    limit: number;
    cursorCreatedAt?: number;
    cursorId?: number;
  }): Promise<AnomalyListRow[]> {
    this.ensureTableRead('attendance_anomalies');

    const where: string[] = ['a.team_id = ?'];
    const bind: unknown[] = [params.teamId];
    if (params.status != null) {
      where.push('a.status = ?');
      bind.push(params.status);
    }
    if (params.anomalyType != null) {
      where.push('a.anomaly_type = ?');
      bind.push(params.anomalyType);
    }
    if (params.cursorCreatedAt != null && params.cursorId != null) {
      // 与 ORDER BY created_at DESC, id DESC 对应的"上一页最后一行"游标（严格小于）。
      where.push('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))');
      bind.push(params.cursorCreatedAt, params.cursorCreatedAt, params.cursorId);
    }
    const sql = `SELECT a.id, a.session_id, a.anomaly_type, a.status, a.created_at, a.handled_at
                   FROM attendance_anomalies a
                  WHERE ${where.join(' AND ')}
                  ORDER BY a.created_at DESC, a.id DESC
                  LIMIT ?`;
    return this.all<AnomalyListRow>(sql, [...bind, params.limit]);
  }

  /**
   * TEAM 作用域定位（§9）：仅当 id 同时属于当前租户 team_id 时返回行。
   * 跨团队 / 不存在 → null → 上层 404（不构成 cross-team existence oracle）。
   */
  async findTeamAnomaly(anomalyId: number, teamId: number): Promise<AnomalyDetailRow | null> {
    this.ensureTableRead('attendance_anomalies');
    return this.first<AnomalyDetailRow>(
      `SELECT a.id, a.session_id, a.anomaly_type, a.status, a.detail, a.created_at,
              a.handled_by, a.handled_at, a.resolution,
              s.activity_id, s.user_id, s.checkin_at, s.checkout_at, s.status AS attendance_status,
              s.review_status, s.service_date, s.slot
         FROM attendance_anomalies a
         LEFT JOIN attendance_sessions s ON s.id = a.session_id
        WHERE a.id = ? AND a.team_id = ?`,
      [anomalyId, teamId],
    );
  }

  /**
   * 原子处置（§15 / §16 / §17-L 硬门禁）：audit event INSERT + 条件 UPDATE 在单次 db.batch 内完成。
   *
   * 原子守卫（与 S2-6i 同构）：两条语句共享同一 PRE-state 谓词 P：
   *     P := (id = ? AND team_id = ? AND status = 1)
   * - stmt[0]（INSERT...SELECT）只写 attendance_events，【不触碰】attendance_anomalies → 不改变 P 真值；
   * - db.batch 单写事务、语句顺序执行、批内无其它写者；
   * - 故 stmt[1]（UPDATE）求值 P 时真值与 stmt[0] 求值时【必然相同】。
   *
   * 由 (1)(2)(3)：P 真 → 恰好 1 event + 恰好 1 行 UPDATE；P 假（已处置/跨团队/不存在）→
   * 0 event + 0 行（409/404 不写 event）。
   *
   * 故障注入：mode1 令 stmt[0] event_type CHECK 违例 → 整批回滚（UPDATE 从未生效）；
   * mode2 令 stmt[1] status CHECK 违例 → 已执行的 INSERT 被真实回滚（event 不存在）。
   *
   * @returns UPDATE 实际变更行数（0 = 守卫未命中，调用方据 findTeamAnomaly 区分 404 / 409）。
   */
  async resolveAnomalyAtomically(
    anomalyId: number,
    teamId: number,
    newStatus: number,
    eventType: string,
    reason: string,
    rawJson: string,
    operatorId: number,
    now: number,
  ): Promise<number> {
    this.ensureTableRead('attendance_anomalies');
    this.ensureTableRead('attendance_events');

    const nonce = `anomaly:${anomalyId}:${now}:${Math.floor(Math.random() * 1e9).toString(36)}`;
    // stmt[0]：审计事件，守卫 = PRE-state 谓词 P（与下方 UPDATE 完全一致）。
    // 经 LEFT JOIN attendance_sessions 安全取 activity_id / user_id；session 缺失仅使 SELECT 0 行（原子性不受影响）。
    const insertStmt = this.db
      .prepare(
        `INSERT INTO attendance_events
           (session_id, activity_id, user_id, team_id, event_type, nonce, operator_id, reason, raw, occurred_at, created_at)
         SELECT a.session_id, s.activity_id, s.user_id, a.team_id, ?, ?, ?, ?, ?, ?, ?
           FROM attendance_anomalies a
           LEFT JOIN attendance_sessions s ON s.id = a.session_id
          WHERE a.id = ? AND a.team_id = ? AND a.status = 1`,
      )
      .bind(eventType, nonce, operatorId, reason, rawJson, now, now, anomalyId, teamId);
    // stmt[1]：条件 UPDATE，守卫 = 同一 PRE-state 谓词 P（下推 team_id，§9）。
    const updateStmt = this.db
      .prepare(
        `UPDATE attendance_anomalies
            SET status = ?, handled_by = ?, handled_at = ?, resolution = ?
          WHERE id = ? AND team_id = ? AND status = 1`,
      )
      .bind(newStatus, operatorId, now, reason, anomalyId, teamId);

    const results = await this.db.batch([insertStmt, updateStmt]);
    return Number(results[1]?.meta?.changes ?? 0);
  }
}
