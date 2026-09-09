/**
 * P33-P3B-2A 本地 rollout orchestrator（仅 LOCAL）。
 *
 * 强制顺序（rollout closure，不得只写进报告让人“记得执行”）：
 *   0024 → backfill → verify → 0025 → final verify
 *
 * 纪律：
 * - 仅 LOCAL：直接以 node:sqlite 对本地 miniflare sqlite（或 BACKFILL_DB_PATH 隔离库）应用 0024 / 0025 SQL。
 * - 不得 deploy、不得连接 remote production / preview、不得创建任何远端资源。
 * - 幂等：已应用过的阶段自动跳过（按 public_id 列存在性 / NOT NULL 状态判断）。
 * - backfill / verify 复用同一份 scripts/backfill_p33_comments.mjs、verify_p33_comments.mjs。
 * - REMOTE 回填不在本脚本范围（见 final report K. Remote Limitation）。
 *
 * 运行：
 *   node --experimental-sqlite scripts/migrate_p33_community.mjs
 *   BACKFILL_DB_PATH=/path/to/test.sqlite node --experimental-sqlite scripts/migrate_p33_community.mjs
 * 退出码：全部阶段 OK → 0；任一阶段失败 → 1；库不存在 → 2
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workersDir = resolve(__dirname, '..');
const migrationsDir = join(workersDir, 'migrations');
const d1Dir = join(workersDir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const backfillScript = join(__dirname, 'backfill_p33_comments.mjs');
const verifyScript = join(__dirname, 'verify_p33_comments.mjs');

let dbPath;
if (process.env.BACKFILL_DB_PATH) {
  dbPath = process.env.BACKFILL_DB_PATH;
  console.error('[migrate] 使用 BACKFILL_DB_PATH 覆盖:', dbPath);
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

function runScript(script) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['--experimental-sqlite', script], {
      env: { ...process.env, BACKFILL_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => res({ code, out }));
  });
}

function hasColumn(db, table, col) {
  const r = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, col);
  return !!r;
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

let failed = 0;
function phase(name, ok, out) {
  console.log(`\n=== ${name} ===`);
  console.log(out);
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

// ---- Phase 1: 0024（content_articles.content_type 增加 'post' + content_comments.public_id 可空）----
if (!hasColumn(db, 'content_comments', 'public_id')) {
  const sql = readFileSync(join(migrationsDir, '0024_p33_community_content.sql'), 'utf8');
  db.exec(sql);
  console.log('\n=== Phase 1: 0024 applied ===');
} else {
  console.log('\n=== Phase 1: 0024 already applied (skip) ===');
}

// ---- Phase 2: backfill ----
const r2 = await runScript(backfillScript);
phase('Phase 2: backfill', r2.code === 0, r2.out);

// ---- Phase 3: verify (pre-0025) ----
const r3 = await runScript(verifyScript);
phase('Phase 3: verify (pre-0025)', r3.code === 0, r3.out);

// ---- Phase 4: 0025（public_id 升级为 NOT NULL UNIQUE）----
const notNullRow = db.prepare("SELECT \"notnull\" FROM pragma_table_info('content_comments') WHERE name='public_id'").get();
if (!notNullRow || notNullRow.notnull !== 1) {
  const sql = readFileSync(join(migrationsDir, '0025_p33_comment_public_id_notnull.sql'), 'utf8');
  db.exec(sql);
  console.log('\n=== Phase 4: 0025 applied ===');
} else {
  console.log('\n=== Phase 4: 0025 already applied (skip) ===');
}

// ---- Phase 5: final verify ----
const r5 = await runScript(verifyScript);
phase('Phase 5: final verify', r5.code === 0, r5.out);

db.close();
console.log(`\n=== migrate_p33_community: ${failed === 0 ? 'CLOSURE OK ✅' : failed + ' 阶段失败 ❌'} ===`);
process.exit(failed === 0 ? 0 : 1);
