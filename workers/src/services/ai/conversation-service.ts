/**
 * 嘉禾 AI V1 —— conversation orchestration service（P36-C3-2）。
 *
 * 这是 AI HTTP 层唯一的编排点：route **不得**自行串联 provider / repository / 限流。
 *
 * 冻结契约（P36-C3A 设计 + 本任务 §2/§4–§19）：
 * - AI_TEAM_CONTEXT = ACTIVE_TEAM_REQUIRED：无 active team → 403，**先于** provider / context / usage。
 * - AI_CLIENT_HISTORY = FORBIDDEN：history **只能**来自服务端 `ai_conversations.messages`；
 *   客户端提交 `history` 一律 400（strict body allowlist 只允许 `message`）。
 * - AI_PROVIDER_SELECTION / AI_MODEL_SELECTION = SERVER_ONLY；client 不可提交。
 * - AI_CONTEXT_REFRESH = EVERY_REQUEST_REBUILD：每轮都重建业务上下文（权威数据），
 *   AI_RAW_CONTEXT_STORAGE = FORBIDDEN（raw context 绝不落库）。
 * - AI_PUBLIC_PROVIDER_MODEL_VISIBILITY = HIDDEN：HTTP 响应不返回 provider / model。
 * - AI_TITLE_PROVIDER_CALLS = 0：title 由首条用户消息本地生成，不额外调用 provider。
 * - AI_RATE_LIMIT_TYPE = BEST_EFFORT_COST_GUARD：provider **之前**判决；limited → providerCalls = 0。
 * - AI_CONVERSATION_CAS = EXPECTED_STORED_MESSAGES：CAS stale → 409，**绝不**自动重试 provider。
 * - AI_USAGE_CONVERSATION_ATOMICITY = NOT_ATOMIC：usage 已写而持久化失败时不补偿删除、不重调 provider。
 * - AI_CAN_MUTATE_BUSINESS_STATE = NO：本服务只写 ai_conversations（usage 由 P36-C2 写）。
 *
 * 请求顺序（§4）：
 *   authentication → active team → permission(route) → strict body → ownership → rate limit
 *   → context(inside assist) → provider → usage logging → conversation persistence → safe projection
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../../env';
import type { AuthContext } from '../../types/auth';
import type { TenantContext } from '../../types/tenant';
import type { Paginated } from '../../types/api';
import {
  AIConversationRepository,
  type ConversationDetail,
  type ConversationListItem,
  type StoredConversationMessage,
} from '../../repository/ai-conversation';
import { generateUlid } from '../../utils/crypto';
import {
  aiRateLimited,
  aiUnavailable,
  authRequired,
  conflict,
  invalidParam,
  notFound,
  teamScopeRequired,
  ConflictReason,
  type AIUnavailableReason,
} from '../../utils/errors';
import { AIBackendService } from './service';
import { AIRateLimitService } from './rate-limit';
import { AIInputError, normalizeUserInput, AI_MAX_HISTORY_MESSAGES } from './input';
import type { AICompletionMessage, AIProvider, AIProviderErrorKind } from './provider';
import { AIProviderError } from './provider';
import type { FetchLike } from './http-chat-provider';
import { resolveAIConfig } from '../../config/ai';
import { isUlid } from '../../utils/validation';

/** AI 助手所需权限码（与 RBAC 冻结目录一致；route 层 requirePermission）。 */
export const AI_ASSIST_PERMISSION = 'ai.assist.use';

/** V1 唯一 capability（服务端固定；客户端不可提交）。 */
export const AI_CONVERSATION_SERVICE_CAPABILITY = 'volunteer_assist';

/** title 最大字符数（本地生成；AI_TITLE_PROVIDER_CALLS = 0）。 */
export const AI_TITLE_MAX_CHARS = 40;

/** 生成 title 所需的 provider 调用次数（冻结 0）。 */
export const AI_TITLE_PROVIDER_CALLS = 0;

/** 客户端 body 允许字段（strict allowlist；任何其它字段 → 400）。 */
export const AI_MESSAGE_BODY_ALLOWED_KEYS: readonly string[] = ['message'];

export interface AIConversationServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env: Env;
  /** 可注入 provider（测试 mock）；缺省使用 server config 工厂。 */
  provider?: AIProvider;
  /** 可注入 fetch（测试 mock）；缺省使用运行时全局 fetch。 */
  fetchImpl?: FetchLike;
}

