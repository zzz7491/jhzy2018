/**
 * 嘉禾 AI V1 统一配置（P36-C1）。
 *
 * 定位（冻结，见 P36-B §5/§6/§7/§10）：
 * - **Provider-neutral**：本模块不绑定任何供应商；provider / model / baseUrl 全部来自 server config。
 * - **Secret 隔离**：AI_API_KEY 只从 Workers Secret 读取；本模块【绝不】打印 / 返回给 API 响应 /
 *   写日志 / 写库。仅在与 adapter 之间内存传递。
 * - **安全默认 + 钳制**：缺失 / 非法配置一律回落 IMPLEMENTATION DEFAULT（不抛错、不阻塞启动），
 *   数值配置受上下界钳制。
 * - **不伪造生产配置**：未配置 model / baseUrl / apiKey 时，configured=false；
 *   本模块【不】内置任何供应商端点或模型名作默认值。
 *
 * 纪律：所有 AI 配置只能从这里取，禁止在 service / route 中散落硬编码。
 */

import type { Env } from '../env';

/** IMPLEMENTATION DEFAULT（非永久业务规则）。 */
export const AI_DEFAULTS = {
  /** 协议族名称（非供应商）；V1 唯一 adapter 实现标准 HTTP chat-completions 契约。 */
  provider: 'http-chat',
  /** 未配置 AI_BASE_URL 时为空 → configured=false（不内置任何供应商端点）。 */
  baseUrl: '',
  /** 未配置 AI_MODEL 时为空 → configured=false（不内置任何供应商模型名）。 */
  model: '',
  timeoutMs: 30_000,
  maxOutputTokens: 1024,
  rateLimitPerMin: 10,
  rateLimitPerDay: 200,
} as const;

/** 超时上下界（毫秒）。 */
export const AI_TIMEOUT_MS_MIN = 1_000;
export const AI_TIMEOUT_MS_MAX = 120_000;
/** 输出 token 上下界。 */
export const AI_MAX_OUTPUT_TOKENS_MIN = 1;
export const AI_MAX_OUTPUT_TOKENS_MAX = 8_192;
/** 频率阈值上下界（次）。 */
export const AI_RATE_LIMIT_MIN = 1;
export const AI_RATE_LIMIT_MAX = 100_000;

/**
 * 解析后的 AI 配置。
 * ⚠ apiKey 属于敏感字段：仅允许传给 adapter；绝不记录 / 返回 / 落库。
 */
export interface AIConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 是否具备发起真实调用的最小配置（provider/model/baseUrl/apiKey 均非空）。 */
  configured: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  rateLimitPerMin: number;
  rateLimitPerDay: number;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const v = Math.floor(n);
  if (v < min || v > max) return fallback;
  return v;
}

function nonEmpty(raw: string | undefined): string {
  return raw == null ? '' : raw.trim();
}

/** 解析 AI 配置（唯一入口）。绝不抛出；缺省/非法即回落安全默认。 */
export function resolveAIConfig(env: Env): AIConfig {
  const provider = nonEmpty(env.AI_PROVIDER) || AI_DEFAULTS.provider;
  const model = nonEmpty(env.AI_MODEL);
  const baseUrl = nonEmpty(env.AI_BASE_URL);
  const apiKey = nonEmpty(env.AI_API_KEY);
  return {
    provider,
    model,
    baseUrl,
    apiKey,
    configured: provider !== '' && model !== '' && baseUrl !== '' && apiKey !== '',
    timeoutMs: clampInt(env.AI_TIMEOUT_MS, AI_DEFAULTS.timeoutMs, AI_TIMEOUT_MS_MIN, AI_TIMEOUT_MS_MAX),
    maxOutputTokens: clampInt(
      env.AI_MAX_OUTPUT_TOKENS,
      AI_DEFAULTS.maxOutputTokens,
      AI_MAX_OUTPUT_TOKENS_MIN,
      AI_MAX_OUTPUT_TOKENS_MAX,
    ),
    rateLimitPerMin: clampInt(env.AI_RL_PER_MIN, AI_DEFAULTS.rateLimitPerMin, AI_RATE_LIMIT_MIN, AI_RATE_LIMIT_MAX),
    rateLimitPerDay: clampInt(env.AI_RL_PER_DAY, AI_DEFAULTS.rateLimitPerDay, AI_RATE_LIMIT_MIN, AI_RATE_LIMIT_MAX),
  };
}

/**
 * 频率限制语义冻结（P36-B §10 / 任务 §10）：
 * 未来基于 ai_usage_logs 的 COUNT 是 **BEST_EFFORT_COST_GUARD**，不是严格并发 quota。
 * P36-C1 只建立 config contract，不实现 runtime limiter（429 runtime 留 P36-C3）。
 */
export const AI_RATE_LIMIT_SEMANTICS = 'BEST_EFFORT_COST_GUARD' as const;
