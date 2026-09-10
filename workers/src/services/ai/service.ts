/**
 * 嘉禾 AI V1 —— 后端服务（P36-C2 §8/§9/§12）。
 *
 * 职责（provider-neutral）：
 *   validate input → build authorized context → 构造 versioned prompt
 *   → 调用 AIProvider.complete() → 写 usage（成功路径）→ 返回安全结果。
 *
 * 硬规则：
 * - 业务层只依赖 `AIProvider`（provider-neutral）；不 import 任何供应商 SDK。
 * - 只读 / 解释 / 建议：**绝不**变更任何权威业务状态（无 INSERT/UPDATE/DELETE 业务表）。
 * - 返回值**不含** raw context / system prompt / internal numeric id / API key / raw provider 响应。
 * - provider 错误已由 adapter 归一化为 `AIProviderError`（config_error / timeout / provider_error）；
 *   本服务不追加原始上游 body。
 * - 产品级边界（P36-C2B 冻结）：嘉禾 AI V1 要求 **active team**（JIAHE_AI_V1_TEAM_CONTEXT =
 *   ACTIVE_TEAM_REQUIRED）；`auth.teamId == null` → 入口即抛 `teamScopeRequired()`，绝不先调用 provider。
 *
 * 本阶段**不**建立 conversation repository / HTTP route（P36-C3）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../../env';
import type { AuthContext } from '../../types/auth';
import type { TenantContext } from '../../types/tenant';
import { AIContextRepository } from '../../repository/ai-context';
import { resolveAIConfig, type AIConfig } from '../../config/ai';
import { createAIProvider } from './factory';
import { AIProviderError, type AICompletionMessage, type AIProvider, type AIProviderErrorKind } from './provider';
import type { FetchLike } from './http-chat-provider';
import { buildVolunteerAssistContext, type AIContextSourceLabel } from './data-block';
import { assertNoClientControlFields, normalizeHistory, normalizeUserInput } from './input';
import { AIUsageRepository } from './usage';
import { teamScopeRequired } from '../../utils/errors';
import {
  VOLUNTEER_ASSIST_SYSTEM_PROMPT,
  VOLUNTEER_ASSIST_PROMPT_VERSION,
} from './prompts/volunteer-assist.v1';

export interface AIBackendDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env: Env;
  /** 可注入 fetch（测试 mock）；缺省使用运行时全局 fetch。 */
  fetchImpl?: FetchLike;
}

/** 客户端调用输入：只允许 message + history；其余控制面字段一律拒绝。 */
export interface AIAssistInput {
  message?: unknown;
  history?: unknown;
  [key: string]: unknown;
}

/** 安全输出：不含 raw context / system prompt / internal id / 凭证。 */
export interface AIAssistResult {
  text: string;
  provider: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  };
  sourceLabels: AIContextSourceLabel[];
  promptVersion: string;
}

/**
 * 服务边界的安全错误文案（§9）：provider 失败仅按 kind 折叠为通用消息，
 * 绝不把上游原始 body / 端点细节 / 凭证透给上层。
 */
const SAFE_PROVIDER_ERROR_MESSAGES: Readonly<Record<AIProviderErrorKind, string>> = {
  config_error: 'AI provider is not configured',
  timeout: 'AI provider request timed out',
  provider_error: 'AI provider request failed',
};

export class AIBackendService {
  private readonly deps: AIBackendDeps;
  private readonly cfg: AIConfig;
  private readonly provider: AIProvider;

  constructor(deps: AIBackendDeps, provider?: AIProvider) {
    this.deps = deps;
    this.cfg = resolveAIConfig(deps.env);
    this.provider = provider ?? createAIProvider(deps.env, deps.fetchImpl);
  }

  async assist(rawInput: AIAssistInput): Promise<AIAssistResult> {
    // 0) 产品级边界（P36-C2B 冻结）：JIAHE_AI_V1_TEAM_CONTEXT = ACTIVE_TEAM_REQUIRED。
    //    无 active team → 立即拒绝，**绝不先调用 provider 再失败**（成本安全）。
    //    必须发生在 context 构造 / 任何 repository 查询 / provider.complete() / usage logging 之前。
    //    注意：即使 points/growth 属 USER_SCOPED，V1 也不允许无 team 的 SELF-only AI 模式
    //    ——这是产品级边界，不改变 USER_SCOPED 数据读取能力本身，也不改 TABLE_SCOPE/schema。
    if (this.deps.auth.teamId == null) throw teamScopeRequired();

    // 1) 输入规范（拒绝 client 控制面字段 / system role / 空 / 超长 / 越界历史）
    assertNoClientControlFields(rawInput);
    const message = normalizeUserInput(rawInput?.message);
    const history = normalizeHistory(rawInput?.history);

    // 2) 服务端确定性构造授权上下文（只读、最小投影、逐行 privacy guard）
    const repoCtx = { auth: this.deps.auth, tenant: this.deps.tenant };
    const ctxResult = await buildVolunteerAssistContext(
      new AIContextRepository({ db: this.deps.db, ctx: repoCtx }),
    );

    // 3) 组装 messages：历史（sanitized）+ 本轮「DATA 块 + 用户问题」
    const messages: AICompletionMessage[] = [
      ...history,
      { role: 'user', content: `${ctxResult.dataBlock}\n\n【用户问题】\n${message}` },
    ];

    // 4) 调用 provider（错误已归一化；不追加原始上游 body）
    let result;
    try {
      result = await this.provider.complete({
        system: VOLUNTEER_ASSIST_SYSTEM_PROMPT,
        messages,
        maxOutputTokens: this.cfg.maxOutputTokens,
        timeoutMs: this.cfg.timeoutMs,
      });
    } catch (err) {
      // §9：无论 adapter 抛什么，服务边界一律**折叠为通用错误**——只保留 kind（+ 可选 status），
      // 丢弃可能携带上游 body / 凭证 / 端点细节的原始 message。
      const kind: AIProviderErrorKind = err instanceof AIProviderError ? err.kind : 'provider_error';
      const status = err instanceof AIProviderError ? err.status : undefined;
      throw new AIProviderError(kind, SAFE_PROVIDER_ERROR_MESSAGES[kind], status);
    }

    // 5) usage 记录（仅成功路径；失败路径 = DEFERRED，见 usage.ts）
    await new AIUsageRepository({ db: this.deps.db, ctx: repoCtx }).recordSuccess({
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    });

    // 6) 安全输出（显式构造，绝不透出 raw context / prompt / id / key）
    return {
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
      },
      sourceLabels: ctxResult.sourceLabels,
      promptVersion: VOLUNTEER_ASSIST_PROMPT_VERSION,
    };
  }
}