/** 由首条用户消息本地生成 title：折叠空白 → trim → 截断。不调用 provider。 */
export function buildConversationTitle(message: string): string | null {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > AI_TITLE_MAX_CHARS ? collapsed.slice(0, AI_TITLE_MAX_CHARS) : collapsed;
}

/**
 * 从已存储消息推导送给 provider 的历史（SERVER HISTORY ONLY）。
 * - 只保留 user / assistant 角色；内容先 trim，空内容丢弃。
 * - 只取最后 AI_MAX_HISTORY_MESSAGES 条（PROVIDER_HISTORY_WINDOW）。
 * - **不删除任何存储消息**（STORED_HISTORY 不裁剪）。
 */
export function deriveServerHistory(stored: readonly StoredConversationMessage[]): AICompletionMessage[] {
  const out: AICompletionMessage[] = [];
  for (const m of stored) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (content === '') continue;
    out.push({ role: m.role, content });
  }
  return out.length > AI_MAX_HISTORY_MESSAGES ? out.slice(out.length - AI_MAX_HISTORY_MESSAGES) : out;
}

export class AIConversationService {
  private readonly deps: AIConversationServiceDeps;

  constructor(deps: AIConversationServiceDeps) {
    this.deps = deps;
  }

  private repo(): AIConversationRepository {
    return new AIConversationRepository({
      db: this.deps.db,
      ctx: { auth: this.deps.auth, tenant: this.deps.tenant },
    });
  }

  /**
   * 产品级边界（§5）：必须已认证 + ACTIVE_TEAM_REQUIRED。
   * route 已有 requireActiveTeam/requirePermission；此处为 service 纵深防御
   * （防止未来其它调用方绕过 route）。
   */
  private requireAssistContext(): void {
    const auth = this.deps.auth;
    if (!auth.authenticated || auth.userId == null) throw authRequired();
    if (auth.teamId == null) throw teamScopeRequired();
  }

  /** rate limit（§14）：必须在 provider 之前；limited → providerCalls = 0。 */
  private async enforceRateLimit(): Promise<void> {
    const cfg = resolveAIConfig(this.deps.env);
    const decision = await new AIRateLimitService({
      db: this.deps.db,
      auth: this.deps.auth,
    }).evaluate({ rateLimitPerMin: cfg.rateLimitPerMin, rateLimitPerDay: cfg.rateLimitPerDay });
    if (!decision.allowed) {
      throw aiRateLimited(decision.limited, decision.retryAfterSeconds);
    }
  }

