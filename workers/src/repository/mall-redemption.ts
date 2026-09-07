/**
 * MallRedemptionRepository（P24-P2C）—— 积分商城兑换核心 SQL builder（唯一写入口骨架）。
 *
 * 设计冻结依据：
 *   P24-P0 = PASS
 *   P24-P1 DESIGN = PASS
 *   P24-P2A PREFLIGHT = PASS（attempt token 协议 / A–F 场景实测）
 *   P24-P2B = PASS（0020 仅 3 权限 + 6 绑定；mall schema 未改动）
 *
 * 【本阶段边界】
 * - 只构造 S1→S2→S3→S4 四条已 bind 的 prepared statement，**绝不执行 db.batch()**。
 * - 不创建 service / route / API，不做 409 冲突处理，不做 ULID 校验，不生成 verifyCode。
 * - 不修改 mall schema、不重建 points_ledger、不新增 'redeem' type（沿用既有 'exchange'）。
 *
 * 【权威输入纪律（P24 v1 冻结）】
 * - 调用方只允许传：productPublicId / orderNo / verifyCode / now。
 * - userId / teamId 一律取自 this.ctx.auth（禁止调用方传入）。
 * - product_id / team_id / product_title / points_price 一律由 SQL 从真实 mall_products 派生
 *   （禁止调用方传 product numeric id / cost / points / title / stock / quantity）。
 * - quantity = 1 fixed（真实 mall_orders 无 quantity 列，P24 v1 不支持多件）。
 * - verifyCode = 未来 Service 层服务端生成的 attempt token（非客户端字段）。
 *
 * 【attempt-token 幂等（P24-P2A-REV2 冻结，取代已废弃的 order_no-only gate）】
 * - S1 写入 order_no = 客户端 ULID，verify_code = 服务端本次 attempt token。
 * - S2/S3/S4 统一门控于 attempt CTE：order_no + verify_code + user_id + team_id + product_id 全等。
 * - retry（同 orderNo + 新 verifyCode）：attempt CTE 恒空 → S1..S4 全为 0 行，
 *   且 **不依赖 UNIQUE(points_ledger.request_id) 报错触发 rollback**。
 * - 缺少 points_accounts → S1 = 0（等价零余额），**不自动创建账户**。
 */

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { BaseRepository } from './base';
import { teamScopeRequired, userScopeRequired } from '../utils/errors';

/** mall_products.status：1 = 上架（可兑换）。 */
export const MALL_PRODUCT_STATUS_ACTIVE = 1;
/** mall_orders.status：1 = 已下单待核销。 */
export const MALL_ORDER_STATUS_CREATED = 1;
/** points_ledger.direction：2 = 扣减。 */
export const LEDGER_DIRECTION_DEBIT = 2;
/** points_ledger.type：既有合法值 'exchange'（0018 CHECK），不新增 'redeem'。 */
export const LEDGER_TYPE_EXCHANGE = 'exchange';
/** points_ledger.source_type：兑换订单。 */
export const LEDGER_SOURCE_TYPE_MALL_ORDER = 'mall_order';

/** 兑换运行参数（禁止传入任何 SQL 可推导值 / 任何客户端权威字段）。 */
export interface RedeemInput {
  /** 商品外部 id（mall_products.public_id，ULID）—— 唯一商品 selector。 */
  productPublicId: string;
  /** 客户端生成的 26 位 ULID 订单号（幂等键，不是 attempt token）。 */
  orderNo: string;
  /** 服务端本次 attempt token（写入 mall_orders.verify_code）。 */
  verifyCode: string;
  /** 服务端生成的公开领取凭证（写入 mall_orders.exchange_code，与 verify_code 职责严格分离）。 */
  exchangeCode: string;
  /** Unix epoch seconds。 */
  now: number;
}

