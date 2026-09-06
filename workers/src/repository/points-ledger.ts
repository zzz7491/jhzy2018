/**
 * PointsLedgerRepository（P23-P2）—— 服务积分账本（points_ledger / points_accounts）核心 SQL builder。
 *
 * 设计冻结依据：
 *   P23-DESIGN-REV1 ~ REV7 = PASS
 *   P23 IMPLEMENTATION PREFLIGHT = PASS（含 disposable DB probe：0018 rebuild + 数据保留）
 *   P23-P1 = PASS（0018 已落地：points_revision / total_debits / type+'service'）
 *
 * 核心不变量（REV4–REV7 冻结）：
 *   target_units  = settlement_status = EFFECTIVE(1) ? points_awarded_units : 0
 *   ledger_net    = Σ(direction=1 ? +amount : direction=2 ? -amount : 0)
 *                   WHERE source_type='service_record' AND source_id = sr.id
 *   delta         = target_units - ledger_net
 *   delta = 0     → 不写 ledger、不改 account（真 no-op）
 *   每次成功 mutation 后：ledger_net == target_units
 *
 * 幂等三重守卫（每条 statement 独立成立，缺一不可）：
 *   ① points_revision > 0        —— TRUE mutation gate（REV6）：历史/未进入 pipeline 的 SR（revision=0）整体跳过。
 *   ② request_id NOT EXISTS      —— 'svc:sr:'||public_id||':'||points_revision 已入账则本 mutation identity 不再执行。
 *   ③ delta != 0                 —— 事务内实时 target-minus-net；已收敛则 0 行。
 *
 * 架构纪律：
 * - 本类只提供 buildServicePointsStatements()：返回 S0→S1→S2 已 bind 的 prepared statements，
 *   供 P23-P3 push 进 ServiceRecord mutation 的同一个 db.batch（同批原子：SR mutation 失败 → Points 一并回滚）。
 * - 本阶段不执行 db.batch、不修改 ServiceRecord revision、不注入 attendance 事务。
 *
 * SQL 派生纪律（REV5/REV7）：
 * - 调用方只允许传 sessionId / now / remark / operatorId 等运行参数；
 *   service_record id、user_id、public_id、points_revision、target、ledger_net、delta、request_id
 *   全部由 SQL 在事务内从真实 ServiceRecord 状态推导，禁止调用方拼接。
 * - SR selector 统一为 session_id（service_records.session_id UNIQUE，REV5 逐路径证明可得）。
 * - request_id 纯 SQL 构造：'svc:sr:' || sr.public_id || ':' || sr.points_revision。
 * - statement 顺序（REV4）：S0 ensure account → S1 UPDATE account → S2 INSERT ledger；
 *   S2 的 balance_after 直接读取 S1 更新后的 points_accounts.balance（禁止再 +delta）。
 * - 账户语义（REV1/REV2）：balance 允许为负（审计一致性优先）；
 *   delta>0 → total_earned；delta<0 → total_debits（服务冲正绝不污染 total_spent）；
 *   last_ledger_id / last_checked_at 为 dormant 字段，P23 v1 不维护（PREFLIGHT FINAL FIX 已证）。
 */

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { BaseRepository } from './base';

/** settlement_status（与 repository/service-records.ts 一致）：1 = EFFECTIVE。 */
const SETTLEMENT_EFFECTIVE = 1;

/** ServicePoints mutation 的运行参数（禁止传入任何 SQL 可推导值）。 */
export interface ServicePointsInput {
  /** SR 内部 selector（service_records.session_id，UNIQUE）。 */
  sessionId: number;
  /** Unix epoch seconds。 */
  now: number;
  /** ledger remark（可空；调用方语义，如 'checkout' / 'adjust' / 'revoke'）。 */
  remark?: string | null;
  /** 操作者内部 id（可空；系统自动 transition 时为 null）。 */
  operatorId?: number | null;
}

/**
 * 三条 statement（顺序固定 S0 → S1 → S2），供调用方原样 push 进同一 db.batch。
 */
export interface ServicePointsStatements {
  statements: [D1PreparedStatement, D1PreparedStatement, D1PreparedStatement];
}

/**
 * 账户只读投影（API 层映射为 *_units）。
 * 隐藏：user_id / last_ledger_id / last_checked_at（dormant 字段，P23 v1 不维护）。
 */
