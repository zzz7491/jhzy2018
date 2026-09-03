/**
 * 统一 API 响应 / 分页类型（S2-5）。
 *
 * 纪律（用户 §七 / §十八）：
 * - 所有 API 必须经 utils/response.ts 的统一 helper 输出。
 * - 分页默认值 / 上限为【IMPLEMENTATION DEFAULT】，不冒充业务规则；
 *   如后续设计文档给出业务定义，以设计文档为准。
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  request_id: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  /** 仅允许包含客户端输入相关的安全提示，禁止任何服务端内部信息。 */
  details?: Record<string, string>;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
  request_id: string;
}

/** 分页查询参数（已解析并 clamp）。 */
export interface PaginationQuery {
  page: number;
  pageSize: number;
  offset: number;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}

/**
 * 分页默认值 —— IMPLEMENTATION DEFAULT（非业务规则）。
 * maxPageSize=100：防止 page_size=999999999 类资源滥用。
 */
export const PAGINATION_DEFAULTS = {
  page: 1,
  pageSize: 20,
  maxPageSize: 100,
} as const;
