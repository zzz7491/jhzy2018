// =============================================================================
// N0-G1 — READ-ONLY DELIVERY DIAGNOSTICS 实现验证（真实 app + local D1）
//
// 策略（对齐 p33_content_http.mjs）：
//   1) esbuild 打包真实 src/app.ts（含 N0-G1 新挂载）→ 内存 ESM → createApp()。
//   2) node:sqlite 适配（p33 makeD1）；应用【全部】migration（含 0003 权限种子）。
//   3) 种子 users / notification_deliveries（多种 status 与 attempted_at）。
//   4) 真实中间件链：authContext → tenantContext → csrfGuard →
//      requirePermission('audit.log.view') → requirePlatformAuditView → route。
//   5) 断言：授权矩阵（200/403/401）、stale RESERVED、terminal failure、
//      RESERVED=AMBIGUOUS、PII 白名单、threshold 边界、分页。
//   不依赖 wrangler / 不触远端 / 不真实调用微信 / 不修改任何冻结文件。
//   运行（workers/ 目录）：node tests/n0g1_delivery_diagnostics.mjs
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

// ---------- D1 适配器（node:sqlite 后端，对齐 p33_content_http.mjs）----------
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) {
        params = p;
        return stmt;
      },
      async all(...override) {
        const p = override.length ? override : params;
        return { results: sqlite.prepare(sql).all(...p) };
      },
      async first(...override) {
        const p = override.length ? override : params;
        const rows = sqlite.prepare(sql).all(...p);
        return rows.length ? rows[0] : null;
      },
      async run(...override) {
        const p = override.length ? override : params;
        const r = sqlite.prepare(sql).run(...p);
        return { meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) await s.run();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// PII / 内部字段禁止出现在响应里
const BANNED = [
  'openid',
  'ciphertext',
  'phone',
  'id_card',
  'token',
  'secret',
  'provider_template_id',
  'provider_message_id',
  'provider payload',
  'raw openid',
];
function scanBanned(obj, path = '') {
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanBanned(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (BANNED.includes(k)) return `forbidden key '${k}' at ${path}`;
      const r = scanBanned(obj[k], `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

// 扫描任何值是否包含 openid 字面量等
function containsBannedString(s) {
  if (typeof s !== 'string') return false;
  const lower = s.toLowerCase();
  return ['openid', 'ciphertext', 'secret', 'access_token', 'appsecret'].some((b) => lower.includes(b));
}
function scanValues(obj, path = '') {
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanValues(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = scanValues(obj[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (containsBannedString(obj)) return `forbidden value at ${path}: ${obj}`;
  return null;
}

async function main() {
  // 1) 打包真实 app.ts
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const built = await build({
    entryPoints: [appPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `n0g1_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration（含 0003 权限种子）
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const fs = await import('node:fs');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);

  // 3) 种子 users
  const U = { a: 11, b: 12, c: 13 };
  for (const [k, id] of Object.entries(U)) {
    seed('INSERT INTO users (id, public_id, status) VALUES (?,?,1)', id, 'U_' + k + '_' + id);
  }

  // 4) 种子 notification_deliveries（多种 status / attempted_at）
  const NOW = Math.floor(Date.now() / 1000);
  let dseq = 0;
  function insertDelivery({ userId, status, attemptedAt, providerCode, providerMsg, idem }) {
    const key = idem ?? `idem_${status}_${dseq++}_${Math.random().toString(36).slice(2)}`;
    seed(
      `INSERT INTO notification_deliveries
        (user_id, channel, template_key, provider_template_id, status,
         provider_error_code, provider_error_message, authorization_event_id, idempotency_key, attempted_at, delivered_at)
       VALUES (?, 'WECHAT_SUBSCRIBE', 'signupReview', 'TID', ?, ?, ?, NULL, ?, ?, ?)`,
      userId,
      status,
      providerCode ?? null,
      providerMsg ?? null,
      key,
      attemptedAt,
      status === 'DELIVERED' ? attemptedAt + 1 : null,
    );
    return q('SELECT id FROM notification_deliveries WHERE idempotency_key=?', key)?.id;
  }

  // stale RESERVED：A1 超过默认阈值(1h)，A2 在阈值内
  const A1 = insertDelivery({ userId: U.a, status: 'RESERVED', attemptedAt: NOW - 7200 }); // 2h 前
  const A2 = insertDelivery({ userId: U.b, status: 'RESERVED', attemptedAt: NOW - 1800 }); // 30min 前
  // 三行 stale 用于分页（均 > 1h）
  const S1 = insertDelivery({ userId: U.a, status: 'RESERVED', attemptedAt: NOW - 7200 });
  const S2 = insertDelivery({ userId: U.b, status: 'RESERVED', attemptedAt: NOW - 7200 });
  const S3 = insertDelivery({ userId: U.c, status: 'RESERVED', attemptedAt: NOW - 7200 });
  // terminal failure
  const TERR = insertDelivery({ userId: U.a, status: 'PROVIDER_ERROR', attemptedAt: NOW - 7200, providerCode: '40003', providerMsg: 'TOKEN_STABLE' });
  const TNET = insertDelivery({ userId: U.b, status: 'NETWORK_ERROR', attemptedAt: NOW - 7200, providerCode: null, providerMsg: 'NETWORK_AMBIGUOUS' });
  // 不应出现在任何一类
  const DONE = insertDelivery({ userId: U.a, status: 'DELIVERED', attemptedAt: NOW - 7200 });
  const REJ = insertDelivery({ userId: U.b, status: 'PROVIDER_REJECTED', attemptedAt: NOW - 7200, providerCode: '43101' });
  const INV = insertDelivery({ userId: U.c, status: 'INVALID_PAYLOAD', attemptedAt: NOW - 7200 });
  // 用于 threshold 下界（2min 前，threshold=60 时应返回）
  const LOW = insertDelivery({ userId: U.a, status: 'RESERVED', attemptedAt: NOW - 120 });

  // 5) 请求驱动
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    const res = await app.request(path, { method, headers }, ENV);
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }

  // ============ §7 AUTHORIZATION ============
  const AUTH = '?mode=stale_reserved';
  {
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'platform_super_admin', user: U.a });
    check('AUTH platform_super_admin → 200', r.status === 200, `got ${r.status}`);
  }
  {
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'platform_operator', user: U.b });
    check('AUTH platform_operator → 200', r.status === 200, `got ${r.status}`);
  }
  {
    // team_admin 即便带 active team（持有 team-scoped audit.log.view）→ 仍 403
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'team_admin', user: U.a, team: 1 });
    check('AUTH team_admin (with team) → 403', r.status === 403, `got ${r.status}`);
  }
  {
    // 无 active team 的 team_admin 同样 403
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'team_admin', user: U.a });
    check('AUTH team_admin (no team) → 403', r.status === 403, `got ${r.status}`);
  }
  {
    // 普通用户（volunteer，无 audit.log.view）→ 403
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'volunteer', user: U.a, team: 1 });
    check('AUTH ordinary user (volunteer) → 403', r.status === 403, `got ${r.status}`);
  }
  {
    // 未认证 → 401
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH);
    check('AUTH unauthenticated → 401', r.status === 401, `got ${r.status}`);
  }
  {
    // 额外证明：team_auditor / team_owner 也持有 team-scoped audit.log.view → 仍 403（平台作用域细化生效）
    const ra = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'team_auditor', user: U.a, team: 1 });
    const ro = await call('GET', '/api/v2/admin/delivery-diagnostics' + AUTH, { role: 'team_owner', user: U.a, team: 1 });
    check('AUTH team_auditor (team-scoped audit.log.view) → 403', ra.status === 403, `got ${ra.status}`);
    check('AUTH team_owner (team-scoped audit.log.view) → 403', ro.status === 403, `got ${ro.status}`);
  }

  // ============ §8 DATA ============
  // A. stale RESERVED
  {
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=stale_reserved', { role: 'platform_super_admin', user: U.a });
    const items = r.json?.data?.items ?? [];
    const ids = items.map((x) => x.delivery_id);
    check('DATA stale_reserved 返回超过阈值的 RESERVED (A1)', ids.includes(A1), `ids=${ids}`);
    check('DATA stale_reserved 不返回阈值内的 RESERVED (A2)', !ids.includes(A2), `ids=${ids}`);
    check('DATA stale_reserved 不含 terminal/DELIVERED', !ids.includes(TERR) && !ids.includes(TNET) && !ids.includes(DONE));
    // RESERVED 必须标记 AMBIGUOUS
    const a1 = items.find((x) => x.delivery_id === A1);
    check('DATA stale RESERVED provider_outcome = AMBIGUOUS', a1 && a1.provider_outcome === 'AMBIGUOUS', JSON.stringify(a1));
    check('DATA stale RESERVED reserved_age_seconds > 0', a1 && a1.reserved_age_seconds > 0, JSON.stringify(a1));
  }

  // B. terminal failure
  {
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=terminal_failure', { role: 'platform_super_admin', user: U.a });
    const items = r.json?.data?.items ?? [];
    const ids = items.map((x) => x.delivery_id);
    check('DATA terminal_failure 返回 PROVIDER_ERROR', ids.includes(TERR), `ids=${ids}`);
    check('DATA terminal_failure 返回 NETWORK_ERROR', ids.includes(TNET), `ids=${ids}`);
    check('DATA terminal_failure 不含 DELIVERED', !ids.includes(DONE), `ids=${ids}`);
    check('DATA terminal_failure 不含 PROVIDER_REJECTED', !ids.includes(REJ), `ids=${ids}`);
    check('DATA terminal_failure 不含 INVALID_PAYLOAD', !ids.includes(INV), `ids=${ids}`);
    check('DATA terminal_failure 不含 RESERVED', !ids.includes(A1) && !ids.includes(A2), `ids=${ids}`);
    const terr = items.find((x) => x.delivery_id === TERR);
    check('DATA terminal PROVIDER_ERROR 不含 provider_outcome 字段', terr && terr.provider_outcome === undefined, JSON.stringify(terr));
    check('DATA terminal provider_error_code 透传', terr && terr.provider_error_code === '40003', JSON.stringify(terr));
  }

  // C. PII / 白名单
  {
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=terminal_failure', { role: 'platform_super_admin', user: U.a });
    const keyHit = scanBanned(r.json?.data);
    const valHit = scanValues(r.json?.data);
    check('PII 响应不含禁止 key（openid/ciphertext/secret/provider_template_id...）', keyHit === null, keyHit ?? '');
    check('PII 响应不含禁止字符串字面量', valHit === null, valHit ?? '');
    // 白名单字段存在
    const it = (r.json?.data?.items ?? [])[0] || {};
    const okFields =
      'delivery_id' in it && 'user_id' in it && 'status' in it && 'template_key' in it &&
      'authorization_event_id' in it && 'idempotency_key' in it && 'provider_error_code' in it &&
      'provider_error_message' in it && 'attempted_at' in it && 'delivered_at' in it && 'reserved_age_seconds' in it;
    check('PII 白名单字段齐全', okFields, JSON.stringify(it));
  }

  // D. pagination + threshold 边界
  {
    // 分页：3 行 stale，page_size=2 → total=3，items=2
    const r = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=stale_reserved&page_size=2', { role: 'platform_super_admin', user: U.a });
    const data = r.json?.data;
    check('PAGING page_size=2 → 返回 2 行', data?.items?.length === 2, `len=${data?.items?.length}`);
    // 共 4 行 stale RESERVED：A1 + S1 + S2 + S3
    check('PAGING total=4', data?.pagination?.total === 4, `total=${data?.pagination?.total}`);
    check('PAGING total_pages 计算正确', data?.pagination?.total_pages === 2, `tp=${data?.pagination?.total_pages}`);

    // 有效 threshold=60 应返回 2min 前的 ROW（LOW）
    const r60 = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=stale_reserved&threshold=60', { role: 'platform_super_admin', user: U.a });
    const ids60 = (r60.json?.data?.items ?? []).map((x) => x.delivery_id);
    check('THRESHOLD min=60 返回 2min 前 RESERVED (LOW)', ids60.includes(LOW), `ids=${ids60}`);

    // 有效 threshold=2592000（30d 上限）→ 200
    const rMax = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=stale_reserved&threshold=2592000', { role: 'platform_super_admin', user: U.a });
    check('THRESHOLD max=2592000 → 200', rMax.status === 200, `got ${rMax.status}`);

    // 无效 threshold → 400
    for (const t of ['0', '-1', '99999999', 'abc', '1.5']) {
      const r = await call('GET', `/api/v2/admin/delivery-diagnostics?mode=stale_reserved&threshold=${t}`, { role: 'platform_super_admin', user: U.a });
      check(`THRESHOLD invalid=${t} → 400`, r.status === 400, `got ${r.status}`);
    }

    // mode 缺失 / 非法 → 400
    const rNoMode = await call('GET', '/api/v2/admin/delivery-diagnostics', { role: 'platform_super_admin', user: U.a });
    check('QUERY mode 缺失 → 400', rNoMode.status === 400, `got ${rNoMode.status}`);
    const rBadMode = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=bogus', { role: 'platform_super_admin', user: U.a });
    check('QUERY mode=bogus → 400', rBadMode.status === 400, `got ${rBadMode.status}`);

    // 未知 query key → 400
    const rUnknown = await call('GET', '/api/v2/admin/delivery-diagnostics?mode=terminal_failure&evil=1', { role: 'platform_super_admin', user: U.a });
    check('QUERY 未知 key → 400', rUnknown.status === 400, `got ${rUnknown.status}`);
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== N0-G1 DELIVERY DIAGNOSTICS TEST: ${results.length - failed.length}/${results.length} PASS ====`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('ALL GREEN');
}

main().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
