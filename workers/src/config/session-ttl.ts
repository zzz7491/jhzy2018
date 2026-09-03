/**
 * Session TTL 统一配置（S2-6c-3）。
 *
 * 用户裁决（指令 §四）：
 * - 小程序 Session：30 天
 * - 管理端 Session：12 小时
 * 二者均标记为 **IMPLEMENTATION DEFAULT**，不是永久不可修改的业务规则。
 *
 * 纪律：
 * - 所有 TTL 只能从这里取，禁止在 service / route 中散落硬编码。
 * - 允许通过 Worker 绑定覆盖（SESSION_TTL_MINIPROGRAM_SECONDS / SESSION_TTL_ADMIN_SECONDS），
 *   但受安全上下界钳制：下界 60s（防误配成"永不过期之外的无效短值"），上界 30d（防无限会话）。
 * - 非法 / 缺失 / 非数字配置一律回落到默认值（不抛错、不阻塞启动）。
 */

import type { Env } from '../env';

/** 通道标识：mini = 小程序 Bearer；admin = 管理端 __Host-session Cookie。 */
export type SessionChannel = 'miniprogram' | 'admin';

/** IMPLEMENTATION DEFAULT：小程序 30 天。 */
export const SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS = 30 * 24 * 3600;

/** IMPLEMENTATION DEFAULT：管理端 12 小时。 */
export const SESSION_TTL_ADMIN_DEFAULT_SECONDS = 12 * 3600;

/** TTL 下界（秒）：低于此值视为配置错误，回落默认。 */
export const SESSION_TTL_MIN_SECONDS = 60;

/** TTL 上界（秒）：30 天，超过此值视为配置错误，回落默认。禁止无限会话。 */
export const SESSION_TTL_MAX_SECONDS = 30 * 24 * 3600;

function clampTtl(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const v = Math.floor(n);
  if (v < SESSION_TTL_MIN_SECONDS || v > SESSION_TTL_MAX_SECONDS) return fallback;
  return v;
}

/** 小程序通道 TTL（秒）。 */
export function miniprogramTtlSeconds(env: Env): number {
  return clampTtl(env.SESSION_TTL_MINIPROGRAM_SECONDS, SESSION_TTL_MINIPROGRAM_DEFAULT_SECONDS);
}

/** 管理端通道 TTL（秒）。 */
export function adminTtlSeconds(env: Env): number {
  return clampTtl(env.SESSION_TTL_ADMIN_SECONDS, SESSION_TTL_ADMIN_DEFAULT_SECONDS);
}

/** 按通道取 TTL（唯一的 TTL 取值入口）。 */
export function sessionTtlSeconds(env: Env, channel: SessionChannel): number {
  return channel === 'admin' ? adminTtlSeconds(env) : miniprogramTtlSeconds(env);
}
