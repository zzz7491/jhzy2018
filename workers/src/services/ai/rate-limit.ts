/**
 * 嘉禾 AI V1 —— runtime rate-limit foundation（P36-C3-1）。
 *
 * 语义（冻结 P36-C1 config contract + P36-C3A 设计 §11/§12/§13/§14）：
 * - `AI_RATE_LIMIT_TYPE = BEST_EFFORT_COST_GUARD`。
 *   这是成本护栏，**不是** 严格并发 quota，**不是** concurrency-safe limiter。
 * - 数据源**唯一**：`ai_usage_logs`（只读）。统计维度**仅 user_id**（不加 team dimension）。
 * - 窗口：per-minute（created_at >= now - 60）/ per-day（created_at >= now - 86400）。
 * - **不写 usage**、**不 reserve quota**、**不锁**、**不**引入 KV / Durable Object / Redis / quota table。
 * - 并发事实（已接受 V1 限制）：两个并发请求可以同时 COUNT 并同时通过（race 存在）。
 *
 * 用量口径：当前 `ai_usage_logs` 只在 provider **成功**路径写入（P36-C2），
 * 因此 limiter 只能依据现有成功 usage rows 计数。
 * `ai_usage_logs.status` 数值语义仍 = UNDEFINED（本模块不定义），
 * `FAILED_USAGE_ACCOUNTING = DEFERRED`（不写失败 usage、不 migration）。
 *
 * 本模块**不依赖 HTTP**：返回 domain result（allowed / limited + retryAfterSeconds），
 * 由未来 route/service 决定「limited → providerCalls = 0」。本轮不新增 429 ErrorCode。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../../types/auth';
import { authRequired } from '../../utils/errors';

/** 冻结语义标识（供测试 contract / 报告引用）。 */
export const AI_RATE_LIMIT_TYPE = 'BEST_EFFORT_COST_GUARD' as const;
/** 严格并发配额：否。 */
export const AI_RATE_LIMIT_STRICT_CONCURRENCY = false as const;
/** 统计维度：仅 user。 */
export const AI_RATE_LIMIT_DIMENSION = 'user' as const;
/** 窗口长度（秒）。 */
export const AI_RATE_LIMIT_MINUTE_WINDOW_SECONDS = 60;
export const AI_RATE_LIMIT_DAY_WINDOW_SECONDS = 86_400;
/** 失败用量口径仍待定（不在此定义 status 语义、不写失败 usage、不 migration）。 */
export const RATE_LIMIT_FAILED_USAGE_ACCOUNTING = 'DEFERRED' as const;

export type AIRateLimitWindow = 'minute' | 'day';

/** 领域级限流判决（non-HTTP）。 */
export type AIRateLimitDecision =
  | { allowed: true }
  | { allowed: false; limited: AIRateLimitWindow; retryAfterSeconds: number };

export interface AIRateLimitLimits {
  /** 每分钟上限（来自 resolveAIConfig：AI_RL_PER_MIN）。 */
  rateLimitPerMin: number;
  /** 每日上限（来自 resolveAIConfig：AI_RL_PER_DAY）。 */
  rateLimitPerDay: number;
}

export interface AIRateLimitDeps {
  db: D1Database;
  auth: AuthContext;
}

interface WindowCount {
  count: number;
  oldest: number | null;
}

/**
 * 计算建议 retry 间隔（保守但精确）：
 * 为了让最早一条窗口内记录滚出窗口，需等待 (oldest + window) - now，最少 1 秒。
 */
function retryAfterSeconds(oldest: number | null, windowSeconds: number, now: number): number {
  if (oldest == null || !Number.isFinite(oldest)) return windowSeconds;
  return Math.max(1, oldest + windowSeconds - now);
}

export class AIRateLimitService {
  constructor(private readonly deps: AIRateLimitDeps) {}

  /** 单窗口计数（只读 ai_usage_logs；仅 user 维度）。 */
  private async countWindow(userId: number, since: number): Promise<WindowCount> {
    const row = await this.deps.db
      .prepare(
        `SELECT COUNT(*) AS c, MIN(created_at) AS oldest
           FROM ai_usage_logs
          WHERE user_id = ? AND created_at >= ?`,
      )
      .bind(userId, since)
      .first<{ c: number; oldest: number | null }>();
    return { count: row?.c ?? 0, oldest: row?.oldest ?? null };
  }

  /**
   * best-effort 判决。
   * 顺序：先 per-minute，再 per-day；命中任一即返回 limited（不做 provider 调用）。
   * 无认证用户 → authRequired()（防御；pipeline 本应在更前拒绝）。
   */
  async evaluate(limits: AIRateLimitLimits): Promise<AIRateLimitDecision> {
    const userId = this.deps.auth.userId;
    if (userId == null) throw authRequired();

    const now = Math.floor(Date.now() / 1000);

    const minute = await this.countWindow(userId, now - AI_RATE_LIMIT_MINUTE_WINDOW_SECONDS);
    if (minute.count >= limits.rateLimitPerMin) {
      return {
        allowed: false,
        limited: 'minute',
        retryAfterSeconds: retryAfterSeconds(minute.oldest, AI_RATE_LIMIT_MINUTE_WINDOW_SECONDS, now),
      };
    }

    const day = await this.countWindow(userId, now - AI_RATE_LIMIT_DAY_WINDOW_SECONDS);
    if (day.count >= limits.rateLimitPerDay) {
      return {
        allowed: false,
        limited: 'day',
        retryAfterSeconds: retryAfterSeconds(day.oldest, AI_RATE_LIMIT_DAY_WINDOW_SECONDS, now),
      };
    }

    return { allowed: true };
  }
}
