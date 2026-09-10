/**
 * 嘉禾 AI V1 —— conversation 持久化仓库（P36-C3-1）。
 *
 * 边界（冻结，见 P36-C3A 设计 + 本任务 §2/§3/§4/§5/§8/§9）：
 * - **所有权**：conversation 永远属于 (authenticated user, active team)。
 *   所有 get / update 谓词【必须】同时包含 `public_id AND user_id AND team_id`；
 *   任何仅 `WHERE public_id = ?` 都是被禁止的写法。跨用户 / 跨团队一律返回
 *   not-found（不泄露存在性，不构成 existence oracle）。
 * - **public_id 对外，numeric id 只内部使用**：本仓库的公开返回值【绝不】包含 numeric id。
 * - **只写 ai_conversations**：本仓库不触碰任何业务表（AI_CAN_MUTATE_BUSINESS_STATE = NO）。
 * - **不处理 usage**：ai_usage_logs 由 P36-C2 `AIUsageRepository` 负责；
 *   AI_USAGE_CONVERSATION_ATOMICITY = NOT_ATOMIC（不做跨表 transaction / 不补偿删除 / 不重调 provider）。
 * - **不选 provider / model**：provider / model 由调用方（未来 conversation service）以
 *   server config 结果传入；本仓库不调用任何 AI，不生成 title（AI_TITLE_PROVIDER_CALLS = 0）。
 * - **不发明 status 语义**：成功行使用 schema 既有 DEFAULT(1)；本仓库【不】写 2 / 3，
 *   也不赋予 ACTIVE / DELETED 等 lifecycle 语义。
 * - **CAS**：并发保护以「已存储 messages 原文」为期望值（CONVERSATION_CAS =
 *   EXPECTED_STORED_MESSAGES），【不】使用 updated_at 作为唯一乐观锁（秒级精度不足以
 *   阻止同秒并发覆盖）。
 *
 * 分层说明：本文件属于 repository 层，唯一的 services 依赖是 P36-C2 的**纯无状态**
 * privacy guard（`services/ai/privacy.ts` 无任何 DB / 服务依赖）——本任务 §5 明确要求
 * 「继续复用 P36-C2 privacy guard」，故在其持久化边界直接复用，避免第二套禁止键清单。
 */

import { BaseRepository } from './base';
import type { Paginated } from '../types/api';
import { teamScopeRequired, userScopeRequired } from '../utils/errors';
import { isUlid } from '../utils/validation';
import { assertNoForbiddenKeys } from '../utils/ai-privacy';

/** V1 唯一 capability（服务端固定；客户端不可提交）。 */
export const AI_CONVERSATION_CAPABILITY = 'volunteer_assist' as const;

/**
 * source_labels 冻结白名单。
 * 与 P36-C2 `services/ai/data-block.ts#AI_CONTEXT_SOURCE_LABELS` 保持一致
 * （测试以 parity 断言锁定，防止两处漂移）。
 */
export const CONVERSATION_SOURCE_LABELS = [
  '团队',
  '活动',
  '服务记录',
  '积分',
  '成长',
  '培训',
  '证书',
  '社区内容',
] as const;
export type ConversationSourceLabel = (typeof CONVERSATION_SOURCE_LABELS)[number];
const SOURCE_LABEL_SET: ReadonlySet<string> = new Set(CONVERSATION_SOURCE_LABELS);

/**
 * 并发保护策略标识（冻结）：以「已存储 messages 原文」为 CAS 期望值。
 * UPDATED_AT_USED_AS_SOLE_LOCK = NO。
 */
export const CONVERSATION_CAS = 'EXPECTED_STORED_MESSAGES' as const;

/** V1 持久化的单条消息（最小格式：role / content / [assistant:] source_labels）。 */
export interface StoredConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 assistant message 允许携带；来自冻结白名单。 */
  source_labels?: string[];
}

/** 会话契约违规（repository 层领域错误；HTTP 映射留 C3-2/C3-3）。 */
export class ConversationContractError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ConversationContractError';
    this.reason = reason;
  }
}

