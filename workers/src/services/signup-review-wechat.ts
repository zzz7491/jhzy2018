/**
 * N0-E5C：活动报名审核结果 WeChat payload 构造（最小、可测试）。
 *
 * 纪律（N0-E5C §4 / §7 / §8）：
 *   - 所有值来自权威业务数据：activities.title / activities.address / review decision / activity_signups.review_at。
 *   - 不使用「待定」/ 任何 privacy fallback / team public contact / creator nickname / owner phone /
 *     trusted phone / emergency contact。
 *   - 若活动地址为空（activities.address 为 OPTIONAL，可 NULL/blank）：返回 null → 调用方判定 NOT_ELIGIBLE，
 *     跳过 WeChat；业务 review + IN_APP 已成功，不受影响（绝不因缺 address 抛回业务失败）。
 *
 * 该模块是纯函数，便于确定性测试，且被 ActivitySignupService 在 atomic commit 之后 best-effort 调用。
 */

import { formatWeChatTime7 } from '../utils/wechat-time';

export interface SignupReviewWeChatInput {
  /** activities.title（权威数据源）。 */
  title: string;
  /** activities.address（权威数据源，可为 null/blank → 返回 null）。 */
  address: string | null;
  /** review decision。 */
  decision: 'approve' | 'reject';
  /** activity_signups.review_at（unix 秒）。 */
  reviewAt: number;
}

/** provider field key 键入的 payload（phrase1/thing2/thing4/time7）。 */
export interface SignupReviewWeChatData {
  // N0-E5C：index signature 使其可赋值给 adapter send 的 `data: Record<string, string>` 契约。
  [k: string]: string;
  phrase1: string;
  thing2: string;
  thing4: string;
  time7: string;
}

/** 冻结短语值（N0-E5C §7）：approve=通过 / reject=未通过。 */
export const PHRASE_APPROVED = '通过';
export const PHRASE_REJECTED = '未通过';

/**
 * 构造 signupReview 模板 payload。地址缺失时返回 null（调用方据此跳过 WeChat）。
 */
export function buildSignupReviewWeChatData(input: SignupReviewWeChatInput): SignupReviewWeChatData | null {
  const address = input.address != null ? input.address.trim() : '';
  if (address.length === 0) return null;

  const title = input.title != null ? input.title.trim() : '';
  if (title.length === 0) return null;

  return {
    phrase1: input.decision === 'approve' ? PHRASE_APPROVED : PHRASE_REJECTED,
    thing2: title,
    thing4: address,
    time7: formatWeChatTime7(input.reviewAt),
  };
}
