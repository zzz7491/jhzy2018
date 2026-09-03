import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_PATH = process.argv[2];
const MIGRATION_FILE = join(import.meta.dirname, 'migrations', '0004_attendance_multi_participation.sql');
const MIGRATION_NAME = '0004_attendance_multi_participation.sql';

const d = new DatabaseSync(DB_PATH);

// 1) 幂等：已应用则跳过
const already = d.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').get(MIGRATION_NAME);
if (already) {
  console.log('[0004] already applied, skipping');
} else {
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  d.exec(sql);
  d.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(MIGRATION_NAME);
  console.log('[0004] applied');
}

// 2) 验证新 schema
const cols = d.prepare("SELECT name FROM pragma_table_info('attendance_sessions')").all().map((r) => r.name);
console.log('[verify] attendance_sessions columns:', cols.join(', '));
const hasServiceDate = cols.includes('service_date') && cols.includes('slot');
console.log('[verify] service_date+slot present:', hasServiceDate);

const idx = d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_active_attendance'").get();
console.log('[verify] uq_active_attendance present:', !!idx);

const oldIdx = d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_attendance_sessions_1'").get();
console.log('[verify] old UNIQUE(signup_id) autoindex removed:', !oldIdx);

const oldTables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_old'").all().map((r) => r.name);
console.log('[verify] leftover _old tables:', oldTables.length === 0 ? 'none' : oldTables.join(','));

// FK 目标应为新 attendance_sessions
const fk = d.prepare("SELECT 'attendance_events' AS t, (SELECT GROUP_CONCAT(\"table\") FROM pragma_foreign_key_list('attendance_events')) AS refs").get();
console.log('[verify] attendance_events FK targets:', fk.refs);

const migs = d.prepare('SELECT name FROM d1_migrations ORDER BY rowid').all().map((r) => r.name);
console.log('[verify] d1_migrations:', migs.join(', '));

d.close();
const ok = hasServiceDate && idx && !oldIdx && oldTables.length === 0 && (fk.refs || '').includes('attendance_sessions');
if (!ok) {
  console.error('[0004] VERIFY FAILED');
  process.exit(1);
}
console.log('[0004] OK');
