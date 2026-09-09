// =============================================================================
// P33-P3B-2B — Community Repository + Service Core 集成探针（直接测 core，无 routes）
//
// 策略：用 esbuild 把真实 src/*.ts 打包成临时 ESM（置于 os.tmpdir，不进入 git delta），
// 再以 node:sqlite 实现 D1Database 适配器（prepare/bind/all/first/run/batch），
// 应用全部 migration 后在本地 sqlite 上直接实例化 Repository/Service 进行断言。
// 不依赖 wrangler / HTTP，不触碰任何冻结文件。
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

// --- 唯一 public_id 生成（仅用于种子；article/comment public_id 由仓库层 generateUlid 生成）---
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
        return {
          meta: {
            changes: r.changes ?? 0,
            last_row_id: Number(r.lastInsertRowid ?? 0),
          },
        };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      // BaseRepository.batch 传入的是已 prepare+bind 的语句对象数组（见 base.ts）。
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          const r = await s.run();
          out.push(r);
        }
        sqlite.exec('COMMIT');
        return out;
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
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 断言期望抛错 ----------
async function expectCode(fn, code, label) {
  try {
    await fn();
    check(label, false, `expected throw ${code}, got none`);
    return null;
  } catch (e) {
    const got = e && e.code ? e.code : (e && e.name) || 'unknown';
    check(label, got === code, `expected ${code}, got ${got}`);
    return e;
  }
}

// ---------- 无 numeric id 字段 ----------
const BANNED_KEYS = new Set(['id', 'user_id', 'team_id', 'file_id', 'object_key', 'checksum', 'author_id', 'target_id']);
function assertNoNumericIdKeys(obj, label) {
  const keys = Object.keys(obj || {});
  const hit = keys.filter((k) => BANNED_KEYS.has(k));
  check(`${label}: 无 numeric id 字段`, hit.length === 0, hit.length ? `found ${hit.join(',')}` : '');
}

// ---------- RepositoryContext 构造 ----------
function ctx(userId, teamId, roles = []) {
  return {
    auth: { authenticated: true, userId, role: null, teamId, roles },
    tenant: { scope: 'TEAM_SCOPED', teamId, userId },
  };
}

