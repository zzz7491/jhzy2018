// =============================================================================
// P33-R2A 时代 — Community HTTP Runtime Verification（真实 app + local D1）
//
// 策略（与 p33_r2a_readonly.mjs 同源，但覆盖完整 H1–H25 + §13 矩阵）：
//   1) esbuild 打包真实 src/app.ts（含管理端 create/update 路由 + 既有挂载）→ 内存 ESM。
//   2) node:sqlite D1 适配器，应用【全部】migration（含 0026 志愿者社交权限回收）。
//   3) 仅种子 users / teams / files；不写任何 permission 数据。
//   4) 真实中间件链（authContext → tenantContext → csrfGuard → requirePermission → route）。
//   5) 只读时代断言：
//        - 志愿者 5 类写操作（建文/编辑/评论/点赞/举报）→ 一律 403（社交锁定）。
//        - 文章生命周期（创建/审核/下架/删除）由管理员端点驱动（team_owner）。
//        - 读端点（feed / detail / 跨团队 404 / 审计流转 / 禁止标识扫描）保持不变。
//   不依赖 wrangler / 不触远端 / 不修改任何冻结文件。
//   运行时（workers/ 目录）：node tests/p33_content_http.mjs
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

// 合法 ULID（Crockford，供被 gate 拦截前的 param 解析；gate 先返回 403，此处仅为格式安全）。
const DUMMY_ULID = '123456789ABCDEFGHJKMNPQRSTV';

// ---------- D1 适配器（node:sqlite 后端）----------
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

