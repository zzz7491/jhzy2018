// =============================================================================
// N0-E0 — Activity Signup Review Foundation State Machine
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
// 仅验证 N0-E0 报名审核状态机（不接通知 / 不接微信 / 不接 frontend）。
//
// 覆盖（对应任务 §11）：
//   A  PENDING → APPROVED = 200（review_status=1 / review_by / review_at / review_reason=null）
//   B  PENDING → REJECTED = 200（review_status=2 / review_by / review_at / review_reason trimmed）
//   C  reject 缺 reason → 400
//   D  reject 纯空白 reason → 400
//   E  reject reason >500 → 400
//   F  invalid decision → 400
//   G  APPROVED → APPROVED blocked（409）
//   H  APPROVED → REJECTED blocked（409）
//   I  REJECTED → APPROVED blocked（409）
//   J  REJECTED → REJECTED blocked（409）
//   K  cross-team 审核 → 404
//   L  missing signup → 404
//   M  无 signup.signup.review 权限 → 403
//   N  并发/重复审核：仅一个 UPDATE 获得 changes===1（一 200 一 409）
//   O  PENDING 用户审核前仍可取消（既有行为不回归）
//
// 运行：node tests/n0e0_activity_signup_review_state_machine.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

// 严格 ULID（与 utils/validation.ts 的 ULID_RE 一致：^[0-9A-HJKMNP-TV-Z]{26}$）
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let s = '';
  for (let i = 0; i < 26; i++) s += ULID_ALPHABET[Math.floor(Math.random() * ULID_ALPHABET.length)];
  return s;
}

// ---------- D1 适配器（node:sqlite 后端，复用 P34-C2 harness 形态）----------
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
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

