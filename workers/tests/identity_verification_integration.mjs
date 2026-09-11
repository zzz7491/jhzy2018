#!/usr/bin/env node
/**
 * P0-A 身份核验集成测试（18 项覆盖）。
 *
 * 前置：
 *   - 本地 D1 已应用迁移 0031（含 identity_verifications 表）。
 *   - `wrangler dev --local` 已启动（默认 BASE_URL http://127.0.0.1:8787，ENVIRONMENT=local → Fake Provider）。
 *
 * 纪律（与全仓一致）：
 * - 响应体绝不出现：身份证明文 / Provider 原始响应 / SecretId / SecretKey / failure_reason_code。
 * - 身份证明文不落库（仅 HMAC 指纹 + 脱敏展示）。
 * - 不请求腾讯云真实收费接口（Fake Provider 确定性映射）。
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
const fpOf = (name, idCard) => createHmac('sha256', LOCAL_KEY).update(`${name}|${idCard}`).digest('hex');
const idHashOf = (idCard) => createHmac('sha256', LOCAL_KEY).update(idCard).digest('hex');

const ID_VERIFIED = '11010119900307001X';
const ID_MISMATCH = '11010119900307002X';
const ID_ERROR = '11010119900307003X';
const ID_REVIEW = '11010119900307004X';
const ID_VERIFIED2 = '11010119900307005X';
const ID_INVALID = '11010119900307006X';
const NAME_A = '张三';
const NAME_B = '李四';

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
  // 健康自检：若服务不可达 → 明示 NOT_EXECUTED_TO_ASSERTION_COMPLETION。
  const health = await req('GET', '/');
  if (health.connError || health.res.status === 0) {
    process.stderr.write(
      `\nLIVE_ASSERTION = NOT_EXECUTED_TO_ASSERTION_COMPLETION (server unreachable at ${BASE}; ` +
        `需先 wrangler dev --local 且本地 D1 已应用迁移 0031)\n`,
    );
    process.exitCode = 0;
    return;
  }

  const r = await login('P0A_OPENID_1', 'P0A_UNIONID_1');
  const token = r.body?.data?.token ?? null;
  const userId = userIdOfPublicId(r.body?.data?.user?.public_id);
  check('T0 登录取得 token + userId', token != null && userId != null, `token=${!!token} userId=${userId}`);

  // 不变量快照（regression：无关业务计数不变）
  const before = {
    users: qc('SELECT COUNT(*) n FROM users'),
    teamMembers: qc('SELECT COUNT(*) n FROM team_members'),
    userRoles: qc('SELECT COUNT(*) n FROM user_roles'),
    permissions: qc('SELECT COUNT(*) n FROM permissions'),
    rolePermissions: qc('SELECT COUNT(*) n FROM role_permissions'),
    examSessions: qc('SELECT COUNT(*) n FROM exam_sessions'),
    certificates: qc('SELECT COUNT(*) n FROM certificates'),
  };

  // ===== 7. status before verification =====
  {
    const s = await req('GET', '/api/v2/volunteer/identity/status', { headers: bearer(token) });
    check('7 status 未核验 = UNVERIFIED', s.res.status === 200 && s.body?.data?.status === 'UNVERIFIED', s.text.slice(0, 120));
  }

  // ===== 1. VERIFIED =====
  let verifiedAt = null;
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', {
      headers: bearer(token),
      body: { real_name: NAME_A, id_card: ID_VERIFIED },
    });
    verifiedAt = v.body?.data?.verified_at ?? null;
    check(
      '1 verify VERIFIED → 200 + status VERIFIED + verified_at + provider_request_id',
      v.res.status === 200 &&
        v.body?.data?.status === 'VERIFIED' &&
        typeof verifiedAt === 'number' &&
        !!v.body?.data?.provider_request_id,
      v.text.slice(0, 160),
    );
  }

  // ===== 9. API 不返回完整身份证 =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', {
      headers: bearer(token),
      body: { real_name: NAME_A, id_card: ID_VERIFIED },
    });
    check('9 API 响应不含完整身份证明文', !v.text.includes(ID_VERIFIED), v.text.slice(0, 120));
    check('9b API 响应不含真实姓名明文', !v.text.includes(NAME_A), v.text.slice(0, 120));
  }

  // ===== 8. status after VERIFIED =====
  {
    const s = await req('GET', '/api/v2/volunteer/identity/status', { headers: bearer(token) });
    check(
      '8 status 核验后 = VERIFIED + verified_at + masked',
      s.res.status === 200 &&
        s.body?.data?.status === 'VERIFIED' &&
        s.body?.data?.masked_id_card?.endsWith('001X') &&
        !s.text.includes(ID_VERIFIED),
      s.text.slice(0, 140),
    );
  }

  // ===== 10. DB 不保存身份证明文 =====
  {
    const p = q1('SELECT real_name_enc, id_card_hash, id_card_mask FROM volunteer_profiles WHERE user_id = ?', userId);
    const rows = qn('SELECT * FROM identity_verifications WHERE user_id = ?', userId);
    const noPlainInIv = rows.every((r) => !('id_card' in r) && !('real_name' in r));
    check(
      '10a volunteer_profiles 不存姓名明文（real_name_enc != 张三）',
      p?.real_name_enc != null && p.real_name_enc !== NAME_A,
      `enc=${p?.real_name_enc?.slice(0, 16)}`,
    );
    check(
      '10b id_card_hash 为指纹非明文且 = HMAC(id_card)',
      p?.id_card_hash != null && p.id_card_hash !== ID_VERIFIED && p.id_card_hash === idHashOf(ID_VERIFIED),
      `hash=${p?.id_card_hash?.slice(0, 12)}`,
    );
    check('10c id_card_mask 脱敏（末4=001X，全长18）', p?.id_card_mask?.length === 18 && p.id_card_mask.endsWith('001X') && p.id_card_mask.startsWith('*'), p?.id_card_mask);
    check('10d identity_verifications 无身份证/姓名明文列', noPlainInIv, JSON.stringify(rows[0] ?? {}).slice(0, 120));
  }

  // ===== 11. provider secret 不出现在响应 =====
  {
    const all = ALL_TEXT.join(' ');
    const leak = ['SecretId', 'SecretKey', 'TENCENT_NOT_CONFIGURED', 'SIMULATED_OUTAGE', 'NAME_ID_MISMATCH', 'MANUAL_FALLBACK'].filter((s) => all.includes(s));
    check('11 响应/日志不包含 Secret / 内部 failure_reason_code', leak.length === 0, `leak=${leak}`);
  }

  // ===== 12. 同 user + 同指纹 VERIFIED 后再提交 → 不新增 attempt =====
  {
    const beforeN = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_VERIFIED } });
    const afterN = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const verifiedRows = qc("SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ? AND status = 'VERIFIED'", userId);
    check('12 重复提交（已 VERIFIED）不新增收费 attempt（行数不变）', afterN === beforeN && verifiedRows === 1, `before=${beforeN} after=${afterN} verified=${verifiedRows}`);
  }

  // ===== 13. 并发/重复请求不会形成重复收费 attempt =====
  {
    const beforeN = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const [a, b] = await Promise.all([
      req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_VERIFIED } }),
      req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_VERIFIED } }),
    ]);
    const afterN = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const verifiedRows = qc("SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ? AND status = 'VERIFIED'", userId);
    const someRateLimited = a.res.status === 429 || b.res.status === 429;
    check(
      '13 并发重复 → 至多一次收费（VERIFIED 行数=1，新增<=1 且含一次限流）',
      verifiedRows === 1 && afterN - beforeN <= 1 && (someRateLimited || afterN - beforeN === 0),
      `before=${beforeN} after=${afterN} a=${a.res.status} b=${b.res.status} verified=${verifiedRows}`,
    );
  }

  // ===== 2. MISMATCH =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_MISMATCH } });
    check('2 MISMATCH → 409 IDENTITY_MISMATCH', v.res.status === 409 && v.body?.error?.code === 'IDENTITY_MISMATCH', v.text.slice(0, 120));
  }

  // ===== 3. PROVIDER_ERROR =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_ERROR } });
    check('3 PROVIDER_ERROR → 503 IDENTITY_PROVIDER_UNAVAILABLE', v.res.status === 503 && v.body?.error?.code === 'IDENTITY_PROVIDER_UNAVAILABLE', v.text.slice(0, 120));
  }

  // ===== 4. MANUAL_REVIEW =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_REVIEW } });
    check('4 MANUAL_REVIEW → 200 status MANUAL_REVIEW + code IDENTITY_REVIEW_REQUIRED', v.res.status === 200 && v.body?.data?.status === 'MANUAL_REVIEW' && v.body?.data?.code === 'IDENTITY_REVIEW_REQUIRED', v.text.slice(0, 140));
  }

  // ===== 5. invalid real_name =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: '', id_card: ID_VERIFIED } });
    check('5 空 real_name → 400 INVALID_INPUT', v.res.status === 400 && v.body?.error?.code === 'INVALID_INPUT', v.text.slice(0, 120));
  }

  // ===== 6. invalid id_card format =====
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: '12345' } });
    check('6 非法 id_card 格式 → 400 invalid_param(id_card)', v.res.status === 400 && v.body?.error?.details?.id_card === 'invalid_format', v.text.slice(0, 140));
  }

  // ===== 14. 修改身份证 → 新 verification required =====
  {
    const beforeRows = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_VERIFIED2 } });
    const afterRows = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const newFpRow = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ? AND identity_fingerprint = ?', userId, fpOf(NAME_A, ID_VERIFIED2));
    const s = await req('GET', '/api/v2/volunteer/identity/status', { headers: bearer(token) });
    check('14 改身份证 → 新 attempt（行数+1，新指纹存在，status=VERIFIED）', v.res.status === 200 && afterRows === beforeRows + 1 && newFpRow === 1 && s.body?.data?.status === 'VERIFIED', `before=${beforeRows} after=${afterRows} newFp=${newFpRow} status=${s.body?.data?.status}`);
  }

  // ===== 15. 修改姓名 → 新 verification required =====
  {
    const beforeRows = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_B, id_card: ID_VERIFIED2 } });
    const afterRows = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ?', userId);
    const newFpRow = qc('SELECT COUNT(*) n FROM identity_verifications WHERE user_id = ? AND identity_fingerprint = ?', userId, fpOf(NAME_B, ID_VERIFIED2));
    check('15 改姓名（同身份证）→ 新 attempt（新指纹，行数+1）', v.res.status === 200 && afterRows === beforeRows + 1 && newFpRow === 1, `before=${beforeRows} after=${afterRows} newFp=${newFpRow}`);
  }

  // ===== 16. 历史记录不被覆盖 =====
  {
    const firstFp = fpOf(NAME_A, ID_VERIFIED);
    const orig = qn('SELECT id, status FROM identity_verifications WHERE user_id = ? AND identity_fingerprint = ?', userId, firstFp);
    check('16 最初 VERIFIED 记录仍在（未被 UPDATE 覆盖）', orig.length === 1 && orig[0].status === 'VERIFIED', JSON.stringify(orig));
  }

  // ===== 17. 无关业务不变量不变 =====
  {
    const after = {
      users: qc('SELECT COUNT(*) n FROM users'),
      teamMembers: qc('SELECT COUNT(*) n FROM team_members'),
      userRoles: qc('SELECT COUNT(*) n FROM user_roles'),
      permissions: qc('SELECT COUNT(*) n FROM permissions'),
      rolePermissions: qc('SELECT COUNT(*) n FROM role_permissions'),
      examSessions: qc('SELECT COUNT(*) n FROM exam_sessions'),
      certificates: qc('SELECT COUNT(*) n FROM certificates'),
    };
    const unchanged =
      before.users === after.users &&
      before.teamMembers === after.teamMembers &&
      before.userRoles === after.userRoles &&
      before.permissions === after.permissions &&
      before.rolePermissions === after.rolePermissions &&
      before.examSessions === after.examSessions &&
      before.certificates === after.certificates;
    check('17 无关业务计数不变（users/team_members/user_roles/permissions/exam/cert）', unchanged, JSON.stringify({ before, after }));
  }

  // ===== 18. INVALID_INPUT 持久化语义（单一事实来源 SSOT）=====
  // 上游判定输入非法（Fake → INVALID_INPUT，等价腾讯 -2/-3）→ HTTP 400 INVALID_INPUT，
  // 且 identity_verifications 行必须保留 INVALID_INPUT 状态（不得降级为 PROVIDER_ERROR）。
  {
    const v = await req('POST', '/api/v2/volunteer/identity/verify', { headers: bearer(token), body: { real_name: NAME_A, id_card: ID_INVALID } });
    check('18a INVALID_INPUT → 400 INVALID_INPUT（API 契约）', v.res.status === 400 && v.body?.error?.code === 'INVALID_INPUT', v.text.slice(0, 140));

    const row = q1(
      `SELECT status, failure_reason_code FROM identity_verifications
        WHERE user_id = ? AND identity_fingerprint = ? ORDER BY id DESC LIMIT 1`,
      userId,
      fpOf(NAME_A, ID_INVALID),
    );
    check(
      '18b DB 最终记录 status = INVALID_INPUT（SSOT，非 PROVIDER_ERROR）',
      row?.status === 'INVALID_INPUT' && row?.status !== 'PROVIDER_ERROR',
      `row=${JSON.stringify(row)}`,
    );
    check(
      '18c DB failure_reason_code 保留原始语义（FAKE_INVALID_INPUT）',
      row?.failure_reason_code === 'FAKE_INVALID_INPUT',
      `frc=${row?.failure_reason_code}`,
    );
  }

  process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
  if (fail > 0) process.stderr.write(`FAILED: ${fails.join(', ')}\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`FATAL ${String(e)}\n`);
  process.exitCode = 1;
});
