/**
 * P33-P3B-2A 本地回填脚本（仅 local D1 / 隔离测试库）。
 *
 * 纪律（与 scripts/backfill_0006_occurrences.mjs 一致）：
 * - 仅操作 local D1（node:sqlite 直接打开 miniflare sqlite 文件；或通过 BACKFILL_DB_PATH 指向隔离测试库）。
 * - 不连接 production / preview / remote。
 * - ULID 内联实现，与 src/utils/crypto.ts::generateUlid() 完全同契约（不 import .ts）。
 * - 整个 backfill 为单事务：任意一行失败 → ROLLBACK 全部本轮新增 → exit non-zero。
 * - 仅处理 WHERE public_id IS NULL；已有 public_id 不修改（幂等）。
 * - 不修改其它字段、不删除评论；numeric id 仅内部使用。
 *
 * REMOTE 模式：当前未实现。
 *   若显式传入 --remote，本脚本明确报告限制并以退出码 3 退出，绝不伪造 remote 实现。
 *   （wrangler CLI 无法对 D1 执行安全参数化批处理，远端回填须由 DBA 另行以安全方式完成。）
 *
 * 运行：
 *   node --experimental-sqlite scripts/backfill_p33_comments.mjs
 *   BACKFILL_DB_PATH=/path/to/test.sqlite node --experimental-sqlite scripts/backfill_p33_comments.mjs
 *   node --experimental-sqlite scripts/backfill_p33_comments.mjs --remote   # → 明确报告限制，exit 3
 */
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ---- REMOTE 模式未实现：明确报告限制，不伪造 ----
if (process.argv.includes('--remote')) {
  console.error('❌ REMOTE 模式未实现：本脚本仅支持 LOCAL D1 / BACKFILL_DB_PATH 隔离库。');
  console.error('   远端回填须由 DBA 通过 wrangler 以安全参数化方式执行（当前 wrangler 无安全参数绑定 → 不伪造）。');
  console.error('   详见 final report K. Remote Limitation。');
  process.exit(3);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const workersDir = resolve(__dirname, '..');
const d1Dir = join(workersDir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

let dbPath;
if (process.env.BACKFILL_DB_PATH) {
  // 隔离测试库支持：用 BACKFILL_DB_PATH 覆盖默认 miniflare 文件，复用同一核心回填逻辑。
  dbPath = process.env.BACKFILL_DB_PATH;
  console.error('[backfill] 使用 BACKFILL_DB_PATH 覆盖:', dbPath);
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
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

// ---- 与 src/utils/crypto.ts::generateUlid() 完全同契约的 Crockford ULID ----
// ULID_ENCODING 排除 I/L/O/U；48-bit 毫秒时间戳 + 80-bit 随机数；输出 26 字符。
const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function generateUlid() {
  const time = Date.now();
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // 10 字符时间戳（每个 5 bit）
  let out = '';
  let t = time;
  for (let i = 9; i >= 0; i--) {
    out = ULID_ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  // 16 字符随机段（80 bit）
  let rand = 0n;
  for (let i = 0; i < 10; i++) {
    rand = (rand << 8n) | BigInt(bytes[i]);
  }
  for (let i = 15; i >= 0; i--) {
    out += ULID_ENCODING[Number((rand >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

// 现有非 NULL public_id（用于碰撞去重，避免违反 UNIQUE 约束）
const existingRows = db.prepare('SELECT public_id FROM content_comments WHERE public_id IS NOT NULL').all();
const used = new Set(existingRows.map((r) => r.public_id));

const nullRows = db.prepare('SELECT id FROM content_comments WHERE public_id IS NULL ORDER BY id').all();
const TOTAL_NULL = nullRows.length;

// 生成不与现有/本轮冲突的 ULID（极端碰撞时重试；128-bit 随机下几乎不可能）
function freshUlid() {
  let pid;
  let guard = 0;
  do {
    pid = generateUlid();
    guard++;
  } while (used.has(pid) && guard < 1000);
  used.add(pid);
  return pid;
}

const updateStmt = db.prepare('UPDATE content_comments SET public_id = ? WHERE id = ?');

let UPDATED = 0;
let FAILED = 0;
let SKIPPED = 0; // 已有 public_id（理论上为 0，因本脚本只取 NULL 行）
try {
  db.exec('BEGIN');
  for (const r of nullRows) {
    const pid = freshUlid();
    try {
      updateStmt.run(pid, r.id);
      UPDATED++;
    } catch (e) {
      FAILED++;
      console.error('❌ update failed for comment', r.id, '-', e.message);
    }
  }

  if (FAILED > 0) {
    db.exec('ROLLBACK');
    console.log('TOTAL_NULL=' + TOTAL_NULL);
    console.log('UPDATED=' + UPDATED);
    console.log('FAILED=' + FAILED);
    console.log('SKIPPED=' + SKIPPED);
    console.error('\n❌ BACKFILL FAILED — 已 ROLLBACK 全部本轮新增');
    process.exit(1);
  }

  db.exec('COMMIT');
  console.log('TOTAL_NULL=' + TOTAL_NULL);
  console.log('UPDATED=' + UPDATED);
  console.log('FAILED=' + FAILED);
  console.log('SKIPPED=' + SKIPPED);
  console.error('\n✅ BACKFILL OK');
  process.exit(0);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\n❌ BACKFILL EXCEPTION — 已 ROLLBACK:', e.message);
  process.exit(1);
}