  /**
   * Strict body allowlist（§6）：body 必须是对象且**只**含 `message`（string）。
   * 采用白名单而非 deny-list：history / provider / model / capability / system / context /
   * tool* / action / command / operation / 任何未知字段 → 400。
   */
  private static strictMessage(raw: unknown): string {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidParam('body', 'expected JSON object');
    }
    const body = raw as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!AI_MESSAGE_BODY_ALLOWED_KEYS.includes(key)) {
        throw invalidParam(key, 'field is not allowed');
      }
    }
    if (typeof body.message !== 'string') {
      throw invalidParam('message', 'must be a string');
    }
    try {
      return normalizeUserInput(body.message);
    } catch (err) {
      // AIInputError → 400 INVALID_PARAM：details 只携带稳定 reason token，
      // 不泄露内部栈 / SQL / 配置细节。
      if (err instanceof AIInputError) throw invalidParam('message', err.reason);
      throw err;
    }
  }

  /**
   * provider/config/timeout → AIProviderError 的 kind → 安全 503 reason 映射（§3）。
   * - config_error   → ai_unavailable（无需向客户端区分配置错误细节）
   * - timeout        → ai_timeout
   * - provider_error → ai_upstream_error
   * 不泄露：provider raw body / endpoint / API key / Authorization / stack / 内部异常 message。
   */
  private static readonly PROVIDER_ERROR_REASON: Record<AIProviderErrorKind, AIUnavailableReason> = {
    config_error: 'ai_unavailable',
    timeout: 'ai_timeout',
    provider_error: 'ai_upstream_error',
  };

  /**
   * 统一的 backend 调用（复用 P36-C2：context / provider / usage）。
   * 任何 provider / config / timeout 失败都归一化为 `AIProviderError`，在此折叠为
   * 安全 503 `AI_UNAVAILABLE`（§3）——**绝不**默认透给 500 INTERNAL_ERROR，也不回显上游细节。
   */
  private async callBackend(message: string, history: AICompletionMessage[]) {
    try {
      const backend = new AIBackendService(
        {
          db: this.deps.db,
          auth: this.deps.auth,
          tenant: this.deps.tenant,
          env: this.deps.env,
          fetchImpl: this.deps.fetchImpl,
        },
        this.deps.provider,
      );
      return await backend.assist({ message, history });
    } catch (err) {
      // config_error（可能发生在 backend 构造期）/ timeout / provider_error 一律 → 503。
      if (err instanceof AIProviderError) {
        throw aiUnavailable(AIConversationService.PROVIDER_ERROR_REASON[err.kind]);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  /** list（§10）：仅本人 + 本团队；投影由 repository 保证（无 provider/model/messages/id）。 */
  async listConversations(
    page: number,
    pageSize: number,
    offset: number,
  ): Promise<Paginated<ConversationListItem>> {
    this.requireAssistContext();
    return this.repo().listConversations(page, pageSize, offset);
  }

  /** detail（§11）：谓词含 public_id + user_id + team_id；跨用户 / 跨团队 → 404。 */
  async getConversation(publicId: string): Promise<ConversationDetail> {
    this.requireAssistContext();
    if (!isUlid(publicId)) throw invalidParam('publicId', 'must be a 26-char ULID');
    const detail = await this.repo().getConversation(publicId);
    if (!detail) throw notFound('Conversation');
    return detail;
  }

  // -------------------------------------------------------------------------
  // write flows
  // -------------------------------------------------------------------------

  /**
   * CREATE（§8）：
   *   auth/team → strict body → rate limit → assist(history=[]) → [usage 已写]
   *   → generate public_id + 本地 title → persist → safe projection（201）。
   * 持久化失败：usage 保留、**不重调** provider（NOT_ATOMIC）。
   */
  async createConversation(rawBody: unknown): Promise<ConversationDetail> {
    this.requireAssistContext();
    const message = AIConversationService.strictMessage(rawBody);
    await this.enforceRateLimit();

    // AI_CLIENT_HISTORY = FORBIDDEN：创建时 history 恒为空。
    const result = await this.callBackend(message, []);

    const publicId = generateUlid();
    await this.repo().createConversation({
      publicId,
      title: buildConversationTitle(message),
      provider: result.provider,
      model: result.model,
      userMessage: message,
      assistantMessage: result.text,
      sourceLabels: result.sourceLabels,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        latencyMs: result.usage.latencyMs,
      },
    });

    const detail = await this.repo().getConversation(publicId);
    if (!detail) throw notFound('Conversation');
    return detail;
  }

  /**
   * NEXT MESSAGE（§9）：
   *   auth/team → ULID → strict body → readMessagesForAppend（ownership）
   *   → 记录 expectedMessagesRaw → 由服务端存储推导 bounded history
   *   → rate limit → assist → [usage 已写] → appendExchange(CAS)。
   *
   * CAS OK → 200（返回最新安全投影）；CAS stale → 409 CONFLICT（conversation_stale），
   * **不重拉不重试 provider**；行不存在 → 404。
   */
  async appendMessage(publicId: string, rawBody: unknown): Promise<ConversationDetail> {
    this.requireAssistContext();
    if (!isUlid(publicId)) throw invalidParam('publicId', 'must be a 26-char ULID');
    const message = AIConversationService.strictMessage(rawBody);

    // ownership（§4）：的所有权谓词在 repository 内部（public_id + user_id + team_id）。
    const snapshot = await this.repo().readMessagesForAppend(publicId);
    if (!snapshot) throw notFound('Conversation');
    const expectedMessagesRaw = snapshot.messagesRaw;
    const history = deriveServerHistory(snapshot.messages);

    await this.enforceRateLimit();

    // 上下文每次重建（AI_CONTEXT_REFRESH = EVERY_REQUEST_REBUILD）——在 assist 内部完成。
    const result = await this.callBackend(message, history);

    const appended = await this.repo().appendExchange({
      publicId,
      expectedMessagesRaw,
      userMessage: message,
      assistantMessage: result.text,
      sourceLabels: result.sourceLabels,
      provider: result.provider,
      model: result.model,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        latencyMs: result.usage.latencyMs,
      },
    });

    if (!appended.ok) {
      if (appended.reason === 'stale') throw conflict(ConflictReason.CONVERSATION_STALE);
      throw notFound('Conversation');
    }

    const detail = await this.repo().getConversation(publicId);
    if (!detail) throw notFound('Conversation');
    return detail;
  }
}
