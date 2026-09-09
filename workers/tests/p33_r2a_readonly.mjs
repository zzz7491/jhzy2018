// =============================================================================
// P33-R2A — Community Read-Only Backend Conversion（真实 app + local D1）
//
// 目标：验证「公益社区 = 只读资料 / 内容查看中心」后端改造的运行时正确性。
//   1) esbuild 打包真实 src/app.ts（含本次新增的管理端 create/update 路由）。
//   2) node:sqlite D1 适配器，应用【全部】migration（含 0026 志愿者社交权限回收）。
//   3) 仅种子 users / teams / files（最小业务数据）；不写任何 permission 数据。
//   4) 真实中间件链（authContext → tenantContext → csrfGuard → requirePermission → route）。
//   5) 覆盖 A–P 验证矩阵：
//        A–E  志愿者 5 类写操作全部 → 403（社交功能已锁定）
//        F    管理员（team_owner）POST /admin/content/articles → 201，DRAFT/PENDING，author=operator
//        G    管理员创建 + 本人同 team 附件 → 201 + 附件物化
//        H    管理员创建 + 他人同 team 附件 → 201 + 附件物化（管理员不要求本人上传）
//        I    管理员创建 + 跨 team 附件 → 404（resolve 强制 team 边界）
//        J    管理员创建 + 超 9 附件 → 400
//        K    管理员创建 + 重复附件 → 400
//        L    管理员 PUT 编辑 → 200，重置 DRAFT/PENDING
//        M    管理员 PUT 编辑他人著作文（同 team）→ 200（不绑定 author）
//        N    管理员 PUT 编辑跨 team 文章 → 404
//        O    管理员创建 → 审核发布 → 进入志愿者 feed 可见
//        P    志愿者调用管理端端点 → 403
//
// 不依赖 wrangler / 不触远端 / 不修改任何冻结文件。
// 运行时（需在 workers/ 目录执行）：node tests/p33_r2a_readonly.mjs
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

