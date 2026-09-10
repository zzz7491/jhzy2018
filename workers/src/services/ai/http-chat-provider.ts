/**
 * 最小 provider adapter（P36-C1）——实现 provider-neutral 接口。
 *
 * 设计（冻结，见 P36-B §5/§6/§7）：
 * - 走**标准 HTTP chat-completions 契约**（POST {baseUrl}/chat/completions），
 *   【不】引入任何供应商 SDK、不在业务层硬编码任何 provider / model / 端点。
 * - endpoint / model / key 一律来自 server config（构造参数）。
 * - key 只在内存中用于 Authorization 头；绝不返回调用方 / 绝不记录。
 * - 上游错误 / 超时统一归一化为 AIProviderError（不携带上游原始 body）。
 * - 通过注入 fetchImpl 可被单元测试 mock（本阶段不调用任何真实外部 AI API）。
 */

import {
  AIProviderError,
  type AICompletionRequest,
  type AICompletionResult,
  type AIFinishReason,
  type AIProvider,
} from './provider';

/** 可注入的 fetch（默认使用运行时全局 fetch；测试注入 mock）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** adapter 配置：全部来自 server config。 */
export interface HttpChatProviderConfig {
  /** provider 名称（执行记录用，来自 config；非供应商硬编码）。 */
  name: string;
  /** 端点基址（来自 config；业务代码不写死任何供应商 URL）。 */
  baseUrl: string;
  /** 凭证（来自 Workers Secret；绝不外泄）。 */
  apiKey: string;
  /** 模型名（来自 config）。 */
  model: string;
}

/** 默认采样温度（服务端固定；客户端不可传入）。 */
const DEFAULT_TEMPERATURE = 0.2;

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeFinishReason(raw: unknown): AIFinishReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  return 'error';
}

export class HttpChatProvider implements AIProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: HttpChatProviderConfig, fetchImpl?: FetchLike) {
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    if (!this.baseUrl) throw new AIProviderError('config_error', 'AI base URL not configured');
    if (!this.apiKey) throw new AIProviderError('config_error', 'AI credential not configured');
    if (!this.model) throw new AIProviderError('config_error', 'AI model not configured');
  }

  /** 端点：{baseUrl}/chat/completions（标准 HTTP chat-completions 契约）。 */
  private endpoint(): string {
    return this.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: req.maxOutputTokens,
      stream: false,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const startedAt = Date.now();

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // 归一化：超时 vs 其它传输错误（绝不透出上游细节 / 密钥）。
      if (isAbortError(err)) throw new AIProviderError('timeout', 'AI provider timed out');
      throw new AIProviderError('provider_error', 'AI provider request failed');
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      throw new AIProviderError('provider_error', 'AI provider returned an error', res.status);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new AIProviderError('provider_error', 'AI provider returned a malformed response');
    }

    return this.parse(payload, latencyMs);
  }

  private parse(payload: unknown, latencyMs: number): AICompletionResult {
    const p = payload as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;

    const choice = p?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string') {
      throw new AIProviderError('provider_error', 'AI provider response missing content');
    }

    return {
      text,
      provider: this.name,
      model: this.model,
      promptTokens: toInt(p?.usage?.prompt_tokens),
      completionTokens: toInt(p?.usage?.completion_tokens),
      latencyMs,
      finishReason: normalizeFinishReason(choice?.finish_reason),
    };
  }
}