/** 四条 statement（顺序固定 S1 → S2 → S3 → S4），供调用方原样 push 进同一 db.batch。 */
export interface RedeemStatements {
  statements: [
    D1PreparedStatement,
    D1PreparedStatement,
    D1PreparedStatement,
    D1PreparedStatement,
  ];
}

/**
 * P24-P2D：order_no 归属判定（纯 SELECT，只返回两个布尔，**不返回任何既有订单字段**）。
 * - taken        ：该 order_no 是否已被任何订单占用（mall_orders.order_no 为全局 UNIQUE）。
 * - sameIdentity ：是否被【同一 user + 同一 team + 同一请求商品 public_id】占用。
 *
 * 【跨租户最小化纪律】
 * order_no 全局唯一意味着"别的用户/别的团队占用了同一个号"必须可判定（否则无法区分
 * 幂等返回与 409 冲突）。但判定只需布尔，因此本方法**刻意不把任何跨团队行取回 JS**：
 * 既有的 user_id / team_id / product_id / 创建时间等字段一律不 materialize，
 * 仅以两个 EXISTS 子查询结果返回，杜绝跨租户字段进入 service / API 层。
 */
export interface OrderNoState {
  taken: boolean;
  sameIdentity: boolean;
}

/**
 * P24-P2D：商品可兑换状态（纯 SELECT，仅用于 0/0/0/0 后的错误分类）。
 * scope 恒为 public_id + auth.teamId（跨团队商品一律视为不存在 → 404，不泄露）。
 */
export interface ProductRedeemState {
  id: number;
  publicId: string;
  teamId: number;
  status: number;
  deletedAt: number | null;
  stock: number;
  pointsPrice: number;
}

/**
 * 权威商品 CTE 工厂（bind 槽位恒为 ?1 / ?2）。
 * - 由 public_id + auth.teamId 解析真实商品，客户端无法指定 numeric id / 跨团队商品。
 * - requireStock = true（S1 资格）：额外要求 stock >= 1 —— 兑换资格硬门槛。
 * - requireStock = false（S2/S3/S4 身份）：**绝不能**带 stock >= 1。
 *
 * 【关键纪律 / P24-P2C 实测修正】
 * S3 会把 stock 减 1；若 stock 原为 1，S3 执行后 stock = 0。
 * 此时若 attempt 门控仍复用"stock >= 1"的 tgt，S4 的 attempt CTE 会退化为空集，
 * 导致订单与扣分都已生效但流水缺失（实测 F 场景 S4 = 0）。
 * 因此：资格判定（stock）只属于 S1；S2–S4 的门控必须建立在【事务内不变】的
 * 身份属性（public_id / team_id / status / deleted_at）之上。
 */
function tgtCte(requireStock: boolean): string {
  return `
WITH tgt AS (
  SELECT
    p.id           AS product_id,
    p.team_id      AS team_id,
    p.title        AS title,
    p.points_price AS points_price
  FROM mall_products p
  WHERE p.public_id = ?
    AND p.team_id   = ?
    AND p.status    = ${MALL_PRODUCT_STATUS_ACTIVE}
    AND p.deleted_at IS NULL${requireStock ? '\n    AND p.stock    >= 1' : ''}
)`;
}

/** S1 专用：兑换资格 CTE（含 stock >= 1）。 */
const TGT_ELIGIBLE_CTE = tgtCte(true);

/**
 * 本次 attempt 门控 CTE（S2–S4 共用，bind 槽位恒为 ?3 / ?4 / ?5）。
 * - 必须全等匹配：order_no + verify_code + user_id + team_id + product_id。
 * - team_id / product_id 由【身份】tgt 派生（绑定"相同真实商品"，杜绝跨商品/跨团队误匹配），
 *   且不随 S3 的 stock 变化而失效。
 * - 禁止退化为 WHERE order_no = ?（retry 会命中陈旧订单 → 重复扣分/扣库存）。
 */
