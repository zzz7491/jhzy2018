/**
 * 统一响应 helper（S2-5）。
 *
 * 纪律（用户 §七）：
 * - 成功：{ success:true, data, request_id }
 * - 失败：{ success:false, error:{ code, message, details? }, request_id }
 * - request_id 与响应头 X-Request-ID 严格一致（由 request-id middleware 保证）。
 */

import type { Context } from 'hono';
import type { ApiSuccess, ApiFailure } from '../types/api';
import type { AppError } from './errors';
import { internalError } from './errors';

/** 取当前请求 request id（request-id middleware 注入；异常兜底）。 */
function requestIdOf(c: Context): string {
  return c.get('requestId') ?? 'unassigned';
}

/** 统一成功响应。 */
export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  const body: ApiSuccess<T> = { success: true, data, request_id: requestIdOf(c) };
  return c.json(body, status);
}

/**
 * 统一失败响应。
 * - AppError → 使用其 code/status/message/details。
 * - 其他未知异常 → 一律折叠为 500 INTERNAL_ERROR（不泄露任何内部信息）。
 */
export function fail(c: Context, err: unknown): Response {
  const appErr: AppError =
    err instanceof Error && (err as AppError).code != null && (err as AppError).status != null
      ? (err as AppError)
      : internalError();
  const body: ApiFailure = {
    success: false,
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details ? { details: appErr.details } : {}),
    },
    request_id: requestIdOf(c),
  };
  // S2-6g：状态集合纳入 409（业务状态冲突）；
  // P36-C3-2：纳入 429（AI best-effort 成本护栏限流）；
  // P36-C3-3：纳入 503（AI 不可用，provider/config/timeout 统一折叠）；
  // 其余维持既有折叠策略。
  return c.json(body, appErr.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503);
}
