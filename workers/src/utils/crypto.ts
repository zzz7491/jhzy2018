/**
 * 加密工具（S2-6c-1）—— 全部基于 Workers 原生 Web Crypto（CONFIRMED 平台能力）。
 *
 * 安全纪律：
 * - Session Token：32 字节 CSPRNG（crypto.getRandomValues），base64url 编码。
 * - 落库仅存 SHA-256 摘要；明文 token 不落任何存储、不进日志（上层保证）。
 * - 身份标识匹配使用 HMAC-SHA256（与 S2-3 user_identities.identity_hash 设计一致）。
 */

/** 生成不透明 Session Token（形如 s_<43 字符 base64url>）。 */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `s_${base64urlEncode(bytes)}`;
}

/** SHA-256 摘要（hex，64 字符）。 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest));
}

/** HMAC-SHA256 摘要（hex）。key 为服务端密钥（实现期由 Workers Secret 提供）。 */
export async function hmacSha256Hex(key: string, input: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(input));
  return hex(new Uint8Array(sig));
}

/**
 * 生成 Crockford ULID（26 位，排除 I/L/O/U）——用于 sessions.public_id 等。
 * 48-bit 毫秒时间戳 + 80-bit 随机数。
 */
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateUlid(): string {
  const time = Date.now();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 10 字符时间戳（每个 5 bit）
  let out = '';
  let t = time;
  for (let i = 9; i >= 0; i--) {
    out = ULID_ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  // 16 字符随机段（80 bit）
  let rand = 0n;
  for (let i = 0; i < 10; i++) {
    rand = (rand << 8n) | BigInt(bytes[i]);
  }
  for (let i = 15; i >= 0; i--) {
    out += ULID_ENCODING[Number((rand >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
