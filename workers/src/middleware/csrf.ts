/**
 * 管理端 CSRF 防护（S2-6c-3，指令 §五）。
 *
 * 采用方案：**Origin 校验 + 自定义请求头**（不是 Double Submit Cookie）。
 * 不采用 Double Submit Cookie 的理由（指令给定，此处记录）：
 *   - 已有 HttpOnly `__Host-session`，再加一个可读的 CSRF Cookie 会扩大状态复杂度；
 *   - 管理端 API 全部由我方控制，Origin + 自定义 Header 双条件即可覆盖浏览器跨站场景；
 *   - 自定义 Header 天然阻断 HTML 表单类跨站请求（表单无法设置自定义头）。
 *
 * 规则：
 * 1) 仅对【Cookie 认证】的【状态改变】请求生效（POST/PUT/PATCH/DELETE...）；
 * 2) GET/HEAD/OPTIONS 等安全方法不要求（无副作用）；
 * 3) Bearer Token 的微信小程序请求【不套】浏览器 Cookie CSRF 模型（小程序无 Cookie 自动携带）；
 * 4) 必须同时满足：Origin ∈ 管理端 allowlist，且 X-JHZY-CSRF: 1；
 * 5) Origin 缺失一律拒绝（不回落 Referer —— Referer 可被 stripping，属弱校验）；
 * 6) allowlist 未配置（生产）→ 空列表 → 全部拒绝（fail-closed）。
 */

import { createMiddleware } from 'hono/factory';
import type { AppVars, Env } from '../env';
import { csrfFailed } from '../utils/errors';
import { hasSessionCookie } from '../utils/session-cookie';

/** 自定义 CSRF 请求头（浏览器跨站表单 / 简单请求无法设置）。 */
export const CSRF_HEADER_NAME = 'x-jhzy-csrf';

/** 期望的自定义头值。 */
export const CSRF_HEADER_EXPECTED = '1';

/** 安全方法（无副作用，不校验）。 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** local 明确 allowlist（指令：本地/测试环境使用明确 local allowlist，不写死生产域名）。 */
const LOCAL_ALLOWED_ORIGINS: readonly string[] = ['http://127.0.0.1:8787', 'http://localhost:8787'];

/** 管理端允许的 Origin 列表；未配置时 local 用本地清单，其它环境为空（fail-closed）。 */
export function adminAllowedOrigins(env: Env): string[] {
  const raw = env.ADMIN_ALLOWED_ORIGINS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return (env.ENVIRONMENT ?? 'local') === 'local' ? [...LOCAL_ALLOWED_ORIGINS] : [];
}

/**
 * CSRF 守卫中间件。
 * 挂载位置：/api/v2/* 全局（S2-6c-3）。未携带会话 Cookie 的请求零成本透传。
 */
export const csrfGuardMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVars }>(
  async (c, next) => {
    // ① 安全方法不校验。
    if (SAFE_METHODS.has(c.req.method)) return next();

    // ② 仅 Cookie 认证请求进入 CSRF 模型；Bearer / x-session-token 走小程序通道，不适用。
    if (c.req.header('authorization') != null) return next();
    if (c.req.header('x-session-token') != null) return next();
    if (!hasSessionCookie(c.req.header('cookie'))) return next();

    // ③ 自定义头（阻断表单类跨站）。
    if (c.req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_EXPECTED) throw csrfFailed();

    // ④ Origin 校验（缺失即拒绝；不使用 Referer 回落）。
    const origin = c.req.header('origin');
    if (origin == null) throw csrfFailed();
    const allowed = adminAllowedOrigins(c.env);
    if (allowed.length === 0 || !allowed.includes(origin)) throw csrfFailed();

    return next();
  },
);
