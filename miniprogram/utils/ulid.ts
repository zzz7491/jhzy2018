// utils/ulid.ts
// 生成 Crockford Base32 ULID（26 位，排除 I/L/O/U），与后端 generateUlid 同构，
// 满足后端 workers isUlid 校验：/^[0-9A-HJKMNP-TV-Z]{26}$/。
//
// 前端无 Web Crypto（crypto.getRandomValues 在微信小程序不可用），随机段改用 Math.random。
// public_id 非安全敏感字段，且后端对 (team, consumer, definition) 有唯一性守卫，碰撞由后端拒绝。
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time: number, len: number): string {
  let out = '';
  let t = time;
  for (let i = len - 1; i >= 0; i--) {
    out = ULID_ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ULID_ENCODING[Math.floor(Math.random() * 32)];
  }
  return out;
}

export function generateUlid(): string {
  const time = Date.now();
  // 10 字符时间戳（50-bit 容量，仅用低 48-bit）+ 16 字符随机段 = 26 位
  return encodeTime(time, 10) + encodeRandom(16);
}

export default generateUlid;
