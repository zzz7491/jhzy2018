// =============================================================================
// P33-P3B-2C — Community HTTP Runtime Verification（真实 app + local D1）
//
// 策略：
//   1) esbuild 打包真实 src/app.ts（含本轮回写的 content/admin-content 路由 + 既有挂载）
//      → 内存 ESM（不进 git delta）。
//   2) 以 node:sqlite 实现 D1Database 适配器，应用【全部】migration
//      （含 0002 roles / 0003 权限目录 / 0023 SELF 权限 / 0024+0025 社区 schema）。
//      → roles / permissions / role_permissions 由 migration 真实填充，
//        权限裁决 100% DB-backed（与 S2-6f 运行时一致）。
//   3) 仅种子 users / teams / files（最小必需业务数据）；不写任何 permission 数据。
//   4) 通过 Hono app.request() 直接驱动【真实中间件链】
//      （authContext → tenantContext → csrfGuard → requirePermission → route → errorHandler）
//      以 x-test-* local mock 身份注入通道（S2-5 既定回归通道；权限解析走真实 role_permissions）。
//   5) 覆盖 H1–H25 + §13 审计流转核验。
//   不依赖 wrangler / 不触远端 / 不修改任何冻结文件。
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

// --- 唯一 public_id 生成（仅种子；article/comment public_id 由仓库层生成）---
let __c = 0;
function pid(tag) {
  __c++;
  return (tag + __c.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
}

// ---------- D1 适配器（node:sqlite 后端，与 P33-P3B-2B 核心测试同构）----------
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

// 收集需要被 H23 扫描的响应（data 部分）
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
  // 10 个同 team 文件（max-9 测试）
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

  // ===== H3：volunteer 自创建 → 成功 =====
  let a1Pub = null;
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A1', body: 'hello' },
    });
    remember(r.json);
    a1Pub = r.json?.data?.article_public_id ?? null;
    const st = a1Pub ? artState(a1Pub) : null;
    check('H3 volunteer 自创建 → 201 + status=1/audit=1', r.status === 201 && st && st.status === 1 && st.audit_status === 1, `status=${r.status} art=${JSON.stringify(st)}`);
  }

  // ===== H4：volunteer 更新自己 → 成功 =====
  {
    const r = await call('PUT', `/api/v2/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A1-edited' },
    });
    remember(r.json);
    const st = artState(a1Pub);
    check('H4 volunteer 更新自己 → 200 + 回到草稿', r.status === 200 && st.status === 1 && st.audit_status === 1, `status=${r.status} art=${JSON.stringify(st)}`);
  }

  // ===== H5：volunteer 更新他人 → 404 =====
  {
    const r = await call('PUT', `/api/v2/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uBob, team: tA, body: { title: 'x' },
    });
    check('H5 volunteer 更新他人文章 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H6：跨团队详情 → 404（先建 teamB 文章）=====
  let aBPub = null;
  {
    const c = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uCarol, team: tB, body: { title: 'B1', body: 'b' },
    });
    aBPub = c.json?.data?.article_public_id ?? null;
    const r = await call('GET', `/api/v2/content/articles/${aBPub}`, { role: 'volunteer', user: uAlice, team: tA });
    check('H6 跨团队文章详情 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H7：volunteer 不能 admin approve → 403 =====
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${a1Pub}/approve`, {
      role: 'volunteer', user: uAlice, team: tA,
    });
    check('H7 volunteer 不能 admin approve → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H8：volunteer 不能 admin delete → 403 =====
  {
    const r = await call('DELETE', `/api/v2/admin/content/articles/${a1Pub}`, {
      role: 'volunteer', user: uAlice, team: tA,
    });
    check('H8 volunteer 不能 admin delete → 403', r.status === 403, `got ${r.status}`);
  }

  // ===== H9：admin（team_owner）approve → 成功 =====
  {
    const r = await call('POST', `/api/v2/admin/content/articles/${a1Pub}/approve`, {
      role: 'team_owner', user: uAlice, team: tA,
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
      role: 'team_owner', user: uAlice, team: tA,
    });
    const st = artState(a1Pub);
    const feed = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice, team: tA });
    const items = feed.json?.data?.items ?? [];
    check('H11 reject → status=1/audit=3 且不在 feed', rj.status === 200 && st.status === 1 && st.audit_status === 3 && !items.some((x) => x.article_public_id === a1Pub), `art=${JSON.stringify(st)}`);
  }

  // ===== H12：评论创建即可见（先重新 approve 让文章可评论）=====
  let c1Pub = null;
  {
    await call('POST', `/api/v2/admin/content/articles/${a1Pub}/approve`, { role: 'team_owner', user: uAlice, team: tA });
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/comments`, {
      role: 'volunteer', user: uAlice, team: tA, body: { content: 'nice' },
    });
    remember(r.json);
    c1Pub = r.json?.data?.comment_public_id ?? null;
    const list = await call('GET', `/api/v2/content/articles/${a1Pub}/comments`, { role: 'volunteer', user: uAlice, team: tA });
    remember(list.json);
    const items = list.json?.data ?? [];
    check('H12 评论创建 → 201 且立即可见', r.status === 201 && items.some((x) => x.comment_public_id === c1Pub), `list=${items.length}`);
  }

  // ===== H13：点赞两次幂等 =====
  {
    const r1 = await call('POST', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    const r2 = await call('POST', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    remember(r1.json); remember(r2.json);
    const st = artState(a1Pub);
    check('H13 点赞两次幂等 (liked=true, like_count=1)', r1.json?.data?.liked === true && r2.json?.data?.liked === true && r1.json?.data?.like_count === 1 && r2.json?.data?.like_count === 1 && st.like_count === 1, `c1=${r1.json?.data?.like_count} c2=${r2.json?.data?.like_count} st=${st.like_count}`);
  }

  // ===== H14：取消点赞两次幂等 =====
  {
    const r1 = await call('DELETE', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    const r2 = await call('DELETE', `/api/v2/content/articles/${a1Pub}/like`, { role: 'volunteer', user: uAlice, team: tA });
    remember(r1.json); remember(r2.json);
    const st = artState(a1Pub);
    check('H14 取消点赞两次幂等 (liked=false, like_count=0)', r1.json?.data?.liked === false && r2.json?.data?.liked === false && r1.json?.data?.like_count === 0 && r2.json?.data?.like_count === 0 && st.like_count === 0, `c1=${r1.json?.data?.like_count} c2=${r2.json?.data?.like_count} st=${st.like_count}`);
  }

  // ===== H15：文章举报 → 安全成功响应 =====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'illegal', detail: 'x' },
    });
    remember(r.json);
    check('H15 文章举报 → 200 + {ok:true}', r.status === 200 && r.json?.data?.ok === true, `status=${r.status}`);
  }

  // ===== H16：评论举报（comment_public_id）=====
  {
    const r = await call('POST', `/api/v2/content/comments/${c1Pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'abuse' },
    });
    remember(r.json);
    check('H16 评论举报 → 200 + {ok:true}', r.status === 200 && r.json?.data?.ok === true, `status=${r.status}`);
  }

  // ===== H17：跨团队评论举报 → 404 =====
  {
    const r = await call('POST', `/api/v2/content/comments/${c1Pub}/report`, {
      role: 'volunteer', user: uCarol, team: tB, body: { reason: 'abuse' },
    });
    check('H17 跨团队评论举报 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H18：以 file_public_id 创建含附件 =====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A2', body: 'b', attachment_file_public_ids: [fAlicePub] },
    });
    remember(r.json);
    const pub = r.json?.data?.article_public_id;
    const cnt = pub ? q('SELECT COUNT(*) c FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)', pub).c : -1;
    check('H18 附件创建路径 → 201 + 附件物化', r.status === 201 && cnt === 1, `status=${r.status} att=${cnt}`);
  }

  // ===== H19：他人同 team 附件拒绝（400）=====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A3', body: 'b', attachment_file_public_ids: [fBobPub] },
    });
    check('H19 他人同 team 附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== H20：跨团队附件 → 404 =====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A4', body: 'b', attachment_file_public_ids: [fCarolPub] },
    });
    check('H20 跨团队附件 → 404', r.status === 404, `got ${r.status}`);
  }

  // ===== H21：max 9 强制 =====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A5', body: 'b', attachment_file_public_ids: fMaxPubs },
    });
    check('H21 超过9个附件 → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== H22：重复附件拒绝 =====
  {
    const r = await call('POST', '/api/v2/content/articles', {
      role: 'volunteer', user: uAlice, team: tA, body: { title: 'A6', body: 'b', attachment_file_public_ids: [fAlicePub, fAlicePub] },
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

  // ===== H24：非法 article/comment public id → 400 =====
  {
    const bad = 'NOTULID1234567890ABCDEFGH';
    const r1 = await call('GET', `/api/v2/content/articles/${bad}`, { role: 'volunteer', user: uAlice, team: tA });
    const r2 = await call('POST', `/api/v2/content/comments/${bad}/report`, { role: 'volunteer', user: uAlice, team: tA, body: { reason: 'abuse' } });
    check('H24 非法 public id → 400', r1.status === 400 && r2.status === 400, `article=${r1.status} comment=${r2.status}`);
  }

  // ===== H25：非法举报 reason → 400 =====
  {
    const r = await call('POST', `/api/v2/content/articles/${a1Pub}/report`, {
      role: 'volunteer', user: uAlice, team: tA, body: { reason: 'not-a-reason' },
    });
    check('H25 非法举报 reason → 400', r.status === 400, `got ${r.status}`);
  }

  // ===== §13 审计流转核验（独立文章 B，干净序列）=====
  {
    const c = await call('POST', '/api/v2/content/articles', { role: 'volunteer', user: uAlice, team: tA, body: { title: 'B', body: 'b' } });
    const bPub = c.json?.data?.article_public_id;
    const bId = artId(bPub);

    await call('POST', `/api/v2/admin/content/articles/${bPub}/approve`, { role: 'team_owner', user: uAlice, team: tA });
    const ap = auditRow(bId, 'approve');
    check('§13 approve from=1 to=2', ap && ap.from_status === '1' && ap.to_status === '2', JSON.stringify(ap));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/reject`, { role: 'team_owner', user: uAlice, team: tA });
    const rj = auditRow(bId, 'reject');
    check('§13 reject from=2 to=1', rj && rj.from_status === '2' && rj.to_status === '1', JSON.stringify(rj));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/approve`, { role: 'team_owner', user: uAlice, team: tA });
    const ap2 = auditRow(bId, 'approve');
    check('§13 二次 approve from=1 to=2', ap2 && ap2.from_status === '1' && ap2.to_status === '2', JSON.stringify(ap2));

    await call('POST', `/api/v2/admin/content/articles/${bPub}/unpublish`, { role: 'team_owner', user: uAlice, team: tA });
    const un = auditRow(bId, 'unpublish');
    check('§13 unpublish from=2 to=3', un && un.from_status === '2' && un.to_status === '3', JSON.stringify(un));

    await call('DELETE', `/api/v2/admin/content/articles/${bPub}`, { role: 'team_owner', user: uAlice, team: tA });
    const del = auditRow(bId, 'delete');
    check('§13 delete from=3 to=4', del && del.from_status === '3' && del.to_status === '4', JSON.stringify(del));
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-P3B-2C HTTP TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
