/**
 * device_name 派生（S2-6c-3，指令 §六）。
 *
 * 纪律：
 * - 【不新增任何数据库字段】：sessions.user_agent 存原始（截断）UA，device_name 仅在 API 响应层派生。
 * - 只做展示层语义，不做 UA fingerprinting（不组合多特征、不生成稳定设备指纹、不做熵累积）。
 * - 无法可靠识别一律返回 'Unknown Device'（包括异常 / 超长 / 空 / 非 ASCII 控制字符）。
 * - 本文件不输出任何日志，不接触任何敏感值。
 */

/** sessions.user_agent 存储上限（超出截断，防超长 UA 撑爆行 / 便于审计）。 */
export const USER_AGENT_MAX_STORE_LENGTH = 256;

const UNKNOWN = 'Unknown Device';

/** 浏览器识别（顺序敏感：小程序 → 微信 → Edge/Opera/Firefox/Chrome → Safari）。 */
function detectBrowser(ua: string): string | null {
  if (/miniprogram/i.test(ua)) return 'WeChat Mini Program';
  if (/micromessenger/i.test(ua)) return 'WeChat';
  if (/\bedg(?:e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/\bopr\/|\bopera\b/i.test(ua)) return 'Opera';
  if (/\b(?:firefox|fxios)\//i.test(ua)) return 'Firefox';
  if (/\b(?:chrome|chromium|crios)\//i.test(ua)) return 'Chrome';
  if (/\bsafari\//i.test(ua)) return 'Safari';
  return null;
}

/** 操作系统识别。 */
function detectOs(ua: string): string | null {
  if (/\bwindows\b|win32|win64/i.test(ua)) return 'Windows';
  if (/\biphone\b/i.test(ua)) return 'iPhone';
  if (/\bipad\b/i.test(ua)) return 'iPad';
  if (/\bandroid\b/i.test(ua)) return 'Android';
  if (/\bmacintosh\b|\bmac os x\b/i.test(ua)) return 'Mac';
  if (/\blinux\b/i.test(ua)) return 'Linux';
  return null;
}

/**
 * 派生展示用设备名。
 * 例：'WeChat Mini Program' / 'Chrome on Windows' / 'Safari on iPhone' / 'Unknown Device'
 */
export function deriveDeviceName(userAgent: string | null | undefined): string {
  if (typeof userAgent !== 'string') return UNKNOWN;
  const ua = userAgent.trim();
  if (ua.length === 0 || ua.length > 4096) return UNKNOWN;
  // 控制字符（含换行 / 制表）视为异常输入，直接兜底，避免日志注入与误判。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(ua)) return UNKNOWN;

  const browser = detectBrowser(ua);
  // 小程序 / 微信内置浏览器已是完整语义，不再拼接 OS。
  if (browser === 'WeChat Mini Program' || browser === 'WeChat') return browser;
  const os = detectOs(ua);
  if (browser != null && os != null) return `${browser} on ${os}`;
  return browser ?? os ?? UNKNOWN;
}

/** 存储前截断 UA（null 安全；控制字符替换为空格，防日志注入）。 */
export function normalizeUserAgentForStore(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = userAgent.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, USER_AGENT_MAX_STORE_LENGTH);
}