const ATTEMPT_CTE = `${tgtCte(false)},
attempt AS (
  SELECT
    o.id         AS order_id,
    o.order_no   AS order_no,
    o.user_id    AS user_id,
    o.team_id    AS team_id,
    o.product_id AS product_id,
    o.points     AS points
  FROM mall_orders o
  WHERE o.order_no    = ?
    AND o.verify_code = ?
    AND o.user_id     = ?
    AND o.team_id     = (SELECT team_id FROM tgt)
    AND o.product_id  = (SELECT product_id FROM tgt)
)`;

/** 统一 attempt 存在性守卫（S2/S3/S4 共用，杜绝语义漂移）。 */
const ATTEMPT_GATE_SQL = `EXISTS (SELECT 1 FROM attempt)`;

/** request_id 纯 SQL 构造：'ex:<order_no>'（禁止调用方传 requestId）。 */
const REQUEST_ID_SQL = `'ex:' || (SELECT order_no FROM attempt)`;

export class MallRedemptionRepository extends BaseRepository {
  /**
   * 构造兑换四件套（S1 → S2 → S3 → S4）。仅供调用方 push 进同一 db.batch；
   * 本方法【不执行】db.batch、不读余额、不生成任何 ID。
   *
   * - S1 INSERT mall_orders：全部字段由 tgt 派生；余额不足 / 无账户 / 无库存 /
   *   order_no 已存在 → 0 行。
   * - S2 UPDATE points_accounts：balance -= order.points，total_spent += order.points，
   *   total_earned / total_debits 不变；amount 直接读 attempt order.points。
   * - S3 UPDATE mall_products：stock -= 1，sold_count += 1；product_id 来自 attempt。
   * - S4 INSERT points_ledger：type='exchange'，direction=2，source_type='mall_order'，
   *   source_id=order.id，request_id='ex:'||order_no，balance_after 直接读 S2 后账户余额
   *   （禁止 old_balance - amount 重算）。
   *
   * operator_id / remark 依据（真实项目用法）：
   * - points_ledger.operator_id 可空（REFERENCES users(id) ON DELETE SET NULL），
   *   PointsLedgerRepository 对"无独立操作者"场景绑定 `operatorId ?? null` —— 自发兑换无独立操作者，
   *   故冻结为 NULL。
   * - remark 沿用 service-records 的短语义标签惯例（'checkout' / 'revoke' / 'adjust'），
   *   故冻结为 'exchange'。
   */
  buildRedeemStatements(p: RedeemInput): RedeemStatements {
    this.ensureTableRead('mall_products');
    this.ensureTableRead('mall_orders');
    this.ensureTableRead('points_accounts');
    this.ensureTableRead('points_ledger');

    const userId = this.ctx.auth.userId;
    const teamId = this.ctx.auth.teamId;
    if (userId == null) throw userScopeRequired();
    if (teamId == null) throw teamScopeRequired();

    // ---- S1：权威订单 INSERT（order_no = 客户端 ULID，verify_code = 服务端 attempt token，
    //      exchange_code = 服务端公开领取凭证；三者一次性原子写入，杜绝无码窗口）----
    // bind: ?1 productPublicId, ?2 teamId, ?3 orderNo, ?4 userId, ?5 verifyCode, ?6 exchangeCode,
    //       ?7 now, ?8 userId(余额账户), ?9 orderNo(重复单守卫)
    const s1 = this.db
      .prepare(
        `${TGT_ELIGIBLE_CTE}
         INSERT INTO mall_orders (
           order_no, user_id, team_id, product_id, product_title, points, status, verify_code, exchange_code, created_at
         )
         SELECT
           ?,                                  -- order_no
           ?,                                  -- user_id
           (SELECT team_id FROM tgt),
           (SELECT product_id FROM tgt),
           (SELECT title FROM tgt),
           (SELECT points_price FROM tgt),
           ${MALL_ORDER_STATUS_CREATED},
           ?,                                  -- verify_code（服务端 attempt token）
           ?,                                  -- exchange_code（服务端公开领取凭证）
           ?                                   -- now
         WHERE EXISTS (SELECT 1 FROM tgt)
           AND (SELECT balance FROM points_accounts WHERE user_id = ?)
               >= (SELECT points_price FROM tgt)
           AND NOT EXISTS (SELECT 1 FROM mall_orders WHERE order_no = ?)`,
      )
      .bind(p.productPublicId, teamId, p.orderNo, userId, p.verifyCode, p.exchangeCode, p.now, userId, p.orderNo);

    // ---- S2：扣分（amount 直接读 attempt order.points，绝不信任客户端 cost）----
    // bind: ?1..?5 CTE, ?6 now
    const s2 = this.db
      .prepare(
        `${ATTEMPT_CTE}
         UPDATE points_accounts
            SET balance      = balance      - (SELECT points FROM attempt),
                total_spent  = total_spent  + (SELECT points FROM attempt),
                updated_at   = ?
          WHERE user_id = (SELECT user_id FROM attempt)
            AND ${ATTEMPT_GATE_SQL}
            AND balance >= (SELECT points FROM attempt)`,
      )
      .bind(p.productPublicId, teamId, p.orderNo, p.verifyCode, userId, p.now);

    // ---- S3：扣库存（product_id / team_id 来自 attempt order，非客户端 numeric id）----
    // bind: ?1..?5 CTE, ?6 now
    const s3 = this.db
      .prepare(
        `${ATTEMPT_CTE}
         UPDATE mall_products
            SET stock      = stock - 1,
                sold_count = sold_count + 1,
                updated_at = ?
          WHERE id      = (SELECT product_id FROM attempt)
            AND team_id = (SELECT team_id FROM attempt)
            AND stock  >= 1
            AND ${ATTEMPT_GATE_SQL}`,
      )
      .bind(p.productPublicId, teamId, p.orderNo, p.verifyCode, userId, p.now);

    // ---- S4：exchange 流水（balance_after 直接读 S2 后余额；request_id 由 SQL 构造）----
    // bind: ?1..?5 CTE, ?6 now
    const s4 = this.db
      .prepare(
        `${ATTEMPT_CTE}
         INSERT INTO points_ledger (
           user_id, direction, amount, balance_after,
           type, source_type, source_id, request_id, remark, operator_id, created_at
         )
         SELECT
           (SELECT user_id FROM attempt),
           ${LEDGER_DIRECTION_DEBIT},
           (SELECT points FROM attempt),
           (SELECT balance FROM points_accounts WHERE user_id = (SELECT user_id FROM attempt)),
           '${LEDGER_TYPE_EXCHANGE}',
           '${LEDGER_SOURCE_TYPE_MALL_ORDER}',
           (SELECT order_id FROM attempt),
           ${REQUEST_ID_SQL},
           '${LEDGER_TYPE_EXCHANGE}',
           NULL,
           ?
         WHERE ${ATTEMPT_GATE_SQL}`,
      )
      .bind(p.productPublicId, teamId, p.orderNo, p.verifyCode, userId, p.now);

    return { statements: [s1, s2, s3, s4] };
  }