export interface PointsAccountView {
  balance: number;
  total_earned: number;
  total_spent: number;
  total_debits: number;
  updated_at: number | null;
}

/**
 * 流水只读投影（API 层映射为 amount_units / balance_after_units）。
 * 隐藏内部实现字段：id / user_id / source_id / operator_id / request_id。
 * service_record 流水经 LEFT JOIN 投影其真实 public_id；其余类型 source_public_id = NULL（不伪造）。
 */
export interface PointsLedgerView {
  direction: number;
  amount: number;
  balance_after: number;
  type: string;
  source_type: string | null;
  source_public_id: string | null;
  remark: string | null;
  created_at: number;
}

/**
 * 三条 statement 共用的 CTE 前缀：
 * - sr  ：按 session_id 定位 ServiceRecord（id/public_id/user_id/settlement_status/points/revision）。
 * - net ：该 SR 已有账本净额（仅 source_type='service_record' AND source_id=sr.id）。
 * - d   ：delta = target - net（全事务内实时计算，禁止 service layer 预计算 bind）。
 * 必须放在每条 statement 的 SQL 最前（CTE 在主语句之前），保证 bind 序号稳定：sessionId 恒为第 1 个 ?。
 */
const SR_CTE = `
WITH sr AS (
  SELECT
    id,
    public_id,
    user_id,
    settlement_status,
    points_awarded_units,
    points_revision
  FROM service_records
  WHERE session_id = ?
),
net AS (
  SELECT COALESCE(SUM(
           CASE direction WHEN 1 THEN amount WHEN 2 THEN -amount ELSE 0 END
         ), 0) AS n
  FROM points_ledger
  WHERE source_type = 'service_record'
    AND source_id   = (SELECT id FROM sr)
),
d AS (
  SELECT
    (CASE WHEN (SELECT settlement_status FROM sr) = ${SETTLEMENT_EFFECTIVE}
          THEN (SELECT points_awarded_units FROM sr)
          ELSE 0 END)
    - (SELECT n FROM net) AS v
)`;

/** request_id 纯 SQL 构造（REV6/REV7）：'svc:sr:<public_id>:<points_revision>'。 */
const REQUEST_ID_SQL = `'svc:sr:' || (SELECT public_id FROM sr) || ':' || (SELECT points_revision FROM sr)`;

/** 幂等守卫（①②③），S0/S1/S2 三条共用同一逻辑。 */
const GUARDS_SQL = `
  (SELECT points_revision FROM sr) > 0
  AND (SELECT v FROM d) <> 0
  AND NOT EXISTS (
    SELECT 1 FROM points_ledger
    WHERE request_id = ${REQUEST_ID_SQL}
  )`;