// review 响应禁止泄露内部审核人 id / 租户 / 归属列（signup.id 允许暴露）
const REVIEW_BANNED = new Set(['review_by', 'user_id', 'team_id', 'activity_id', 'created_by']);
function scanForBanned(obj) {
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = scanForBanned(it); if (r) return r; }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (REVIEW_BANNED.has(k)) return `forbidden key '${k}'`;
      const r = scanForBanned(obj[k]);
      if (r) return r;
    }
  }
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
  const bundlePath = join(tmpdir(), `n0e0_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);

  // 3) 用户与团队
  const USERS = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const uid = {};
  for (const n of USERS) {
    const pub = ulid();
    seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', pub, n);
    uid[n] = q('SELECT id FROM users WHERE public_id=?', pub).id;
  }
  const tA = (() => {
    const pub = ulid();
    seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', pub, 'teamA', uid.alice);
    return q('SELECT id FROM teams WHERE public_id=?', pub).id;
  })();
  const tB = (() => {
    const pub = ulid();
    seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', pub, 'teamB', uid.dave);
    return q('SELECT id FROM teams WHERE public_id=?', pub).id;
  })();

  // 4) 请求驱动
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const t0 = 1_700_000_000;
  /** 每测试独立活动（team A），避免 UNIQUE(user_id, activity_id) 冲突，且隔离状态。 */
  function makeActivity(title = 'review-act') {
    const pub = ulid();
    seed(
      `INSERT INTO activities
         (public_id, team_id, title, start_time, end_time, status, audit_status, need_audit, allow_cancel, created_by)
       VALUES (?,?,?,?,?,1,2,1,1,?)`,
      pub, tA, title, t0, t0 + 7200, uid.alice,
    );
    const id = q('SELECT id FROM activities WHERE public_id=?', pub).id;
    return { pub, id };
  }
  /** 直接落库一条 PENDING 报名（绕过报名资格门，专注审核路径）。 */
  function seedPendingSignup(activityId, userId) {
    const now = Math.floor(Date.now() / 1000);
    seed(
      'INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at) VALUES (?,?,0,1,?)',
      activityId, userId, now,
    );
    return q('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?', activityId, userId).id;
  }
  const signupState = (id) =>
    q('SELECT review_status, review_by, review_at, review_reason, status, updated_at FROM activity_signups WHERE id=?', id);

  const review = (actPub, signupId, decision, role, user, team, reason) =>
    call('POST', `/api/v2/activities/${actPub}/signups/${signupId}/review`, {
      role, user, team,
      body: reason !== undefined ? { decision, reason } : { decision },
    });

  // ======================= A：PENDING → APPROVED =======================
  {
    const act = makeActivity('A');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    check('A PENDING→APPROVE 200', r.status === 200, `status=${r.status}`);
    const st = signupState(s);
    check('A review_status=1', st.review_status === 1, `rs=${st.review_status}`);
    check('A review_by = 审核人', st.review_by === uid.carol, `rb=${st.review_by}`);
    check('A review_at 非空', st.review_at != null, `ra=${st.review_at}`);
    check('A review_reason = NULL', st.review_reason === null, `rr=${st.review_reason}`);
    const sg = scanForBanned(r.json?.data ?? {});
    check('A 响应不含内部审核人/租户列', sg === null, sg ?? '');
    check('A 响应含 review_status/review_at/review_reason',
      r.json?.data?.signup?.review_status === 1 && r.json?.data?.signup?.review_at != null,
      JSON.stringify(r.json?.data?.signup));
  }

  // ======================= B：PENDING → REJECTED =======================
  {
    const act = makeActivity('B');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '  材料不全，请补充  ');
    check('B PENDING→REJECT 200', r.status === 200, `status=${r.status}`);
    const st = signupState(s);
    check('B review_status=2', st.review_status === 2, `rs=${st.review_status}`);
    check('B review_by = 审核人', st.review_by === uid.carol);
    check('B review_at 非空', st.review_at != null);
    check('B review_reason 已 trim', st.review_reason === '材料不全，请补充', `rr=${st.review_reason}`);
    const sg = scanForBanned(r.json?.data ?? {});
    check('B 响应不含内部审核人/租户列', sg === null, sg ?? '');
  }

  // ======================= C：reject 缺 reason → 400 =======================
  {
    const act = makeActivity('C');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, undefined);
    check('C reject 缺 reason → 400', r.status === 400, `status=${r.status}`);
    check('C 未落库（review_status 仍 0）', signupState(s).review_status === 0);
  }

  // ======================= D：reject 纯空白 reason → 400 =======================
  {
    const act = makeActivity('D');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '     ');
    check('D reject 空白 reason → 400', r.status === 400, `status=${r.status}`);
    check('D 未落库', signupState(s).review_status === 0);
  }

  // ======================= E：reject reason >500 → 400 =======================
  {
    const act = makeActivity('E');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, 'x'.repeat(501));
    check('E reject >500 → 400', r.status === 400, `status=${r.status}`);
    check('E 未落库', signupState(s).review_status === 0);
  }

  // ======================= F：invalid decision → 400 =======================
  {
    const act = makeActivity('F');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'bananas', 'team_auditor', uid.carol, tA, undefined);
    check('F invalid decision → 400', r.status === 400, `status=${r.status}`);
    check('F 未落库', signupState(s).review_status === 0);
  }

  // ======================= G：APPROVED → APPROVED blocked =======================
  {
    const act = makeActivity('G');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    check('G APPROVED→APPROVED 阻断 → 409', r.status === 409, `status=${r.status}`);
    check('G 状态保持 APPROVED', signupState(s).review_status === 1);
  }

  // ======================= H：APPROVED → REJECTED blocked =======================
  {
    const act = makeActivity('H');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '事后驳回');
    check('H APPROVED→REJECTED 阻断 → 409', r.status === 409, `status=${r.status}`);
    check('H 状态保持 APPROVED', signupState(s).review_status === 1);
  }

  // ======================= I：REJECTED → APPROVED blocked =======================
  {
    const act = makeActivity('I');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '不合格');
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    check('I REJECTED→APPROVED 阻断 → 409', r.status === 409, `status=${r.status}`);
    check('I 状态保持 REJECTED', signupState(s).review_status === 2);
  }

  // ======================= J：REJECTED → REJECTED blocked =======================
  {
    const act = makeActivity('J');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '不合格');
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '再次驳回');
    check('J REJECTED→REJECTED 阻断 → 409', r.status === 409, `status=${r.status}`);
    check('J 状态保持 REJECTED', signupState(s).review_status === 2);
  }

  // ======================= K：cross-team 审核 → 404 =======================
  {
    const act = makeActivity('K'); // team A
    const s = seedPendingSignup(act.id, uid.bob);
    // 审核人以 team B 上下文发起（仍具备 review 角色，但跨团队）
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tB);
    check('K cross-team 审核 → 404', r.status === 404, `status=${r.status}`);
    check('K 未落库', signupState(s).review_status === 0);
  }

  // ======================= L：missing signup → 404 =======================
  {
    const act = makeActivity('L');
    const r = await review(act.pub, 999999, 'approve', 'team_auditor', uid.carol, tA);
    check('L missing signup → 404', r.status === 404, `status=${r.status}`);
  }

  // ======================= M：无 review 权限 → 403 =======================
  {
    const act = makeActivity('M');
    const s = seedPendingSignup(act.id, uid.bob);
    // volunteer 持有 cancel/create 但不持有 signup.signup.review
    const r = await review(act.pub, s, 'approve', 'volunteer', uid.erin, tA);
    check('M 无 signup.signup.review 权限 → 403', r.status === 403, `status=${r.status}`);
    check('M 未落库', signupState(s).review_status === 0);
  }

  // ======================= N：并发/重复审核 → 仅一个 changes===1 =======================
  {
    const act = makeActivity('N');
    const s = seedPendingSignup(act.id, uid.bob);
    const [r1, r2] = await Promise.all([
      review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA),
      review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA),
    ]);
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    const conflictCount = [r1, r2].filter((r) => r.status === 409).length;
    check('N 仅一个审核成功（一 200 一 409）', okCount === 1 && conflictCount === 1, `ok=${okCount} conflict=${conflictCount}`);
    check('N 最终 review_status=1（仅一次状态变化）', signupState(s).review_status === 1, `rs=${signupState(s).review_status}`);
  }

  // ======================= O：PENDING 用户审核前仍可取消（既有行为不回归）=======================
  {
    const act = makeActivity('O');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await call('DELETE', `/api/v2/activities/${act.pub}/signups/me`, {
      role: 'volunteer', user: uid.bob, team: tA,
    });
    check('O PENDING 用户取消 → 200', r.status === 200, `status=${r.status}`);
    check('O 报名变为已取消（status=2）', signupState(s).status === 2, `status=${signupState(s).status}`);
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`N0-E0 RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== N0-E0 = BLOCKED ===' : '=== N0-E0 = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
