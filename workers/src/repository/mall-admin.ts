/**
 * MallAdminRepository（P25-P3B1）—— 管理端（TEAM）订单查询 + 原子核销仓储。
 *
 * 设计冻结依据：
 *   P25-P3A DESIGN = PASS / P25-P3A-REV1（TEAM 双层守卫 + 精确 5 文件边界）
 *   P25-P1（status 1=待领取待核销、2=已领取已核销、3/4=RESERVED；无退款语义）
 *
 * 【本文件边界】
 * - 只负责管理端 TEAM 作用域的「读」与「原子核销写」。
 * - 每个方法（含写方法 verifyOrder）首行必须执行
 *   `this.ensureTableRead('mall_orders')`（项目当前唯一真实表级作用域守卫；
 *   全仓不存在 ensureTableWrite，写操作同样由它收口，与 mall-redemption.ts 一致）。
 * - 守卫之外，SQL 必须再显式限定 `team_id = auth.teamId`。两层缺一不可：
 *   守卫负责"是否有团队上下文"（无则 403 TEAM_SCOPED_REQUIRED），SQL 谓词负责"只命中本团数据行"。
 * - 核销只翻转订单生命周期：仅改 status / verified_by / verified_at / updated_at。
 *   严禁触碰 points_accounts / points_ledger / mall_products.stock / sold_count /
 *   mall_orders.exchange_code / verify_code / points。核销不是二次兑换，也不是反向兑换。
 */

import { BaseRepository } from './base';
import { teamScopeRequired } from '../utils/errors';

/** 管理端订单对外投影（TEAM 作用域，仅公开 public 字段）。 */
export interface TeamOrderView {
  order_no: string;
  exchange_code: string | null;
  product_public_id: string | null;
  product_title: string;
  points_units: number;
  status: number;
  verified_at: number | null;
  created_at: number | null;
  updated_at: number | null;
  user_public_id: string | null;
  verified_by_public_id: string | null;
}

/**
 * 管理端订单 SELECT 投影：
 *  - user_public_id         ← JOIN users(下单人).public_id
 *  - verified_by_public_id  ← LEFT JOIN users(核销人).public_id（未核销为 null）
 *  - product_public_id      ← LEFT JOIN mall_products.public_id
 * 绝不投影：id / user_id / team_id / product_id / verify_code / verified_by(数字)。
 */
const TEAM_ORDER_SELECT = `SELECT
       mo.order_no            AS order_no,
       mo.exchange_code       AS exchange_code,
       mp.public_id           AS product_public_id,
       mo.product_title       AS product_title,
       mo.points              AS points_units,
       mo.status              AS status,
       mo.verified_at         AS verified_at,
       mo.created_at          AS created_at,
       mo.updated_at          AS updated_at,
       u.public_id            AS user_public_id,
       vu.public_id           AS verified_by_public_id
  FROM mall_orders mo
  LEFT JOIN users u          ON u.id  = mo.user_id
  LEFT JOIN mall_products mp ON mp.id = mo.product_id
  LEFT JOIN users vu         ON vu.id = mo.verified_by`;

/** 核销后的目标状态：2 = 已领取 / 已核销。 */
const MALL_ORDER_STATUS_VERIFIED = 2;

/** 可被核销的源状态：1 = 待领取 / 待核销。 */
const MALL_ORDER_STATUS_CREATED = 1;

export class MallAdminRepository extends BaseRepository {
  /** TEAM 上下文：未携带 teamId → 403（与 checkReadAccess 的 TEAM_SCOPED 判定一致）。 */
  private get authTeamId(): number {
    const tid = this.ctx.auth.teamId;
    if (tid == null) throw teamScopeRequired();
    return tid;
  }

  /**
   * 本团订单列表（TEAM 作用域；不按 user_id 过滤，因为这是管理员本团核销列表）。
   * 确定性排序：created_at DESC, id DESC。
   */
  async listTeamOrders(limit: number, offset: number, status?: number): Promise<TeamOrderView[]> {
    this.ensureTableRead('mall_orders');
    const params: unknown[] = [this.authTeamId];
    let sql = `${TEAM_ORDER_SELECT} WHERE mo.team_id = ?`;
    if (status != null) {
      sql += ` AND mo.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY mo.created_at DESC, mo.id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return this.all<TeamOrderView>(sql, params);
  }

  /** 本团订单总数（可选 status 过滤，与 listTeamOrders 条件保持一致）。 */
  async countTeamOrders(status?: number): Promise<number> {
    this.ensureTableRead('mall_orders');
    const params: unknown[] = [this.authTeamId];
    let sql = `SELECT COUNT(*) AS c FROM mall_orders WHERE team_id = ?`;
    if (status != null) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    const row = await this.first<{ c: number }>(sql, params);
    return row ? Number(row.c) : 0;
  }

  /** 本团单订单详情（按 order_no，防枚举：未命中返回 null，由路由统一 404）。 */
  async getTeamOrder(orderNo: string): Promise<TeamOrderView | null> {
    this.ensureTableRead('mall_orders');
    return this.first<TeamOrderView>(`${TEAM_ORDER_SELECT} WHERE mo.team_id = ? AND mo.order_no = ?`, [
      this.authTeamId,
      orderNo,
    ]);
  }

  /**
   * 本团内按兑换码定位（TEAM 作用域）。
   * 核销 UPDATE changes=0 后的分类重读也必须走这里，
   * 以保证「不存在 / 错误码 / 跨团队 / legacy NULL」在 TEAM 范围内同形，不产生存在性 oracle。
   */
  async getByExchangeCode(exchangeCode: string): Promise<TeamOrderView | null> {
    this.ensureTableRead('mall_orders');
    return this.first<TeamOrderView>(`${TEAM_ORDER_SELECT} WHERE mo.team_id = ? AND mo.exchange_code = ?`, [
      this.authTeamId,
      exchangeCode,
    ]);
  }

  /**
   * 原子核销：仅一条条件 UPDATE，绝不先 SELECT 再无条件 UPDATE（避免并发双核销）。
   * WHERE 同时约束 exchange_code + team_id + status=1 → 天然幂等且原子。
   * 返回受影响行数（1 = 首次核销成功；0 = 不可核销，需调用方 TEAM 重读分类）。
   */
  async verifyOrder(exchangeCode: string, verifiedBy: number, now: number): Promise<number> {
    this.ensureTableRead('mall_orders');
    const res = await this.run(
      `UPDATE mall_orders
          SET status      = ${MALL_ORDER_STATUS_VERIFIED},
              verified_by = ?,
              verified_at = ?,
              updated_at  = ?
        WHERE exchange_code = ?
          AND team_id      = ?
          AND status       = ${MALL_ORDER_STATUS_CREATED}`,
      [verifiedBy, now, now, exchangeCode, this.authTeamId],
    );
    return Number(res.meta?.changes ?? 0);
  }
}
