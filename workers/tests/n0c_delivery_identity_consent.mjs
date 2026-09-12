// tests/n0c_delivery_identity_consent.mjs
// N0-C 确定性集成测试（本地 D1 + 真实 Worker 运行时；零外网 / 零微信发送）。
//
// 覆盖（N0-C §24）：
//   A. delivery identity 加密（stored != plaintext；独立 node:crypto 交叉解密 == 原始；API 不返回明文/密文/hash）
//   B. hash 一致性（同 openid 同 hash；不同 openid 不同 hash）
//   C. upsert 幂等（重复登录 = 1 行）
//   D. legacy 用户无 encrypted identity → readiness false
//   E. consent ACCEPT / REJECT / BAN
//   F. 非法 consent state 被拒（400 SUBSCRIPTION_INVALID_STATE）
//   G. 跨用户不可访问（SELF）+ 未认证 401
//   H. 未配置 / 不匹配 template 被拒（400 SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED）
//   I. 重复上报同一 consent 幂等（1 行）
//   J. 登录 hook 不破坏既有认证行为（登录成功 + 既有端点仍 200）
//
// 运行前置：migrations 已 apply；wrangler dev --local 已在 :8787 运行。
// 运行：node --experimental-sqlite tests/n0c_delivery_identity_consent.mjs

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, createDecipheriv } from 'node:crypto';

// proxy 防护（node fetch 会把 127.0.0.1 走代理）
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const BASE = 'http://127.0.0.1:8787';
const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

// local TEST-ONLY 常量（必须与 service 内常量一致）
const LOCAL_ENC_KEY = 'local-test-only-delivery-enc-key';
const LOCAL_IDENTITY_KEY = 'local-test-only-identity-key';
const DOMAIN = 'delivery:v1:';

const OPENID = 'T_FAKE_OPENID_N0C_1';
const OPENID2 = 'T_FAKE_OPENID_N0C_2';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + (extra ? '  :: ' + extra : ''));
  }
}

function findDb() {
  const dir = join(process.cwd(), D1_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.includes('metadata'));
  if (files.length === 0) throw new Error('no D1 sqlite file under ' + dir);
  return join(dir, files[0]);
}

function b64uToBuf(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  return Buffer.from(b + pad, 'base64');
}

// 独立实现：镜像 utils/crypto.ts 的 `v1.<ivB64url>.<ctB64url>`（AES-256-GCM，key=SHA-256(secret)）
function decrypt(secret, encoded) {
  const parts = encoded.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('bad ciphertext format');
  const key = createHash('sha256').update(secret).digest();
  const iv = b64uToBuf(parts[1]);
  const ct = b64uToBuf(parts[2]);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function domainHash(externalId) {
  return createHmac('sha256', LOCAL_IDENTITY_KEY).update(DOMAIN + externalId).digest('hex');
}

async function req(method, path, { token, headers, body } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json, raw: json ? JSON.stringify(json) : '' };
}

