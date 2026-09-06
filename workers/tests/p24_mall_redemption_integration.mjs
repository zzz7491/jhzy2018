/**
 * P24-P4 正式测试：积分商城兑换（Mall）集成回归。
 *
 * 覆盖范围（依据 P24-P4 授权）：
 *   SECTION 1 — Migration / schema 正式覆盖（0001→0020，FK=ON；mall 历史表；权限 98/281 + mall 绑定）
 *   SECTION 2 — Core redemption 正式覆盖（first / same-replay / race-replay / conflict）
 *   SECTION 3 — Failure-domain 正式覆盖（insufficient / no-account / out-of-stock / inactive / deleted / wrong-team）
 *   SECTION 4 — Concurrency / invariant 正式覆盖（last stock / balance once）
 *   SECTION 5 — Real S4 rollback 正式覆盖（UNIQUE(request_id) 触发 db.batch 整体回滚）
 *   SECTION 6 — Real API app.fetch 覆盖（products / POST orders / orders list+detail / 投影安全 / points 闭环）
 *
 * 复用 P23-P5 正式测试架构：esbuild 运行时打包真实 src + node:sqlite + d1-shim + 真实 Hono app.fetch。
 * 不修改任何源码 / 迁移 / catalog / 历史 WIP；不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：
 *   node tests/p24_mall_redemption_integration.mjs
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
export { MallService } from './src/services/mall-service';
export { MallRedemptionRepository } from './src/repository/mall-redemption';
`;

async function loadImpl() {
  const entryPath = join(WORKERS, '.p24_bundle_entry.ts');
  writeFileSync(entryPath, BUNDLE_ENTRY);
  const bundlePath = join(tmpdir(), `p24_bundle_${process.pid}_${Date.now()}.mjs`);
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

// 应用全部当前 migration（FK OFF 应用，避免应用期 FK 顺序问题）
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

// 完整当前 schema DB（0001→0020），FK 开启
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

// 在所有 mutation 场景结束后强制校验：无 orphan、无损坏（FK 全程保持 ON，禁止为 fixture 关闭）
function assertFkIntegrity(sqlite, label) {
  const fk = q(sqlite, 'PRAGMA foreign_key_check');
  assert(fk.length === 0, `${label}: foreign_key_check = 0 after mutations (got ${fk.length})`);
  const ic = q(sqlite, 'PRAGMA integrity_check');
  const icVal = ic.length === 1 ? Object.values(ic[0])[0] : null;
  assert(icVal === 'ok', `${label}: integrity_check = ok after mutations (got ${icVal})`);
}

// ---- 种子 helpers ----
function ensureUser(sqlite, id, teamId) {
  run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [id, generateUlid(), 'u' + id]);
}
function seedTeam(sqlite, id, ownerId) {
  ensureUser(sqlite, ownerId, id);
  run(sqlite, 'INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', [id, generateUlid(), 'team' + id, ownerId]);
}
function seedAccount(sqlite, userId, balance, totalEarned = balance, totalSpent = 0) {
  run(sqlite, 'INSERT OR IGNORE INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (?,?,?,?,0,0)', [userId, balance, totalEarned, totalSpent]);
}
function seedFile(sqlite, id, teamId, publicId) {
  run(sqlite, 'INSERT OR IGNORE INTO files (id, public_id, team_id, object_key, mime_type, created_at) VALUES (?,?,?,?,?,0)', [id, publicId, teamId, 'obj' + id, 'image/png']);
}
function seedProduct(sqlite, o) {
  run(sqlite, `INSERT OR IGNORE INTO mall_products
    (id, public_id, team_id, title, cover_file_id, detail, points_price, stock, sold_count, status, sort, created_at, updated_at, deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    o.id, o.publicId, o.teamId, o.title ?? 'p', o.coverFileId ?? null, o.detail ?? null,
    o.pointsPrice, o.stock, o.soldCount ?? 0, o.status ?? 1, o.sort ?? 0, o.createdAt ?? 1000, o.updatedAt ?? null, o.deletedAt ?? null,
  ]);
}

// FK-safe 活动链 → service_records → points_ledger(source_type='service_record')。
// 复用 P23 已验证的 seed pattern；全部 FK 在 FK=ON 下合法，绝不关闭 FK 注入 orphan。
function seedServiceRecordChain(sqlite, o) {
  const { userId, teamId, activityId, sessionId, signupId, participationId, occurrenceId, srId, srPub, pointsAwarded } = o;
  run(sqlite, 'INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', [199, generateUlid(), 'u199']);
  run(sqlite, `INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status, points_multiplier_pct, max_session_minutes, created_by)
    VALUES (?,?,?,?,0,0,1,?,?,?)`, [activityId, generateUlid(), teamId, 'a', 100, null, 199]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status) VALUES (?,?,?,0,1,1)', [occurrenceId, generateUlid(), activityId]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_signups (id, user_id, activity_id, status) VALUES (?,?,?,1)', [signupId, userId, activityId]);
  run(sqlite, 'INSERT OR IGNORE INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) VALUES (?,?,?,?,1,0)', [participationId, generateUlid(), signupId, occurrenceId]);
  run(sqlite, `INSERT OR IGNORE INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot, checkin_at, checkout_at, status, review_status, business_service_date, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'',?,?,?,?,?,0,0)`, [
    sessionId, signupId, activityId, userId, teamId, participationId,
    1000,
    3700,
    2,
    0,
    '2026-09-01',
  ]);
  run(sqlite, `INSERT INTO service_records
    (id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, settlement_status, points_awarded_units, public_id, business_service_date, created_at, updated_at, points_revision)
    VALUES (?,?,?,?,?,1,'auto',1,0,1,1,?,?, '2026-09-01',0,0,1)`,
    [srId, sessionId, userId, teamId, activityId, pointsAwarded, srPub]);
  return srId;
}

const NOW = Math.floor(Date.now() / 1000);

function makeMallService(db, userId, teamId) {
  return new IMPL.MallService({
    db,
    auth: { authenticated: true, userId, teamId, role: 'volunteer' },
    tenant: { scope: 'TEAM_SCOPED', teamId, userId },
  });
}

let IMPL;
let BUNDLE_PATH;

async function main() {
  const loaded = await loadImpl();
  IMPL = loaded.mod;
  BUNDLE_PATH = loaded.bundlePath;

  // =========================================================================
  // SECTION 1 — Migration / schema 正式覆盖（0001→0020，FK=ON）
  // =========================================================================
  section('1 — Migration / schema (0001→0020, FK=ON)');
  {
    const { sqlite } = freshCurrentRuntimeDb();
    const fk = q(sqlite, 'PRAGMA foreign_key_check');
    assert(fk.length === 0, `S1: foreign_key_check = 0 (got ${fk.length})`);

    const ic = q(sqlite, 'PRAGMA integrity_check');
    const icVal = ic.length === 1 ? Object.values(ic[0])[0] : null;
    assert(icVal === 'ok', `S1: integrity_check = ok (got ${icVal})`);

    // mall 两表来自历史 schema（0001）
    const mpCols = q(sqlite, "PRAGMA table_info(mall_products)").map((c) => c.name);
    assert(mpCols.includes('public_id'), 'S1: mall_products.public_id exists');
    assert(mpCols.includes('points_price'), 'S1: mall_products.points_price exists');
    assert(mpCols.includes('stock'), 'S1: mall_products.stock exists');
    const moCols = q(sqlite, 'PRAGMA table_info(mall_orders)').map((c) => c.name);
    assert(moCols.includes('order_no'), 'S1: mall_orders.order_no exists');
    assert(moCols.includes('verify_code'), 'S1: mall_orders.verify_code exists');

    // 权限计数冻结值
    const permCount = get1(sqlite, 'SELECT COUNT(*) c FROM permissions').c;
    const rpCount = get1(sqlite, 'SELECT COUNT(*) c FROM role_permissions').c;
    assert(permCount === 98, `S1: permissions = 98 (got ${permCount})`);
    assert(rpCount === 281, `S1: role_permissions = 281 (got ${rpCount})`);

    const mallPerms = q(sqlite, `SELECT code FROM permissions WHERE code IN ('mall.product.read','mall.order.read','mall.order.create')`).map((r) => r.code).sort();
    assert(JSON.stringify(mallPerms) === JSON.stringify(['mall.order.create', 'mall.order.read', 'mall.product.read']), `S1: 3 mall perms present (got ${JSON.stringify(mallPerms)})`);

    function mallBindingsFor(roleCode) {
      return get1(sqlite, `SELECT COUNT(*) c FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.code=? AND p.perm_group='mall'`, [roleCode]).c;
    }
    function totalBindingsFor(roleCode) {
      return get1(sqlite, `SELECT COUNT(*) c FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.code=?`, [roleCode]).c;
    }
    assert(mallBindingsFor('volunteer') === 3, `S1: volunteer mall bindings = 3 (got ${mallBindingsFor('volunteer')})`);
    assert(mallBindingsFor('platform_super_admin') === 3, `S1: platform_super_admin mall bindings = 3 (got ${mallBindingsFor('platform_super_admin')})`);
    assert(mallBindingsFor('platform_operator') === 0, `S1: platform_operator mall bindings = 0 (got ${mallBindingsFor('platform_operator')})`);
    assert(mallBindingsFor('team_owner') === 0, `S1: team_owner mall bindings = 0 (got ${mallBindingsFor('team_owner')})`);
    assert(mallBindingsFor('team_admin') === 0, `S1: team_admin mall bindings = 0 (got ${mallBindingsFor('team_admin')})`);
    assert(mallBindingsFor('team_auditor') === 0, `S1: team_auditor mall bindings = 0 (got ${mallBindingsFor('team_auditor')})`);
    assert(totalBindingsFor('volunteer') === 30, `S1: volunteer total bindings = 30 (got ${totalBindingsFor('volunteer')})`);
    assert(totalBindingsFor('platform_super_admin') === 98, `S1: platform_super_admin total bindings = 98 (got ${totalBindingsFor('platform_super_admin')})`);
  }

  // =========================================================================
  // SECTION 2 — Core redemption 正式覆盖（via MallService + MallRedemptionRepository）
  // =========================================================================
  section('2 — Core redemption (MallService)');

  let A_FIRST;
  // A. first exchange（price=300, balance=1000, stock=5）
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1 });
    const orderNo = generateUlid();
    const svc = makeMallService(db, 11, 21);
    const out = await svc.redeem({ productPublicId: P1, orderNo });
    assert(out.status === 'created', `A: status=created (got ${out.status})`);
    assert(out.orderNo === orderNo, `A: orderNo echoed (got ${out.orderNo})`);

    const order = get1(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]);
    assert(order != null, 'A: mall_order created');
    assert(order.points === 300, `A: order.points=300 (got ${order && order.points})`);
    assert(order.status === 1, `A: order.status=1 (got ${order && order.status})`);

    const acct = get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=11');
    assert(acct.balance === 700, `A: balance=700 (got ${acct.balance})`);
    assert(acct.total_spent === 300, `A: total_spent=300 (got ${acct.total_spent})`);
    assert(acct.total_earned === 1000, `A: total_earned unchanged=1000 (got ${acct.total_earned})`);
    assert(acct.total_debits === 0, `A: total_debits unchanged=0 (got ${acct.total_debits})`);

    const prod = get1(sqlite, 'SELECT * FROM mall_products WHERE id=101');
    assert(prod.stock === 4, `A: stock=4 (got ${prod.stock})`);
    assert(prod.sold_count === 1, `A: sold_count=1 (got ${prod.sold_count})`);

    const led = q(sqlite, "SELECT * FROM points_ledger WHERE source_type='mall_order' AND request_id=?", ['ex:' + orderNo]);
    assert(led.length === 1, `A: 1 exchange ledger (got ${led.length})`);
    assert(led[0].direction === 2, `A: ledger direction=2 (got ${led[0].direction})`);
    assert(led[0].amount === 300, `A: ledger amount=300 (got ${led[0].amount})`);
    assert(led[0].balance_after === 700, `A: ledger balance_after=700 (got ${led[0].balance_after})`);
    assert(led[0].type === 'exchange', `A: ledger type=exchange (got ${led[0].type})`);
    assert(led[0].source_type === 'mall_order', `A: ledger source_type=mall_order (got ${led[0].source_type})`);

    // 回填供后续同身份幂等测试使用
    A_FIRST = { sqlite, db, P1, orderNo };
  }

  // B. same-order idempotent replay（同 user/team/product/orderNo → existing，零二次副作用）
  {
    const { sqlite, db, P1, orderNo } = A_FIRST;
    const svc = makeMallService(db, 11, 21);
    const out = await svc.redeem({ productPublicId: P1, orderNo });
    assert(out.status === 'existing', `B: status=existing (got ${out.status})`);
    const orders = q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]);
    assert(orders.length === 1, `B: orders unchanged=1 (got ${orders.length})`);
    const acct = get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=11');
    assert(acct.balance === 700, `B: balance unchanged=700 (got ${acct.balance})`);
    assert(acct.total_spent === 300, `B: total_spent unchanged=300 (got ${acct.total_spent})`);
    const prod = get1(sqlite, 'SELECT * FROM mall_products WHERE id=101');
    assert(prod.stock === 4, `B: stock unchanged=4 (got ${prod.stock})`);
    assert(prod.sold_count === 1, `B: sold_count unchanged=1 (got ${prod.sold_count})`);
    assert(q(sqlite, "SELECT * FROM points_ledger WHERE source_type='mall_order' AND request_id=?", ['ex:' + orderNo]).length === 1, 'B: ledger unchanged=1');
  }

  // C. race-style replay（pre-read 不存在，batch 时旧订单已出现 → existing，无二次副作用）
  {
    const { sqlite, db, P1, orderNo } = A_FIRST;
    const svc = makeMallService(db, 11, 21);
    const out = await svc.redeem({ productPublicId: P1, orderNo });
    assert(out.status === 'existing', `C: race-loser status=existing (got ${out.status})`);
    const acct = get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=11');
    assert(acct.balance === 700, `C: balance unchanged=700 (got ${acct.balance})`);
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 4, `C: stock unchanged=4`);
    assert(q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]).length === 1, `C: orders unchanged=1`);
  }

  // D. conflict — 不同 user 复用同 orderNo → 409 public_id_conflict
  {
    const { sqlite, db, P1, orderNo } = A_FIRST;
    ensureUser(sqlite, 12, 21);
    seedAccount(sqlite, 12, 1000, 1000, 0);
    const svc = makeMallService(db, 12, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo });
    } catch (e) {
      err = e;
    }
    assert(err != null, 'D: different-user conflict threw');
    assert(err.status === 409 && err.details && err.details.reason === 'public_id_conflict', `D: 409 public_id_conflict (got ${err && err.status}/${err && err.details && err.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]).length === 1, 'D: no extra order created');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=12').balance === 1000, 'D: user12 balance unchanged');
  }

  // E. conflict — 不同 product 复用同 orderNo → 409 public_id_conflict
  {
    const { sqlite, db, orderNo } = A_FIRST;
    const P2 = generateUlid();
    seedProduct(sqlite, { id: 102, publicId: P2, teamId: 21, pointsPrice: 300, stock: 5, sort: 2 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P2, orderNo });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 409 && err.details && err.details.reason === 'public_id_conflict', `E: 409 public_id_conflict (got ${err && err.status}/${err && err.details && err.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]).length === 1, 'E: no extra order created');
    assertFkIntegrity(sqlite, 'S2-core');
  }

  // =========================================================================
  // SECTION 3 — Failure-domain 正式覆盖
  // =========================================================================
  section('3 — Failure-domain');

  // F. insufficient balance → 409 mall_insufficient_balance，无 mutation
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 100, 100, 0); // balance=100 < price=300
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 409 && err.details && err.details.reason === 'mall_insufficient_balance', `F: 409 mall_insufficient_balance (got ${err && err.status}/${err && err.details && err.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders').length === 0, 'F: no order created');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 100, 'F: balance unchanged');
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 5, 'F: stock unchanged');
    assertFkIntegrity(sqlite, 'S3-F');
  }

  // G. no account → 同样 mall_insufficient_balance，且不得创建 account
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    // 无 points_accounts 行
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 409 && err.details && err.details.reason === 'mall_insufficient_balance', `G: 409 mall_insufficient_balance (no account) (got ${err && err.status}/${err && err.details && err.details.reason})`);
    assert(get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=11') == null, 'G: no account auto-created');
    assertFkIntegrity(sqlite, 'S3-G');
  }

  // H. stock=0 → 409 mall_out_of_stock，无 mutation
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 0, sort: 1 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 409 && err.details && err.details.reason === 'mall_out_of_stock', `H: 409 mall_out_of_stock (got ${err && err.status}/${err && err.details && err.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders').length === 0, 'H: no order created');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 1000, 'H: balance unchanged');
    assertFkIntegrity(sqlite, 'S3-H');
  }

  // I. inactive product (status=2) → 404
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1, status: 2 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 404, `I: inactive product → 404 (got ${err && err.status})`);
    assertFkIntegrity(sqlite, 'S3-I');
  }

  // J. deleted product (deleted_at set) → 404
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1, deletedAt: 123 });
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 404, `J: deleted product → 404 (got ${err && err.status})`);
    assertFkIntegrity(sqlite, 'S3-J');
  }

  // K. wrong-team product → 404（不泄露存在性）
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    seedTeam(sqlite, 99, 198);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 99, pointsPrice: 300, stock: 5, sort: 1 }); // 属 team 99
    const svc = makeMallService(db, 11, 21);
    let err = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err = e;
    }
    assert(err != null && err.status === 404, `K: wrong-team product → 404 (got ${err && err.status})`);
    assertFkIntegrity(sqlite, 'S3-K');
  }

  // =========================================================================
  // SECTION 4 — Concurrency / invariant 正式覆盖
  // =========================================================================
  section('4 — Concurrency / invariant');

  // L. last stock（stock=1，两个兑换者争 → exactly 1 order / 1 debit / 1 stock decrement / 1 ledger / stock=0）
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    ensureUser(sqlite, 12, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    seedAccount(sqlite, 12, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 1, sort: 1 });
    const svcA = makeMallService(db, 11, 21);
    const svcB = makeMallService(db, 12, 21);
    const outA = await svcA.redeem({ productPublicId: P1, orderNo: generateUlid() });
    assert(outA.status === 'created', `L: first succeeds (got ${outA.status})`);
    let errB = null;
    try {
      await svcB.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      errB = e;
    }
    assert(errB != null && errB.status === 409 && errB.details && errB.details.reason === 'mall_out_of_stock', `L: second → 409 mall_out_of_stock (got ${errB && errB.status}/${errB && errB.details && errB.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders').length === 1, `L: exactly 1 order (got ${q(sqlite, 'SELECT * FROM mall_orders').length})`);
    assert(get1(sqlite, 'SELECT COUNT(*) c FROM points_ledger WHERE source_type=\'mall_order\'').c === 1, 'L: exactly 1 ledger');
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 0, 'L: stock=0');
    assert(get1(sqlite, 'SELECT sold_count FROM mall_products WHERE id=101').sold_count === 1, 'L: sold_count=1');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 700, 'L: user11 debited to 700');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=12').balance === 1000, 'L: user12 unchanged');
    assertFkIntegrity(sqlite, 'S4-L');
  }

  // M. balance only enough once（同用户两个不同 orderNo，余额仅够一次）
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 300, 300, 0); // balance=300 = 恰好够一次 price=300
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1 });
    const svc = makeMallService(db, 11, 21);
    const out1 = await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    assert(out1.status === 'created', `M: first created (got ${out1.status})`);
    let err2 = null;
    try {
      await svc.redeem({ productPublicId: P1, orderNo: generateUlid() });
    } catch (e) {
      err2 = e;
    }
    assert(err2 != null && err2.status === 409 && err2.details && err2.details.reason === 'mall_insufficient_balance', `M: second → 409 mall_insufficient_balance (got ${err2 && err2.status}/${err2 && err2.details && err2.details.reason})`);
    assert(q(sqlite, 'SELECT * FROM mall_orders').length === 1, `M: exactly 1 order (got ${q(sqlite, 'SELECT * FROM mall_orders').length})`);
    assert(get1(sqlite, 'SELECT COUNT(*) c FROM points_ledger WHERE source_type=\'mall_order\'').c === 1, 'M: exactly 1 ledger');
    assert(get1(sqlite, 'SELECT stock FROM mall_products WHERE id=101').stock === 4, 'M: exactly 1 stock decrement');
    assert(get1(sqlite, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 0, 'M: balance >= 0 (0)');
    assertFkIntegrity(sqlite, 'S4-M');
  }

  // =========================================================================
  // SECTION 5 — Real S4 rollback 正式覆盖
  // =========================================================================
  section('5 — Real S4 rollback (UNIQUE(request_id) → full batch rollback)');
  {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    ensureUser(sqlite, 11, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    const P1 = generateUlid();
    seedProduct(sqlite, { id: 101, publicId: P1, teamId: 21, pointsPrice: 300, stock: 5, sort: 1 });
    const orderNo = generateUlid();
    // 预插真实 points_ledger 行，其 request_id = 'ex:' + orderNo → S4 命中 UNIQUE 约束
    run(sqlite, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at)
      VALUES (11, 2, 300, 700, 'exchange', 'mall_order', NULL, ?, 'exchange', NULL, 0)`, ['ex:' + orderNo]);

    const svc = makeMallService(db, 11, 21);
    let threw = false;
    try {
      await svc.redeem({ productPublicId: P1, orderNo });
    } catch {
      threw = true;
    }
    assert(threw, 'S4: redeem threw on UNIQUE(request_id)');

    // 回滚断言
    assert(q(sqlite, 'SELECT * FROM mall_orders WHERE order_no=?', [orderNo]).length === 0, 'S4: new mall_order = 0');
    const acct = get1(sqlite, 'SELECT * FROM points_accounts WHERE user_id=11');
    assert(acct.balance === 1000, `S4: balance = before (1000, got ${acct.balance})`);
    assert(acct.total_spent === 0, `S4: total_spent = before (0, got ${acct.total_spent})`);
    const prod = get1(sqlite, 'SELECT * FROM mall_products WHERE id=101');
    assert(prod.stock === 5, `S4: stock = before (5, got ${prod.stock})`);
    assert(prod.sold_count === 0, `S4: sold_count = before (0, got ${prod.sold_count})`);
    // 仅预插的那一行（request_id 唯一），无新增
    assert(q(sqlite, "SELECT * FROM points_ledger WHERE source_type='mall_order' AND request_id=?", ['ex:' + orderNo]).length === 1, 'S4: new exchange ledger = 0 (only seed row)');
    const fk2 = q(sqlite, 'PRAGMA foreign_key_check');
    assert(fk2.length === 0, `S4: foreign_key_check = 0 (got ${fk2.length})`);
    assertFkIntegrity(sqlite, 'S5');
  }

  // =========================================================================
  // SECTION 6 — Real API app.fetch 覆盖
  // =========================================================================
  section('6 — Real API (createApp + app.fetch)');

  // 准备共享种子（team 21 商品 + team 99 跨团商品 + 用户/账户/文件）
  const api = (() => {
    const { sqlite, db } = freshCurrentRuntimeDb();
    seedTeam(sqlite, 21, 199);
    seedTeam(sqlite, 99, 198);
    for (const u of [11, 12, 13]) ensureUser(sqlite, u, 21);
    seedAccount(sqlite, 11, 1000, 1000, 0);
    seedAccount(sqlite, 12, 1000, 1000, 0);
    seedFile(sqlite, 901, 21, generateUlid()); // 封面文件（team 21）
    const filePid = get1(sqlite, 'SELECT public_id FROM files WHERE id=901').public_id;

    // team 21 商品（确定性排序：sort ASC, created_at DESC, id DESC）
    const PC = generateUlid(); // sort=5, created_at=200
    const PB = generateUlid(); // sort=5, created_at=100
    const PA = generateUlid(); // sort=10, created_at=100
    const PD = generateUlid(); // sort=20, created_at=100, stock=0 (in_stock=false)
    const PE = generateUlid(); // sort=1, created_at=100, status=2 (inactive)
    const PF = generateUlid(); // sort=1, created_at=100, deleted
    seedProduct(sqlite, { id: 101, publicId: PC, teamId: 21, title: 'C', pointsPrice: 300, stock: 4, sort: 5, createdAt: 200, coverFileId: 901 });
    seedProduct(sqlite, { id: 102, publicId: PB, teamId: 21, title: 'B', pointsPrice: 200, stock: 2, sort: 5, createdAt: 100 });
    seedProduct(sqlite, { id: 103, publicId: PA, teamId: 21, title: 'A', pointsPrice: 100, stock: 3, sort: 10, createdAt: 100 });
    seedProduct(sqlite, { id: 104, publicId: PD, teamId: 21, title: 'D', pointsPrice: 50, stock: 0, sort: 20, createdAt: 100 });
    seedProduct(sqlite, { id: 105, publicId: PE, teamId: 21, title: 'E', pointsPrice: 50, stock: 5, sort: 1, createdAt: 100, status: 2 });
    seedProduct(sqlite, { id: 106, publicId: PF, teamId: 21, title: 'F', pointsPrice: 50, stock: 5, sort: 1, createdAt: 100, deletedAt: 123 });
    // team 99 跨团商品（不应出现在 team 21 列表）
    const PX = generateUlid();
    seedProduct(sqlite, { id: 991, publicId: PX, teamId: 99, title: 'X', pointsPrice: 100, stock: 5, sort: 1 });

    const app = IMPL.createApp();
    const env = { DB: db, ENVIRONMENT: 'local' };
    return { sqlite, db, app, env, filePid, PC, PB, PA, PD, PE, PF, PX };
  })();

  const { sqlite: AS, app, env } = api;
  async function call(method, path, opts = {}) {
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
  const PRODUCT_FORBIDDEN = ['id', 'team_id', 'cover_file_id', 'stock', 'sold_count'];
  const ORDER_FORBIDDEN = ['verify_code', 'id', 'user_id', 'team_id', 'product_id', 'verified_by'];
  const TX_FORBIDDEN = ['id', 'user_id', 'source_id', 'operator_id', 'request_id'];
  const noForbidden = (item, keys) => !keys.some((k) => k in (item || {}));

  // 6.1 GET /products 成功路径 + 投影 + 确定性排序 + 跨团不可见
  {
    const r = await call('GET', '/api/v2/mall/products', { role: 'volunteer', user: 11, team: 21 });
    assert(r.status === 200, `6.1: products GET 200 (got ${r.status})`);
    const items = r.json.data.items;
    // 仅 team21 active 未删除：PC/PB/PA/PD（PE inactive, PF deleted, PX 跨团排除）
    assert(items.length === 4, `6.1: only own-team active undeleted (got ${items.length})`);
    const order = items.map((i) => i.public_id);
    assert(JSON.stringify(order) === JSON.stringify([api.PC, api.PB, api.PA, api.PD]), `6.1: deterministic order sort ASC,created_at DESC,id DESC (got ${order})`);
    // in_stock boolean，PD=false
    const pdItem = items.find((i) => i.public_id === api.PD);
    assert(pdItem.in_stock === false, `6.1: PD in_stock=false (got ${pdItem.in_stock})`);
    assert(items.filter((i) => i.in_stock === true).length === 3, '6.1: 3 in_stock true');
    // cover_public_id 投影（PC 有封面）
    const pcItem = items.find((i) => i.public_id === api.PC);
    assert(pcItem.cover_public_id === api.filePid, `6.1: cover_public_id projected (got ${pcItem.cover_public_id})`);
    assert(pcItem.points_price_units === 300 && typeof pcItem.points_price_units === 'number', `6.1: points_price_units=300 (got ${pcItem.points_price_units})`);
    // 投影安全：无内部字段
    assert(items.every((i) => noForbidden(i, PRODUCT_FORBIDDEN)), '6.1: products hide internal keys');
    assert(!('stock' in pdItem) && !('detail' in pdItem) === false, '6.1: detail key present, stock absent');
    assert(!('stock' in pdItem), '6.1: no exact stock key');
  }

  // 6.2 产品权限 / team scope
  {
    const cross = await call('GET', '/api/v2/mall/products', { role: 'volunteer', user: 11, team: 21 });
    const crossItems = cross.json.data.items;
    assert(!crossItems.some((i) => i.public_id === api.PX), '6.2: cross-team product invisible');
    const supNoTeam = await call('GET', '/api/v2/mall/products', { role: 'platform_super_admin', user: 11 });
    assert(supNoTeam.status === 403, `6.2: super no team → 403 (got ${supNoTeam.status})`);
    const supTeam = await call('GET', '/api/v2/mall/products', { role: 'platform_super_admin', user: 11, team: 21 });
    assert(supTeam.status === 200, `6.2: super active team → 200 (got ${supTeam.status})`);
    const noPerm = await call('GET', '/api/v2/mall/products', { role: 'platform_operator', user: 11, team: 21 });
    assert(noPerm.status === 403, `6.2: missing permission → 403 (got ${noPerm.status})`);
    const unauth = await call('GET', '/api/v2/mall/products', {});
    assert(unauth.status === 401, `6.2: unauth → 401 (got ${unauth.status})`);
  }

  // 6.3 POST /orders 成功 + 副作用 + 幂等 + 校验
  let createdOrderNo;
  {
    const body = { product_public_id: api.PC, order_no: generateUlid() };
    const r = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body });
    assert(r.status === 201, `6.3: POST first → 201 (got ${r.status})`);
    assert(r.json.data && r.json.data.orderNo === body.order_no, `6.3: returns {orderNo} (got ${r.json.data && r.json.data.orderNo})`);
    createdOrderNo = r.json.data.orderNo;
    // 真实四表副作用
    const order = get1(AS, 'SELECT * FROM mall_orders WHERE order_no=?', [createdOrderNo]);
    assert(order != null && order.points === 300, `6.3: order points=300 (got ${order && order.points})`);
    assert(get1(AS, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 700, '6.3: balance debited 1000→700');
    assert(get1(AS, 'SELECT total_spent FROM points_accounts WHERE user_id=11').total_spent === 300, '6.3: total_spent=300');
    assert(get1(AS, 'SELECT stock FROM mall_products WHERE id=101').stock === 3, '6.3: stock 4→3');
    assert(get1(AS, 'SELECT COUNT(*) c FROM points_ledger WHERE source_type=\'mall_order\'').c === 1, '6.3: ledger exchange added');

    // 同一 orderNo 重试 → 200 existing，无二次副作用
    const r2 = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PC, order_no: createdOrderNo } });
    assert(r2.status === 200, `6.3: same replay → 200 (got ${r2.status})`);
    assert(get1(AS, 'SELECT balance FROM points_accounts WHERE user_id=11').balance === 700, '6.3: replay no second debit');
    assert(get1(AS, 'SELECT COUNT(*) c FROM points_ledger WHERE source_type=\'mall_order\'').c === 1, '6.3: replay no second ledger');
  }

  // 6.4 POST 校验：forbidden / invalid ulid / unknown-ignored
  {
    const f1 = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PC, order_no: generateUlid(), quantity: 1 } });
    assert(f1.status === 400, `6.4: forbidden field quantity → 400 (got ${f1.status})`);
    const f2 = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: 'bad', order_no: generateUlid() } });
    assert(f2.status === 400, `6.4: invalid product_public_id → 400 (got ${f2.status})`);
    const f3 = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PC, order_no: 'bad' } });
    assert(f3.status === 400, `6.4: invalid order_no → 400 (got ${f3.status})`);
    const okUnknown = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PC, order_no: generateUlid(), note: 'ignored' } });
    assert(okUnknown.status === 201, `6.4: unrelated unknown field ignored → 201 (got ${okUnknown.status})`);
  }

  // 6.5 POST 业务失败：insufficient / out-of-stock / wrong-team / inactive / deleted / conflict
  {
    // 余额不足
    const u13 = 13; ensureUser(AS, u13, 21); seedAccount(AS, u13, 100, 100, 0);
    const ins = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: u13, team: 21, body: { product_public_id: api.PC, order_no: generateUlid() } });
    assert(ins.status === 409 && ins.json.error.details.reason === 'mall_insufficient_balance', `6.5: insufficient → 409 mall_insufficient_balance (got ${ins.status}/${ins.json.error.details.reason})`);
    // 缺货（PD stock=0）
    const oos = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PD, order_no: generateUlid() } });
    assert(oos.status === 409 && oos.json.error.details.reason === 'mall_out_of_stock', `6.5: out-of-stock → 409 mall_out_of_stock (got ${oos.status}/${oos.json.error.details.reason})`);
    // 跨团商品
    const wt = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PX, order_no: generateUlid() } });
    assert(wt.status === 404, `6.5: wrong-team product → 404 (got ${wt.status})`);
    // 下架商品
    const ina = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PE, order_no: generateUlid() } });
    assert(ina.status === 404, `6.5: inactive product → 404 (got ${ina.status})`);
    // 已删除商品
    const del = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PF, order_no: generateUlid() } });
    assert(del.status === 404, `6.5: deleted product → 404 (got ${del.status})`);
    // orderNo 冲突：user12 复用 createdOrderNo
    const conf = await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 12, team: 21, body: { product_public_id: api.PC, order_no: createdOrderNo } });
    assert(conf.status === 409 && conf.json.error.details.reason === 'public_id_conflict', `6.5: orderNo conflict → 409 public_id_conflict (got ${conf.status}/${conf.json.error.details.reason})`);
  }

  // 6.6 GET /orders 列表（SELF+TEAM、确定性排序、分页、?user_id/?team_id 不可覆盖、投影）
  {
    // 为 user11 再兑换两单（共 3 单），使用 PC（stock 充足，已扣 1，剩 3）
    for (let i = 0; i < 2; i++) {
      await call('POST', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21, body: { product_public_id: api.PC, order_no: generateUlid() } });
    }
    const list = await call('GET', '/api/v2/mall/orders', { role: 'volunteer', user: 11, team: 21 });
    assert(list.status === 200, `6.6: orders list 200 (got ${list.status})`);
    const items = list.json.data.items;
    assert(items.length === 3, `6.6: SELF sees only own 3 (got ${items.length})`);
    assert(list.json.data.pagination.total === 3, `6.6: pagination.total=3 (got ${list.json.data.pagination.total})`);
    // 确定性排序 created_at DESC, id DESC
    const createdDesc = items.every((it, i) => i === 0 || items[i - 1].created_at >= it.created_at);
    assert(createdDesc, '6.6: created_at DESC order');
    // 投影安全（无 verify_code / 内部 id）
    assert(items.every((i) => noForbidden(i, ORDER_FORBIDDEN)), '6.6: orders hide internal keys');
    assert(items.every((i) => typeof i.points_units === 'number'), '6.6: points_units numeric');

    // ?user_id=12 不可覆盖
    const override = await call('GET', '/api/v2/mall/orders?user_id=12', { role: 'volunteer', user: 11, team: 21 });
    assert(override.json.data.items.length === 3, `6.6: ?user_id=12 ignored → still 3 (got ${override.json.data.items.length})`);
    // ?team_id=99 不可覆盖
    const overrideT = await call('GET', '/api/v2/mall/orders?team_id=99', { role: 'volunteer', user: 11, team: 21 });
    assert(overrideT.json.data.items.length === 3, `6.6: ?team_id=99 ignored → still 3 (got ${overrideT.json.data.items.length})`);

    // 分页 page_size=2
    const p1 = await call('GET', '/api/v2/mall/orders?page=1&page_size=2', { role: 'volunteer', user: 11, team: 21 });
    assert(p1.json.data.items.length === 2, `6.6: page1 size2 → 2 (got ${p1.json.data.items.length})`);
    assert(p1.json.data.pagination.total_pages === 2, `6.6: total_pages=2 (got ${p1.json.data.pagination.total_pages})`);
    const p2 = await call('GET', '/api/v2/mall/orders?page=2&page_size=2', { role: 'volunteer', user: 11, team: 21 });
    assert(p2.json.data.items.length === 1, `6.6: page2 → 1 (got ${p2.json.data.items.length})`);
    const cap = await call('GET', '/api/v2/mall/orders?page_size=9999', { role: 'volunteer', user: 11, team: 21 });
    assert(cap.json.data.pagination.page_size === 100, `6.6: page_size clamped 100 (got ${cap.json.data.pagination.page_size})`);
    const neg = await call('GET', '/api/v2/mall/orders?page_size=-3', { role: 'volunteer', user: 11, team: 21 });
    assert(neg.status === 400, `6.6: negative page_size → 400 (got ${neg.status})`);
  }

  // 6.7 GET /orders/:orderNo 详情（own=200；other-user/other-team/nonexistent=404；invalid=400；投影同 list）
  {
    const own = await call('GET', '/api/v2/mall/orders/' + createdOrderNo, { role: 'volunteer', user: 11, team: 21 });
    assert(own.status === 200, `6.7: own detail 200 (got ${own.status})`);
    assert(own.json.data.order_no === createdOrderNo, '6.7: detail order_no matches');
    assert(noForbidden(own.json.data, ORDER_FORBIDDEN), '6.7: detail hides internal keys');

    const otherUser = await call('GET', '/api/v2/mall/orders/' + createdOrderNo, { role: 'volunteer', user: 12, team: 21 });
    assert(otherUser.status === 404, `6.7: other user → 404 (got ${otherUser.status})`);
    const otherTeam = await call('GET', '/api/v2/mall/orders/' + createdOrderNo, { role: 'volunteer', user: 11, team: 99 });
    assert(otherTeam.status === 404, `6.7: other team → 404 (got ${otherTeam.status})`);
    const nonexist = await call('GET', '/api/v2/mall/orders/' + generateUlid(), { role: 'volunteer', user: 11, team: 21 });
    assert(nonexist.status === 404, `6.7: nonexistent → 404 (got ${nonexist.status})`);
    const invalid = await call('GET', '/api/v2/mall/orders/not-a-ulid', { role: 'volunteer', user: 11, team: 21 });
    assert(invalid.status === 400, `6.7: invalid ULID → 400 (got ${invalid.status})`);
  }

  // 6.8 Points API closure：兑换后 GET /points/transactions 出现 mall_order → order_no，且保留 service_record 投影
  {
    const tx = await call('GET', '/api/v2/points/transactions', { role: 'volunteer', user: 11, team: 21 });
    assert(tx.status === 200, `6.8: transactions 200 (got ${tx.status})`);
    const items = tx.json.data.items;
    const mallRow = items.find((i) => i.source_type === 'mall_order' && i.source_public_id === createdOrderNo);
    assert(mallRow != null, '6.8: mall_order row present for createdOrderNo');
    assert(mallRow.source_public_id === createdOrderNo, `6.8: source_public_id = order_no (got ${mallRow && mallRow.source_public_id})`);
    assert(mallRow.direction === 2, `6.8: direction=2 (got ${mallRow && mallRow.direction})`);
    assert(mallRow.amount_units === 300, `6.8: amount_units=300 (got ${mallRow && mallRow.amount_units})`);
    assert(noForbidden(mallRow, TX_FORBIDDEN), '6.8: ledger hides internal keys');

    // 预插一条真实 FK-safe service_record 流水，证明 P24 的 JOIN 没破坏 P23 投影。
    // 全程 FK=ON；通过完整活动链（users/teams/activities/occurrences/signups/participations/sessions）
    // 构造合法 service_records 行，再插入 points_ledger(source_type='service_record')。绝不为 fixture 关闭 FK。
    const srId = 7777;
    const srPub = generateUlid();
    seedServiceRecordChain(AS, {
      userId: 11, teamId: 21,
      activityId: 93001, sessionId: 97777, signupId: 955001,
      participationId: 956001, occurrenceId: 939001, srId, srPub, pointsAwarded: 75,
    });
    run(AS, `INSERT INTO points_ledger (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at)
      VALUES (11,1,75,775,'service','service_record',?, 'svc:sr:closure:1', 'checkout', NULL, 0)`, [srId]);
    const tx2 = await call('GET', '/api/v2/points/transactions', { role: 'volunteer', user: 11, team: 21 });
    const srRow = tx2.json.data.items.find((i) => i.source_type === 'service_record');
    assert(srRow != null && srRow.source_public_id === srPub, `6.8: service_record → source_public_id preserved (got ${srRow && srRow.source_public_id})`);
    const legacyRow = tx2.json.data.items.find((i) => i.source_type === 'activity');
    if (legacyRow) assert(legacyRow.source_public_id === null, '6.8: legacy → null (no leak)');

    // 最终 FK/integrity gate：6 段所有 fixtures/API/mutations 之后，AS DB 无 orphan、无损坏
    assertFkIntegrity(AS, 'S6-API-closure');
  }

  // =========================================================================
  console.log(`\nP24-P4 TEST RESULT: ${FAIL === 0 ? 'PASS' : 'FAIL'}  (pass=${PASS}, fail=${FAIL})`);
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
