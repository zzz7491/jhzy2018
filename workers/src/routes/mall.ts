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
 * P25-P3B2 追加（管理端，均与 SELF 分离、独立前缀 + mall.order.verify）：
 *   GET  /api/v2/mall/admin/orders          —— 本团订单列表（TEAM）
 *   GET  /api/v2/mall/admin/orders/:orderNo —— 本团订单详情（TEAM；404 防枚举）
 *   POST /api/v2/mall/admin/orders/verify   —— 按兑换码核销（TEAM；幂等，200 verified/already_verified）
 * 且 SELF POST 响应追加 exchangeCode（公开领取凭证；内部 verify_code 永不返回）。
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
import { MallAdminRepository, type TeamOrderView } from '../repository/mall-admin';
import { MallService } from '../services/mall-service';
import { MallVerificationService } from '../services/mall-verification-service';
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
  // P25-P3B2：响应投影增加 exchangeCode（公开领取凭证）。
  //   - created / existing 同形；existing 返回库中**原有** exchange_code（service 保证不覆盖）；
  //   - legacy（P24 之前）订单 exchange_code 为 NULL → 原样返回 null，不 backfill；
  //   - 内部 verify_code 永不返回。
  const payload = { orderNo: outcome.orderNo, exchangeCode: outcome.exchangeCode };
  if (outcome.status === 'created') return ok(c, payload, 201);
  return ok(c, payload, 200);
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

// ---------------------------------------------------------------------------
// P25-P3B2 —— 管理端（TEAM）订单查询 + 核销。
//
// 与 SELF API 严格分离：SELF 的 /orders 与 /orders/:orderNo 绝不因 query 参数
// 切换为团队查询；管理端能力全部走独立的 /admin/* 前缀与 mall.order.verify 权限。
//
// 生命周期（P25-P1 冻结）：1=待领取/待核销，2=已领取/已核销，3/4=RESERVED（不解释含义，无退款语义）。
// ---------------------------------------------------------------------------

/**
 * 管理端列表 status 过滤：仅接受 1（待核销）与 2（已核销）。
 * 其余值（0 / 3 / 4 / 非整数 / 空串）一律 400 —— 绝不赋予 RESERVED 状态业务含义。
 */
function parseAdminStatusFilter(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || (n !== 1 && n !== 2)) {
    throw invalidParam('status', 'must be 1 or 2');
  }
  return n;
}

/**
 * 管理端列表项投影：刻意**剔除** verified_by_public_id（列表不暴露核销人）。
 * 即使 repository 行已带该字段，也必须在路由层裁掉。
 */
function toAdminListItem(o: TeamOrderView) {
  return {
    order_no: o.order_no,
    exchange_code: o.exchange_code,
    product_public_id: o.product_public_id,
    product_title: o.product_title,
    points_units: o.points_units,
    status: o.status,
    verified_at: o.verified_at,
    created_at: o.created_at,
    updated_at: o.updated_at,
    user_public_id: o.user_public_id,
  };
}

/** 管理端详情投影：额外公开 verified_by_public_id（JOIN users.public_id，非数字 id）。 */
function toAdminDetail(o: TeamOrderView) {
  return {
    order_no: o.order_no,
    exchange_code: o.exchange_code,
    product_public_id: o.product_public_id,
    product_title: o.product_title,
    points_units: o.points_units,
    status: o.status,
    verified_at: o.verified_at,
    created_at: o.created_at,
    updated_at: o.updated_at,
    user_public_id: o.user_public_id,
    verified_by_public_id: o.verified_by_public_id,
  };
}

// GET /admin/orders —— 本团订单列表（TEAM；mall.order.verify）
mall.get('/admin/orders', requirePermission('mall.order.verify'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const pg = parsePagination(c.req.query());
  const status = parseAdminStatusFilter(c.req.query('status'));

  const repo = new MallAdminRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const rows = await repo.listTeamOrders(pg.pageSize, pg.offset, status);
  const total = await repo.countTeamOrders(status);

  const data: Paginated<ReturnType<typeof toAdminListItem>> = {
    items: rows.map(toAdminListItem),
    pagination: {
      page: pg.page,
      page_size: pg.pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pg.pageSize)),
    },
  };
  return ok(c, data);
});

// GET /admin/orders/:orderNo —— 本团订单详情（TEAM；404 防枚举）
mall.get('/admin/orders/:orderNo', requirePermission('mall.order.verify'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const orderNo = requireUlidParam(c.req.param('orderNo'), 'orderNo');
  const repo = new MallAdminRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const order = await repo.getTeamOrder(orderNo);
  // 跨团队 / 不存在统一 404，不区分，避免存在性枚举。
  if (order == null) throw notFound('Order');
  return ok(c, toAdminDetail(order));
});

// POST /admin/orders/verify —— 按兑换码核销（TEAM；幂等）
mall.post('/admin/orders/verify', requirePermission('mall.order.verify'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  // 只读取 exchange_code；归一化 / SQL / 分类全部由 MallVerificationService 负责，
  // 路由不重复实现，也不二次翻译其 AppError（400 非法 / 404 不存在·跨团队 / 409 RESERVED）。
  const raw = await c.req.json().catch(() => null);
  const body =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const svc = new MallVerificationService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const outcome = await svc.verifyExchangeCode(body['exchange_code']);

  // 首次核销与重复核销均为 200，靠 body.status 区分（不靠 HTTP status）。
  return ok(c, { status: outcome.status, order: toAdminDetail(outcome.order) }, 200);
});

export default mall;
