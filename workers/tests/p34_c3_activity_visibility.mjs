// =============================================================================
// P34-C3 — Activity Volunteer Visibility Boundary
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration，含 0027）。
//
// 覆盖（对应任务 §10）：
//   A  APPROVED+status1 list 可见      B  APPROVED+status2 可见
//   C  APPROVED+status3 可见           D  APPROVED+status4 可见
//   E  audit DRAFT+status1 list 不可见  F  PENDING+status1 不可见
//   G  REJECTED+status1 不可见          H  APPROVED+status0 不可见
//   I  APPROVED+status5 不可见
//   J  DRAFT detail → 404              K  PENDING detail → 404
//   L  REJECTED detail → 404           M  UNPUBLISHED detail → 404
//   N  APPROVED+status1 detail → 200    O  APPROVED+status2 → 200
//   P  APPROVED+status3 → 200           Q  APPROVED+status4 → 200
//   R  cross-team → 404                 S  deleted → 404
//   T  admin 可读同团队 DRAFT            U  admin 可读 PENDING
//   V  admin 可读 REJECTED              W  admin 可读 UNPUBLISHED
//   X  volunteer 不能报名 DRAFT(非 status1)→ 409
//   Y  volunteer 报名 APPROVED+status1 仍可用
//   Z  志愿者响应无 numeric DB id
//
// 运行：node tests/p34_c3_activity_visibility.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

