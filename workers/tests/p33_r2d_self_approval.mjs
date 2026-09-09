// =============================================================================
// P33-R2D-B — Community Approval Self-Approval (Separation-of-Duties) Enforcement
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
// 验证冻结规则：创建者不得审核/发布自己创建的内容（author_id != audit_by）。
//   - 自审 approve/reject → 403（明确业务错误，非 404）
//   - 同 team 其他 team_auditor / team_admin 审核 → 200
//   - 跨团队 auditor → 404（team scope 隔离）
//   - 志愿者 approve/reject → 403（无审核权限）
//   - 自审被拒：status/audit_status 不变，audit_by/audit_at 未写，无成功 audit log
//   - 他人审核：audit_by = reviewer，audit_at 填充，audit log operator = reviewer
//   - 响应无 numeric/internal 标识泄漏
// 运行：node tests/p33_r2d_self_approval.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
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

// ---------- 响应中禁止出现的 numeric/internal 标识键 ----------
const BANNED_KEYS = new Set([
  'id', 'user_id', 'team_id', 'file_id', 'author_id', 'target_id',
  'object_key', 'checksum', 'reporter_id', 'report_id',
]);
function scanForBanned(obj) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanForBanned(obj[i]);
      if (r) return r;
    }
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
  const bundlePath = join(tmpdir(), `p33_r2d_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const fs = await import('node:fs');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  // 3) 种子：users / teams
  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  const U = { alice: pid('U'), bob: pid('U'), carol: pid('U'), dave: pid('U') };
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.alice, 'alice');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.bob, 'bob');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.carol, 'carol');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.dave, 'dave');
  const uAlice = q('SELECT id FROM users WHERE public_id=?', U.alice).id;
  const uBob = q('SELECT id FROM users WHERE public_id=?', U.bob).id;
  const uCarol = q('SELECT id FROM users WHERE public_id=?', U.carol).id;
  const uDave = q('SELECT id FROM users WHERE public_id=?', U.dave).id;

  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uAlice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uDave);
  const tA = q('SELECT id FROM teams WHERE public_id=?', T.A).id;
  const tB = q('SELECT id FROM teams WHERE public_id=?', T.B).id;

  // 4) 请求驱动（真实中间件链；mock 身份注入）
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
  const artState = (pub) =>
    q('SELECT status, audit_status, published_at, author_id, audit_by, audit_at, team_id FROM content_articles WHERE public_id=?', pub);
  const auditRows = (pub) =>
    qa(
      `SELECT action, operator_id, team_id, from_status, to_status
         FROM content_audit_logs WHERE target_type='article'
           AND target_id=(SELECT id FROM content_articles WHERE public_id=?)
         ORDER BY id`,
      pub,
    );
  async function createArticle(role, user, team, title) {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role, user, team, body: { title: title ?? 'T', body: 'b' },
    });
    return r.json?.data?.article_public_id ?? null;
  }

  // ===== A：创建者自审 approve → 403 =====
  const aA = await createArticle('team_admin', uAlice, tA, 'A-self-approve');
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${aA}/approve`, { role: 'team_admin', user: uAlice, team: tA });
    check('A 创建者自审 approve → 403', r.status === 403, `got ${r.status}`);
    const st = artState(aA);
    check('A 自审后 status/audit 未变 (1/1)', st && st.status === 1 && st.audit_status === 1, JSON.stringify(st));
  }

  // ===== B：创建者自审 reject → 403 =====
  const aB = await createArticle('team_admin', uAlice, tA, 'B-self-reject');
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${aB}/reject`, { role: 'team_admin', user: uAlice, team: tA });
    check('B 创建者自审 reject → 403', r.status === 403, `got ${r.status}`);
    const st = artState(aB);
    check('B 自审后 status/audit 未变 (1/1)', st && st.status === 1 && st.audit_status === 1, JSON.stringify(st));
  }

  // ===== C：同 team team_auditor 审核 approve → 200 =====
  const aC = await createArticle('team_admin', uAlice, tA, 'C-auditor-approve');
  let rC;
  {
    rC = await call('POST', `/api/v2/admin/content/articles/${aC}/approve`, { role: 'team_auditor', user: uCarol, team: tA });
    check('C 同team team_auditor approve → 200', rC.status === 200, `got ${rC.status}`);
    const st = artState(aC);
    check('C 发布后 status=2/audit=2', st && st.status === 2 && st.audit_status === 2, JSON.stringify(st));
  }

  // ===== D：同 team team_auditor 审核 reject → 200 =====
  const aD = await createArticle('team_admin', uAlice, tA, 'D-auditor-reject');
  let rD;
  {
    rD = await call('POST', `/api/v2/admin/content/articles/${aD}/reject`, { role: 'team_auditor', user: uCarol, team: tA });
    check('D 同team team_auditor reject → 200', rD.status === 200, `got ${rD.status}`);
    const st = artState(aD);
    check('D reject 后 status=1/audit=3', st && st.status === 1 && st.audit_status === 3, JSON.stringify(st));
  }

  // ===== E：同 team 其他 team_admin 审核 approve → 200 =====
  const aE = await createArticle('team_admin', uAlice, tA, 'E-admin-approve');
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${aE}/approve`, { role: 'team_admin', user: uBob, team: tA });
    check('E 同team 其他 team_admin approve → 200', r.status === 200, `got ${r.status}`);
    const st = artState(aE);
    check('E 发布后 status=2/audit=2', st && st.status === 2 && st.audit_status === 2, JSON.stringify(st));
  }

  // ===== F：跨团队 auditor 审核 → 404（team scope 隔离）=====
  const aF = await createArticle('team_admin', uAlice, tA, 'F-cross');
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${aF}/approve`, { role: 'team_auditor', user: uDave, team: tB });
    check('F 跨团队 auditor approve → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== G：志愿者 approve/reject → 403（无审核权限）=====
  const aG = await createArticle('team_admin', uAlice, tA, 'G-volunteer');
  {
    const r1 = await call('POST', `/api/v2/admin/content/articles/${aG}/approve`, { role: 'volunteer', user: uAlice, team: tA });
    check('G 志愿者 approve → 403', r1.status === 403, `got ${r1.status}`);
    const r2 = await call('POST', `/api/v2/admin/content/articles/${aG}/reject`, { role: 'volunteer', user: uAlice, team: tA });
    check('G 志愿者 reject → 403', r2.status === 403, `got ${r2.status}`);
  }

  // ===== H：自审被拒 — 状态/审计未变更、无成功 audit log =====
  {
    const logsA = auditRows(aA);
    const okA = !logsA.some((l) => l.action === 'approve' || l.action === 'reject');
    check('H 自审被拒：无成功 approve/reject audit log', okA, JSON.stringify(logsA));
    const st = artState(aA);
    const okState = st && st.status === 1 && st.audit_status === 1 && st.audit_by === null && st.audit_at === null;
    check('H 自审被拒：status/audit 未变 + audit_by/audit_at 未写', okState, JSON.stringify(st));
  }

  // ===== I：他人审核 — audit_by=reviewer、audit_at 填充、audit log operator=reviewer =====
  {
    const st = artState(aC); // 由 carol (team_auditor) approve
    check('I audit_by = reviewer(carol)', st && st.audit_by === uCarol, `audit_by=${st?.audit_by} expect=${uCarol}`);
    check('I audit_at 已填充', st && st.audit_at != null, `audit_at=${st?.audit_at}`);
    const logs = auditRows(aC);
    const ap = logs.find((l) => l.action === 'approve');
    check('I audit log operator = reviewer(carol)', !!ap && ap.operator_id === uCarol, JSON.stringify(ap));
  }

  // ===== J：numeric/internal ID 泄漏 = NO =====
  {
    const hitC = scanForBanned(rC.json);
    check('J approve 响应无禁止 numeric/internal 标识', hitC === null, hitC ?? 'ok');
    const hitD = scanForBanned(rD.json);
    check('J reject 响应无禁止 numeric/internal 标识', hitD === null, hitD ?? 'ok');
  }

  // ===== 附加：team_auditor 仅审核、不能创建（强化审核专用模型）=====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_auditor', user: uCarol, team: tA, body: { title: 'X', body: 'b' },
    });
    check('附加 team_auditor 创建文章 → 403（仅审核）', r.status === 403, `got ${r.status}`);
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-R2D-B SELF-APPROVAL TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