async function main() {
  const db = new DatabaseSync(findDb());

  // ===== 登录（真实 TS 加密路径）=====
  const login1 = await req('POST', '/api/v2/auth/wechat/login', {
    body: { code: `MOCK_WECHAT_CODE.${OPENID}.-` },
  });
  ok('login 200 + token', login1.status === 200 && !!login1.json?.data?.token, login1.raw);
  const token = login1.json?.data?.token;

  const expectedHash = domainHash(OPENID);

  // ===== A/B: 加密 + hash =====
  const row = db
    .prepare('SELECT * FROM notification_delivery_identities WHERE external_id_hash = ?')
    .get(expectedHash);
  ok('A1 delivery identity row exists', !!row);
  ok('A2 ciphertext != plaintext', !!row && row.encrypted_external_id !== OPENID);
  ok('A3 ciphertext has no plaintext substring', !!row && !row.encrypted_external_id.includes(OPENID));
  ok('A4 ciphertext self-describing v1', !!row && row.encrypted_external_id.startsWith('v1.'));
  let dec = null;
  try {
    dec = decrypt(LOCAL_ENC_KEY, row.encrypted_external_id);
  } catch (e) {
    dec = 'ERR:' + e.message;
  }
  ok('A5 independent decrypt == original openid', dec === OPENID, 'got=' + dec);
  ok('B1 hash deterministic (== expected HMAC)', !!row && row.external_id_hash === expectedHash);
  ok('A6 status ACTIVE', !!row && row.status === 'ACTIVE');

  // ===== C: 幂等 upsert =====
  await req('POST', '/api/v2/auth/wechat/login', { body: { code: `MOCK_WECHAT_CODE.${OPENID}.-` } });
  const cnt1 = db
    .prepare('SELECT COUNT(*) AS n FROM notification_delivery_identities WHERE external_id_hash = ?')
    .get(expectedHash).n;
  ok('C1 repeated login idempotent (1 row)', cnt1 === 1, 'count=' + cnt1);

  // ===== B: 不同 openid → 不同 hash =====
  await req('POST', '/api/v2/auth/wechat/login', { body: { code: `MOCK_WECHAT_CODE.${OPENID2}.-` } });
  const hash2 = domainHash(OPENID2);
  ok('B2 different openid -> different hash', hash2 !== expectedHash);
  const row2 = db
    .prepare('SELECT * FROM notification_delivery_identities WHERE external_id_hash = ?')
    .get(hash2);
  ok('B3 second identity stored + decrypts', !!row2 && decrypt(LOCAL_ENC_KEY, row2.encrypted_external_id) === OPENID2);

  // ===== 状态端点（SELF）+ 无泄漏 =====
  const status = await req('GET', '/api/v2/subscriptions/status', { token });
  ok('S1 status 200', status.status === 200 && status.json?.success === true, status.raw);
  const data = status.json?.data ?? {};
  ok('S2 delivery_identity_ready true', data.delivery_identity_ready === true);
  ok('S3 templates catalog present', Array.isArray(data.templates) && data.templates.length >= 1);
  ok('S4 no plaintext openid in response', !status.raw.includes(OPENID));
  ok('S5 no ciphertext in response', !status.raw.includes('v1.'));
  ok('S6 no hash in response', !status.raw.includes(expectedHash));

  const tpl = (data.templates || []).find((t) => t.template_key === 'signup');
  ok('S7 signup template mapped to provider id', !!tpl && !!tpl.template_id);
  const TID = tpl?.template_id;

  // ===== E/F/H/I: consent =====
  const cAccept = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'signup', template_id: TID, state: 'ACCEPT' },
  });
  ok('E1 ACCEPT 200', cAccept.status === 200 && cAccept.json?.data?.item?.consent_state === 'ACCEPT', cAccept.raw);

  const cReject = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'signup', template_id: TID, state: 'REJECT' },
  });
  ok('E2 REJECT 200', cReject.status === 200 && cReject.json?.data?.item?.consent_state === 'REJECT', cReject.raw);

  const cBan = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'signup', template_id: TID, state: 'BAN' },
  });
  ok('E3 BAN 200', cBan.status === 200 && cBan.json?.data?.item?.consent_state === 'BAN', cBan.raw);

  const consentRows = db
    .prepare('SELECT COUNT(*) AS n FROM wechat_subscription_consents WHERE user_id = ? AND template_key = ?')
    .get(row.user_id, 'signup').n;
  ok('I1 repeated consent idempotent (1 row)', consentRows === 1, 'count=' + consentRows);

  const cInvalid = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'signup', template_id: TID, state: 'MAYBE' },
  });
  ok(
    'F1 invalid state rejected 400 SUBSCRIPTION_INVALID_STATE',
    cInvalid.status === 400 && cInvalid.json?.error?.code === 'SUBSCRIPTION_INVALID_STATE',
    cInvalid.raw,
  );

  const cUnknown = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'not_a_real_template', template_id: 'whatever', state: 'ACCEPT' },
  });
  ok(
    'H1 unconfigured template rejected 400 SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED',
    cUnknown.status === 400 && cUnknown.json?.error?.code === 'SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED',
    cUnknown.raw,
  );

  const cMismatch = await req('POST', '/api/v2/subscriptions/consent', {
    token,
    body: { template_key: 'signup', template_id: 'WRONG_TEMPLATE_ID', state: 'ACCEPT' },
  });
  ok(
    'H2 mismatched template_id rejected 400 SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED',
    cMismatch.status === 400 && cMismatch.json?.error?.code === 'SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED',
    cMismatch.raw,
  );

  // ===== D/G: legacy readiness false + 跨用户隔离 + 未认证 =====
  const legacy = await req('GET', '/api/v2/subscriptions/status', {
    headers: { 'x-test-role': 'volunteer', 'x-test-user': '99001' },
  });
  ok('D1 legacy user status 200', legacy.status === 200, legacy.raw);
  ok('D2 legacy readiness false', legacy.json?.data?.delivery_identity_ready === false);
  ok('D3 legacy sees no consents', Array.isArray(legacy.json?.data?.items) && legacy.json.data.items.length === 0);

  const anon = await req('GET', '/api/v2/subscriptions/status', {});
  ok('G1 unauthenticated 401 AUTH_REQUIRED', anon.status === 401 && anon.json?.error?.code === 'AUTH_REQUIRED', anon.raw);

  // ===== J: 既有认证行为保持 =====
  const unread = await req('GET', '/api/v2/notifications/unread-count', { token });
  ok('J1 existing endpoint still 200 with new session', unread.status === 200, unread.raw);

  // ===== 全局无明文 openid 落库 =====
  const allRows = db
    .prepare('SELECT encrypted_external_id FROM notification_delivery_identities')
    .all();
  ok(
    'A7 no stored row contains plaintext openid',
    allRows.every((r) => !String(r.encrypted_external_id).includes('T_FAKE_OPENID')),
  );

  console.log(`\nN0C_RESULT pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('N0C_TEST_ERROR', e);
  process.exitCode = 1;
});
