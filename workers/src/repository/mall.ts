/**
 * MallRepository（P24-P3B）—— 商城读 API 仓储层。
 *
 * 设计冻结依据：
 *   P24-P3A DESIGN = PASS（四端点 / SELF+TEAM / 投影 / 排序 / 分页 全部冻结）
 *   P24-P3A-REV1（verify_code 降为 INTERNAL ONLY；未知字段忽略）
 *
 * 【本文件边界】
 * - 仅负责商城「读 API」：商品列表 / 本人订单列表 / 本人订单详情 + 计数。
 * - 所有方法纯 SELECT；绝无 INSERT/UPDATE/run/batch。
 * - 租户作用域由 BaseRepository.ensureTableRead 统一收口（mall_products / mall_orders
 *   均为 TEAM_SCOPED，依据 TABLE_SCOPE 矩阵）；订单再额外强制 SELF（user_id = auth.userId）。
 * - 范围/身份严格取自 this.ctx.auth（与 mall-redemption.ts 及 checkReadAccess 一致），
 *   不读 HTTP 对象。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { BaseRepository } from './base';
import { authRequired, teamScopeRequired } from '../utils/errors';

/** 仓储构造上下文（由路由层组装，绝不来自 HTTP 对象本身）。 */
export interface MallRepositoryDeps {
  db: D1Database;
  ctx: { auth: AuthContext; tenant: TenantContext };
}

/** 商品对外投影（隐藏 id / team_id / cover_file_id / stock / sold_count）。 */
export interface ProductView {
  public_id: string;
  title: string;
  detail: string | null;
  points_price_units: number;
  in_stock: boolean;
  status: number;
  sort: number;
  cover_public_id: string | null;
  created_at: number;
  updated_at: number | null;
}

/**
 * 订单对外投影（隐藏 verify_code / id / user_id / team_id / product_id / verified_by）。
 *
 * P25-P2B 起新增 exchange_code：它是服务端生成的**公开领取凭证**（用户凭此到管理员处领取），
 * 与 P24 冻结的内部 attempt token `verify_code` 严格分离、永不公开后者。
 * legacy（P24 之前）订单该列为 NULL → 原样返回 null，本层不做 backfill。
 */
export interface OrderListItem {
  order_no: string;
  exchange_code: string | null;
  product_public_id: string;
  product_title: string;
  points_units: number;
  status: number;
  verified_at: number | null;
  created_at: number;
  updated_at: number | null;
}

/** 订单详情与列表项字段完全相同（verify_code 不返回）。 */
export type OrderDetail = OrderListItem;

/** 商品 SELECT 原始行（in_stock_raw 为 SQLite 0/1，需在映射层转 boolean）。 */
interface RawProduct {
  public_id: string;
  title: string;
  detail: string | null;
  points_price: number;
  in_stock_raw: number;
  status: number;
  sort: number;
  cover_public_id: string | null;
  created_at: number;
  updated_at: number | null;
}

/** 订单 SELECT 原始行（points 列映射为 points_units）。 */
interface RawOrder {
  order_no: string;
  exchange_code: string | null;
  product_public_id: string;
  product_title: string;
  points: number;
  status: number;
  verified_at: number | null;
  created_at: number;
  updated_at: number | null;
}

export class MallRepository extends BaseRepository {
  /** SELF 上下文：未认证 / 无 userId → 401。 */
  private get authUserId(): number {
    const uid = this.ctx.auth.userId;
    if (uid == null) throw authRequired();
    return uid;
  }

  /** TEAM 上下文：未携带 teamId → 403（与 checkReadAccess 的 TEAM_SCOPED 判定一致）。 */
  private get authTeamId(): number {
    const tid = this.ctx.auth.teamId;
    if (tid == null) throw teamScopeRequired();
    return tid;
  }

