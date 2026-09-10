/**
 * AI provider 工厂（P36-C1）。
 *
 * 唯一的「配置 → adapter」装配入口：
 * - 从 server config 解析 provider / model / baseUrl / 凭证（凭证来自 Secret）。
 * - V1 只有一个 adapter（HttpChatProvider，标准 HTTP chat-completions 契约）。
 * - fetchImpl 可注入，便于单元测试 mock；生产默认使用运行时全局 fetch。
 *
 * 业务代码不得绕过本工厂直接 new adapter / 直接调用供应商 SDK。
 */

import type { Env } from '../../env';
import { resolveAIConfig } from '../../config/ai';
import { HttpChatProvider, type FetchLike } from './http-chat-provider';
import type { AIProvider } from './provider';

/** 依据 server config 创建 provider（配置缺失 → HttpChatProvider 抛 config_error）。 */
export function createAIProvider(env: Env, fetchImpl?: FetchLike): AIProvider {
  const cfg = resolveAIConfig(env);
  return new HttpChatProvider(
    {
      name: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    },
    fetchImpl,
  );
}
