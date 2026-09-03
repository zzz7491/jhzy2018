import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'E:/D盘备份/miniprogram/workers/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
console.log('data sqlite files:', files);
const db = new DatabaseSync(join(dir, files[0]));
const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('attendance_sessions').map((r) => r.name);
console.log('attendance_sessions cols:', cols.join(','));
const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='uq_active_attendance'").get();
console.log('uq_active_attendance:', idx ? idx.sql : 'MISSING');
const migs = db.prepare('SELECT name FROM d1_migrations ORDER BY rowid').all().map((r) => r.name);
console.log('d1_migrations:', migs.join(' | '));
const au = db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n;
console.log('attendance_sessions rows:', au);
db.close();