// ---------- D1 适配器 ----------
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
  const bundlePath = join(tmpdir(), `p33_r2a_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

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

  // ---- 种子 users / teams / files ----
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

  const fileRow = (pub, team, uploader, mime, visibility) =>
    seed(
      `INSERT INTO files (public_id, team_id, uploader_id, original_name, object_key, mime_type, size_bytes, checksum, visibility, scan_status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      pub, team, uploader, 'n', 'obj', mime, 10, 'cs', visibility, 0,
    );
  const F = {
    alice: pid('F'), // teamA/alice, jpeg, team
    bob: pid('F'), // teamA/bob, png, team（他人同 team）
    carol: pid('F'), // teamB/carol, jpeg, team（跨 team）
    bad: pid('F'), // teamA/alice, txt（非法 mime）
  };
  fileRow(F.alice, tA, uAlice, 'image/jpeg', 'team');
  fileRow(F.bob, tA, uBob, 'image/png', 'team');
  fileRow(F.carol, tB, uCarol, 'image/jpeg', 'team');
  fileRow(F.bad, tA, uAlice, 'text/plain', 'team');
  const fMaxPubs = [];
  for (let i = 0; i < 10; i++) {
    const pub = pid('F');
    fileRow(pub, tA, uAlice, 'image/jpeg', 'team');
    fMaxPubs.push(pub);
  }

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
    q('SELECT status, audit_status, published_at, author_id, team_id FROM content_articles WHERE public_id=?', pub);
  const attCount = (pub) =>
    q('SELECT COUNT(*) c FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)', pub).c;

  // ===== A：志愿者自建文章 → 403 =====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A1', body: 'hi' },
    });
    check('A 志愿者 POST /content/articles → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== B：志愿者自编辑 → 403 =====
  {
    // 先由管理员建一篇，供志愿者尝试编辑
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'B1', body: 'b' },
    });
    const pub = c.json?.data?.article_public_id;
    const r = await call('PUT', `/api/v2/content/articles/${pub}`, {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'x' },
    });
    check('B 志愿者 PUT /content/articles/:id → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== C：志愿者评论 → 403 =====
  {
    // 用一篇真实存在的文章（管理员建的）排除 400/404 噪声，纯测评论写权限
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'C1', body: 'b' },
    });
    const pub = c.json?.data?.article_public_id;
    const r2 = await call('POST', `/api/v2/content/articles/${pub}/comments`, {
      role: 'volunteer', user: uAlice, team: tA, body: { content: 'x' },
    });
    check('C 志愿者 POST /content/articles/:id/comments → 403', r2.status === 403, `got ${r2.status}`);
  }

  // ===== D：志愿者点赞（POST/DELETE）→ 403 =====
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'D1', body: 'b' },
    });
    const pub = c.json?.data?.article_public_id;
    const r1 = await call('POST', `/api/v2/content/articles/${pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    const r2 = await call('DELETE', `/api/v2/content/articles/${pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    check('D 志愿者 点赞/取消点赞 → 403/403', r1.status === 403 && r2.status === 403, `post=${r1.status} del=${r2.status}`);
  }

  // ===== E：志愿者举报（文章/评论）→ 403 =====
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'E1', body: 'b' },
    });
    const pub = c.json?.data?.article_public_id;
    const r1 = await call('POST', `/api/v2/content/articles/${pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'illegal' },
    });
    const r2 = await call('POST', '/api/v2/content/comments/00000000000000000000000000/report', {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'abuse' },
    });
    check('E 志愿者 举报 → 403/403', r1.status === 403 && r2.status === 403, `art=${r1.status} cm=${r2.status}`);
  }

  // ===== F：管理员创建 → 201 + DRAFT/PENDING + author=operator =====
  let fPub = null;
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'F1', body: 'hello' },
    });
    remember(r.json);
    fPub = r.json?.data?.article_public_id ?? null;
    const st = fPub ? artState(fPub) : null;
    check('F 管理员 POST /admin/content/articles → 201 + status=1/audit=1 + author=operator',
      r.status === 201 && st && st.status === 1 && st.audit_status === 1 && st.author_id === uAlice && st.team_id === tA,
      `status=${r.status} art=${JSON.stringify(st)}`);
  }

  // ===== G：管理员创建 + 本人同 team 附件 → 201 + 附件物化 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'G1', body: 'b', attachment_file_public_ids: [F.alice] },
    });
    remember(r.json);
    const pub = r.json?.data?.article_public_id;
    const cnt = pub ? attCount(pub) : -1;
    check('G 管理员创建 + 本人同 team 附件 → 201 + 附件物化', r.status === 201 && cnt === 1, `status=${r.status} att=${cnt}`);
  }

  // ===== H：管理员创建 + 他人同 team 附件 → 201 + 附件物化（不要求本人上传）=====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'H1', body: 'b', attachment_file_public_ids: [F.bob] },
    });
    remember(r.json);
    const pub = r.json?.data?.article_public_id;
    const cnt = pub ? attCount(pub) : -1;
    check('H 管理员创建 + 他人同 team 附件 → 201 + 附件物化', r.status === 201 && cnt === 1, `status=${r.status} att=${cnt}`);
  }

  // ===== I：管理员创建 + 跨 team 附件 → 404 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'I1', body: 'b', attachment_file_public_ids: [F.carol] },
    });
    check('I 管理员创建 + 跨 team 附件 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== J：管理员创建 + 超 9 附件 → 400 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'J1', body: 'b', attachment_file_public_ids: fMaxPubs },
    });
    check('J 管理员创建 + 超 9 附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== K：管理员创建 + 重复附件 → 400 =====
  {
    const r = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'K1', body: 'b', attachment_file_public_ids: [F.alice, F.alice] },
    });
    check('K 管理员创建 + 重复附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== L：管理员 PUT 编辑 → 200 + 重置 DRAFT/PENDING =====
  {
    const r = await call('PUT', `/api/v2/admin/content/articles/${fPub}`, {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'F1-edited' },
    });
    remember(r.json);
    const st = artState(fPub);
    check('L 管理员 PUT 编辑 → 200 + 重置 status=1/audit=1', r.status === 200 && st.status === 1 && st.audit_status === 1, `status=${r.status} art=${JSON.stringify(st)}`);
  }

  // ===== M：管理员 PUT 编辑他人著作文（同 team）→ 200（不绑定 author）=====
  {
    // fPub 的 author=uAlice；用 uBob（同为 teamA team_owner）编辑
    const r = await call('PUT', `/api/v2/admin/content/articles/${fPub}`, {
      role: 'team_owner', user: uBob, team: tA, body: { title: 'M-edited' },
    });
    remember(r.json);
    check('M 管理员 PUT 编辑他人著作文（同 team）→ 200', r.status === 200, `got ${r.status}`);
  }

  // ===== N：管理员 PUT 编辑跨 team 文章 → 404 =====
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uCarol, team: tB, body: { title: 'N1', body: 'b' },
    });
    const pub = c.json?.data?.article_public_id;
    const r = await call('PUT', `/api/v2/admin/content/articles/${pub}`, {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'x' },
    });
    check('N 管理员 PUT 编辑跨 team 文章 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== O：管理员创建 → 审核发布 → 进入志愿者 feed =====
  let oPub = null;
  {
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: uAlice, team: tA, body: { title: 'O1', body: 'visible' },
    });
    oPub = c.json?.data?.article_public_id;
    const ap = await call('POST', `/api/v2/admin/content/articles/${oPub}/approve`, { role: 'team_admin', user: uBob, team: tA });
    const st = artState(oPub);
    const feed = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice, team: tA });
    remember(feed.json);
    const items = feed.json?.data?.items ?? [];
    check('O 管理员创建→审核发布→志愿者 feed 可见',
      ap.status === 200 && st.status === 2 && st.audit_status === 2 && items.some((x) => x.article_public_id === oPub),
      `approve=${ap.status} art=${JSON.stringify(st)}`);
  }

  // ===== P：志愿者调用管理端端点 → 403 =====
  {
    const r1 = await call('POST', '/api/v2/admin/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'x', body: 'y' },
    });
    const r2 = await call('PUT', `/api/v2/admin/content/articles/${oPub}`, {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'x' },
    });
    check('P 志愿者 调用管理端 create/update → 403/403', r1.status === 403 && r2.status === 403, `create=${r1.status} update=${r2.status}`);
  }

  // ===== 附加：所有被采集响应不含禁止 numeric/internal 标识 =====
  {
    let bad = null;
    for (const d of scanned) {
      const hit = scanForBanned(d);
      if (hit) { bad = hit; break; }
    }
    check('Z 响应不含禁止 numeric/internal 标识', bad === null, bad ?? 'scanned ' + scanned.length);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-R2A READONLY TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
