/**
 * P33-P3B-2A 本地验收脚本（只读，绝不修改任何数据）。
 *
 * 纪律（与 scripts/verify_0006.mjs 一致）：
 * - 仅操作 local D1 / 隔离测试库；以 readOnly 模式打开，任何写操作都会抛错，强制只读。
 * - 不连接 production / preview / remote。
 *
 * 校验内容：
 *   核心 4 项（backfill 正确性，始终校验）：
 *     A. NULL public_id count = 0
 *     B. public_id count = row count（无 NULL 残留）
 *     C. 每条 public_id 长度 = 26 且符合 Crockford regex /^[0-9A-HJKMNP-TV-Z]{26}$/
 *     D. 重复 public_id count = 0
 *   0025 后 schema 校验（仅当 public_id 已为 NOT NULL 时强制；pre-0025 顺延提示）：
 *     E. public_id schema = NOT NULL
 *     F. 命名唯一索引 idx_comment_public_id 存在且 unique
 *
 * 运行：
 *   node --experimental-sqlite scripts/verify_p33_comments.mjs
 *   BACKFILL_DB_PATH=/path/to/test.sqlite node --experimental-sqlite scripts/verify_p33_comments.mjs
 * 退出码：全部适用检查 PASS → 0；任一失败 → 1；表/库不存在 → 2
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workersDir = resolve(__dirname, '..');
const d1Dir = join(workersDir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

let dbPath;
if (process.env.BACKFILL_DB_PATH) {
  dbPath = process.env.BACKFILL_DB_PATH;
} else {
  const entries = readdirSync(d1Dir).filter(
    (f) => f.endsWith('.sqlite') && !f.includes('metadata') && !f.endsWith('-wal') && !f.endsWith('-shm'),
  );
  if (entries.length === 0) {
    console.error('❌ 未找到本地 D1 sqlite 文件，请先运行 wrangler dev 生成本地 D1，或设置 BACKFILL_DB_PATH。');
    process.exit(2);
  }
  dbPath = join(d1Dir, entries[0]);
}

// 只读打开：任何写操作都会抛错，强制 verify 安全。
const db = new DatabaseSync(dbPath, { readOnly: true });

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---- 表存在性 ----
const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_comments'").get();
if (!tbl) {
  console.error('❌ content_comments 表不存在');
  process.exit(2);
}
check('content_comments 表存在', true);

// ---- 列信息 ----
const cols = db.prepare("SELECT name, \"notnull\" FROM pragma_table_info('content_comments')").all();
const colInfo = {};
for (const c of cols) colInfo[c.name] = c;
const hasPublicId = !!colInfo.public_id;
const isPublicIdNotNull = hasPublicId && colInfo.public_id.notnull === 1;

// ---- A/B/D. 计数类校验 ----
const total = db.prepare('SELECT COUNT(*) n FROM content_comments').get().n;
const nullCount = db.prepare('SELECT COUNT(*) n FROM content_comments WHERE public_id IS NULL').get().n;
const nonNullCount = db.prepare('SELECT COUNT(public_id) n FROM content_comments').get().n;
const dupRows = db.prepare(
  "SELECT public_id, COUNT(*) c FROM content_comments WHERE public_id IS NOT NULL GROUP BY public_id HAVING c > 1",
).all();
const dupCount = dupRows.length;

check('NULL public_id count = 0', nullCount === 0, `null=${nullCount}`);
check('public_id count = row count', nonNullCount === total, `nonNull=${nonNullCount}/${total}`);
check('重复 public_id count = 0', dupCount === 0, dupCount ? JSON.stringify(dupRows) : '');

// ---- C. ULID 合法性 ----
let lenBad = 0;
let regexBad = 0;
if (total > 0) {
  const rows = db.prepare('SELECT public_id FROM content_comments').all();
  for (const r of rows) {
    if (r.public_id.length !== 26) lenBad++;
    else if (!ULID_RE.test(r.public_id)) regexBad++;
  }
}
check('每条 public_id 长度 = 26', lenBad === 0, `bad=${lenBad}`);
check('每条 public_id 符合 Crockford regex', regexBad === 0, `bad=${regexBad}`);

// ---- E/F. 0025 后 schema 校验（仅当 public_id 已为 NOT NULL 时强制）----
const idxRow = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='content_comments' AND name='idx_comment_public_id'",
).get();
let uniqueIdxIsUnique = false;
if (idxRow) {
  const info = db.prepare("SELECT \"unique\" u FROM pragma_index_list('content_comments') WHERE name='idx_comment_public_id'").get();
  uniqueIdxIsUnique = !!info && info.u === 1;
}

if (isPublicIdNotNull) {
  check('public_id schema = NOT NULL', isPublicIdNotNull);
  check('unique index idx_comment_public_id 存在且 unique', uniqueIdxIsUnique, idxRow ? '' : '索引缺失');
} else {
  console.log('  ℹ️  public_id 仍为可空（pre-0025）；NOT NULL / unique 校验顺延至 0025 后 final verify。');
}

db.close();
console.log(`\n=== verify_p33_comments: ${failed === 0 ? 'ALL PASS ✅' : failed + ' 项失败 ❌'} ===`);
process.exit(failed === 0 ? 0 : 1);
