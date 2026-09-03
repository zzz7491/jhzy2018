/**
 * 管理端 Session Cookie 构造 / 解析（S2-6c-3）。
 *
 * 冻结属性（指令 §四 / S2-6B ADR）：
 *   __Host-session=<token>; HttpOnly; Secure; Path=/; SameSite=Lax【无 Domain】
 * - __Host- 前缀要求：Secure + Path=/ + 无 Domain（三者缺一浏览器即丢弃），此处严格满足。
 * - Max-Age 必须与服务端 sessions.expires_at 同源 TTL 一致；
 *   但【Cookie 不是权威状态】—— D1 sessions 行才是权威，撤销后即使 Cookie 仍在也一律 401。
 */

/** 管理端会话 Cookie 名（__Host- 前缀）。 */
export const SESSION_COOKIE_NAME = '__Host-session';

/** 属性片段（HttpOnly / Secure / Path=/ / SameSite=Lax / 无 Domain）。 */
const ATTRS = 'HttpOnly; Secure; Path=/; SameSite=Lax';

/** 签发 Cookie：Max-Age 由调用方传入（必须与服务端 TTL 同源）。 */
export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${SESSION_COOKIE_NAME}=${token}; ${ATTRS}; Max-Age=${maxAge}`;
}

/** 清除 Cookie（登出 / 全端下线）：同名 + 立即过期 + 同属性，确保浏览器覆盖旧值。 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${ATTRS}; Max-Age=0`;
}

/** 从 Cookie 请求头中读取会话 token（仅取值，不做任何校验）。 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (cookieHeader == null) return null;
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([A-Za-z0-9_-]+)`).exec(cookieHeader);
  return m ? m[1] : null;
}

/** 请求头中是否存在会话 Cookie（CSRF 判定用，不取 token 值）。 */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return readSessionCookie(cookieHeader) != null;
}
