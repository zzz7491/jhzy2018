// ULID generator (Crockford base32, excludes I L O U).
// Deterministic when seeded (tests / reproducible migration runs).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// mulberry32 PRNG — deterministic given seed.
export function makeRng(seed = 0) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeTime(now, len) {
  let str = '';
  for (let i = 0; i < len; i++) {
    const mod = now % 32;
    str = ENCODING[mod] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len, rng) {
  let str = '';
  for (let i = 0; i < len; i++) str += ENCODING[Math.floor(rng() * 32)];
  return str;
}

// opts.time: epoch ms (default Date.now()); opts.rng: PRNG (default Math.random).
export function makeUlid(opts = {}) {
  const now = opts.time ?? Date.now();
  const rng = opts.rng ?? Math.random;
  return encodeTime(now, 10) + encodeRandom(16, rng);
}
