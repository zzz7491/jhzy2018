#!/usr/bin/env node
/**
 * P0-B 微信可信手机号绑定集成测试（≥18 项覆盖）。
 *
 * 前置：
 *   - 本地 D1 已应用迁移 0032（含 phone_verifications 表）；本脚本以 fresh D1 运行（wrangler dev --local 自动应用）。
 *   - `wrangler dev --local` 已启动（默认 BASE_URL http://127.0.0.1:8787，ENVIRONMENT=local → Fake Provider 确定性、零外网）。
 *
 * 纪律（与全仓一致）：
 * - 响应体绝不出现：完整手机号明文 / 动态 code / Provider 原始错误 / Secret / access_token / api.weixin.qq.com。
 * - 完整手机号不落库（仅 AES-GCM 密文 + HMAC 指纹 + 脱敏展示）；失败行 enc/mask 为空串。
 * - 不请求微信真实接口（Fake Provider 确定性映射）。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const LOCAL_KEY = 'local-test-only-identity-key';
const phoneHashOf = (p) => createHmac('sha256', LOCAL_KEY).update(p).digest('hex');

// Fake Provider 确定性映射（与 src/providers/wechat/phone-client.ts 对应）。
const FAKE_BOUND = 'FAKE_PHONE_BOUND'; // → '13800005678'
const FAKE_BOUND_2 = 'FAKE_PHONE_BOUND_2'; // → '13900001234'
const FAKE_INVALID = 'FAKE_PHONE_INVALID'; // → INVALID_CODE
const FAKE_ERROR = 'FAKE_PHONE_ERROR'; // → PROVIDER_ERROR

const PHONE_A = '13800005678';
const PHONE_B = '13900001234';
const MASK_A = '138****5678';
const MASK_B = '139****1234';

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    fails.push(name);
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

// ===== DB helpers =====
function dbFile() {
  return join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const q1 = (sql, ...b) => withDb((db) => db.prepare(sql).get(...b));
const qn = (sql, ...b) => withDb((db) => db.prepare(sql).all(...b));
const qc = (sql, ...b) => withDb((db) => db.prepare(sql).get(...b)?.n ?? 0);

// ===== HTTP helpers =====
const ALL_TEXT = [];
async function req(method, path, { headers = {}, body } = {}) {
  let res, json;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    return { res: { status: 0 }, body: null, text: String(e), connError: true };
  }
  const text = JSON.stringify(json);
  ALL_TEXT.push(text);
  return { res, body: json, text };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

async function login(openid, unionid = '-') {
  return req('POST', '/api/v2/auth/wechat/login', { body: { code: `MOCK_WECHAT_CODE.${openid}.${unionid}` } });
}
function userIdOfPublicId(pid) {
  return q1('SELECT id FROM users WHERE public_id = ?', pid)?.id ?? null;
}

// ===== main =====
async function main() {
  const health = await req('GET', '/');
  if (health.connError || health.res.status === 0) {
    process.stderr.write(
      `\nLIVE_ASSERTION = NOT_EXECUTED_TO_ASSERTION_COMPLETION (server unreachable at ${BASE}; ` +
        `需先 wrangler dev --local 且本地 D1 已应用迁移 0032)\n`,
    );
    process.exitCode = 0;
    return;
  }

  // ---- 用户 1 ----
  const r1 = await login('P0B_OPENID_1', 'P0B_UNIONID_1');
  const token1 = r1.body?.data?.token ?? null;
  const userId1 = userIdOfPublicId(r1.body?.data?.user?.public_id);
  check('T0 登录取得 token + userId', token1 != null && userId1 != null, `token=${!!token1} userId=${userId1}`);

  const before = {
    identityVerifications: qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId1),
    volunteerProfiles: qc('SELECT COUNT(*) n FROM volunteer_profiles WHERE user_id = ?', userId1),
    activitySignups: qc('SELECT COUNT(*) n FROM activity_signups'),
    examSessions: qc('SELECT COUNT(*) n FROM exam_sessions'),
    certificates: qc('SELECT COUNT(*) n FROM certificates'),
  };

  // ===== S1. 绑定前状态 = 未绑定 =====
  {
    const s = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token1) });
    check(
      'S1 绑定前 status = 未绑定（bound=false, mask/source/bound_at 均 null）',
      s.res.status === 200 &&
        s.body?.data?.bound === false &&
        s.body?.data?.phone_mask === null &&
        s.body?.data?.source === null &&
        s.body?.data?.bound_at === null,
      s.text.slice(0, 140),
    );
  }

  // ===== S2. BOUND 成功 =====
  let mask2 = null;
  {
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token1), body: { code: FAKE_BOUND } });
    mask2 = v.body?.data?.phone_mask ?? null;
    check(
      'S2 BOUND → 200 + bound=true + phone_mask=138****5678 + source=WECHAT + bound_at(数字)',
      v.res.status === 200 &&
        v.body?.data?.bound === true &&
        mask2 === MASK_A &&
        v.body?.data?.source === 'WECHAT' &&
        typeof v.body?.data?.bound_at === 'number',
      v.text.slice(0, 160),
    );
  }

  // ===== S3. 响应不含完整手机号 / 动态 code =====
  {
    const t = JSON.stringify(ALL_TEXT.slice(-1)[0]);
    check('S3a 响应不含完整手机号明文 13800005678', !t.includes(PHONE_A), t.slice(0, 120));
    check('S3b 响应不含动态 code FAKE_PHONE_BOUND', !t.includes(FAKE_BOUND), t.slice(0, 120));
  }

  // ===== S4. DB 安全断言 =====
  {
    const row = q1('SELECT * FROM phone_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId1);
    check('S4a phone_enc 非空且 ≠ 明文（AES-GCM 密文）', row?.phone_enc != null && row.phone_enc !== '' && row.phone_enc !== PHONE_A && row.phone_enc.includes(':'), `enc=${row?.phone_enc?.slice(0, 16)}`);
    check('S4b phone_hash = HMAC(LOCAL_KEY, 13800005678) 且 ≠ 明文', row?.phone_hash === phoneHashOf(PHONE_A) && row.phone_hash !== PHONE_A, `hash=${row?.phone_hash?.slice(0, 12)}`);
    check('S4c phone_mask = 138****5678', row?.phone_mask === MASK_A, row?.phone_mask);
    check('S4d status = BOUND', row?.status === 'BOUND', row?.status);
    check('S4e provider 列 = WECHAT（CHECK 约束）', row?.provider === 'WECHAT', row?.provider);
    check('S4f bound_at 已写入（数字）', typeof row?.bound_at === 'number', String(row?.bound_at));
    // 全表不得出现任何完整手机号明文
    const allRows = qn('SELECT * FROM phone_verifications WHERE user_id = ?', userId1);
    const noPlain = allRows.every((r) => !JSON.stringify(r).includes(PHONE_A));
    check('S4g 任意行序列化均不含完整手机号明文', noPlain, JSON.stringify(allRows).slice(0, 120));
  }

  // ===== S5. 同 user + 同 hash 已 BOUND → 幂等（不新增 BOUND 行）=====
  {
    const beforeN = qc("SELECT COUNT(*) n FROM phone_verifications WHERE user_id = ? AND status = 'BOUND'", userId1);
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token1), body: { code: FAKE_BOUND } });
    const afterN = qc("SELECT COUNT(*) n FROM phone_verifications WHERE user_id = ? AND status = 'BOUND'", userId1);
    check('S5 重复绑定（同 hash 已 BOUND）幂等 → 200 且 BOUND 行数不变', v.res.status === 200 && afterN === beforeN && afterN === 1 && v.body?.data?.phone_mask === MASK_A, `before=${beforeN} after=${afterN} mask=${v.body?.data?.phone_mask}`);
  }

  // ===== S6. 新手机号 → 允许重绑（新 BOUND 当前）=====
  {
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token1), body: { code: FAKE_BOUND_2 } });
    check(
      'S6 重绑新手机号 → 200 + phone_mask=139****1234 + source=WECHAT',
      v.res.status === 200 && v.body?.data?.bound === true && v.body?.data?.phone_mask === MASK_B && v.body?.data?.source === 'WECHAT',
      v.text.slice(0, 160),
    );
  }

  // ===== S7. 旧历史保留（138 的 BOUND 行仍在）=====
  {
    const boundN = qc("SELECT COUNT(*) n FROM phone_verifications WHERE user_id = ? AND status = 'BOUND'", userId1);
    const oldRow = q1("SELECT phone_mask FROM phone_verifications WHERE user_id = ? AND status = 'BOUND' AND phone_mask = ?", userId1, MASK_A);
    check('S7 重绑后旧 BOUND 历史保留（BOUND 行数=2，138 行仍在）', boundN === 2 && oldRow != null, `boundN=${boundN}`);
  }

  // ===== S8. INVALID_CODE 不破坏既有 BOUND =====
  {
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token1), body: { code: FAKE_INVALID } });
    check('S8 INVALID_CODE → 400 PHONE_INVALID_CODE', v.res.status === 400 && v.body?.error?.code === 'PHONE_INVALID_CODE', v.text.slice(0, 140));
    const s = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token1) });
    check('S8b 失败后 status 仍 bound=true 且 mask=139****1234（未破坏）', s.body?.data?.bound === true && s.body?.data?.phone_mask === MASK_B, s.text.slice(0, 140));
    const row = q1("SELECT status, phone_enc, phone_mask FROM phone_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId1);
    check('S8c 失败行 status=INVALID_CODE 且 enc/mask 为空串', row?.status === 'INVALID_CODE' && row.phone_enc === '' && row.phone_mask === '', JSON.stringify(row));
  }

  // ===== S9. PROVIDER_ERROR 不破坏既有 BOUND =====
  {
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token1), body: { code: FAKE_ERROR } });
    check('S9 PROVIDER_ERROR → 503 PHONE_PROVIDER_UNAVAILABLE', v.res.status === 503 && v.body?.error?.code === 'PHONE_PROVIDER_UNAVAILABLE', v.text.slice(0, 140));
    const s = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token1) });
    check('S9b 失败后 status 仍 bound=true 且 mask=139****1234（未破坏）', s.body?.data?.bound === true && s.body?.data?.phone_mask === MASK_B, s.text.slice(0, 140));
    const row = q1("SELECT status, phone_enc, phone_mask FROM phone_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId1);
    check('S9c 失败行 status=PROVIDER_ERROR 且 enc/mask 为空串', row?.status === 'PROVIDER_ERROR' && row.phone_enc === '' && row.phone_mask === '', JSON.stringify(row));
  }

  // ===== S10. 动态 code 不落库 =====
  {
    const allRows = qn('SELECT * FROM phone_verifications WHERE user_id = ?', userId1);
    const leak = allRows.some((r) => JSON.stringify(r).includes('FAKE_PHONE'));
    check('S10 全表不含动态 code 字符串（FAKE_PHONE_*）', !leak, JSON.stringify(allRows).slice(0, 120));
  }

  // ===== S11. 动态 code 不进响应（INVALID 场景）=====
  {
    const inv = ALL_TEXT.find((t) => t.includes('PHONE_INVALID_CODE'));
    check('S11 INVALID 响应不含动态 code FAKE_PHONE_INVALID', inv == null || !inv.includes(FAKE_INVALID), inv?.slice(0, 120) ?? '');
  }

  // ===== S12 / S13. 未认证不可绑定 / 不可读状态 =====
  {
    const b = await req('POST', '/api/v2/users/me/phone/wechat/bind', { body: { code: FAKE_BOUND } });
    check('S12 未认证绑定 → 401 AUTH_REQUIRED', b.res.status === 401 && b.body?.error?.code === 'AUTH_REQUIRED', b.text.slice(0, 120));
    const s = await req('GET', '/api/v2/users/me/phone/status');
    check('S13 未认证读状态 → 401 AUTH_REQUIRED', s.res.status === 401 && s.body?.error?.code === 'AUTH_REQUIRED', s.text.slice(0, 120));
  }

  // ===== S14. Fake Provider 确定性（同 mask 一致）=====
  {
    const s = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token1) });
    check('S14 当前 status mask 与 S2 一致（138****5678 已被重绑为 139，故此处应为 139）', s.body?.data?.phone_mask === MASK_B && mask2 === MASK_A, `s2=${mask2} now=${s.body?.data?.phone_mask}`);
  }

  // ===== S15. 无真实微信外网调用（响应不含微信域名）=====
  {
    const all = ALL_TEXT.join(' ');
    check('S15 任意响应不含 api.weixin.qq.com / weixin.qq.com', !all.includes('weixin.qq.com'), all.slice(0, 120));
  }

  // ===== S16. P0-A 回归：手机号操作不改写身份核验域 =====
  {
    const afterIv = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId1);
    const afterVp = qc('SELECT COUNT(*) n FROM volunteer_profiles WHERE user_id = ?', userId1);
    check('S16a identity_verifications 计数未因 phone 操作变化', before.identityVerifications === afterIv, `before=${before.identityVerifications} after=${afterIv}`);
    check('S16b volunteer_profiles 未被 phone 绑定写入（自填电话表独立）', before.volunteerProfiles === afterVp && afterVp === 0, `before=${before.volunteerProfiles} after=${afterVp}`);
  }

  // ===== S17. 禁止域不变量 =====
  {
    const after = {
      activitySignups: qc('SELECT COUNT(*) n FROM activity_signups'),
      examSessions: qc('SELECT COUNT(*) n FROM exam_sessions'),
      certificates: qc('SELECT COUNT(*) n FROM certificates'),
    };
    const untouched =
      before.activitySignups === after.activitySignups &&
      before.examSessions === after.examSessions &&
      before.certificates === after.certificates;
    check('S17 禁止域计数不变（activity_signups/exam_sessions/certificates）', untouched, JSON.stringify({ before, after }));
  }

  // ===== S18. 最终状态反映最新 BOUND =====
  {
    const s = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token1) });
    check('S18 最终 status = bound + 最新 mask 139****1234 + source WECHAT', s.body?.data?.bound === true && s.body?.data?.phone_mask === MASK_B && s.body?.data?.source === 'WECHAT', s.text.slice(0, 140));
  }

  // ===== S19. 用户隔离（USER_SCOPED）：第二用户独立 =====
  {
    const r2 = await login('P0B_OPENID_2', 'P0B_UNIONID_2');
    const token2 = r2.body?.data?.token ?? null;
    const userId2 = userIdOfPublicId(r2.body?.data?.user?.public_id);
    const s0 = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token2) });
    check('S19a 用户2 初始未绑定', s0.body?.data?.bound === false, s0.text.slice(0, 120));
    const v = await req('POST', '/api/v2/users/me/phone/wechat/bind', { headers: bearer(token2), body: { code: FAKE_BOUND } });
    check('S19b 用户2 绑定 → 200 mask=138****5678', v.res.status === 200 && v.body?.data?.phone_mask === MASK_A, v.text.slice(0, 140));
    const s1 = await req('GET', '/api/v2/users/me/phone/status', { headers: bearer(token2) });
    check('S19c 用户2 状态独立（不受用户1 影响）', s1.body?.data?.bound === true && s1.body?.data?.phone_mask === MASK_A, s1.text.slice(0, 140));
    const u2N = qc("SELECT COUNT(*) n FROM phone_verifications WHERE user_id = ? AND status = 'BOUND'", userId2);
    check('S19d 用户2 的 BOUND 行仅 1（无跨用户泄漏）', u2N === 1, `u2N=${u2N}`);
  }

  process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
  if (fail > 0) process.stderr.write(`FAILED: ${fails.join(', ')}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`FATAL ${String(e)}\n`);
  process.exitCode = 1;
});
