/**
 * Request ID middleware（S2-5）。
 *
 * 规则（用户 §八）：
 * - 客户端提供合法 X-Request-ID（8–64 位 [A-Za-z0-9_-]）时透传（安全处理：白名单字符 + 长度限制，
 *   防止 header 注入 / 日志伪造）。
 * - 否则 Worker 自动生成（req-<uuid>）。
 * - 响应头返回 X-Request-ID；错误响应体 request_id 与之严格一致（response helper 读取同一变量）。
 */

import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';

const SAFE_REQ_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function generateRequestId(): string {
  // Workers 运行时提供 crypto.randomUUID。
  return `req-${crypto.randomUUID()}`;
}

export function sanitizeRequestId(input: string | undefined): string | null {
  if (input != null && SAFE_REQ_ID_RE.test(input)) return input;
  return null;
}

export const requestIdMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVars }>(
  async (c, next) => {
    const id = sanitizeRequestId(c.req.header('x-request-id')) ?? generateRequestId();
    c.set('requestId', id);
    c.header('X-Request-ID', id);
    await next();
  },
);
