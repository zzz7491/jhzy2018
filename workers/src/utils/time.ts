/**
 * 业务时间工具（S2-6k1）—— Asia/Shanghai 业务时区统一来源。
 *
 * 纪律（用户 S2-6k1-P0.5 §4 / §25）：
 * - runtime 一律使用 IANA timezone 'Asia/Shanghai'，绝不允许在业务 service 中散落 `+8 hours` 手工数学。
 * - migration 历史回填使用的 `strftime(..., '+8 hours')` 仅限 MIGRATION BACKFILL，绝不进入本模块。
 * - 输入 Unix epoch **seconds**；输出稳定 ASCII 'YYYY-MM-DD'（业务自然日）。
 *
 * 实现选择（用户明确要求）：使用 Intl.DateTimeFormat + formatToParts 提取 year/month/day，
 * 再显式拼装 `${year}-${month}-${day}`，不依赖任何 locale 的默认短日期格式
 * （locale 格式不应成为核心数据契约）。
 */

/** 平台业务时区（IANA）。Runtime 唯一真相源。 */
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

/**
 * 合理 epoch seconds 上界（远小于 1e11；毫秒值会被拒）。
 * ≈ 2286-11-20，足够覆盖业务需求且能拦截 13 位毫秒误输入。
 */
const MAX_EPOCH_SECONDS = 10_000_000_000;

/**
 * 将 Unix epoch seconds 转换为业务自然日 'YYYY-MM-DD'（Asia/Shanghai）。
 *
 * @param epochSeconds Unix epoch **seconds**（整数）。
 * @returns 稳定 ASCII 'YYYY-MM-DD' 字符串。
 * @throws 若输入非有限数 / 非整数 / 不在合理 epoch seconds 范围（含 13 位毫秒误输入）。
 */
export function toBusinessDate(epochSeconds: number): string {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
    throw new Error(`toBusinessDate: invalid epoch (not finite number): ${String(epochSeconds)}`);
  }
  if (!Number.isInteger(epochSeconds)) {
    throw new Error(`toBusinessDate: epoch must be integer seconds, got: ${String(epochSeconds)}`);
  }
  if (epochSeconds <= 0 || epochSeconds >= MAX_EPOCH_SECONDS) {
    throw new Error(`toBusinessDate: epoch seconds out of range: ${String(epochSeconds)}`);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') map[p.type] = p.value;
  }

  const { year, month, day } = map;
  if (!year || !month || !day) {
    throw new Error('toBusinessDate: failed to extract date parts from Intl.DateTimeFormat');
  }
  return `${year}-${month}-${day}`;
}
