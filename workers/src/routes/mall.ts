/**
 * Mall API（P24-P3B）—— 四个端点的路由集成。
 *
 * 设计冻结依据：
 *   P24-P3A DESIGN = PASS
 *   P24-P3A-REV1（verify_code INTERNAL ONLY；未知字段忽略）
 *
 * 端点：
 *   GET  /api/v2/mall/products        —— 商品列表（TEAM；mall.product.read）
 *   POST /api/v2/mall/orders         —— 兑换（TEAM + SELF；mall.order.create；201/200）
 *   GET  /api/v2/mall/orders         —— 本人订单列表（TEAM + SELF；mall.order.read）
 *   GET  /api/v2/mall/orders/:orderNo—— 本人订单详情（TEAM + SELF；mall.order.read；404 防枚举）
 *
 * 纪律：
 * - 权限由 requirePermission（D1 裁决；401/403/500）包裹。
 * - 租户/身份作用域由 Repository 的 ensureTableRead + SELF WHERE 收口。
 * - 路由只读取 product_public_id / order_no；禁止字段出现即 400；其它未知 key 忽略。
 * - 业务冲突（mall_insufficient_balance / mall_out_of_stock / public_id_conflict）直接由
 *   AppError/errorHandler 折叠，路由不二次翻译。
 * - 不创建 route 之外的任何副作用；不读取/透传 verify_code 等内部字段。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { MallRepository, type OrderListItem, type ProductView } from '../repository/mall';
import { MallService } from '../services/mall-service';
import { ok } from '../utils/response';
import { requirePermission } from '../middleware/rbac';
import { authRequired, invalidParam, notFound } from '../utils/errors';
import { isUlid, parsePagination, requireUlidParam } from '../utils/validation';
import type { Paginated } from '../types/api';

const mall = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * 客户端禁止提交、会篡改服务端控制字段的名单（出现即 400；复用 service-records FORBIDDEN 范式）。
 * 这些字段试图控制：数量 / attempt token / 积分金额 / 用户·团队身份 / 商品内部身份 / 库存。
 */
const FORBIDDEN_ORDER_FIELDS = [
  'quantity',
  'verify_code',
  'points',
  'cost',
  'title',
  'team_id',
  'user_id',
  'product_id',
  'stock',
] as const;

/**
 * 解析兑换请求体：仅读取 product_public_id / order_no；其余字段忽略（不读取、不透传）。
 * 顺序：先 FORBIDDEN 名单 400，再 ULID 校验 400（与 service-records 一致）。
 */
function parseOrderBody(raw: unknown): { productPublicId: string; orderNo: string } {
  const body =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  for (const field of FORBIDDEN_ORDER_FIELDS) {
    if (field in body) {
      throw invalidParam(field, 'must not be provided by client');
    }
  }

  const productPublicId = body['product_public_id'];
  const orderNo = body['order_no'];
  if (typeof productPublicId !== 'string' || !isUlid(productPublicId)) {
    throw invalidParam('product_public_id', 'must be a 26-char ULID');
  }
  if (typeof orderNo !== 'string' || !isUlid(orderNo)) {
    throw invalidParam('order_no', 'must be a 26-char ULID');
  }
  return { productPublicId, orderNo };
}

// ---------------------------------------------------------------------------
// GET /products —— 商品列表（TEAM_SCOPED）
// ---------------------------------------------------------------------------
mall.get('/products', requirePermission('mall.product.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const pg = parsePagination(c.req.query());
  const repo = new MallRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const items = await repo.listProducts(pg.page, pg.pageSize, pg.offset);
  const total = await repo.countProducts();

  const data: Paginated<ProductView> = {
    items,
    pagination: {
      page: pg.page,
      page_size: pg.pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pg.pageSize)),
    },
  };
  return ok(c, data);
});

// ---------------------------------------------------------------------------
// POST /orders —— 兑换动作（TEAM + SELF）。POST 本身即兑换，无需独立 /redeem。
// ---------------------------------------------------------------------------
mall.post('/orders', requirePermission('mall.order.create'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const body = await c.req.json().catch(() => null);
  const { productPublicId, orderNo } = parseOrderBody(body);

  const svc = new MallService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const outcome = await svc.redeem({ productPublicId, orderNo });

  // created → 201；existing（同身份幂等重放）→ 200。业务冲突直接由 errorHandler 折叠。
  if (outcome.status === 'created') return ok(c, { orderNo: outcome.orderNo }, 201);
  return ok(c, { orderNo: outcome.orderNo }, 200);
});

// ---------------------------------------------------------------------------
// GET /orders —— 本人订单列表（SELF + TEAM）
// ---------------------------------------------------------------------------
mall.get('/orders', requirePermission('mall.order.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const pg = parsePagination(c.req.query());
  const repo = new MallRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const items = await repo.listSelfOrders(pg.page, pg.pageSize, pg.offset);
  const total = await repo.countSelfOrders();

  const data: Paginated<OrderListItem> = {
    items,
    pagination: {
      page: pg.page,
      page_size: pg.pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pg.pageSize)),
    },
  };
  return ok(c, data);
});

// ---------------------------------------------------------------------------
// GET /orders/:orderNo —— 本人订单详情（SELF + TEAM；404 防枚举）
// ---------------------------------------------------------------------------
mall.get('/orders/:orderNo', requirePermission('mall.order.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const orderNo = requireUlidParam(c.req.param('orderNo'), 'orderNo');
  const repo = new MallRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const order = await repo.getSelfOrder(orderNo);
  if (order == null) throw notFound('Order');
  return ok(c, order);
});

export default mall;