  /**
   * 商品列表（TEAM_SCOPED + 仅本团 active 未删除）。
   * 确定性排序：sort ASC, created_at DESC, id DESC（id 为 PK tiebreak）。
   * 投影隐藏内部字段；in_stock = stock >= 1（不泄露精确库存）。
   */
  async listProducts(page: number, pageSize: number, offset: number): Promise<ProductView[]> {
    this.ensureTableRead('mall_products');
    const rows = await this.all<RawProduct>(
      `SELECT
         mp.public_id                                                   AS public_id,
         mp.title                                                       AS title,
         mp.detail                                                      AS detail,
         mp.points_price                                                AS points_price,
         (mp.stock >= 1)                                                AS in_stock_raw,
         mp.status                                                      AS status,
         mp.sort                                                        AS sort,
         f.public_id                                                    AS cover_public_id,
         mp.created_at                                                  AS created_at,
         mp.updated_at                                                  AS updated_at
       FROM mall_products mp
       LEFT JOIN files f ON mp.cover_file_id = f.id
       WHERE mp.team_id = ? AND mp.status = 1 AND mp.deleted_at IS NULL
       ORDER BY mp.sort ASC, mp.created_at DESC, mp.id DESC
       LIMIT ? OFFSET ?`,
      [this.authTeamId, pageSize, offset],
    );
    return rows.map((r) => ({
      public_id: r.public_id,
      title: r.title,
      detail: r.detail,
      points_price_units: r.points_price,
      in_stock: r.in_stock_raw === 1,
      status: r.status,
      sort: r.sort,
      cover_public_id: r.cover_public_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /** 商品总数（供分页 total；同 WHERE 条件）。 */
  async countProducts(): Promise<number> {
    this.ensureTableRead('mall_products');
    const row = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM mall_products
        WHERE team_id = ? AND status = 1 AND deleted_at IS NULL`,
      [this.authTeamId],
    );
    return row?.total ?? 0;
  }

  /**
   * 本人订单列表（SELF + TEAM：user_id = auth.userId AND team_id = auth.teamId）。
   * 确定性排序：created_at DESC, id DESC（对齐 P23 listTransactions）。
   * product_public_id 经 mall_products.public_id JOIN 取得。
   */
  async listSelfOrders(page: number, pageSize: number, offset: number): Promise<OrderListItem[]> {
    this.ensureTableRead('mall_orders');
    const rows = await this.all<RawOrder>(
      `SELECT
         mo.order_no                                                    AS order_no,
         mo.exchange_code                                               AS exchange_code,
         mp.public_id                                                   AS product_public_id,
         mo.product_title                                               AS product_title,
         mo.points                                                      AS points,
         mo.status                                                      AS status,
         mo.verified_at                                                 AS verified_at,
         mo.created_at                                                  AS created_at,
         mo.updated_at                                                  AS updated_at
       FROM mall_orders mo
       LEFT JOIN mall_products mp ON mo.product_id = mp.id
       WHERE mo.user_id = ? AND mo.team_id = ?
       ORDER BY mo.created_at DESC, mo.id DESC
       LIMIT ? OFFSET ?`,
      [this.authUserId, this.authTeamId, pageSize, offset],
    );
    return rows.map((r) => ({
      order_no: r.order_no,
      exchange_code: r.exchange_code,
      product_public_id: r.product_public_id,
      product_title: r.product_title,
      points_units: r.points,
      status: r.status,
      verified_at: r.verified_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /** 本人订单总数（供分页 total；同 WHERE 条件）。 */
  async countSelfOrders(): Promise<number> {
    this.ensureTableRead('mall_orders');
    const row = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM mall_orders WHERE user_id = ? AND team_id = ?`,
      [this.authUserId, this.authTeamId],
    );
    return row?.total ?? 0;
  }

  /**
   * 本人订单详情（SELF + TEAM + order_no 同时限制）。
   * 未命中统一返回 null —— 路由层负责 404（不区分「别人的/别团队/真不存在」，防枚举）。
   */
  async getSelfOrder(orderNo: string): Promise<OrderDetail | null> {
    this.ensureTableRead('mall_orders');
    const row = await this.first<RawOrder>(
      `SELECT
         mo.order_no                                                    AS order_no,
         mo.exchange_code                                               AS exchange_code,
         mp.public_id                                                   AS product_public_id,
         mo.product_title                                               AS product_title,
         mo.points                                                      AS points,
         mo.status                                                      AS status,
         mo.verified_at                                                 AS verified_at,
         mo.created_at                                                  AS created_at,
         mo.updated_at                                                  AS updated_at
       FROM mall_orders mo
       LEFT JOIN mall_products mp ON mo.product_id = mp.id
       WHERE mo.order_no = ? AND mo.user_id = ? AND mo.team_id = ?`,
      [orderNo, this.authUserId, this.authTeamId],
    );
    if (row == null) return null;
    return {
      order_no: row.order_no,
      exchange_code: row.exchange_code,
      product_public_id: row.product_public_id,
      product_title: row.product_title,
      points_units: row.points,
      status: row.status,
      verified_at: row.verified_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