// ===========================================================================
// 消息校验 / 序列化（写入前必须通过）
// ===========================================================================

function validateSourceLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ConversationContractError('invalid_source_labels', 'source_labels must be an array');
  }
  const out: string[] = [];
  for (const label of raw) {
    if (typeof label !== 'string' || !SOURCE_LABEL_SET.has(label)) {
      throw new ConversationContractError('unknown_source_label', `unknown source label '${String(label)}'`);
    }
    out.push(label);
  }
  return out;
}

/**
 * 校验单条待持久化消息（§5）。
 * 顺序：privacy guard（复用 P36-C2）→ role → content → 精确字段白名单 → source_labels 白名单。
 * 任何未列出的字段（含 numeric 内部 id / PII 键）一律拒绝。
 */
export function validateStoredMessage(input: unknown): StoredConversationMessage {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConversationContractError('invalid_message_shape', 'message must be an object');
  }
  const msg = input as Record<string, unknown>;

  // 复用 P36-C2 privacy guard：internal numeric id / PII / secret 键名一律拦截。
  assertNoForbiddenKeys(msg, 'message');

  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') {
    throw new ConversationContractError('invalid_message_role', "message role must be 'user' or 'assistant'");
  }
  if (typeof msg.content !== 'string') {
    throw new ConversationContractError('invalid_message_content', 'message content must be a string');
  }

  const allowed = role === 'assistant' ? ['role', 'content', 'source_labels'] : ['role', 'content'];
  for (const key of Object.keys(msg)) {
    if (!allowed.includes(key)) {
      throw new ConversationContractError('unknown_message_field', `unexpected message field '${key}'`);
    }
  }

  const out: StoredConversationMessage = { role, content: msg.content };
  if (role === 'assistant') {
    out.source_labels = validateSourceLabels(msg.source_labels ?? []);
  }
  return out;
}

/** 校验一组消息（逐条）。 */
export function validateStoredMessages(input: unknown): StoredConversationMessage[] {
  if (!Array.isArray(input)) {
    throw new ConversationContractError('invalid_messages_shape', 'messages must be an array');
  }
  return input.map(validateStoredMessage);
}

/** 规范化序列化（键序稳定，保证 CAS 原文可比）。 */
export function serializeMessages(messages: StoredConversationMessage[]): string {
  return JSON.stringify(
    messages.map((m) =>
      m.role === 'assistant'
        ? { role: m.role, content: m.content, source_labels: m.source_labels ?? [] }
        : { role: m.role, content: m.content },
    ),
  );
}

/**
 * 安全解析已存储 messages（§7）。损坏 JSON / 非法结构【绝不】静默信任 → 抛领域错误。
 */
export function parseStoredMessages(raw: string | null | undefined): StoredConversationMessage[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConversationContractError('malformed_stored_messages', 'stored messages is not valid JSON');
  }
  return validateStoredMessages(parsed);
}

// ===========================================================================
// 输入 / 输出类型
// ===========================================================================