export class PointsLedgerRepository extends BaseRepository {
  /**
   * 构造 ServiceRecord 积分联动三件套（S0 → S1 → S2）。
   *
   * - S0 ensure account：仅当 SR 存在 + 守卫①②③成立 + 账户尚不存在时创建（user_id 取自 sr.user_id）。
   * - S1 UPDATE account ：balance += delta；delta>0 → total_earned；delta<0 → total_debits；
   *                       total_spent / last_ledger_id / last_checked_at 不变；updated_at = now。
   * - S2 INSERT ledger  ：type='service'，source_type='service_record'，source_id=sr.id，
   *                       balance_after = S1 更新后的 points_accounts.balance（直接读取，禁止 +delta）。
   *
   * 调用方必须把三条按序放入与 ServiceRecord mutation 相同的 db.batch（P23-P3 接线）。
   */
  buildServicePointsStatements(p: ServicePointsInput): ServicePointsStatements {
    this.ensureTableRead('service_records');
    this.ensureTableRead('points_accounts');
    this.ensureTableRead('points_ledger');

    // ---- S0：conditional ensure account（缺账户才建；绝不给 delta=0 / revision=0 的用户建空账户）----
    const s0 = this.db
      .prepare(
        `${SR_CTE}
         INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at)
         SELECT (SELECT user_id FROM sr), 0, 0, 0, 0, ?
         WHERE (SELECT user_id FROM sr) IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM points_accounts
             WHERE user_id = (SELECT user_id FROM sr)
           )
           AND ${GUARDS_SQL}`,
      )
      .bind(p.sessionId, p.now);

    // ---- S1：UPDATE account（balance / total_earned / total_debits；total_spent 不变；updated_at = now）----
    const s1 = this.db
      .prepare(
        `${SR_CTE}
         UPDATE points_accounts
            SET balance      = balance + (SELECT v FROM d),
                total_earned = total_earned + (CASE WHEN (SELECT v FROM d) > 0 THEN (SELECT v FROM d) ELSE 0 END),
                total_debits = total_debits  + (CASE WHEN (SELECT v FROM d) < 0 THEN -(SELECT v FROM d) ELSE 0 END),
                updated_at   = ?
          WHERE user_id = (SELECT user_id FROM sr)
            AND ${GUARDS_SQL}`,
      )
      .bind(p.sessionId, p.now);

    // ---- S2：INSERT ledger（balance_after 直接读 S1 后余额；request_id 由 SQL 构造）----
    const s2 = this.db
      .prepare(
        `${SR_CTE}
         INSERT INTO points_ledger (
           user_id, direction, amount, balance_after,
           type, source_type, source_id, request_id, remark, operator_id, created_at
         )
         SELECT
           (SELECT user_id FROM sr),
           (CASE WHEN (SELECT v FROM d) > 0 THEN 1 ELSE 2 END),
           ABS((SELECT v FROM d)),
           (SELECT balance FROM points_accounts WHERE user_id = (SELECT user_id FROM sr)),
           'service',
           'service_record',
           (SELECT id FROM sr),
           ${REQUEST_ID_SQL},
           ?, ?, ?
         WHERE (SELECT user_id FROM sr) IS NOT NULL
           AND ${GUARDS_SQL}`,
      )
      .bind(p.sessionId, p.remark ?? null, p.operatorId ?? null, p.now);

    return { statements: [s0, s1, s2] };
  }

  // ===== P23-P4B：只读查询（SELF / USER_SCOPED；绝无 INSERT/UPDATE/run/batch）=====

  /**
   * 读取指定用户的积分账户（USER_SCOPED）。
   * 无行时返回 null —— GET 不得因此 INSERT account（lazy-create 仍由 S0 在 mutation 时负责）。
   * 投影仅暴露 balance/total_earned/total_spent/total_debits/updated_at。
   */
  async getAccount(userId: number): Promise<PointsAccountView | null> {
    this.ensureTableRead('points_accounts');
    return this.first<PointsAccountView>(
      `SELECT balance, total_earned, total_spent, total_debits, updated_at
         FROM points_accounts
        WHERE user_id = ?`,
      [userId],
    );
  }

  /**
   * 读取指定用户的积分流水（USER_SCOPED）+ service_record → public_id 投影。
   * 确定性排序：created_at DESC, id DESC（id 为主键 tiebreak）。
   * 隐藏 id / user_id / source_id / operator_id / request_id。
   */
  async listTransactions(
    userId: number,
    page: number,
    pageSize: number,
    offset: number,
  ): Promise<PointsLedgerView[]> {
    this.ensureTableRead('points_ledger');
    return this.all<PointsLedgerView>(
      `SELECT
          pl.direction                                                  AS direction,
          pl.amount                                                     AS amount,
          pl.balance_after                                              AS balance_after,
          pl.type                                                       AS type,
          pl.source_type                                                AS source_type,
          CASE WHEN pl.source_type = 'service_record'
               THEN sr.public_id ELSE NULL END                          AS source_public_id,
          pl.remark                                                     AS remark,
          pl.created_at                                                 AS created_at
       FROM points_ledger pl
       LEFT JOIN service_records sr
              ON pl.source_type = 'service_record'
             AND pl.source_id   = sr.id
      WHERE pl.user_id = ?
      ORDER BY pl.created_at DESC, pl.id DESC
      LIMIT ? OFFSET ?`,
      [userId, pageSize, offset],
    );
  }

  /** 指定用户的流水总数（供分页 total）。 */
  async countTransactions(userId: number): Promise<number> {
    this.ensureTableRead('points_ledger');
    const row = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM points_ledger WHERE user_id = ?`,
      [userId],
    );
    return row?.total ?? 0;
  }
}