let __c = 0;
function pid(tag) {
  __c++;
  return (tag + __c.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
}

// ---------- D1 适配器（node:sqlite 后端）----------
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

const BANNED_KEYS = new Set([
  'id', 'activity_id', 'team_id', 'user_id', 'created_by',
  'submitted_by', 'reviewed_by', 'publish_audit_by',
]);
function scanForBanned(obj) {
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = scanForBanned(it); if (r) return r; }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (BANNED_KEYS.has(k)) return `forbidden key '${k}'`;
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
  const bundlePath = join(tmpdir(), `p34_c3_app_${Date.now()}.mjs`);
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

  // 3) 用户与团队
  const U = { alice: pid('U'), bob: pid('U'), carol: pid('U'), vol: pid('U') };
  for (const n of Object.keys(U)) {
    seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U[n], n);
  }
  const uid = {};
  for (const n of Object.keys(U)) uid[n] = sqlite.prepare('SELECT id FROM users WHERE public_id=?').get(U[n]).id;

  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uid.alice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uid.bob);
  const tA = sqlite.prepare('SELECT id FROM teams WHERE public_id=?').get(T.A).id;
  const tB = sqlite.prepare('SELECT id FROM teams WHERE public_id=?').get(T.B).id;

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
  /** 直接插入活动到指定 (status, audit_status)，用于可见性矩阵。 */
  function insertActivity(teamId, status, audit, title, opts = {}) {
    const pub = pid('ACT');
    seed(
      `INSERT INTO activities
        (public_id, team_id, title, summary, start_time, end_time, signup_deadline, quota, status,
         max_session_minutes, created_by, created_at, updated_at, deleted_at, audit_status, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pub, teamId, title, 'summary', t0, t0 + 7200, null, 0, status,
      null, opts.createdBy ?? uid.alice, t0, t0, opts.deletedAt ?? null, audit,
      opts.publishedAt ?? (status === 1 && audit === 2 ? t0 : null),
    );
    return pub;
  }

  // ---------- 可见性矩阵（team A）----------
  const V1 = insertActivity(tA, 1, 2, 'approved-open');      // APPROVED + SIGNUP_OPEN → 可见
  const V2 = insertActivity(tA, 2, 2, 'approved-inprogress'); // APPROVED + IN_PROGRESS → 可见
  const V3 = insertActivity(tA, 3, 2, 'approved-ended');      // APPROVED + ENDED → 可见
  const V4 = insertActivity(tA, 4, 2, 'approved-cancelled');  // APPROVED + CANCELLED → 可见
  const D1a = insertActivity(tA, 1, 0, 'draft');              // DRAFT(audit) → 不可见
  const P1 = insertActivity(tA, 1, 1, 'pending');             // PENDING → 不可见
  const R1 = insertActivity(tA, 1, 3, 'rejected');             // REJECTED → 不可见
  const A0 = insertActivity(tA, 0, 2, 'approved-draft');      // APPROVED + status0 → 不可见
  const A5 = insertActivity(tA, 5, 2, 'unpublished');         // APPROVED + UNPUBLISHED → 不可见

  // ======================= A–D：志愿者 list 仅可见 APPROVED+status1-4 =======================
  const volList = await call('GET', '/api/v2/activities', { role: 'volunteer', user: uid.vol, team: tA });
  check('志愿者 list 状态码 200', volList.status === 200, `status=${volList.status}`);
  const volItems = (volList.json?.data?.items) || [];
  const volPubs = new Set(volItems.map((x) => x.public_id));
  check('A 志愿者可见 APPROVED+status1', volPubs.has(V1), `pub=${V1}`);
  check('B 志愿者可见 APPROVED+status2', volPubs.has(V2), `pub=${V2}`);
  check('C 志愿者可见 APPROVED+status3', volPubs.has(V3), `pub=${V3}`);
  check('D 志愿者可见 APPROVED+status4', volPubs.has(V4), `pub=${V4}`);

  // ======================= E–I：志愿者 list 不可见其余状态 =======================
  check('E DRAFT(audit) 不在志愿者 list', !volPubs.has(D1a), `pub=${D1a}`);
  check('F PENDING 不在志愿者 list', !volPubs.has(P1), `pub=${P1}`);
  check('G REJECTED 不在志愿者 list', !volPubs.has(R1), `pub=${R1}`);
  check('H APPROVED+status0 不在志愿者 list', !volPubs.has(A0), `pub=${A0}`);
  check('I APPROVED+status5(UNPUBLISHED) 不在志愿者 list', !volPubs.has(A5), `pub=${A5}`);
  check('志愿者 list 长度严格=4', volItems.length === 4, `len=${volItems.length}`);

  // ======================= J–M：志愿者 detail 隐藏态 → 404 =======================
  const j = await call('GET', `/api/v2/activities/${D1a}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('J DRAFT detail → 404', j.status === 404, `status=${j.status}`);
  const k = await call('GET', `/api/v2/activities/${P1}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('K PENDING detail → 404', k.status === 404, `status=${k.status}`);
  const l = await call('GET', `/api/v2/activities/${R1}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('L REJECTED detail → 404', l.status === 404, `status=${l.status}`);
  const m = await call('GET', `/api/v2/activities/${A5}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('M UNPUBLISHED detail → 404', m.status === 404, `status=${m.status}`);

  // ======================= N–Q：志愿者 detail 可见态 → 200 =======================
  const n = await call('GET', `/api/v2/activities/${V1}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('N APPROVED+status1 detail → 200', n.status === 200, `status=${n.status}`);
  const o = await call('GET', `/api/v2/activities/${V2}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('O APPROVED+status2 detail → 200', o.status === 200, `status=${o.status}`);
  const p = await call('GET', `/api/v2/activities/${V3}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('P APPROVED+status3 detail → 200', p.status === 200, `status=${p.status}`);
  const q = await call('GET', `/api/v2/activities/${V4}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('Q APPROVED+status4 detail → 200', q.status === 200, `status=${q.status}`);

  // ======================= R：跨团队 → 404 =======================
  const r = await call('GET', `/api/v2/activities/${V1}`, { role: 'volunteer', user: uid.vol, team: tB });
  check('R 跨团队志愿者 detail → 404', r.status === 404, `status=${r.status}`);
  const rList = await call('GET', '/api/v2/activities', { role: 'volunteer', user: uid.vol, team: tB });
  const rListPubs = new Set((rList.json?.data?.items || []).map((x) => x.public_id));
  check('R 跨团队志愿者 list 不含 teamA 活动', !rListPubs.has(V1), `len=${(rList.json?.data?.items || []).length}`);

  // ======================= S：deleted → 404 =======================
  const S1 = insertActivity(tA, 1, 2, 'deleted', { deletedAt: t0 + 10000 });
  const s = await call('GET', `/api/v2/activities/${S1}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('S deleted 活动 detail → 404', s.status === 404, `status=${s.status}`);

  // ======================= T–W：admin 可读同团队全部状态（§5 不得误伤）=======================
  const t = await call('GET', `/api/v2/activities/${D1a}`, { role: 'team_admin', user: uid.alice, team: tA });
  check('T admin 可读同团队 DRAFT', t.status === 200, `status=${t.status}`);
  const u = await call('GET', `/api/v2/activities/${P1}`, { role: 'team_admin', user: uid.alice, team: tA });
  check('U admin 可读同团队 PENDING', u.status === 200, `status=${u.status}`);
  const v = await call('GET', `/api/v2/activities/${R1}`, { role: 'team_admin', user: uid.alice, team: tA });
  check('V admin 可读同团队 REJECTED', v.status === 200, `status=${v.status}`);
  const w = await call('GET', `/api/v2/activities/${A5}`, { role: 'team_admin', user: uid.alice, team: tA });
  check('W admin 可读同团队 UNPUBLISHED', w.status === 200, `status=${w.status}`);

  // admin list 包含隐藏态（同团队全部）
  const adminList = await call('GET', '/api/v2/activities', { role: 'team_admin', user: uid.alice, team: tA });
  const adminPubs = new Set((adminList.json?.data?.items || []).map((x) => x.public_id));
  check('admin list 包含 DRAFT/PENDING/REJECTED/UNPUBLISHED',
    adminPubs.has(D1a) && adminPubs.has(P1) && adminPubs.has(R1) && adminPubs.has(A5),
    `len=${(adminList.json?.data?.items || []).length}`);

  // ======================= X1–X4 / Y：signup 资格边界（P34-C3 blocker fix）=======================
  // createOwn 现经 findSignupEligibleByPublicId：仅 audit_status=APPROVED(2) AND status=SIGNUP_OPEN(1) 可报名，
  // 其余（含 status=1 + audit DRAFT/PENDING/REJECTED，以及非开放态）一律 404（与不可见态一致，不泄露存在性）。
  const x1 = await call('POST', `/api/v2/activities/${D1a}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('X1 志愿者报名 status1+audit DRAFT → 404 拒绝', x1.status === 404, `status=${x1.status}`);
  const x2 = await call('POST', `/api/v2/activities/${P1}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('X2 志愿者报名 status1+audit PENDING → 404 拒绝', x2.status === 404, `status=${x2.status}`);
  const x3 = await call('POST', `/api/v2/activities/${R1}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('X3 志愿者报名 status1+audit REJECTED → 404 拒绝', x3.status === 404, `status=${x3.status}`);
  const x4 = await call('POST', `/api/v2/activities/${A5}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('X4 志愿者报名 status5+audit APPROVED(UNPUBLISHED) → 404 拒绝', x4.status === 404, `status=${x4.status}`);
  // Y：APPROVED + SIGNUP_OPEN → 报名成功（200/201）
  const y = await call('POST', `/api/v2/activities/${V1}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('Y 志愿者报名 APPROVED+status1 → 200/201', y.status === 200 || y.status === 201, `status=${y.status}`);

  // ======================= Z：numeric DB id 不产生在志愿者响应中 =======================
  const zListHit = scanForBanned(volItems);
  check('Z 志愿者 list 响应无 numeric DB id', zListHit === null, zListHit || '');
  const zDetailHit = n.json?.data?.activity ? scanForBanned(n.json.data.activity) : 'no-activity';
  check('Z 志愿者 detail 响应无 numeric DB id', zDetailHit === null, zDetailHit === 'no-activity' ? '' : zDetailHit);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\nRESULT: ${passed}/${total} passed`);
  if (passed !== total) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
