import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const d = new DatabaseSync(dbPath);

console.log('=== indexes on attendance_sessions ===');
for (const r of d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='attendance_sessions'").all()) {
  console.log('  ', r.name, '=>', r.sql);
}
console.log('=== tables with FK referencing attendance_sessions ===');
for (const r of d.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%REFERENCES attendance_sessions%'").all()) {
  console.log('  ', r.name);
}
console.log('=== d1_migrations applied ===');
try {
  for (const r of d.prepare('SELECT name FROM d1_migrations').all()) console.log('  ', r.name);
} catch (e) {
  console.log('  (no d1_migrations table)', e.message);
}
d.close();
