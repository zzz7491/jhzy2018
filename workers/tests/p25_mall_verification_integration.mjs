/**
 * P25-P4 正式测试：积分商城兑换 + 管理端核销（Mall Verification）集成回归。
 *
 * 依据：P25-P4 授权 —— 把已通过 disposable real app.fetch probe（84/84 PASS）的
 *   P25-P3B2 行为固化为正式仓库测试。仅新增本文件，不触碰任何 production 代码。
 *
 * 覆盖（与 P25-P4 约定一一对应）：
 *   A — 0021 schema / permission baseline
 *         mall_orders.exchange_code + idx_mall_orders_exchange_code；
 *         permissions = 99 / role_permissions = 284；mall.order.verify 仅绑定
 *         team_owner / team_admin / platform_super_admin（不绑定 volunteer /
 *         platform_operator / team_auditor / team_member）。
 *   B — SELF redemption output（POST /orders：201 / replay 200 / exchangeCode
 *         Crockford-12 / 不返回 verifyCode / 零二次 debit·stock·sold·ledger）。
 *   C — SELF reads（list/detail 投影：公开 exchange_code、隐藏 verify_code 与内部 id；
 *         legacy NULL 原样返回不 backfill）。
 *   D — Admin permission matrix（3 端点 × 允许/禁止；super 无 active team → 403
 *         TEAM_SCOPE_REQUIRED，禁 super bypass）。
 *   E — Admin list（TEAM 隔离 / 分页默认与上限 / created_at DESC,id DESC /
 *         status 1·2 允许、3·4·非整数 400 / 投影）。
 *   F — Admin detail（TEAM 内 200；cross-team / missing 均 404；allowed
 *         verified_by_public_id、禁数字 verified_by）。
 *   G — Verify normalization（trim / 空白 / 连字符 / 大写；非法 Crockford I·L·O·U /
 *         长度错误 / 非字符串 → 400）。
 *   H — First verification（status 1→2；verified_by / verified_at / updated_at）。
 *   I — Repeat idempotency（200 already_verified；verified_by / verified_at /
 *         updated_at 三项严格等于第一次，不被覆盖）。
 *   J — Anti-enumeration（wrong code / cross-team / legacy exchange_code NULL
 *         统一 404，不区分 cross-team 与不存在）。
 *   K — RESERVED state（status 3/4 → 409 mall_order_not_verifiable，不写
 *         refund / cancel / expired 语义）。
 *   L — 无记账 / 库存副作用（verify 前后 snapshot 严格不变，仅 status /
 *         verified_by / verified_at / updated_at 可变）。
 *   M — DB integrity（PRAGMA foreign_key_check = 0；PRAGMA integrity_check = ok）。
 *
 * 架构（与 P24-P4 / P23-P5 正式测试一致）：
 *   esbuild 运行时打包真实 src → createApp → 真实 Hono app.fetch；
 *   node:sqlite + d1-shim；应用全部 migration（0001→0021）后 PRAGMA foreign_keys = ON。
 *   不 mock：MallService / MallAdminRepository / MallVerificationService /
 *   RBAC middleware / TEAM scope。
 *   不修改任何源码 / 迁移 / permission-catalog / 历史 WIP；不 git add / commit / push。
 *
 * 运行（repo root）：
 *   node workers/tests/p25_mall_verification_integration.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { D1Database, generateUlid } from './lib/d1-shim.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const WORKERS = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(WORKERS, 'migrations');

// ---------------------------------------------------------------------------
// 1) 运行时打包真实实现（esbuild）
// ---------------------------------------------------------------------------
const BUNDLE_ENTRY = `
export { createApp } from './src/app';
`;

async function loadImpl() {
  const entryPath = join(WORKERS, '.p25_bundle_entry.ts');
  writeFileSync(entryPath, BUNDLE_ENTRY);
  const bundlePath = join(tmpdir(), `p25_bundle_${process.pid}_${Date.now()}.mjs`);
  try {
    await build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: bundlePath,
      absWorkingDir: WORKERS,
      logLevel: 'silent',
    });
    const mod = await import('file://' + bundlePath);
    return { mod, bundlePath };
  } finally {
    rmSync(entryPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// 2) 基础工具
// ---------------------------------------------------------------------------
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
function assert(cond, msg) {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    FAILURES.push(msg);
    console.error('  ✗ ' + msg);
  }
}
function section(name) {
  console.log('\n=== SECTION ' + name + ' ===');
}

// 应用全部当前 migration（FK OFF 应用，避免应用期 FK 顺序问题），P25-P4 要求 0001→0021。
function applyAllMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  for (const f of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return files.length;
}

// 完整当前 schema DB（0001→0021），FK 开启
function freshCurrentRuntimeDb() {
  const sqlite = new DatabaseSync(':memory:');
  applyAllMigrations(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = new D1Database(sqlite);
  return { sqlite, db };
}

function run(sqlite, sql, params = []) {
  sqlite.prepare(sql).run(...params);
}
function get1(sqlite, sql, params = []) {
  return sqlite.prepare(sql).get(...params);
}
function q(sqlite, sql, params = []) {
  return sqlite.prepare(sql).all(...params);
}

// 所有以 FK=ON 状态执行 mutation 的场景结束后强制校验：无 orphan、无损坏。
function assertFkIntegrity(sqlite, label) {
  const fk = q(sqlite, 'PRAGMA foreign_key_check');
  assert(fk.length === 0, `${label}: foreign_key_check = 0 after mutations (got ${fk.length})`);
  const ic = q(sqlite, 'PRAGMA integrity_check');
  const icVal = ic.length === 1 ? Object.values(ic[0])[0] : null;
  assert(icVal === 'ok', `${label}: integrity_check = ok after mutations (got ${icVal})`);
}

// ---- 种子 helpers（全部 FK-safe；users→teams(owner)→products→orders 引用链完整）----
function seedBase(sqlite) {
  // users（确定性 public_id 供 user_public_id / verified_by_public_id 断言）
  for (const [id, letter] of [[11, 'A'], [12, 'B'], [13, 'C'], [14, 'D'], [15, 'E']]) {
    run(sqlite, 'INSERT INTO users (id, public_id, nickname) VALUES (?,?,?)', [id, letter.repeat(26), 'u' + id]);
  }
  run(sqlite, `INSERT INTO teams (id, public_id, name, owner_user_id, status, cert_status, is_system) VALUES (21,?,?,11,1,0,0)`, ['T'.repeat(26), 'T1']);
  run(sqlite, `INSERT INTO teams (id, public_id, name, owner_user_id, status, cert_status, is_system) VALUES (22,?,?,12,1,0,0)`, ['V'.repeat(26), 'T2']);
  for (const u of [11, 12]) {
    run(sqlite, 'INSERT INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (?,1000,1000,0,0,0)', [u]);
  }
  // team 21 商品（stock=5 供兑换递减）+ team 22 跨团商品
  run(sqlite, `INSERT INTO mall_products (id, public_id, team_id, title, points_price, stock, sold_count, status, sort, created_at, updated_at, deleted_at) VALUES (101,?,21,'P1',300,5,0,1,0,1000,NULL,NULL)`, ['P'.repeat(26)]);
  run(sqlite, `INSERT INTO mall_products (id, public_id, team_id, title, points_price, stock, sold_count, status, sort, created_at, updated_at, deleted_at) VALUES (102,?,22,'P2',100,3,0,1,0,2000,NULL,NULL)`, ['Q'.repeat(26)]);
}

// 直接落 mall_orders 行（含 exchange_code；verify_code 唯一）
function seedOrder(sqlite, o) {
  run(sqlite, `INSERT INTO mall_orders
    (id, order_no, user_id, team_id, product_id, product_title, points, status, verify_code, exchange_code, verified_by, verified_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    o.id, o.orderNo, o.userId, o.teamId, o.productId, o.title ?? 'P1', o.points ?? 300,
    o.status ?? 1, o.verifyCode ?? ('V' + String(o.id).padStart(25, '0')), o.exchangeCode ?? null,
    o.verifiedBy ?? null, o.verifiedAt ?? null, o.createdAt ?? 1000, o.updatedAt ?? null,
  ]);
}

// app.createApp 单例；env 每 DB 独立（{ DB, ENVIRONMENT: 'local' }）。
let IMPL;
let BUNDLE_PATH;

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const noKeys = (o, keys) => !keys.some((k) => k in (o || {}));
const SELF_FORBIDDEN = ['verify_code', 'id', 'user_id', 'team_id', 'product_id', 'verified_by'];
const ADMIN_LIST_FORBIDDEN = ['verify_code', 'id', 'user_id', 'team_id', 'product_id', 'verified_by', 'verified_by_public_id'];
const ADMIN_DETAIL_FORBIDDEN = ['verify_code', 'id', 'user_id', 'team_id', 'product_id', 'verified_by'];

async function main() {
  const loaded = await loadImpl();
  IMPL = loaded.mod;
  BUNDLE_PATH = loaded.bundlePath;
  const app = IMPL.createApp();

  async function call(env, method, path, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user) headers['x-test-user'] = String(opts.user);
    if (opts.team) headers['x-test-team'] = String(opts.team);
    const init = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await app.fetch(new Request('http://localhost' + path, init), env);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  // =========================================================================
  // SECTION A — 0021 schema / permission baseline
  // =========================================================================
  section('A — 0021 schema / permission baseline');
  {
    const { sqlite } = freshCurrentRuntimeDb();

    const moCols = q(sqlite, 'PRAGMA table_info(mall_orders)').map((c) => c.name);
    assert(moCols.includes('exchange_code'), 'A: mall_orders.exchange_code exists');
    const moIdx = q(sqlite, "PRAGMA index_list('mall_orders')").map((r) => r.name);
    assert(moIdx.includes('idx_mall_orders_exchange_code'), 'A: idx_mall_orders_exchange_code exists');

    assert(get1(sqlite, 'SELECT COUNT(*) c FROM permissions').c === 103, 'A: permissions = 103');
    assert(get1(sqlite, 'SELECT COUNT(*) c FROM role_permissions').c === 291, 'A: role_permissions = 291');

    const verifyBinds = q(sqlite, `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE p.code='mall.order.verify' ORDER BY r.code`).map((x) => x.code);
    assert(JSON.stringify(verifyBinds) === JSON.stringify(['platform_super_admin', 'team_admin', 'team_owner']), `A: mall.order.verify bound exactly to team_owner/team_admin/platform_super_admin (got ${JSON.stringify(verifyBinds)})`);

    const notBound = q(sqlite, `SELECT COUNT(*) c FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE p.code='mall.order.verify' AND r.code IN ('volunteer','platform_operator','team_auditor','team_member')`)[0].c;
    assert(notBound === 0, `A: mall.order.verify NOT bound to volunteer/platform_operator/team_auditor/team_member (got ${notBound})`);

    // legacy NULL 语义：0021 不建 NOT NULL 约束 / 不回填（schema 层证明 exchange_code 可空）
    const exchangeCol = q(sqlite, 'PRAGMA table_info(mall_orders)').find((c) => c.name === 'exchange_code');
    assert(exchangeCol.notnull === 0, 'A: exchange_code nullable (legacy rows allowed)');
  }

  // =========================================================================
  // SECTION B — SELF redemption output（真实 POST /api/v2/mall/orders）
  // =========================================================================
  section('B — SELF redemption output');
  let B_CTX;
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    const env = { DB: db, ENVIRONMENT: 'local' };
    const P1 = 'P'.repeat(26);
    const O1 = generateUlid();

    const a = await call(env, 'POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: P1, order_no: O1 } });
    assert(a.status === 201, `B1: first POST = 201 (got ${a.status})`);
    assert(a.json?.data?.orderNo === O1, 'B1: orderNo echoed');
    const code = a.json?.data?.exchangeCode ?? null;
    assert(typeof code === 'string' && CODE_RE.test(code), `B1: exchangeCode 12-char Crockford (got ${code})`);
    assert(noKeys(a.json?.data, ['verifyCode', 'verify_code']), 'B1: response data has no verifyCode / verify_code');
    assert(!JSON.stringify(a.json).includes('verifyCode') && !JSON.stringify(a.json).includes('verify_code'), 'B1: verifyCode/verify_code never mentioned in body');

    const row = get1(sqlite, 'SELECT exchange_code, verify_code, points, status FROM mall_orders WHERE order_no=?', [O1]);
    assert(row.exchange_code === code, 'B1: DB exchange_code == returned');
    assert(row.verify_code != null && row.verify_code.length > 0 && row.verify_code !== code, 'B1: DB verify_code present and != exchange_code');
    assert(row.status === 1, `B1: order.status=1 (got ${row.status})`);

    // 首次兑换的记账 / 库存副作用
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 700, 'B1: balance debited 1000→700');
    assert(get1(sqlite, 'SELECT total_spent FROM points_accounts WHERE user_id=11').total_spent === 300, 'B1: total_spent=300');
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 4, 'B1: stock 5→4');
    assert(get1(sqlite, 'SELECT sold_count FROM mall_products WHERE id=101').sold_count === 1, 'B1: sold_count=1');
    assert(q(sqlite, "SELECT * FROM points_ledger WHERE source_type='mall_order' AND request_id=?", ['ex:' + O1]).length === 1, 'B1: exactly 1 exchange ledger');

    // 同 order replay → 200，同一 exchangeCode，零二次副作用
    const b = await call(env, 'POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: P1, order_no: O1 } });
    assert(b.status === 200, `B2: replay = 200 (got ${b.status})`);
    assert(b.json?.data?.exchangeCode === code, `B2: replay returns original exchangeCode (got ${b.json?.data?.exchangeCode})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [O1]).length === 1, 'B2: orders unchanged = 1');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 700, 'B2: no second debit (balance=700)');
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 4, 'B2: no second stock decrement (stock=4)');
    assert(get1(sqlite, 'SELECT sold_count FROM mall_products WHERE id=101').sold_count === 1, 'B2: no second sold_count increment (=1)');
    assert(q(sqlite, "SELECT * FROM points_ledger WHERE source_type='mall_order' AND request_id=?", ['ex:' + O1]).length === 1, 'B2: no second exchange ledger');

    assertFkIntegrity(sqlite, 'S-B');
    B_CTX = { sqlite, db, env, code, O1 };
  }

  // =========================================================================
  // SECTION C — SELF reads（list / detail；legacy NULL）
  // =========================================================================
  section('C — SELF reads');
  {
    const { sqlite, db, env, code, O1 } = B_CTX;
    // legacy P24 order（exchange_code NULL，order_no 为合法 ULID 供详情路径使用）
    const OLEG = generateUlid();
    seedOrder(sqlite, { id: 9001, orderNo: OLEG, userId: 11, teamId: 21, productId: 101, exchangeCode: null, createdAt: 1000 });

    const list = await call(env, 'GET', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21 });
    assert(list.status === 200, `C: list 200 (got ${list.status})`);
    const items = list.json?.data?.items ?? [];
    assert(items.length === 2, `C: SELF sees own 2 orders (got ${items.length})`);
    const nowItem = items.find((i) => i.order_no === O1);
    assert(nowItem != null && nowItem.exchange_code === code, 'C: list item exposes exchange_code');
    const legItem = items.find((i) => i.order_no === OLEG);
    assert(legItem != null && legItem.exchange_code === null, 'C: legacy list item exchange_code stays null');
    assert(items.every((i) => noKeys(i, SELF_FORBIDDEN)), 'C: list hides verify_code/id/user_id/team_id/product_id/verified_by');
    assert(!JSON.stringify(list.json).includes('verify_code'), 'C: list body never mentions verify_code');

    const det = await call(env, 'GET', '/api/v2/mall/orders/' + O1, { role: 'volunteer', user: 11, team: 21 });
    assert(det.status === 200, `C: detail 200 (got ${det.status})`);
    assert(det.json?.data?.exchange_code === code, 'C: detail exposes exchange_code');
    assert(noKeys(det.json?.data, SELF_FORBIDDEN), 'C: detail hides internal keys');

    const detLeg = await call(env, 'GET', '/api/v2/mall/orders/' + OLEG, { role: 'volunteer', user: 11, team: 21 });
    assert(detLeg.status === 200 && detLeg.json?.data?.exchange_code === null, 'C: legacy detail exchange_code = null (no backfill in response)');
    assert(get1(sqlite, 'SELECT exchange_code FROM mall_orders WHERE order_no=?', [OLEG]).exchange_code === null, 'C: legacy DB exchange_code remains NULL (no backfill)');

    assertFkIntegrity(sqlite, 'S-C');
  }

  // =========================================================================
  // SECTION D — Admin permission matrix（3 端点 × 允许 / 禁止 / super no team）
  // =========================================================================
  section('D — Admin permission matrix');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7001, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    seedOrder(sqlite, { id: 7002, orderNo: 'B'.repeat(26), userId: 12, teamId: 21, productId: 101, exchangeCode: 'SECND0000001', status: 2, createdAt: 2000, verifiedBy: 13, verifiedAt: 5555, updatedAt: 5555 });
    const env = { DB: db, ENVIRONMENT: 'local' };

    const endpoints = [
      ['list', 'GET', '/api/v2/mall/admin/orders'],
      ['detail', 'GET', '/api/v2/mall/admin/orders/' + 'A'.repeat(26)],
      ['verify', 'POST', '/api/v2/mall/admin/orders/verify', { exchange_code: 'FRST00000001' }],
    ];

    // 允许：team_owner / team_admin / platform_super_admin + active team
    for (const [label, role, user] of [['team_owner', 'team_owner', 11], ['team_admin', 'team_admin', 12], ['super+team', 'platform_super_admin', 13]]) {
      for (const [name, method, path, body] of endpoints) {
        const r = await call(env, method, path, { role, user, team: 21, body });
        assert(r.status === 200, `D: ${label} ${name} = 200 (got ${r.status})`);
      }
    }

    // 禁止：volunteer / platform_operator / team_auditor → 403 FORBIDDEN
    for (const [role, user] of [['volunteer', 11], ['platform_operator', 14], ['team_auditor', 15]]) {
      for (const [name, method, path, body] of endpoints) {
        const r = await call(env, method, path, { role, user, team: 21, body });
        assert(r.status === 403, `D: ${role} ${name} = 403 (got ${r.status})`);
        assert(r.json?.error?.code === 'FORBIDDEN', `D: ${role} ${name} error.code=FORBIDDEN (got ${r.json?.error?.code})`);
      }
    }

    // super 无 active team → 403 TEAM_SCOPE_REQUIRED（禁 super bypass）
    for (const [name, method, path, body] of endpoints) {
      const r = await call(env, method, path, { role: 'platform_super_admin', user: 13, body });
      assert(r.status === 403, `D: super no team ${name} = 403 (got ${r.status})`);
      assert(r.json?.error?.code === 'TEAM_SCOPE_REQUIRED', `D: super no team ${name} error.code=TEAM_SCOPE_REQUIRED (got ${r.json?.error?.code})`);
    }

    assertFkIntegrity(sqlite, 'S-D');
  }

  // =========================================================================
  // SECTION E — Admin list（TEAM 隔离 / 分页 / 排序 / status 过滤 / 投影）
  // =========================================================================
  section('E — Admin list');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 8001, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    seedOrder(sqlite, { id: 8002, orderNo: 'B'.repeat(26), userId: 12, teamId: 21, productId: 101, exchangeCode: 'SECND0000001', status: 2, createdAt: 2000, verifiedBy: 13, verifiedAt: 5555, updatedAt: 5555 });
    seedOrder(sqlite, { id: 8003, orderNo: 'C'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'ST3TEST00001', status: 3, createdAt: 3000 });
    seedOrder(sqlite, { id: 8004, orderNo: 'D'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'ST4TEST00001', status: 4, createdAt: 4000 });
    seedOrder(sqlite, { id: 8100, orderNo: 'E'.repeat(26), userId: 12, teamId: 22, productId: 102, exchangeCode: 'XTEAM0000001', status: 1, createdAt: 5000 }); // cross-team
    const env = { DB: db, ENVIRONMENT: 'local' };

    // TEAM 隔离：team 21 只见本团 4 单
    const l = await call(env, 'GET', '/api/v2/mall/admin/orders', { role: 'team_owner', user: 11, team: 21 });
    assert(l.status === 200, `E: list 200 (got ${l.status})`);
    const items = l.json?.data?.items ?? [];
    assert(items.length === 4, `E: team21 sees only own 4 orders (got ${items.length})`);
    assert(!items.some((i) => i.exchange_code === 'XTEAM0000001'), 'E: cross-team order invisible');

    // 排序：created_at DESC, id DESC
    const ordered = items.map((i) => i.order_no);
    assert(JSON.stringify(ordered) === JSON.stringify(['D'.repeat(26), 'C'.repeat(26), 'B'.repeat(26), 'A'.repeat(26)]), `E: deterministic order created_at DESC, id DESC (got ${JSON.stringify(ordered)})`);

    // 分页默认 page=1 / page_size=20；上限 100；page_size max clamp
    assert(l.json?.data?.pagination?.page === 1 && l.json?.data?.pagination?.page_size === 20, `E: default page=1 page_size=20 (got ${l.json?.data?.pagination?.page}/${l.json?.data?.pagination?.page_size})`);
    const cap = await call(env, 'GET', '/api/v2/mall/admin/orders?page_size=9999', { role: 'team_owner', user: 11, team: 21 });
    assert(cap.status === 200 && cap.json?.data?.pagination?.page_size === 100, `E: page_size clamped to 100 (got ${cap.json?.data?.pagination?.page_size})`);
    const p1 = await call(env, 'GET', '/api/v2/mall/admin/orders?page=1&page_size=2', { role: 'team_owner', user: 11, team: 21 });
    assert(p1.status === 200 && p1.json?.data?.items?.length === 2 && p1.json?.data?.pagination?.total_pages === 2, `E: page1 size2 → 2 items / total_pages=2 (got ${p1.json?.data?.items?.length}/${p1.json?.data?.pagination?.total_pages})`);
    const p2 = await call(env, 'GET', '/api/v2/mall/admin/orders?page=2&page_size=2', { role: 'team_owner', user: 11, team: 21 });
    assert(p2.status === 200 && p2.json?.data?.items?.length === 2, `E: page2 size2 → 2 items (got ${p2.json?.data?.items?.length})`);
    const neg = await call(env, 'GET', '/api/v2/mall/admin/orders?page_size=-3', { role: 'team_owner', user: 11, team: 21 });
    assert(neg.status === 400, `E: negative page_size → 400 (got ${neg.status})`);

    // status 过滤：1 / 2 允许
    const m1 = await call(env, 'GET', '/api/v2/mall/admin/orders?status=1', { role: 'team_owner', user: 11, team: 21 });
    assert(m1.status === 200 && m1.json?.data?.items?.length === 1, `E: status=1 → 1 item (got ${m1.json?.data?.items?.length})`);
    const m2 = await call(env, 'GET', '/api/v2/mall/admin/orders?status=2', { role: 'team_owner', user: 11, team: 21 });
    assert(m2.status === 200 && m2.json?.data?.items?.length === 1, `E: status=2 → 1 item (got ${m2.json?.data?.items?.length})`);
    // status 3 / 4 / 非整数 → 400（不赋予 RESERVED 业务含义）
    for (const sv of ['0', '3', '4', 'abc', '1.5', '99']) {
      const r = await call(env, 'GET', `/api/v2/mall/admin/orders?status=${sv}`, { role: 'team_owner', user: 11, team: 21 });
      assert(r.status === 400, `E: status=${sv} → 400 (got ${r.status})`);
    }

    // list 投影必须包含：order_no / exchange_code / product_public_id / product_title /
    //   points_units / status / verified_at / created_at / updated_at / user_public_id
    const REQUIRED = ['order_no', 'exchange_code', 'product_public_id', 'product_title', 'points_units', 'status', 'verified_at', 'created_at', 'updated_at', 'user_public_id'];
    assert(REQUIRED.every((k) => k in (items[0] ?? {})), 'E: list projection includes all required public fields');
    // list 必须不含：verified_by_public_id / verify_code / numeric ids
    assert(items.every((i) => noKeys(i, ADMIN_LIST_FORBIDDEN)), 'E: list hides verified_by_public_id / verify_code / numeric ids');
    assert(!JSON.stringify(l.json).includes('verified_by_public_id'), 'E: list body never mentions verified_by_public_id');
    assert(!JSON.stringify(l.json).includes('verify_code'), 'E: list body never mentions verify_code');
    const bItem = items.find((i) => i.order_no === 'B'.repeat(26));
    assert(bItem != null && bItem.user_public_id === 'B'.repeat(26), 'E: list exposes user_public_id');
    assert(bItem != null && bItem.points_units === 300 && bItem.verified_at === 5555, 'E: list exposes points_units + verified_at');

    assertFkIntegrity(sqlite, 'S-E');
  }

  // =========================================================================
  // SECTION F — Admin detail（TEAM 内 200；cross-team / missing 均 404；防枚举）
  // =========================================================================
  section('F — Admin detail');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7002, orderNo: 'B'.repeat(26), userId: 12, teamId: 21, productId: 101, exchangeCode: 'SECND0000001', status: 2, createdAt: 2000, verifiedBy: 13, verifiedAt: 5555, updatedAt: 5555 });
    seedOrder(sqlite, { id: 8100, orderNo: 'E'.repeat(26), userId: 12, teamId: 22, productId: 102, exchangeCode: 'XTEAM0000001', status: 1, createdAt: 5000 }); // cross-team
    const env = { DB: db, ENVIRONMENT: 'local' };

    const own = await call(env, 'GET', '/api/v2/mall/admin/orders/' + 'B'.repeat(26), { role: 'team_owner', user: 11, team: 21 });
    assert(own.status === 200, `F: in-team detail = 200 (got ${own.status})`);
    assert(own.json?.data?.order_no === 'B'.repeat(26), 'F: detail order_no matches');
    assert(own.json?.data?.verified_by_public_id === 'C'.repeat(26), `F: detail exposes verified_by_public_id (got ${own.json?.data?.verified_by_public_id})`);
    assert(!('verified_by' in (own.json?.data ?? {})), 'F: detail does NOT expose numeric verified_by');
    assert(noKeys(own.json?.data, ADMIN_DETAIL_FORBIDDEN), 'F: detail hides numeric/internal keys');
    assert(!JSON.stringify(own.json).includes('verify_code'), 'F: detail body never mentions verify_code');

    const cross = await call(env, 'GET', '/api/v2/mall/admin/orders/' + 'E'.repeat(26), { role: 'team_owner', user: 11, team: 21 });
    assert(cross.status === 404, `F: cross-team detail → 404 (got ${cross.status})`);
    assert(cross.json?.error?.code === 'NOT_FOUND', 'F: cross-team detail NOT_FOUND');
    const missing = await call(env, 'GET', '/api/v2/mall/admin/orders/' + 'Z'.repeat(26), { role: 'team_owner', user: 11, team: 21 });
    assert(missing.status === 404, `F: missing detail → 404 (got ${missing.status})`);
    assert(missing.json?.error?.code === 'NOT_FOUND', 'F: missing detail NOT_FOUND');
    const invalid = await call(env, 'GET', '/api/v2/mall/admin/orders/notaulid', { role: 'team_owner', user: 11, team: 21 });
    assert(invalid.status === 400, `F: invalid ULID detail → 400 (got ${invalid.status})`);
    assert(invalid.json?.error?.code === 'INVALID_PARAM', 'F: invalid ULID detail INVALID_PARAM');

    assertFkIntegrity(sqlite, 'S-F');
  }

  // =========================================================================
  // SECTION G — Verify normalization
  // =========================================================================
  section('G — Verify normalization');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7003, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    seedOrder(sqlite, { id: 7004, orderNo: 'B'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'SECND0000001', status: 1, createdAt: 2000 });
    seedOrder(sqlite, { id: 7005, orderNo: 'C'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'ST3TEST00001', status: 1, createdAt: 3000 });
    const env = { DB: db, ENVIRONMENT: 'local' };

    // 合法 canonical code + 客户端输入归一化变体
    const cases = [
      ['low-hyphen', 'FRST00000001', 'frst-0000-0001'],
      ['inner-whitespace', 'SECND0000001', '  secnd 0000001  '],
      ['upper-hyphen', 'ST3TEST00001', 'ST3-TEST-00001'],
    ];
    for (const [name, canonical, input] of cases) {
      const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: input } });
      assert(r.status === 200 && r.json?.data?.status === 'verified', `G: ${name} normalized → 200 verified (got ${r.status}/${r.json?.data?.status})`);
      assert(r.json?.data?.order?.exchange_code === canonical, `G: ${name} canonical code returned (got ${r.json?.data?.order?.exchange_code})`);
      assert(get1(sqlite, 'SELECT exchange_code FROM mall_orders WHERE id=' + (name === 'low-hyphen' ? 7003 : name === 'inner-whitespace' ? 7004 : 7005)).exchange_code === canonical, `G: ${name} DB canonical form`);
    }

    // 非法 Crockford I / L / O / U + 长度错误 + 非字符串 → 400
    const bads = ['ABCDEFGHIJKL', 'FRST0000000I', 'FRST0000000L', 'FRST0000000O', 'FRST0000000U', 'SHORT', 'TOOLONGCODE1234', '', '   '];
    for (const bad of bads) {
      const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: bad } });
      assert(r.status === 400, `G: illegal "${bad}" → 400 (got ${r.status})`);
      assert(r.json?.error?.code === 'INVALID_PARAM', `G: illegal "${bad}" INVALID_PARAM`);
    }
    for (const nonstr of [123456789012, null]) {
      const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: nonstr } });
      assert(r.status === 400, `G: non-string ${String(nonstr)} → 400 (got ${r.status})`);
    }
    const missing = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: {} });
    assert(missing.status === 400, `G: missing exchange_code → 400 (got ${missing.status})`);

    assertFkIntegrity(sqlite, 'S-G');
  }

  // =========================================================================
  // SECTION H — First verification
  // =========================================================================
  section('H — First verification');
  let H_CTX;
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7001, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    const env = { DB: db, ENVIRONMENT: 'local' };

    const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'FRST00000001' } });
    assert(r.status === 200, `H: first verify = 200 (got ${r.status})`);
    assert(r.json?.data?.status === 'verified', `H: status=verified (got ${r.json?.data?.status})`);

    const s = get1(sqlite, 'SELECT status, verified_by, verified_at, updated_at, created_at FROM mall_orders WHERE id=7001');
    assert(s.status === 2, `H: status 1→2 (got ${s.status})`);
    assert(s.verified_by === 13, `H: verified_by = verifier user id 13 (got ${s.verified_by})`);
    assert(s.verified_at != null && s.verified_at > 0, `H: verified_at set (got ${s.verified_at})`);
    assert(s.updated_at != null && s.updated_at > 0 && s.updated_at >= s.verified_at, `H: updated_at updated (got ${s.updated_at})`);

    assertFkIntegrity(sqlite, 'S-H');
    H_CTX = { sqlite, db, env, s };
  }

  // =========================================================================
  // SECTION I — Repeat verification idempotency
  // =========================================================================
  section('I — Repeat verification idempotency');
  {
    const { sqlite, db, env, s: s1 } = H_CTX;

    const r2 = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_admin', user: 12, team: 21, body: { exchange_code: 'FRST00000001' } });
    assert(r2.status === 200, `I: repeat verify = 200 (got ${r2.status})`);
    assert(r2.json?.data?.status === 'already_verified', `I: status=already_verified (got ${r2.json?.data?.status})`);

    const s2 = get1(sqlite, 'SELECT verified_by, verified_at, updated_at FROM mall_orders WHERE id=7001');
    assert(s2.verified_by === s1.verified_by, `I: verified_by unchanged (got ${s2.verified_by})`);
    assert(s2.verified_at === s1.verified_at, `I: verified_at unchanged (got ${s2.verified_at})`);
    assert(s2.updated_at === s1.updated_at, `I: updated_at unchanged (got ${s2.updated_at})`);

    assertFkIntegrity(sqlite, 'S-I');
  }

  // =========================================================================
  // SECTION J — Anti-enumeration
  // =========================================================================
  section('J — Anti-enumeration');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7001, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    seedOrder(sqlite, { id: 7100, orderNo: 'B'.repeat(26), userId: 12, teamId: 22, productId: 102, exchangeCode: 'XTEAM0000001', status: 1, createdAt: 2000 }); // cross-team
    seedOrder(sqlite, { id: 7101, orderNo: 'C'.repeat(26), userId: 12, teamId: 22, productId: 102, exchangeCode: 'WRNG00000001', status: 1, createdAt: 3000 }); // wrong (belongs to team 22)
    seedOrder(sqlite, { id: 7004, orderNo: 'D'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: null, status: 1, createdAt: 4000 }); // legacy NULL
    const env = { DB: db, ENVIRONMENT: 'local' };

    const wrong = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'ZZZZZZZZZZZZ' } });
    assert(wrong.status === 404, `J: wrong code → 404 (got ${wrong.status})`);
    assert(wrong.json?.error?.code === 'NOT_FOUND', 'J: wrong code NOT_FOUND');

    const cross = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'XTEAM0000001' } });
    assert(cross.status === 404, `J: cross-team code → 404 (got ${cross.status})`);
    assert(cross.json?.error?.code === 'NOT_FOUND', 'J: cross-team code NOT_FOUND');

    const wrongTeam = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'WRNG00000001' } });
    assert(wrongTeam.status === 404, `J: code existing in other team → 404 (got ${wrongTeam.status})`);
    assert(wrongTeam.json?.error?.code === 'NOT_FOUND', 'J: other-team code NOT_FOUND');

    const legacy = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'F'.repeat(12) } });
    assert(legacy.status === 404, `J: legacy NULL unreachable by code → 404 (got ${legacy.status})`);
    assert(legacy.json?.error?.code === 'NOT_FOUND', 'J: legacy NULL NOT_FOUND');
    assert(get1(sqlite, 'SELECT exchange_code FROM mall_orders WHERE id=7004').exchange_code === null, 'J: legacy NULL still NULL');

    assertFkIntegrity(sqlite, 'S-J');
  }

  // =========================================================================
  // SECTION K — RESERVED state conflict
  // =========================================================================
  section('K — RESERVED state conflict');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7002, orderNo: 'B'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'ST3TEST00001', status: 3, createdAt: 2000 });
    seedOrder(sqlite, { id: 7003, orderNo: 'C'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'ST4TEST00001', status: 4, createdAt: 3000 });
    const env = { DB: db, ENVIRONMENT: 'local' };

    for (const [code, id] of [['ST3TEST00001', 7002], ['ST4TEST00001', 7003]]) {
      const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: code } });
      assert(r.status === 409, `K: status ${id === 7002 ? 3 : 4} → 409 (got ${r.status})`);
      assert(r.json?.error?.code === 'CONFLICT', 'K: error.code=CONFLICT');
      const reason = r.json?.error?.details?.reason ?? r.json?.details?.reason;
      assert(reason === 'mall_order_not_verifiable', `K: reason=mall_order_not_verifiable (got ${reason})`);
      assert(!/refund|cancel|expired/i.test(JSON.stringify(r.json)), 'K: body never writes refund/cancel/expired semantics');
      assert(get1(sqlite, 'SELECT status FROM mall_orders WHERE id=' + id).status === (id === 7002 ? 3 : 4), 'K: DB status unchanged (RESERVED)');
    }

    assertFkIntegrity(sqlite, 'S-K');
  }

  // =========================================================================
  // SECTION L — No accounting / stock side effects + M — DB integrity gate
  // =========================================================================
  section('L — No accounting/stock side effects');
  let L_SQLITE;
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedBase(sqlite);
    seedOrder(sqlite, { id: 7001, orderNo: 'A'.repeat(26), userId: 11, teamId: 21, productId: 101, exchangeCode: 'FRST00000001', status: 1, createdAt: 1000 });
    const env = { DB: db, ENVIRONMENT: 'local' };

    const snapshot = () => ({
      balance: get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance,
      totalSpent: get1(sqlite, 'SELECT total_spent FROM points_accounts WHERE user_id=11').total_spent,
      totalEarned: get1(sqlite, 'SELECT total_earned FROM points_accounts WHERE user_id=11').total_earned,
      totalDebits: get1(sqlite, 'SELECT total_debits FROM points_accounts WHERE user_id=11').total_debits,
      ledger: get1(sqlite, 'SELECT COUNT(*) c FROM points_ledger').c,
      stock: get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock,
      sold: get1(sqlite, 'SELECT sold_count FROM mall_products WHERE id=101').sold_count,
      code: get1(sqlite, 'SELECT exchange_code FROM mall_orders WHERE id=7001').exchange_code,
      vcode: get1(sqlite, 'SELECT verify_code FROM mall_orders WHERE id=7001').verify_code,
      points: get1(sqlite, 'SELECT points FROM mall_orders WHERE id=7001').points,
    });

    const before = snapshot();
    const r = await call(env, 'POST', '/api/v2/mall/admin/orders/verify', { role: 'team_owner', user: 13, team: 21, body: { exchange_code: 'FRST00000001' } });
    assert(r.status === 200 && r.json?.data?.status === 'verified', `L: verify = 200 verified (got ${r.status}/${r.json?.data?.status})`);
    const after = snapshot();

    // 仅允许变化：status / verified_by / verified_at / updated_at
    assert(after.balance === before.balance, `L: balance unchanged (${before.balance}→${after.balance})`);
    assert(after.totalSpent === before.totalSpent, `L: total_spent unchanged (${before.totalSpent}→${after.totalSpent})`);
    assert(after.totalEarned === before.totalEarned, `L: total_earned unchanged (${before.totalEarned}→${after.totalEarned})`);
    assert(after.totalDebits === before.totalDebits, `L: total_debits unchanged (${before.totalDebits}→${after.totalDebits})`);
    assert(after.ledger === before.ledger, `L: points_ledger count unchanged (${before.ledger}→${after.ledger})`);
    assert(after.stock === before.stock, `L: stock unchanged (${before.stock}→${after.stock})`);
    assert(after.sold === before.sold, `L: sold_count unchanged (${before.sold}→${after.sold})`);
    assert(after.code === before.code && after.code === 'FRST00000001', 'L: exchange_code unchanged');
    assert(after.vcode === before.vcode, 'L: verify_code unchanged');
    assert(after.points === before.points, `L: points unchanged (${before.points}→${after.points})`);
    const s = get1(sqlite, 'SELECT status, verified_by, verified_at, updated_at FROM mall_orders WHERE id=7001');
    assert(s.status === 2 && s.verified_by === 13 && s.verified_at != null && s.updated_at != null, 'L: only status/verified_by/verified_at/updated_at changed');

    L_SQLITE = sqlite;
  }

  // =========================================================================
  // SECTION M — DB integrity（测试结束 gate）
  // =========================================================================
  section('M — DB integrity');
  {
    assertFkIntegrity(L_SQLITE, 'S-M-final');
    const lastSectionDb = L_SQLITE;
    const fk = q(lastSectionDb, 'PRAGMA foreign_key_check');
    const ic = q(lastSectionDb, 'PRAGMA integrity_check');
    const icVal = ic.length === 1 ? Object.values(ic[0])[0] : null;
    assert(fk.length === 0 && icVal === 'ok', `M: final gate foreign_key_check=0 & integrity_check=ok (got ${fk.length}/${icVal})`);
  }

  // =========================================================================
  console.log(`\nP25 formal = ${PASS}/${PASS + FAIL} ${FAIL === 0 ? 'PASS' : 'FAIL'}`);
  if (FAIL === 0) console.log('ALL PASS');
  if (FAIL > 0) {
    console.error('FAILURES:');
    for (const f of FAILURES) console.error('  - ' + f);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  })
  .finally(() => {
    if (BUNDLE_PATH) rmSync(BUNDLE_PATH, { force: true });
  });