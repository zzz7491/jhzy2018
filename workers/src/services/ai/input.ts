/**
 * 嘉禾 AI V1 —— 输入规范与客户端控制面拒绝（P36-C2 §6）。
 *
 * 1. 用户输入：trim → 非空 → 长度上限。
 * 2. 历史消息：只接受 user / assistant；拒绝 client system role；条数有界。
 * 3. 客户端**禁止**提供 provider / model / temperature / system prompt / context /
 *    tool_calls —— 这些一律属于 server config 或服务端构造。
 *
 * 注：HTTP route 层（含 400/403/409 映射）在 P36-C3 接入；本阶段在 service 层验证。
 */

import type { AICompletionMessage } from './provider';

/** 单条用户输入最大字符数。 */
export const AI_INPUT_MAX_CHARS = 2000;
/** 历史消息最大条数（超出只保留最近若干条）。 */
export const AI_MAX_HISTORY_MESSAGES = 20;
/** 允许的消息角色（system 由 request.system 承载，客户端不得提交）。 */
export const AI_MESSAGE_ROLES: readonly AICompletionMessage['role'][] = ['user', 'assistant'];

/** 客户端禁止提交的控制面字段（出现即拒绝）。 */
export const REJECTED_CLIENT_FIELDS: readonly string[] = [
  'provider',
  'model',
  'temperature',
  'top_p',
  'system',
  'system_prompt',
  'systemPrompt',
  'context',
  'business_data',
  'businessData',
  'tool_calls',
  'toolCalls',
  'tools',
  'tool_choice',
  'max_tokens',
  'maxTokens',
  'max_output_tokens',
  'maxOutputTokens',
  'timeout',
  'timeoutMs',
];

/** AI 输入非法（由 service 抛出；C3 route 层映射为 400）。 */
export class AIInputError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'AIInputError';
    this.reason = reason;
  }
}

/** trim 并校验用户输入（非空 + 长度上限）。 */
export function normalizeUserInput(raw: unknown): string {
  if (typeof raw !== 'string') throw new AIInputError('invalid_message', 'message must be a string');
  const trimmed = raw.trim();
  if (trimmed === '') throw new AIInputError('empty_message', 'message must not be empty');
  if (trimmed.length > AI_INPUT_MAX_CHARS) {
    throw new AIInputError('message_too_long', `message exceeds ${AI_INPUT_MAX_CHARS} characters`);
  }
  return trimmed;
}

/**
 * 规范化历史消息：
 * - 必须是数组（或 undefined/null → 空）；
 * - 每项须为 { role: 'user'|'assistant', content: string }；
 * - **拒绝** client 提交的 system / developer / tool 等角色；
 * - 空 content 丢弃；条数上限（保留最近 N 条）。
 */
export function normalizeHistory(raw: unknown): AICompletionMessage[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AIInputError('invalid_history', 'history must be an array');

  const out: AICompletionMessage[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') {
      throw new AIInputError('invalid_history_item', 'history item must be an object');
    }
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role === 'system' || role === 'developer') {
      throw new AIInputError('client_system_role_rejected', 'client may not supply a system role');
    }
    if (role !== 'user' && role !== 'assistant') {
      throw new AIInputError('invalid_history_role', 'history role must be user or assistant');
    }
    if (typeof content !== 'string') {
      throw new AIInputError('invalid_history_content', 'history content must be a string');
    }
    const trimmed = content.trim();
    if (trimmed === '') continue;
    out.push({ role, content: trimmed });
  }
  return out.length > AI_MAX_HISTORY_MESSAGES ? out.slice(out.length - AI_MAX_HISTORY_MESSAGES) : out;
}

/** 拒绝任何客户端控制面字段（provider / model / temperature / system / context / tool*）。 */
export function assertNoClientControlFields(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') return;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (REJECTED_CLIENT_FIELDS.includes(key)) {
      throw new AIInputError('client_control_field_rejected', `client may not supply '${key}'`);
    }
  }
}
