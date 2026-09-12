/**
 * 微信订阅消息 time 类型字段格式化（N0-E5C）。
 *
 * 纪律：
 *   - 输入为 unix 秒（与 activity_signups.review_at 存储格式一致）。
 *   - 输出固定 'YYYY-MM-DD HH:mm'，时区固定 Asia/Shanghai (UTC+8)，不依赖机器本地时区。
 *   - 确定性：对「已加固定偏移的时间戳」使用 UTC 方法提取分量，杜绝隐式 Date locale 差异。
 *   - 不改数据库 review_at 存储方式（仍存 unix 秒）。
 */

/** Asia/Shanghai = UTC+8 固定偏移（中国标准时间，无夏令时）。 */
const UTC_PLUS_8_SECONDS = 8 * 3600;

/**
 * 将 unix 秒格式化为微信 time 字段所需的 'YYYY-MM-DD HH:mm'（UTC+8）。
 * 同输入永远得到同输出，与运行机器时区无关。
 */
export function formatWeChatTime7(unixSeconds: number): string {
  const shiftedMs = (unixSeconds + UTC_PLUS_8_SECONDS) * 1000;
  const d = new Date(shiftedMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}`;
}
