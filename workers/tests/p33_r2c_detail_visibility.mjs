// =============================================================================
// P33-R2C — Community Article Detail Visibility Boundary Runtime Verification
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
// 验证两条详情边界：
//   1) 志愿者详情 GET /api/v2/content/articles/:id
//      仅允许 PUBLISHED + APPROVED；其它状态（草稿/驳回/下架/删除/跨团队）一律 404。
//   2) 管理员详情 GET /api/v2/admin/content/articles/:id
//      同 team 任意未删除状态可读（content.article.audit），含 status/author/attachments；
//      cross-team → 404，deleted → 404，无权限 → 403，非法 ULID → 400。
// 响应安全：不返回任何 numeric/internal 标识键。
// 运行：node tests/p33_r2c_detail_visibility.mjs（在 workers/ 目录）
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
const DUMMY_ULID = '123456789ABCDEFGHJKMNPQRSTV';
const BAD_ULID = 'NOTULID1234567890ABCDEFGH';

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
  const bundlePath = join(tmpdir(), `p33_r2c_app_${Date.now()}.mjs`);
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
  const F = { alice: pid('F') };
  fileRow(F.alice, tA, uAlice, 'image/jpeg', 'team', 0);

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

  // 用管理端（team_owner）建文并推进到目标状态
  async function createInState(team, ownerUser, state, withAttachment = false, reviewerUser = uBob) {
    const body = { title: 'T-' + state, body: 'b' };
    if (withAttachment) body.attachment_file_public_ids = [F.alice];
    const c = await call('POST', '/api/v2/admin/content/articles', {
      role: 'team_owner', user: ownerUser, team, body,
    });
    const pub = c.json?.data?.article_public_id;
    if (state === 'published') {
      await call('POST', `/api/v2/admin/content/articles/${pub}/approve`, { role: 'team_admin', user: reviewerUser, team });
    } else if (state === 'rejected') {
      await call('POST', `/api/v2/admin/content/articles/${pub}/reject`, { role: 'team_admin', user: reviewerUser, team });
    } else if (state === 'unpublished') {
      await call('POST', `/api/v2/admin/content/articles/${pub}/approve`, { role: 'team_admin', user: reviewerUser, team });
      await call('POST', `/api/v2/admin/content/articles/${pub}/unpublish`, { role: 'team_admin', user: reviewerUser, team });
    } else if (state === 'deleted') {
      await call('POST', `/api/v2/admin/content/articles/${pub}/approve`, { role: 'team_admin', user: reviewerUser, team });
      await call('DELETE', `/api/v2/admin/content/articles/${pub}`, { role: 'team_admin', user: reviewerUser, team });
    }
    // 'draft' 保持 POST 后默认 DRAFT/PENDING
    return pub;
  }

  const aPub = await createInState(tA, uAlice, 'published', true);
  const aDraft = await createInState(tA, uAlice, 'draft');
  const aRejected = await createInState(tA, uAlice, 'rejected');
  const aUnpub = await createInState(tA, uAlice, 'unpublished');
  const aDeleted = await createInState(tA, uAlice, 'deleted');
  const aCross = await createInState(tB, uCarol, 'draft'); // teamB 文章，teamA 不可见

  // ---------- 志愿者详情 ----------
  let vPub = await call('GET', `/api/v2/content/articles/${aPub}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V1 志愿者详情 PUBLISHED/APPROVED → 200', vPub.status === 200, `got ${vPub.status}`);
  check('V1 响应含 attachments（含已附文件）', Array.isArray(vPub.json?.data?.attachments) && vPub.json.data.attachments.length >= 1, JSON.stringify(vPub.json?.data?.attachments));
  check('V1 无禁止 numeric 标识', scanForBanned(vPub.json?.data) === null, scanForBanned(vPub.json?.data) ?? 'ok');

  let vDraft = await call('GET', `/api/v2/content/articles/${aDraft}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V2 志愿者详情 DRAFT/PENDING → 404', vDraft.status === 404, `got ${vDraft.status}`);

  let vRej = await call('GET', `/api/v2/content/articles/${aRejected}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V3 志愿者详情 DRAFT/REJECTED → 404', vRej.status === 404, `got ${vRej.status}`);

  let vUnpub = await call('GET', `/api/v2/content/articles/${aUnpub}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V4 志愿者详情 UNPUBLISHED/APPROVED → 404', vUnpub.status === 404, `got ${vUnpub.status}`);

  let vCross = await call('GET', `/api/v2/content/articles/${aCross}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V5 志愿者详情 跨团队 → 404', vCross.status === 404, `got ${vCross.status}`);

  let vDel = await call('GET', `/api/v2/content/articles/${aDeleted}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V6 志愿者详情 已删除 → 404', vDel.status === 404, `got ${vDel.status}`);

  // feed 行为不变：仅含已发布
  let feed = await call('GET', '/api/v2/content/feed', { role: 'volunteer', user: uAlice, team: tA });
  const feedItems = feed.json?.data?.items ?? [];
  check('F1 feed 仅含 PUBLISHED/APPROVED', feedItems.length === 1 && feedItems[0].article_public_id === aPub, `count=${feedItems.length}`);

  // ---------- 管理员详情 ----------
  let adPub = await call('GET', `/api/v2/admin/content/articles/${aPub}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A1 管理员详情 PUBLISHED/APPROVED → 200', adPub.status === 200, `got ${adPub.status}`);
  check('A1 含 status/audit_status', adPub.json?.data?.status === 2 && adPub.json?.data?.audit_status === 2, JSON.stringify(adPub.json?.data));
  check('A1 含 author_public_id', typeof adPub.json?.data?.author_public_id === 'string', JSON.stringify(adPub.json?.data?.author_public_id));
  check('A1 含 attachments', Array.isArray(adPub.json?.data?.attachments) && adPub.json.data.attachments.length >= 1, JSON.stringify(adPub.json?.data?.attachments));
  check('A1 无禁止 numeric 标识', scanForBanned(adPub.json?.data) === null, scanForBanned(adPub.json?.data) ?? 'ok');

  let adDraft = await call('GET', `/api/v2/admin/content/articles/${aDraft}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A2 管理员详情 DRAFT/PENDING → 200', adDraft.status === 200 && adDraft.json?.data?.status === 1 && adDraft.json?.data?.audit_status === 1, `got ${adDraft.status} ${JSON.stringify(adDraft.json?.data)}`);

  let adRej = await call('GET', `/api/v2/admin/content/articles/${aRejected}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A3 管理员详情 DRAFT/REJECTED → 200', adRej.status === 200 && adRej.json?.data?.status === 1 && adRej.json?.data?.audit_status === 3, `got ${adRej.status} ${JSON.stringify(adRej.json?.data)}`);

  let adUnpub = await call('GET', `/api/v2/admin/content/articles/${aUnpub}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A4 管理员详情 UNPUBLISHED/APPROVED → 200', adUnpub.status === 200 && adUnpub.json?.data?.status === 3 && adUnpub.json?.data?.audit_status === 2, `got ${adUnpub.status} ${JSON.stringify(adUnpub.json?.data)}`);

  let adCross = await call('GET', `/api/v2/admin/content/articles/${aCross}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A5 管理员详情 跨团队 → 404', adCross.status === 404, `got ${adCross.status}`);

  let adDel = await call('GET', `/api/v2/admin/content/articles/${aDeleted}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A6 管理员详情 已删除 → 404', adDel.status === 404, `got ${adDel.status}`);

  let adNoPerm = await call('GET', `/api/v2/admin/content/articles/${aPub}`, { role: 'volunteer', user: uAlice, team: tA });
  check('A7 管理员详情 无权限（志愿者）→ 403', adNoPerm.status === 403, `got ${adNoPerm.status}`);

  let adBadUlid = await call('GET', `/api/v2/admin/content/articles/${BAD_ULID}`, { role: 'team_owner', user: uAlice, team: tA });
  check('A8 管理员详情 非法 ULID → 400', adBadUlid.status === 400, `got ${adBadUlid.status}`);

  let vBadUlid = await call('GET', `/api/v2/content/articles/${BAD_ULID}`, { role: 'volunteer', user: uAlice, team: tA });
  check('V7 志愿者详情 非法 ULID → 400', vBadUlid.status === 400, `got ${vBadUlid.status}`);

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-R2C DETAIL VISIBILITY TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
