// utils/transport.ts
// P2-B 统一 Transport —— Header Builder + Error Pipeline + 请求核心。
//
// 纪律（P2-B Authentication & Transport Consolidation）：
// - 唯一 Header Builder：buildHeaders()。所有 API wrapper 禁止各自拼 Header。
// - 唯一 Error Pipeline：toApiError()。HTTP / 业务 / 网络失败一律归一为 ApiError。
// - 唯一请求核心：send()。成功信封 {success:true,data} 解包 → data；失败信封
//   {success:false,error:{code,message,details}} → ApiError。
// - 本模块不做令牌「家族」选择，也不做团队作用域策略；由调用方通过 opts 传入。
//   （团队作用域实际取值统一来自 session.getActiveTeamId()。）

import { getActiveTeamId } from './session';

/** 统一 API 错误形状（全 wrapper 共用）。 */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface HeaderOptions {
  /** Bearer 令牌；空则不加 Authorization 头。 */
  token?: string;
  /** 是否注入 X-Team-Id（team-scoped 端点）。默认 false。 */
  teamScoped?: boolean;
  /** 覆盖 Content-Type。默认 application/json。 */
  contentType?: string;
}

/**
 * 唯一 Header Builder。
 * Content-Type（默认 application/json）+ Authorization(Bearer) + X-Team-Id（teamScoped 时）。
 */
export function buildHeaders(opts: HeaderOptions = {}): Record<string, string> {
  const header: Record<string, string> = {};
  // contentType === '' → 不设 Content-Type（uploadFile/downloadFile 由运行时决定 multipart）。
  if (opts.contentType !== '') header['Content-Type'] = opts.contentType || 'application/json';
  if (opts.token) header['Authorization'] = `Bearer ${opts.token}`;
  if (opts.teamScoped) {
    const teamId = getActiveTeamId();
    if (teamId) header['X-Team-Id'] = teamId;
  }
  return header;
}

export interface ErrorOptions {
  /** 非网络错误的默认 message。默认「请求失败」。 */
  fallbackMessage?: string;
  /** 网络失败时的默认 code。默认 ''（部分 wrapper 使用 'NETWORK'）。 */
  networkCode?: string;
}

/**
 * 唯一 Error Pipeline。
 * 解析失败信封（含 string body），归一为 ApiError；网络失败置 isNetwork=true。
 */
export function toApiError(status: number, raw: any, isNetwork: boolean, opts: ErrorOptions = {}): ApiError {
  let body: any = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
  }
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : isNetwork ? opts.networkCode || '' : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : opts.fallbackMessage || '请求失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

export interface SendOptions extends HeaderOptions {
  errorOptions?: ErrorOptions;
}

/**
 * 唯一请求核心。
 * - 2xx：解包成功信封（body.data 优先，否则 body 原样）。
 * - 非 2xx：reject(toApiError(status, body, false))。
 * - 网络失败：reject(toApiError(0, null, true))。
 */
export function send<T>(method: string, url: string, data?: any, opts: SendOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url,
      method: method as any,
      data,
      header: buildHeaders(opts),
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        const body = res.data;
        if (statusCode >= 200 && statusCode < 300) {
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          reject(toApiError(statusCode, body, false, opts.errorOptions));
        }
      },
      fail: () => {
        reject(toApiError(0, null, true, opts.errorOptions));
      },
    });
  });
}

export default { buildHeaders, toApiError, send };