  // ===== P24-P2D：纯 SELECT 只读 helper（不修改已验证的 S1–S4；仅供 Service 幂等/错误分类）=====

  /**
   * order_no 归属判定（纯 SELECT，只返回两个布尔，绝不 materialize 任何跨团队订单字段）。
   * - taken        ：该 order_no 是否已被任意订单占用（mall_orders.order_no 全局 UNIQUE）。
   * - sameIdentity ：是否被【同一 user + 同一 team + 同一请求商品 public_id】占用。
   * 跨团队占用的订单只经由 taken=true 暴露"被占用"这一布尔事实，绝不取回其 user/team/product。
   */
  async getOrderNoState(orderNo: string, productPublicId: string): Promise<OrderNoState> {
    this.ensureTableRead('mall_orders');
    this.ensureTableRead('mall_products');
    const userId = this.ctx.auth.userId;
    const teamId = this.ctx.auth.teamId;
    if (userId == null) throw userScopeRequired();
    if (teamId == null) throw teamScopeRequired();

    const takenRow = await this.first<{ v: number }>(
      `SELECT EXISTS(SELECT 1 FROM mall_orders WHERE order_no = ?) AS v`,
      [orderNo],
    );
    const sameRow = await this.first<{ v: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM mall_orders o
         JOIN mall_products p ON p.id = o.product_id
         WHERE o.order_no = ?
           AND o.user_id = ?
           AND o.team_id = ?
           AND p.public_id = ?
       ) AS v`,
      [orderNo, userId, teamId, productPublicId],
    );
    return { taken: !!takenRow?.v, sameIdentity: !!sameRow?.v };
  }

  /**
   * 商品可兑换状态（纯 SELECT，仅用于 0/0/0/0 后的错误分类）。
   * scope 恒为 public_id + auth.teamId（跨团队商品一律返回 null → 404，不泄露）。
   */
  async getProductRedeemState(productPublicId: string): Promise<ProductRedeemState | null> {
    this.ensureTableRead('mall_products');
    const teamId = this.ctx.auth.teamId;
    if (teamId == null) throw teamScopeRequired();
    const row = await this.first<{
      id: number;
      public_id: string;
      team_id: number;
      status: number;
      deleted_at: number | null;
      stock: number;
      points_price: number;
    }>(
      `SELECT id, public_id, team_id, status, deleted_at, stock, points_price
         FROM mall_products WHERE public_id = ? AND team_id = ?`,
      [productPublicId, teamId],
    );
    if (!row) return null;
    return {
      id: row.id,
      publicId: row.public_id,
      teamId: row.team_id,
      status: row.status,
      deletedAt: row.deleted_at,
      stock: row.stock,
      pointsPrice: row.points_price,
    };
  }

  /** 当前 SELF 余额（纯 SELECT，仅用于错误分类；绝不替代 S2 的权威扣减）。无账户返回 null。 */
  async getSelfBalance(): Promise<number | null> {
    this.ensureTableRead('points_accounts');
    const userId = this.ctx.auth.userId;
    if (userId == null) throw userScopeRequired();
    const row = await this.first<{ balance: number }>(
      `SELECT balance FROM points_accounts WHERE user_id = ?`,
      [userId],
    );
    return row ? row.balance : null;
  }

  /**
   * 读取【同身份】既有订单的公开领取凭证（纯 SELECT）。
   * - 仅当 order_no + user_id + team_id + product_public_id 全等时才返回其 exchange_code，
   *   否则返回 null（跨团队/跨用户/不存在 → 不泄露任何既有订单字段）。
   * - 不 materialize user_id / team_id / product_id 等内部字段。
   * - 用于幂等重放返回原 exchange_code；P25 之前的历史订单 exchange_code 可能为 NULL（返回 null，不补码）。
   */
  async getExistingExchangeCode(orderNo: string, productPublicId: string): Promise<string | null> {
    this.ensureTableRead('mall_orders');
    this.ensureTableRead('mall_products');
    const userId = this.ctx.auth.userId;
    const teamId = this.ctx.auth.teamId;
    if (userId == null) throw userScopeRequired();
    if (teamId == null) throw teamScopeRequired();
    const row = await this.first<{ exchange_code: string | null }>(
      `SELECT o.exchange_code
         FROM mall_orders o
         JOIN mall_products p ON p.id = o.product_id
        WHERE o.order_no = ?
          AND o.user_id  = ?
          AND o.team_id  = ?
          AND p.public_id = ?`,
      [orderNo, userId, teamId, productPublicId],
    );
    return row ? row.exchange_code : null;
  }
}
