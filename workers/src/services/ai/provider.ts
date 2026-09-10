/**
 * Provider-neutral AI 抽象（P36-C1）。
 *
 * 纪律（冻结）：
 * - 业务层只依赖本文件；本文件【不】import 任何单一供应商的 SDK / 供应商类型。
 * - 供应商名称 / 模型名 / 端点一律不在此声明（全部来自 server config）。
 * - provider / model 只是「执行记录」与「server config」，业务代码不得依赖具体模型名做分支。
 */

/** 归一化后的 provider 失败类型（绝不泄漏原始响应体 / 密钥 / 上游细节）。 */
export type AIProviderErrorKind = 'config_error' | 'timeout' | 'provider_error';

/**
 * 统一的 provider 错误。透出给上层前应折叠为通用 error（不携带上游 body）。
 * 仅保留 kind 与可选 HTTP status，便于日志分级与后续映射（映射到 API 错误属 P36-C3）。
 */
export class AIProviderError extends Error {
  readonly kind: AIProviderErrorKind;
  readonly status?: number;

  constructor(kind: AIProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AIProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/** 会话消息（仅 user / assistant；system 由 request.system 承载）。 */
export interface AICompletionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 统一输入：system prompt + messages + 生成参数。 */
export interface AICompletionRequest {
  /** 版本化 system prompt（见 services/ai/prompts/*）。 */
  system: string;
  messages: AICompletionMessage[];
  /** 服务端固定默认；客户端不可传入（见任务 §15 FRONTEND 非目标）。 */
  temperature?: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

/** 完成原因（归一化）。 */
export type AIFinishReason = 'stop' | 'length' | 'error';

/** 统一输出（至少含任务 §6 要求的字段）。 */
export interface AICompletionResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  finishReason: AIFinishReason;
}

/** provider 中立接口（V1：一个 adapter 实现之）。 */
export interface AIProvider {
  readonly name: string;
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
}
