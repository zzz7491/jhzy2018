// utils/mallApi.ts
// 嘉禾志愿 2.0 商城前端统一客户端（P26-P1A）
// 仅对接 /api/v2/mall 后端；绝不调用 legacy PHP 端点。
// 不修改 legacy utils/request.js；Bearer 从本地存储读取（与 request.js 同范式）。

const MALL_API_BASE = 'https://api.jhzyfw.com/api/v2/mall';
// P27：个人积分账户/流水 SELF 端点（与 /mall 同主域、同 v2 前缀，仅 path 段不同）
const POINTS_API_BASE = 'https://api.jhzyfw.com/api/v2/points';

// Crockford Base32（排除 I L O U），用于 ULID / 领取码
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface MallApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

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
}

export interface CreateOrderResult {
  orderNo: string;
  exchangeCode: string | null;
}

export interface VerifyResult {
  status: 'verified' | 'already_verified';
  order: TeamOrderView;
}

// P27：个人积分账户投影（SELF，整数 units；缺失账户返回全零）
export interface PointsAccountSelfView {
  balance_units: number;
  total_earned_units: number;
  total_spent_units: number;
  total_debits_units: number;
  updated_at: number | null;
}

// P27：个人积分流水单条投影（SELF，整数 units；内部 id 不暴露）
export interface PointsTransactionSelfView {
  direction: number;
  amount_units: number;
  balance_after_units: number;
  type: string;
  source_type: string | null;
  source_public_id: string | null;
  remark: string | null;
  created_at: number;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function buildError(status: number, body: any, isNetwork: boolean): MallApiError {
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : '请求失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

function request<T>(method: string, path: string, data?: any, base: string = MALL_API_BASE): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) header['Authorization'] = `Bearer ${token}`;

    wx.request({
      url: base + path,
      method: method,
      data,
      header,
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        const body = res.data;
        if (statusCode >= 200 && statusCode < 300) {
          // 成功信封：{ success:true, data, request_id }
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message,details} }
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        // 网络层失败：结果未知，交由调用方决定是否保留 order_no 重试
        reject(buildError(0, null, true));
      },
    });
  });
}

export const mallApi = {
  getProducts(page = 1, pageSize = 20): Promise<Paginated<ProductView>> {
    return request<Paginated<ProductView>>('GET', `/products?page=${page}&page_size=${pageSize}`);
  },

  createOrder(productPublicId: string, orderNo: string): Promise<CreateOrderResult> {
    return request<CreateOrderResult>('POST', '/orders', {
      product_public_id: productPublicId,
      order_no: orderNo,
    });
  },

  getMyOrders(page = 1, pageSize = 10): Promise<Paginated<OrderListItem>> {
    return request<Paginated<OrderListItem>>('GET', `/orders?page=${page}&page_size=${pageSize}`);
  },

  getMyOrder(orderNo: string): Promise<OrderListItem> {
    return request<OrderListItem>('GET', `/orders/${orderNo}`);
  },

  adminListOrders(status?: number, page = 1, pageSize = 20): Promise<Paginated<TeamOrderView>> {
    let path = `/admin/orders?page=${page}&page_size=${pageSize}`;
    if (status === 1 || status === 2) path += `&status=${status}`;
    return request<Paginated<TeamOrderView>>('GET', path);
  },

  adminGetOrder(orderNo: string): Promise<TeamOrderView> {
    return request<TeamOrderView>('GET', `/admin/orders/${orderNo}`);
  },

  adminVerify(exchangeCode: string): Promise<VerifyResult> {
    return request<VerifyResult>('POST', '/admin/orders/verify', {
      exchange_code: exchangeCode,
    });
  },

  // P27：当前登录用户积分账户（SELF，permission points.account.read）
  getPointsAccount(): Promise<PointsAccountSelfView> {
    return request<PointsAccountSelfView>('GET', '/account', undefined, POINTS_API_BASE);
  },

  // P27：当前登录用户积分流水（SELF，分页，permission points.account.read）
  getPointsTransactions(page = 1, pageSize = 20): Promise<Paginated<PointsTransactionSelfView>> {
    return request<Paginated<PointsTransactionSelfView>>('GET', `/transactions?page=${page}&page_size=${pageSize}`, undefined, POINTS_API_BASE);
  },

  formatExchangeCode(raw: string | null | undefined): string {
    return formatExchangeCode(raw);
  },

  generateOrderNo(): string {
    return generateOrderNo();
  },

  // P27：积分展示统一 formatter（后端返回整数 units；预留改动点，未来若需 display points 转换仅改此处）
  formatPoints(units?: number | null): string {
    return formatPoints(units);
  },
};

// 领取码分组显示：12 位 raw Crockford → XXXX-XXXX-XXXX（不改原始码值，仅展示用）
export function formatExchangeCode(raw: string | null | undefined): string {
  if (!raw) return '';
  const clean = String(raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 12) return String(raw);
  return clean.replace(/(.{4})(?=.)/g, '$1-');
}

// 积分展示统一 formatter（P27）：后端返回整数 units，UI 统一以 units 原值展示为积分。
// 三处（账户 balance / 商品 points_price_units / 订单 points_units）均经此函数，禁止各自除/乘 100。
export function formatPoints(units?: number | null): string {
  const n = Number(units);
  if (!isFinite(n) || n < 0) return '0';
  return String(Math.round(n));
}

// 26 位 Crockford ULID：10 位时间戳 + 16 位随机（服务端以此作为幂等键）
export function generateOrderNo(): string {
  let t = Date.now();
  let timeStr = '';
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  timeStr = timeStr.padStart(10, '0');
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return timeStr + rand;
}
