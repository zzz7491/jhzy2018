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

/**
 * P33-P3A-2：二进制内容 SHA-256 摘要（hex，64 字符）。
 * 用于 files.checksum（内部字段，不返回客户端）。
 * 与 sha256Hex 的区别：本函数直接对字节摘要，不经 UTF-8 文本编码（二进制安全）。
 */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
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

// =============================================================================
// N0-C：投递身份静态加密（AES-GCM，最小通用 crypto abstraction）
//
// 用途：notification_delivery_identities.encrypted_external_id（raw openid 静态加密）。
// 纪律：
//   - secret 由 Worker env（DELIVERY_IDENTITY_ENC_KEY）提供；本模块不读取 / 打印 / 硬编码生产密钥。
//   - 明文（raw openid）绝不进入日志 / API 响应 / 错误信息；解密仅限可信 backend 路径。
//   - 复用 Workers 原生 Web Crypto（与既有 hmacSha256Hex 同平台能力）。
// =============================================================================

/** 从任意长度 secret 派生 256-bit AES-GCM 密钥（SHA-256 KDF）。 */
async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * AES-GCM 加密（随机 96-bit IV）。
 * 输出编码：`v1.<iv base64url>.<ciphertext base64url>`（自描述版本，便于将来轮换算法）。
 */
export async function aesGcmEncrypt(secret: string, plaintext: string): Promise<string> {
  const key = await deriveAesGcmKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ct))}`;
}

/**
 * AES-GCM 解密（仅可信 backend 路径调用；结果明文绝不返回客户端 / 不进日志）。
 * 非法格式 / 篡改 / 版本不符 → 抛错。
 */
export async function aesGcmDecrypt(secret: string, encoded: string): Promise<string> {
  const parts = encoded.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid ciphertext format');
  const iv = base64urlDecode(parts[1]);
  const ct = base64urlDecode(parts[2]);
  const key = await deriveAesGcmKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** base64url 解码（与 base64urlEncode 对称）。 */
function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