// ---------- 响应中禁止出现的 numeric/internal 标识键 ----------
const BANNED_KEYS = new Set([
  'id', 'user_id', 'team_id', 'file_id', 'author_id', 'target_id',
  'object_key', 'checksum', 'reporter_id', 'report_id',
]);
function scanForBanned(obj, path = '') {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanForBanned(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (BANNED_KEYS.has(k)) return `forbidden key '${k}' at ${path}`;
      const r = scanForBanned(obj[k], `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

const scanned = [];
function remember(json) {
  if (json && json.data != null) scanned.push(json.data);
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
  const bundlePath = join(tmpdir(), `p33_http_app_${Date.now()}.mjs`);
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

  // 3) 种子：users / teams / files
  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  const U = { alice: pid('U'), bob: pid('U'), carol: pid('U') };
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.alice, 'alice');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.bob, 'bob');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.carol, 'carol');
  const uAlice = q('SELECT id FROM users WHERE public_id=?', U.alice).id;
  const uBob = q('SELECT id FROM users WHERE public_id=?', U.bob).id;
  const uCarol = q('SELECT id FROM users WHERE public_id=?', U.carol).id;

  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uAlice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uCarol);
  const tA = q('SELECT id FROM teams WHERE public_id=?', T.A).id;
  const tB = q('SELECT id FROM teams WHERE public_id=?', T.B).id;

  const fileRow = (pub, team, uploader, mime, visibility, scan) =>
    seed(
      `INSERT INTO files (public_id, team_id, uploader_id, original_name, object_key, mime_type, size_bytes, checksum, visibility, scan_status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      pub, team, uploader, 'n', 'obj', mime, 10, 'cs', visibility, scan,
    );
  const F = {
    alice: pid('F'), // teamA/alice, jpeg, team
    bob: pid('F'), // teamA/bob, png, team（他人同 team）
    carol: pid('F'), // teamB/carol, jpeg, team（跨 team）
  };
  fileRow(F.alice, tA, uAlice, 'image/jpeg', 'team', 0);
  fileRow(F.bob, tA, uBob, 'image/png', 'team', 0);
  fileRow(F.carol, tB, uCarol, 'image/jpeg', 'team', 0);
  const fAlicePub = F.alice;
  const fBobPub = F.bob;
  const fCarolPub = F.carol;
  const fMaxPubs = [];
  for (let i = 0; i < 10; i++) {
    const pub = pid('F');
    fileRow(pub, tA, uAlice, 'image/jpeg', 'team', 0);
    fMaxPubs.push(pub);
  }

  // 4) 请求驱动（真实中间件链；local mock 身份注入）
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
  const artId = (pub) => q('SELECT id FROM content_articles WHERE public_id=?', pub)?.id;
  const artState = (pub) =>
    q('SELECT status, audit_status, published_at, author_id, team_id, like_count FROM content_articles WHERE public_id=?', pub);
  const auditRow = (targetId, action) =>
    q(
      `SELECT action, from_status, to_status, operator_id, team_id
         FROM content_audit_logs WHERE target_type='article' AND target_id=? AND action=?
         ORDER BY id DESC LIMIT 1`,
      targetId, action,
    );

  // ===== H1：未认证 feed → 401 =====
  {
    const r = await call('GET', '/api/v2/content/feed');
    check('H1 未认证 feed → 401', r.status === 401, `got ${r.status}`);
  }

  // ===== H2：已认证无 TEAM → 4xx（teamScopeRequired 403）=====
  {
    const r = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice });
    check('H2 已认证无 TEAM → 4xx', r.status >= 400 && r.status < 500, `got ${r.status}`);
  }

  // 管理端先建一篇团队 A 文章（供后续志愿者写拦截 / 审核流转使用）。
  let a1Pub = null;
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A1', body: 'hello' },
    });
    a1Pub = c.json?.data?.article_public_id ?? null;
  }

  // ===== H3：志愿者自建文章 → 403（社交锁定）=====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A1', body: 'hi' },
    });
    check('H3 志愿者自建文章 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H4：志愿者自编辑 → 403 =====
  {
    const r = await call('PUT', `/api/v2/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'x' },
    });
    check('H4 志愿者编辑文章 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H5：志愿者编辑他人文章 → 403（gate 先于 ownership）=====
  {
    const r = await call('PUT', `/api/v2/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uBob, team: tA, body: { title: 'x' },
    });
    check('H5 志愿者编辑他人文章 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H6：跨团队详情 → 404（先建 teamB 文章）=====
  let aBPub = null;
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uCarol, team: tB, body: { title: 'B1', body: 'b' },
    });
    aBPub = c.json?.data?.article_public_id ?? null;
    const r = await call('GET', `/api/v2/content/articles/${aBPub}`, { role: 'volunteer', user: uAlice, team: tA });
    check('H6 跨团队文章详情 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H7：志愿者不能 admin approve → 403 =====
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${a1Pub}/approve`, {
      role: 'volunteer', user: uAlice, team: tA,
    });
    check('H7 志愿者不能 admin approve → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H8：志愿者不能 admin delete → 403 =====
  {
    const r = await call('DELETE', `/api/v2/admin/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uAlice, team: tA,
    });
    check('H8 志愿者不能 admin delete → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H9：admin（team_owner）approve → 成功 =====
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${a1Pub}/approve`, {
      role: 'team_admin', user: uBob, team: tA,
    });
    remember(r.json);
    const st = artState(a1Pub);
    check('H9 admin approve → 200 + status=2/audit=2', r.status === 200 && st.status === 2 && st.audit_status === 2, `status=${r.status} art=${JSON.stringify(st)}`);
  }

  // ===== H10：已发布文章出现在 feed =====
  {
    const r = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice, team: tA });
    remember(r.json);
    const items = r.json?.data?.items ?? [];
    check('H10 已发布文章出现在 feed', items.some((x) => x.article_public_id === a1Pub), `count=${items.length}`);
  }

  // ===== H11：reject 后不在 feed =====
  {
    const rj = await call('POST', `/api/v2/admin/content/articles/${a1Pub}/reject`, {
      role: 'team_admin', user: uBob, team: tA,
    });
    const st = artState(a1Pub);
    const feed = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice, team: tA });
    const items = feed.json?.data?.items ?? [];
    check('H11 reject → status=1/audit=3 且不在 feed', rj.status === 200 && st.status === 1 && st.audit_status === 3 && !items.some((x) => x.article_public_id === a1Pub), `art=${JSON.stringify(st)}`);
  }

  // ===== H12：志愿者评论创建 → 403（社交锁定）=====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/comments`, {
      role: 'volunteer', user: uAlice, team: tA, body: { content: 'nice' },
    });
    check('H12 志愿者评论创建 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H13：志愿者点赞 → 403（社交锁定）=====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    check('H13 志愿者点赞 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H14：志愿者取消点赞 → 403（社交锁定）=====
  {
    const r = await call('DELETE', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    check('H14 志愿者取消点赞 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H15：志愿者文章举报 → 403（社交锁定）=====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'illegal', detail: 'x' },
    });
    check('H15 志愿者文章举报 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H16：志愿者评论举报 → 403（社交锁定）=====
  {
    const r = await call('POST', `/api/v2/content/comments/${DUMMY_ULID}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'abuse' },
    });
    check('H16 志愿者评论举报 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H17：跨团队志愿者评论举报 → 403（gate 先于 team 校验）=====
  {
    const r = await call('POST', `/api/v2/content/comments/${DUMMY_ULID}/report`, {
      role: 'volunteer', user: uCarol, team: tB, body: { reason: 'abuse' },
    });
    check('H17 跨团队志愿者评论举报 → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H18：管理员创建含附件（本人同 team）→ 201 + 附件物化 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A2', body: 'b', attachment_file_public_ids: [fAlicePub] },
    });
    remember(r.json);
    const pub = r.json?.data?.article_public_id;
    const cnt = pub ? q('SELECT COUNT(*) c FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)', pub).c : -1;
    check('H18 管理员创建 + 本人同 team 附件 → 201 + 附件物化', r.status === 201 && cnt === 1, `status=${r.status} att=${cnt}`);
  }

  // ===== H19：管理员创建含他人同 team 附件 → 201 + 附件物化（不要求本人上传）=====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A3', body: 'b', attachment_file_public_ids: [fBobPub] },
    });
    remember(r.json);
    const pub = r.json?.data?.article_public_id;
    const cnt = pub ? q('SELECT COUNT(*) c FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)', pub).c : -1;
    check('H19 管理员创建 + 他人同 team 附件 → 201 + 附件物化', r.status === 201 && cnt === 1, `status=${r.status} att=${cnt}`);
  }

  // ===== H20：管理员创建含跨 team 附件 → 404 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A4', body: 'b', attachment_file_public_ids: [fCarolPub] },
    });
    check('H20 管理员创建 + 跨 team 附件 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H21：max 9 强制 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A5', body: 'b', attachment_file_public_ids: fMaxPubs },
    });
    check('H21 超过9个附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== H22：重复附件拒绝 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'A6', body: 'b', attachment_file_public_ids: [fAlicePub, fAlicePub] },
    });
    check('H22 重复附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== H23：所有被采集响应不含禁止 numeric/internal 标识 =====
  {
    let bad = null;
    for (const d of scanned) {
      const hit = scanForBanned(d);
      if (hit) { bad = hit; break; }
    }
    check('H23 响应不含禁止 numeric/internal 标识', bad === null, bad ?? 'scanned ' + scanned.length);
  }

  // ===== H24：非法 public id → 读路径 400；被 gate 拦截的写路径优先 403 =====
  {
    const bad = 'NOTULID1234567890ABCDEFGH';
    // 读路径（requireActiveTeam + requireUlidParam，无权限 gate）→ 400 字段校验优先。
    const r1 = await call('GET', `/api/v2/content/articles/${bad}`, { role: 'volunteer', user: uAlice, team: tA });
    // 写路径（content.report.create gate 先于 ULID 解析）→ 403（只读时代志愿者已无此权限）。
    const r2 = await call('POST', `/api/v2/content/comments/${bad}/report`, { role: 'volunteer', user: uAlice, team: tA, body: { reason: 'abuse' } });
    check('H24 非法 public id：读→400 / 写(gate)→403', r1.status === 400 && r2.status === 403, `article=${r1.status} comment=${r2.status}`);
  }

  // ===== H25：志愿者非法举报 reason → 403（gate 先于 reason 校验）=====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'not-a-reason' },
    });
    check('H25 志愿者非法举报 reason → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== §13 审计流转核验（独立文章 B，干净序列，管理员驱动）=====
  {
    const c = await call('POST', '/api/v2/admin/content/articles', { role: 'team_owner', user: uAlice, team: tA, body: { title: 'B', body: 'b' } });
    const bPub = c.json?.data?.article_public_id;
    const bId = artId(bPub);

    await call('POST', `/api/v2/admin/content/articles/${bPub}/approve`, { role: 'team_admin', user: uBob, team: tA });
    const ap = auditRow(bId, 'approve');
    check('§13 approve from=1 to=2', ap && ap.from_status === '1' && ap.to_status === '2', JSON.stringify(ap));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/reject`, { role: 'team_admin', user: uBob, team: tA });
    const rj = auditRow(bId, 'reject');
    check('§13 reject from=2 to=1', rj && rj.from_status === '2' && rj.to_status === '1', JSON.stringify(rj));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/approve`, { role: 'team_admin', user: uBob, team: tA });
    const ap2 = auditRow(bId, 'approve');
    check('§13 二次 approve from=1 to=2', ap2 && ap2.from_status === '1' && ap2.to_status === '2', JSON.stringify(ap2));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/unpublish`, { role: 'team_admin', user: uBob, team: tA });
    const un = auditRow(bId, 'unpublish');
    check('§13 unpublish from=2 to=3', un && un.from_status === '2' && un.to_status === '3', JSON.stringify(un));

    await call('DELETE', `/api/v2/admin/content/articles/${bPub}`, { role: 'team_admin', user: uBob, team: tA });
    const del = auditRow(bId, 'delete');
    check('§13 delete from=3 to=4', del && del.from_status === '3' && del.to_status === '4', JSON.stringify(del));
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-R2A HTTP TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