/** 单次 provider 调用的用量（服务端结果；不进 ai_usage_logs）。 */
export interface ExchangeUsage {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** createConversation 输入：全部为 server-controlled（user/team 取自 ctx）。 */
export interface CreateConversationInput {
  /** 服务端生成的 ULID。 */
  publicId: string;
  title: string | null;
  provider: string;
  model: string;
  /** 首条用户消息（已 trim 的纯文本）。 */
  userMessage: string;
  /** 首条助手回复（已脱敏的纯文本）。 */
  assistantMessage: string;
  /** assistant message 的来源标签（冻结白名单）。 */
  sourceLabels: readonly string[];
  usage: ExchangeUsage;
}

/** appendExchange 输入：一次【完整成功】的 exchange（user + assistant）。 */
export interface AppendExchangeInput {
  publicId: string;
  /** **provider 调用之前**读取的 messages 原文（CAS 期望值）。 */
  expectedMessagesRaw: string;
  userMessage: string;
  assistantMessage: string;
  sourceLabels: readonly string[];
  provider: string;
  model: string;
  usage: ExchangeUsage;
}

/** append 结果（领域结果；HTTP 409/404 映射留 C3-2/C3-3）。 */
export type AppendExchangeResult =
  | { ok: true; updated_at: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'stale' };

/** list 投影（§6）：仅 public_id / title / updated_at / created_at。 */
export interface ConversationListItem {
  public_id: string;
  title: string | null;
  updated_at: number | null;
  created_at: number;
}

/** get 投影（§7）：public_id / title / messages / created_at / updated_at。 */
export interface ConversationDetail {
  public_id: string;
  title: string | null;
  messages: StoredConversationMessage[];
  created_at: number;
  updated_at: number | null;
}

/** 预取快照（供未来 service 在 provider 调用前捕获 CAS 期望值 + provider 历史）。 */
export interface ConversationMessagesSnapshot {
  /** 数据库原始 messages 文本（可能为 '' 表示空）。 */
  messagesRaw: string;
  messages: StoredConversationMessage[];
}

// ===========================================================================
// Repository
// ===========================================================================

export class AIConversationRepository extends BaseRepository {
  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** 统一的所有权守卫：TEAM_SCOPED(ai_conversations) + 必须同时具备 user / team 上下文。 */
  private requireScope(): { userId: number; teamId: number } {
    this.ensureTableRead('ai_conversations');
    const teamId = this.ctx.tenant.teamId;
    const userId = this.ctx.auth.userId;
    if (teamId == null) throw teamScopeRequired();
    if (userId == null) throw userScopeRequired();
    return { userId, teamId };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  /**
   * 创建会话（含首轮 exchange：1 条 user + 1 条 assistant）。
   * - 只接受 server-controlled 数据（user/team 取自 ctx）。
   * - capability 强制 'volunteer_assist'；status 省略 → schema DEFAULT(1)。
   * - tool_calls 省略 → NULL（V1 不启用 tool calling）。
   * - 返回不含 numeric id。
   */
  async createConversation(input: CreateConversationInput): Promise<{ public_id: string; created_at: number; updated_at: number }> {
    const { userId, teamId } = this.requireScope();
    if (!isUlid(input.publicId)) {
      throw new ConversationContractError('invalid_public_id', 'publicId must be a 26-char ULID');
    }

    const messages = validateStoredMessages([
      { role: 'user', content: input.userMessage },
      { role: 'assistant', content: input.assistantMessage, source_labels: [...input.sourceLabels] },
    ]);
    const messagesRaw = serializeMessages(messages);
    const now = this.now();

    await this.run(
      `INSERT INTO ai_conversations
         (user_id, team_id, public_id, capability, provider, model, messages, title,
          prompt_tokens, completion_tokens, latency_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        teamId,
        input.publicId,
        AI_CONVERSATION_CAPABILITY,
        input.provider,
        input.model,
        messagesRaw,
        input.title,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.latencyMs,
        now,
        now,
      ],
    );

    return { public_id: input.publicId, created_at: now, updated_at: now };
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  /**
   * 当前 (user, team) 的会话列表（§6）。
   * WHERE user_id = ? AND team_id = ?；投影仅 public_id / title / updated_at / created_at。
   * 排序：updated_at DESC, id DESC（稳定 secondary sort）。
   */
  async listConversations(page: number, pageSize: number, offset: number): Promise<Paginated<ConversationListItem>> {
    const { userId, teamId } = this.requireScope();

    const rows = await this.all<ConversationListItem>(
      `SELECT public_id, title, updated_at, created_at
         FROM ai_conversations
        WHERE user_id = ? AND team_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [userId, teamId, pageSize, offset],
    );
    const totalRow = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ai_conversations WHERE user_id = ? AND team_id = ?`,
      [userId, teamId],
    );
    const total = totalRow?.total ?? 0;

    return {
      items: rows,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------
  /**
   * 读取单个会话（§7）。谓词必须同时含 public_id + user_id + team_id；
   * 跨用户 / 跨团队 → null（not found，不泄露存在性）。messages 经安全解析。
   */
  async getConversation(publicId: string): Promise<ConversationDetail | null> {
    const { userId, teamId } = this.requireScope();
    if (!isUlid(publicId)) return null;

    const row = await this.first<{
      public_id: string;
      title: string | null;
      messages: string | null;
      created_at: number;
      updated_at: number | null;
    }>(
      `SELECT public_id, title, messages, created_at, updated_at
         FROM ai_conversations
        WHERE public_id = ? AND user_id = ? AND team_id = ?`,
      [publicId, userId, teamId],
    );
    if (!row) return null;

    return {
      public_id: row.public_id,
      title: row.title,
      messages: parseStoredMessages(row.messages),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 读取会话 messages 原文快照（所有权受限）。
   * 供未来 conversation service 在 **provider 调用之前** 捕获 CAS 期望值 + provider 历史。
   * 跨用户 / 跨团队 → null。
   */
  async readMessagesForAppend(publicId: string): Promise<ConversationMessagesSnapshot | null> {
    const { userId, teamId } = this.requireScope();
    if (!isUlid(publicId)) return null;

    const row = await this.first<{ messages: string | null }>(
      `SELECT messages FROM ai_conversations
        WHERE public_id = ? AND user_id = ? AND team_id = ?`,
      [publicId, userId, teamId],
    );
    if (!row) return null;

    const raw = row.messages ?? '';
    return { messagesRaw: raw, messages: parseStoredMessages(raw) };
  }

  // -------------------------------------------------------------------------
  // append (CAS)
  // -------------------------------------------------------------------------
  /**
   * 原子追加一次【完整成功】的 exchange（1 条 user + 1 条 assistant，§9）。
   *
   * CAS（§8）：`UPDATE … WHERE public_id = ? AND user_id = ? AND team_id = ? AND messages IS ?`，
   * 期望值 = 调用方在 provider 调用前读取的 messages 原文（expectedMessagesRaw）。
   *   - 命中：changes = 1 → { ok: true }；
   *   - 未命中：changes = 0 → 再做一次**所有权内**探测以区分：
   *       · 行仍存在（属主范围内）→ 'stale'（并发覆盖 / 基于旧 messages）；
   *       · 行不存在（不存在 / 跨用户 / 跨团队）→ 'not_found'（不泄露存在性）。
   *
   * 同秒并发无法绕过：比较的是 messages 文本而非 updated_at。
   * status 不更新（保持成功 DEFAULT/既有值语义）。
   */
  async appendExchange(input: AppendExchangeInput): Promise<AppendExchangeResult> {
    const { userId, teamId } = this.requireScope();
    if (!isUlid(input.publicId)) return { ok: false, reason: 'not_found' };

    const existing = parseStoredMessages(input.expectedMessagesRaw);
    const exchange = validateStoredMessages([
      { role: 'user', content: input.userMessage },
      { role: 'assistant', content: input.assistantMessage, source_labels: [...input.sourceLabels] },
    ]);
    const nextRaw = serializeMessages([...existing, ...exchange]);
    const now = this.now();

    const res = await this.run(
      `UPDATE ai_conversations
          SET messages = ?, provider = ?, model = ?,
              prompt_tokens = ?, completion_tokens = ?, latency_ms = ?,
              updated_at = ?
        WHERE public_id = ? AND user_id = ? AND team_id = ? AND messages IS ?`,
      [
        nextRaw,
        input.provider,
        input.model,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.latencyMs,
        now,
        input.publicId,
        userId,
        teamId,
        input.expectedMessagesRaw,
      ],
    );

    if ((res.meta?.changes ?? 0) > 0) return { ok: true, updated_at: now };

    // changes = 0：区分「并发 stale」与「不存在/越权」——仅所有权范围内探测，不产生 oracle。
    const probe = await this.first<{ one: number }>(
      `SELECT 1 AS one FROM ai_conversations
        WHERE public_id = ? AND user_id = ? AND team_id = ?`,
      [input.publicId, userId, teamId],
    );
    return { ok: false, reason: probe ? 'stale' : 'not_found' };
  }
}
