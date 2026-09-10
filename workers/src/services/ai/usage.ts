/**
 * 嘉禾 AI V1 —— 用量记录（P36-C2 §10 / §14）。
 *
 * 复用既有 `ai_usage_logs`（TEAM_SCOPED，TEAM_SCOPED 作用域由 BaseRepository guard 强制）。
 *
 * 语义纪律（冻结）：
 * - `ai_usage_logs.status` 的 **1/2/3 数值语义在既有 schema / legacy 源中【未定义】**
 *   （AI_USAGE_STATUS_EXISTING_SEMANTICS = UNDEFINED）。因此本模块**不自行发明**语义：
 *   成功路径写入时**省略 status 列**，交由 schema 既有 DEFAULT（1）决定。
 * - **错误 / 超时路径的用量记录 = DEFERRED_TO_SCHEMA_DECISION**（见 FAILED_USAGE_LOGGING）：
 *   在没有权威语义前，不为失败路径写入任何 status 值。
 * - `cost_estimate` 保持 NULL：无可靠 provider 计价 → **绝不虚构成本**。
 * - 绝不记录 API key / secret / 原始 provider 响应 / 隐私 PII。
 */

import { BaseRepository } from '../../repository/base';
import { teamScopeRequired } from '../../utils/errors';

/** 既有 status 语义未定义（取证结论，见任务 §14）。 */
export const AI_USAGE_STATUS_EXISTING_SEMANTICS = 'UNDEFINED' as const;

/** 失败路径用量记录的处置：待 schema 语义决策后再实现。 */
export const FAILED_USAGE_LOGGING = 'DEFERRED_TO_SCHEMA_DECISION' as const;

/** 一次成功的 provider 调用的用量记录输入（不含任何敏感信息）。 */
export interface AIUsageSuccessInput {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export class AIUsageRepository extends BaseRepository {
  /**
   * 记录一次**成功**的 provider 调用。
   * - 省略 status / cost_estimate → 使用 schema DEFAULT（status=1）与 NULL（不虚构成本）。
   * - 只写 ai_usage_logs（AI 遥测），**不是**业务状态变更。
   */
  async recordSuccess(input: AIUsageSuccessInput): Promise<void> {
    this.ensureTableRead('ai_usage_logs');
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();

    await this.run(
      `INSERT INTO ai_usage_logs
         (user_id, team_id, provider, model, prompt_tokens, completion_tokens, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        this.ctx.auth.userId,
        teamId,
        input.provider,
        input.model,
        input.promptTokens,
        input.completionTokens,
        input.latencyMs,
      ],
    );
  }
}