async function main() {
  // 1) 打包真实 src
  const entry = [
    `export { ContentRepository } from ${JSON.stringify(SRC('repository/content.ts'))};`,
    `export { ContentService } from ${JSON.stringify(SRC('services/content-service.ts'))};`,
    `export { ContentAdminService } from ${JSON.stringify(SRC('services/content-admin-service.ts'))};`,
    `export { FileRepository } from ${JSON.stringify(SRC('repository/files.ts'))};`,
  ].join('\n');
  const built = await build({
    stdin: { contents: entry, resolveDir: WORKERS_DIR, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `p33_content_bundle_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const mod = await import(pathToFileURL(bundlePath).href);
  const { ContentRepository, ContentService, ContentAdminService, FileRepository } = mod;

  // 2) 本地 sqlite + 应用 migration
  const sqlite = new DatabaseSync(':memory:');
  const fs = await import('node:fs');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  // 3) 种子：users / teams / files
  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const T = {
    A: pid('T'),
    B: pid('T'),
  };
  const U = {
    alice: pid('U'),
    bob: pid('U'),
    carol: pid('U'),
    dave: pid('U'),
  };
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.alice, 'alice');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.bob, 'bob');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.carol, 'carol');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U.dave, 'dave');
  const uid = (pub) => sqlite.prepare('SELECT id FROM users WHERE public_id=?').get(pub).id;
  const uAlice = uid(U.alice), uBob = uid(U.bob), uCarol = uid(U.carol);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uAlice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uCarol);
  const tid = (pub) => sqlite.prepare('SELECT id FROM teams WHERE public_id=?').get(pub).id;
  const tA = tid(T.A), tB = tid(T.B);

  // files: teamA/alice 可用；teamA/bob 同 team 他人；teamB/carol 跨 team；
  // 另含 visibility!='team' 与 mime 非法 与 scan_status=1 的样例（验证接纳/拒绝边界）
  const fileRow = (pub, team, uploader, mime, visibility, scan) =>
    seed(
      `INSERT INTO files (public_id, team_id, uploader_id, original_name, object_key, mime_type, size_bytes, checksum, visibility, scan_status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      pub, team, uploader, 'n', 'obj', mime, 10, 'cs', visibility, scan,
    );
  const F = {
    a1: pid('F'), // teamA/alice, jpeg, team, scan0 (C1/C2/C22)
    a2: pid('F'), // teamA/bob, png, team (C3 他人同 team)
    a3: pid('F'), // teamA/alice, webp, team
    b1: pid('F'), // teamB/carol, jpeg, team (C4 跨 team)
    pub: pid('F'), // teamA/alice, jpeg, visibility=public (拒绝边界)
    badmime: pid('F'), // teamA/alice, pdf, team (拒绝边界)
    scan1: pid('F'), // teamA/alice, jpeg, team, scan=1 (验证 scan_status 不拦截)
  };
  fileRow(F.a1, tA, uAlice, 'image/jpeg', 'team', 0);
  fileRow(F.a2, tA, uBob, 'image/png', 'team', 0);
  fileRow(F.a3, tA, uAlice, 'image/webp', 'team', 0);
  fileRow(F.b1, tB, uCarol, 'image/jpeg', 'team', 0);
  fileRow(F.pub, tA, uAlice, 'image/jpeg', 'public', 0);
  fileRow(F.badmime, tA, uAlice, 'application/pdf', 'team', 0);
  fileRow(F.scan1, tA, uAlice, 'image/jpeg', 'team', 1);
  const fid = (pub) => sqlite.prepare('SELECT id FROM files WHERE public_id=?').get(pub).id;
  // 10 个用于 max-9 测试（teamA/alice jpeg）
  const maxFiles = [];
  for (let i = 0; i < 10; i++) {
    const pub = pid('F');
    fileRow(pub, tA, uAlice, 'image/jpeg', 'team', 0);
    maxFiles.push(pub);
  }

  const articleState = (pub) =>
    sqlite
      .prepare('SELECT status, audit_status, published_at, author_id, team_id FROM content_articles WHERE public_id=?')
      .get(pub);
  const commentState = (pub) =>
    sqlite.prepare('SELECT status, audit_status, target_id, team_id FROM content_comments WHERE public_id=?').get(pub);

  // ---- C1: self create → DRAFT/PENDING ----
  const svcA = new ContentService({ db: d1, ctx: ctx(uAlice, tA) });
  const c1 = await svcA.createPost({ title: 'A1', body: 'hello' });
  const a1 = articleState(c1.article_public_id);
  check('C1 self create → status=1/audit=1/published=null', a1.status === 1 && a1.audit_status === 1 && a1.published_at === null, JSON.stringify(a1));
  check('C1 author/team 服务端派生', a1.author_id === uAlice && a1.team_id === tA);

  // ---- C2: create with attachment ----
  const c2 = await svcA.createPost({ title: 'A2', body: 'b', attachment_file_public_ids: [F.a1] });
  const att2 = sqlite.prepare('SELECT COUNT(*) c, GROUP_CONCAT(file_id) f FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)').get(c2.article_public_id);
  check('C2 attachment 物化 =1 且 file_id 正确', att2.c === 1 && String(att2.f) === String(fid(F.a1)), JSON.stringify(att2));

  // ---- C3: same-team other-user attachment reject ----
  await expectCode(() => svcA.createPost({ title: 'A3', body: 'b', attachment_file_public_ids: [F.a2] }), 'INVALID_PARAM', 'C3 他人同team附件拒绝');

  // ---- C4: cross-team attachment reject/not found ----
  await expectCode(() => svcA.createPost({ title: 'A4', body: 'b', attachment_file_public_ids: [F.b1] }), 'NOT_FOUND', 'C4 跨team附件 404');

  // ---- C22: scan_status=0 文件被接纳（以及 scan_status=1 也不拦截）----
  const c22 = await svcA.createPost({ title: 'A22', body: 'b', attachment_file_public_ids: [F.scan1] });
  check('C22 scan_status 文件被接纳', !!articleState(c22.article_public_id));

  // ---- C20: max 9 attachment ----
  await expectCode(() => svcA.createPost({ title: 'A20', body: 'b', attachment_file_public_ids: maxFiles }), 'INVALID_PARAM', 'C20 超过9个附件拒绝');
  const c20ok = await svcA.createPost({ title: 'A20b', body: 'b', attachment_file_public_ids: maxFiles.slice(0, 9) });
  const att20 = sqlite.prepare('SELECT COUNT(*) c FROM content_attachments WHERE target_id=(SELECT id FROM content_articles WHERE public_id=?)').get(c20ok.article_public_id);
  check('C20 9个附件被接纳', att20.c === 9, `count=${att20.c}`);

  // ---- C21: duplicate attachment reject ----
  await expectCode(() => svcA.createPost({ title: 'A21', body: 'b', attachment_file_public_ids: [F.a1, F.a1] }), 'INVALID_PARAM', 'C21 重复附件拒绝');

  // ---- C7: cross-team detail not found ----
  const svcB = new ContentService({ db: d1, ctx: ctx(uCarol, tB) });
  await expectCode(() => svcB.getArticle(c1.article_public_id), 'NOT_FOUND', 'C7 跨team详情 404');

  // ---- C8: self update own → DRAFT/PENDING ----
  // 先将其发布（用 admin），再 self-update 验证重置为草稿
  const adminA = new ContentAdminService({ db: d1, ctx: ctx(uAlice, tA) });
  const adminReviewer = new ContentAdminService({ db: d1, ctx: ctx(uBob, tA) });
  await adminReviewer.approve(c1.article_public_id);
  check('前置: approve 后 status=2/audit=2', (() => { const s = articleState(c1.article_public_id); return s.status === 2 && s.audit_status === 2; })());
  await svcA.updateOwnArticle(c1.article_public_id, { title: 'A1-edited' });
  const a1u = articleState(c1.article_public_id);
  check('C8 self update 后 status=1/audit=1/published=null', a1u.status === 1 && a1u.audit_status === 1 && a1u.published_at === null, JSON.stringify(a1u));
  check('C8 标题已更新', a1u ? sqlite.prepare('SELECT title FROM content_articles WHERE public_id=?').get(c1.article_public_id).title === 'A1-edited' : false);

  // ---- C9: update other's → not found ----
  const svcBob = new ContentService({ db: d1, ctx: ctx(uBob, tA) });
  await expectCode(() => svcBob.updateOwnArticle(c1.article_public_id, { title: 'x' }), 'NOT_FOUND', 'C9 他人文章更新 404');

  // ---- C6: feed only published+approved（更新后回到草稿，feed 应空）----
  let feed = await svcA.getFeed(1, 20);
  check('C6 草稿文章不进 feed', feed.items.length === 0, `feed=${feed.items.length}`);

  // ---- C10: admin approve（由非创建者的 reviewer uBob 执行）----
  await adminReviewer.approve(c1.article_public_id);
  const a1ap = articleState(c1.article_public_id);
  check('C10 approve → status=2/audit=2/published set', a1ap.status === 2 && a1ap.audit_status === 2 && a1ap.published_at != null, JSON.stringify(a1ap));
  const log10 = sqlite.prepare("SELECT action,from_status,to_status,operator_id,team_id FROM content_audit_logs WHERE target_type='article' AND target_id=(SELECT id FROM content_articles WHERE public_id=?) ORDER BY id DESC LIMIT 1").get(c1.article_public_id);
  check('C10 审计日志 approve from=1 to=2 operator=uBob(reviewer)', log10 && log10.action === 'approve' && log10.from_status === '1' && log10.to_status === '2' && log10.operator_id === uBob && log10.team_id === tA, JSON.stringify(log10));

  // ---- C6 (cont): feed 现含该文章 ----
  feed = await svcA.getFeed(1, 20);
  check('C6 发布后 feed 含文章', feed.items.length === 1 && feed.items[0].article_public_id === c1.article_public_id, `feed=${feed.items.length}`);
  const fi = feed.items[0];
  assertNoNumericIdKeys(fi, 'C18 feed item');
  check('C18 feed 不含 object_key/checksum', !('object_key' in fi) && !('checksum' in fi));
  check('C18 attachments safe DTO', fi.attachments.every((x) => x.file_public_id && x.mime_type && 'size_bytes' in x && !('object_key' in x)));

  // ---- C13: comment direct approved ----
  const c13 = await svcA.createComment(c1.article_public_id, { content: 'nice' });
  const cm = commentState(c13.comment_public_id);
  check('C13 comment 创建 status=1/audit=1', cm.status === 1 && cm.audit_status === 1 && cm.target_id === sqlite.prepare('SELECT id FROM content_articles WHERE public_id=?').get(c1.article_public_id).id, JSON.stringify(cm));
  const ac = sqlite.prepare('SELECT comment_count FROM content_articles WHERE public_id=?').get(c1.article_public_id).comment_count;
  check('§13 comment_count 计数器一致', ac === 1, `comment_count=${ac}`);
  const comments = await svcA.listComments(c1.article_public_id);
  check('C13 评论可见列表含该评论', comments.length === 1 && comments[0].comment_public_id === c13.comment_public_id);
  assertNoNumericIdKeys(comments[0], 'C18 comment view');

  // ---- C19: comment public_id used for report ----
  const r19 = await svcA.reportComment(c13.comment_public_id, { reason: 'abuse' });
  check('C19 用 comment public_id 举报', r19.ok === true && !('report_id' in r19));

  // ---- C16: article report ----
  const before = sqlite.prepare('SELECT report_count FROM content_articles WHERE public_id=?').get(c1.article_public_id).report_count;
  const r16 = await svcA.reportArticle(c1.article_public_id, { reason: 'illegal', detail: 'x' });
  const after = sqlite.prepare('SELECT report_count FROM content_articles WHERE public_id=?').get(c1.article_public_id).report_count;
  check('C16 文章举报 ok 且 report_count+1', r16.ok === true && after === before + 1, `before=${before} after=${after}`);
  const repRow = sqlite.prepare("SELECT reason_type,description,reporter_id,team_id FROM content_reports WHERE target_type='article' AND target_id=(SELECT id FROM content_articles WHERE public_id=?) ORDER BY id DESC LIMIT 1").get(c1.article_public_id);
  check('C16 举报落库(reason_type/description)', repRow && repRow.reason_type === 'illegal' && repRow.description === 'x' && repRow.reporter_id === uAlice && repRow.team_id === tA, JSON.stringify(repRow));

  // ---- C14: like idempotent ----
  const l1 = await svcA.likeArticle(c1.article_public_id);
  const l2 = await svcA.likeArticle(c1.article_public_id);
  check('C14 点赞幂等 liked=true 且 count 不变', l1.liked === true && l2.liked === true && l1.like_count === 1 && l2.like_count === 1, `l1=${l1.like_count} l2=${l2.like_count}`);
  const lc = sqlite.prepare('SELECT like_count FROM content_articles WHERE public_id=?').get(c1.article_public_id).like_count;
  check('§13 like_count 计数器一致', lc === 1, `like_count=${lc}`);

  // ---- C15: unlike idempotent ----
  const u1 = await svcA.unlikeArticle(c1.article_public_id);
  const u2 = await svcA.unlikeArticle(c1.article_public_id);
  check('C15 取消点赞幂等 liked=false 且 count=0', u1.liked === false && u2.liked === false && u1.like_count === 0 && u2.like_count === 0, `u1=${u1.like_count} u2=${u2.like_count}`);

  // ---- C11: admin reject（由非创建者的 reviewer uBob 执行）----
  await adminReviewer.reject(c1.article_public_id);
  const a1rj = articleState(c1.article_public_id);
  check('C11 reject → status=1/audit=3', a1rj.status === 1 && a1rj.audit_status === 3, JSON.stringify(a1rj));
  const log11 = sqlite.prepare("SELECT action,from_status,to_status FROM content_audit_logs WHERE target_type='article' AND target_id=(SELECT id FROM content_articles WHERE public_id=?) ORDER BY id DESC LIMIT 1").get(c1.article_public_id);
  check('C11 审计 reject from=2 to=1', log11 && log11.action === 'reject' && log11.from_status === '2' && log11.to_status === '1', JSON.stringify(log11));

  // ---- C23: unpublished/rejected absent feed ----
  feed = await svcA.getFeed(1, 20);
  check('C23 rejected 文章不进 feed', feed.items.length === 0, `feed=${feed.items.length}`);

  // ---- C12: admin unpublish ----
  await adminA.unpublish(c1.article_public_id);
  const a1un = articleState(c1.article_public_id);
  check('C12 unpublish → status=3/audit=2/published=null', a1un.status === 3 && a1un.audit_status === 2 && a1un.published_at === null, JSON.stringify(a1un));
  const log12 = sqlite.prepare("SELECT action,from_status,to_status FROM content_audit_logs WHERE target_type='article' AND target_id=(SELECT id FROM content_articles WHERE public_id=?) ORDER BY id DESC LIMIT 1").get(c1.article_public_id);
  check('C12 审计 unpublish from=1 to=3', log12 && log12.action === 'unpublish' && log12.from_status === '1' && log12.to_status === '3', JSON.stringify(log12));

  // ---- 额外：admin delete ----
  await adminA.delete(c1.article_public_id);
  const a1del = articleState(c1.article_public_id);
  check('admin delete → status=4/team-scoped 查询不可见', a1del.status === 4 && a1del.published_at === null, JSON.stringify(a1del));
  const delVisible = await svcA.getArticle(c1.article_public_id).then(() => true).catch(() => false);
  check('admin delete 后 team-scoped 读取 404', delVisible === false);

  // ---- 额外：admin list 返回 safe DTO ----
  const adminList = await adminA.list(1, 20);
  check('admin list 返回分页', adminList.pagination && typeof adminList.pagination.total === 'number');
  if (adminList.items.length) assertNoNumericIdKeys(adminList.items[0], 'C18 admin item');

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== P33-P3B-2B CORE TEST: ${results.length - failed.length}/${results.length} PASS ====`);
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
