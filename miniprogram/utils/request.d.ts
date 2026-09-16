// utils/request.d.ts
// P3-B：为 legacy PHP transport（utils/request.js）补充类型声明。
//
// 纪律：
// - 只补类型，【不修改】utils/request.js 的任何运行时行为（拒绝契约 / Header / 过期处理均保持原样）。
// - request.js 为 CommonJS（module.exports = request），本声明用 export default 与之对齐，
//   配合 esModuleInterop 后 import jhzyRequest from './request' 语义不变。
// - 响应体由各 legacy PHP 端点自行决定，故以泛型 T 交由调用方声明（默认 unknown，避免隐式 any）。

export interface JhzyRequestOptions {
  /** 相对 https://api.jhzyfw.com/api/ 的端点文件名，例如 'login.php' */
  url: string;
  /** HTTP 方法，缺省 GET */
  method?: string;
  /** 请求体：query 字符串或普通对象 */
  data?: unknown;
  /** 自定义请求头（会覆盖统一 Header Builder 的同名项） */
  header?: Record<string, string>;
}

export interface JhzyRequest {
  <T = unknown>(options: JhzyRequestOptions): Promise<T>;
  get<T = unknown>(url: string, data?: unknown, options?: Partial<JhzyRequestOptions>): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, options?: Partial<JhzyRequestOptions>): Promise<T>;
  put<T = unknown>(url: string, data?: unknown, options?: Partial<JhzyRequestOptions>): Promise<T>;
  delete<T = unknown>(url: string, data?: unknown, options?: Partial<JhzyRequestOptions>): Promise<T>;
}

declare const request: JhzyRequest;

export default request;
