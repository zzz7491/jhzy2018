/**
 * 嘉禾 AI V1 —— 代码级隐私 guard（P36-C2 §7）。
 *
 * 目标：在**代码层**阻断禁止字段进入 AI context，而不是只依赖 prompt 措辞。
 *
 * 判定规则（精确键名匹配，**非子串**）：
 * - 只有与 `FORBIDDEN_CONTEXT_KEYS` **完全相等**的键才会被判违规；
 * - 因此 `public_id` / `activity_public_id` / `course_public_id` 等合法键不会被误杀
 *   （不因包含 "id" 子串而误判）。
 *
 * 本模块**不做** NLP / moderation；只做确定性字段名 guard。
 */

/** 绝对禁止出现在 AI context 的键名（精确匹配）。 */
export const FORBIDDEN_CONTEXT_KEYS: readonly string[] = [
  // 内部 numeric 主键 / 外键
  'id',
  'user_id',
  'team_id',
  'activity_id',
  'session_id',
  'signup_id',
  'occurrence_id',
  'slot_id',
  'op_id',
  'position_id',
  'paper_id',
  'course_id',
  'lesson_id',
  'enrollment_id',
  'rule_id',
  'source_id',
  'template_id',
  'file_id',
  'author_id',
  'operator_id',
  'created_by',
  'review_by',
  'audit_by',
  // 隐私密文 / 哈希 / 掩码（volunteer_profiles / user_identities）
  'real_name_enc',
  'id_card_hash',
  'id_card_mask',
  'phone_enc',
  'phone_mask',
  'emergency_contact_enc',
  'identity_hash',
  // 秘密 / 凭证
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'authorization',
];

const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_CONTEXT_KEYS);

/** 隐私 guard 违规（命中禁止键）。 */
export class AIPrivacyError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`AI context privacy violation: ${violations.join(', ')}`);
    this.name = 'AIPrivacyError';
    this.violations = violations;
  }
}

/**
 * 深度扫描：返回所有**精确命中**禁止键的路径（空数组 = 通过）。
 * 数组按索引遍历；嵌套对象递归。
 */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const childPath = `${p}.${k}`;
      if (FORBIDDEN_SET.has(k)) out.push(childPath);
      walk(child, childPath);
    }
  };
  walk(value, path);
  return out;
}

/** 断言无禁止键；命中即抛 AIPrivacyError（code-level guard）。 */
export function assertNoForbiddenKeys(value: unknown, origin = 'context'): void {
  const violations = findForbiddenKeys(value);
  if (violations.length > 0) {
    throw new AIPrivacyError(violations.map((v) => `${origin}${v.slice(1)}`));
  }
}
