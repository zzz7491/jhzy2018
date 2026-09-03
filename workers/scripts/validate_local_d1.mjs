/**
 * S2-4 本地 D1 Runtime Validation + 测试（A–I）。
 *
 * 实现：直接以 node:sqlite 打开 wrangler 本地 D1 的 sqlite 文件（与 Worker 运行时同为 libsqlite3 引擎），
 * 在单进程内完成全部校验，避免反复 spawn wrangler / workerd 导致的进程崩溃。
 *
 * 纪律：仅操作 local D1（不连接 Production）。测试数据全部本地、临时、可删除、带 TEST 标记，
 * 结束后 teardown。不向 permissions / role_permissions / user_roles 插入任何数据。
 *
 * 运行：node --experimental-sqlite scripts/validate_local_d1.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workersDir = resolve(__dirname, '..');
const d1Dir = join(workersDir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const results = [];
let failed = 0;

process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e);
  process.exitCode = 3;
});

function check(name, cond, detail = '') {
  const line = `  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line);
  process.stderr.write(line + '\n');
  if (!cond) failed++;
}

// ---- 定位本地 D1 sqlite 文件（排除 metadata / -wal / -shm）----
const entries = readdirSync(d1Dir)
  .map((f) => String(f))
  .filter((f) => f.endsWith('.sqlite') && !f.includes('metadata') && !f.endsWith('-wal') && !f.endsWith('-shm'));
if (entries.length === 0) {
  console.error('❌ 未找到本地 D1 sqlite 文件，请先运行: npm run migrate:local');
  process.exitCode = 2;
} else {
  const dbPath = join(d1Dir, entries[0]);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  const all = (sql, p = []) => db.prepare(sql).all(...p);
  const one = (sql, p = []) => db.prepare(sql).get(...p);
  const runSql = (sql, p = []) => {
    try {
      db.prepare(sql).run(...p);
      return { ok: true, err: null };
    } catch (e) {
      return { ok: false, err: e };
    }
  };

  console.error('=== S2-4 本地 D1 Runtime Validation ===\n');
  console.error(`db: ${entries[0]}\n`);

  // A. Migration tracking ----
  const mig = all("SELECT name FROM d1_migrations ORDER BY id");
  const migNames = mig.map((r) => r.name).join(', ');
  check('A. migration tracking 正常', mig.length === 4, `4 行 (0001/0002/0003 + S2-6h-R2 的 0004_attendance_multi_participation): ${migNames}`);
  check('A. migration 无顺序问题', migNames.includes('0001') && migNames.includes('0002') && migNames.includes('0003') && migNames.includes('0004'), migNames);

  // B. 所有表创建成功 ----
  const tbl = all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  );
  const tableNames = new Set(tbl.map((r) => r.name));
  check('B. 所有表存在', tableNames.size >= 63, `共 ${tableNames.size} 张用户表（预期 ≥63）`);

  // C. FK 存在 ----
  const fk = all("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('activities')");
  check('C. FK 定义存在（activities）', (fk[0]?.n ?? 0) >= 1, `activities FK 数=${fk[0]?.n}`);
  const fkTeam = all("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('activities') WHERE \"from\" = 'team_id'");
  check('C. team_id FK 存在', (fkTeam[0]?.n ?? 0) >= 1, `team_id FK=${fkTeam[0]?.n}`);

  // D. CHECK 存在（D1 不支持 pragma_check_list 表函数，改用 DDL 内省）----
  const ck = all("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND sql LIKE '%CHECK%'");
  check('D. CHECK 约束存在于 DDL', (ck[0]?.n ?? 0) > 0, `含 CHECK 的表数=${ck[0]?.n}`);

  // E. 索引存在 ----
  const idx = all("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'");
  check('E. 自定义索引存在', (idx[0]?.n ?? 0) > 0, `索引数=${idx[0]?.n}`);

  // F. 6 角色 + volunteer=team ----
  const roles = all('SELECT code, scope FROM roles ORDER BY id');
  const roleCodes = roles.map((r) => r.code);
  const expected = [
    'platform_super_admin', 'platform_operator', 'team_owner',
    'team_admin', 'team_auditor', 'volunteer',
  ];
  const sameSet = expected.every((c) => roleCodes.includes(c)) && roleCodes.length === 6;
  check('F. 6 个冻结角色完整', sameSet, roleCodes.join(','));
  const volunteerScope = roles.find((r) => r.code === 'volunteer')?.scope;
  check('F. volunteer = TEAM scope（S2-2G 裁定）', volunteerScope === 'team', `volunteer.scope=${volunteerScope}`);

  // G. permissions / role_permissions / user_roles —— S2-6e seed 基线（83 / 238 / 0）----
  const permN = one('SELECT COUNT(*) AS n FROM permissions')?.n;
  const rpN = one('SELECT COUNT(*) AS n FROM role_permissions')?.n;
  const urN = one('SELECT COUNT(*) AS n FROM user_roles')?.n;
  check('G. permissions = 83 (S2-6e seed)', permN === 83, `permissions=${permN}`);
  check('G. role_permissions = 238 (S2-6e seed)', rpN === 238, `role_permissions=${rpN}`);
  check('G. user_roles = 0', urN === 0, `user_roles=${urN}`);

  // ---- 幂等清理：删除任何遗留 TEST fixture ----
  runSql("DELETE FROM activity_signups WHERE activity_id IN (SELECT id FROM activities WHERE public_id LIKE 'TEST%')");
  runSql("DELETE FROM activities WHERE public_id LIKE 'TEST%'");
  runSql("DELETE FROM teams WHERE public_id LIKE 'TEST%'");
  runSql("DELETE FROM users WHERE public_id LIKE 'TEST%'");

  // ---- 测试 fixture ----
  const fxUser = runSql("INSERT INTO users (public_id, status, cert_level) VALUES ('TESTUSER00000000000000000001', 1, 0)");
  const fxTeamA = runSql("INSERT INTO teams (public_id, owner_user_id, name, is_system, status, cert_status) VALUES ('TESTTEAM0000000000000000000001', 1, 'TEST-A', 0, 1, 0)");
  const fxTeamB = runSql("INSERT INTO teams (public_id, owner_user_id, name, is_system, status, cert_status) VALUES ('TESTTEAM0000000000000000000002', 1, 'TEST-B', 0, 1, 0)");
  check('fixture: TEST 用户已建', fxUser.ok, fxUser.err?.message ?? '');
  check('fixture: TEST 团队A已建', fxTeamA.ok, fxTeamA.err?.message ?? '');
  check('fixture: TEST 团队B已建', fxTeamB.ok, fxTeamB.err?.message ?? '');

  // H. FK 强制生效（错误 team_id 应被拒）----
  const badFk = runSql(
    "INSERT INTO activities (public_id, team_id, title, start_time, end_time, created_by, status) VALUES ('TESTFK000000000000000000000001', 999999, 'x', 0, 1, 1, 0)",
  );
  check('H. FK 强制生效（错误 team_id 被拒）', !badFk.ok, `rejected=${!badFk.ok} err=${badFk.err?.message ?? ''}`);

  // H2. CHECK 强制生效（非法 enum status=99 应被拒）----
  const badCheck = runSql(
    "INSERT INTO activities (public_id, team_id, title, start_time, end_time, created_by, status) VALUES ('TESTCHK00000000000000000000001', 1, 'x', 0, 1, 1, 99)",
  );
  check('H. CHECK 强制生效（非法 status=99 被拒）', !badCheck.ok, `rejected=${!badCheck.ok} err=${badCheck.err?.message ?? ''}`);

  // I. Tenant Scope 隔离（TEAM_SCOPED 直查 + 派生表 JOIN）----
  runSql("INSERT INTO activities (public_id, team_id, title, start_time, end_time, created_by, status) VALUES ('TESTACT000000000000000000000001', 1, 'A1', 0, 1, 1, 0)");
  runSql("INSERT INTO activities (public_id, team_id, title, start_time, end_time, created_by, status) VALUES ('TESTACT000000000000000000000002', 2, 'A2', 0, 1, 1, 0)");
  const teamA = all('SELECT id, team_id FROM activities WHERE team_id = 1');
  const teamB = all('SELECT id, team_id FROM activities WHERE team_id = 2');
  check('I. TEAM_SCOPED 隔离（team_id=1 仅见本团队数据）', teamA.length === 1 && teamA[0].team_id === 1, `team1 行数=${teamA.length}`);
  check('I. TEAM_SCOPED 隔离（team_id=2 仅见本团队数据）', teamB.length === 1 && teamB[0].team_id === 2, `team2 行数=${teamB.length}`);

  // 派生表（activity_signups 无 team_id，经 JOIN activities 派生）
  const fxSignup = runSql('INSERT INTO activity_signups (activity_id, user_id, review_status, status) VALUES (1, 1, 0, 1)');
  check('fixture: activity_signups 已建', fxSignup.ok, fxSignup.err?.message ?? '');
  const derived = all(
    'SELECT s.id, a.team_id FROM activity_signups s JOIN activities a ON a.id = s.activity_id WHERE a.team_id = 1',
  );
  check('I. DERIVED_TEAM 隔离（activity_signups 经 JOIN 派生 team）', derived.length === 1 && derived[0].team_id === 1, `派生行数=${derived.length}`);

  // Teardown ----
  runSql('DELETE FROM activity_signups WHERE activity_id IN (1,2)');
  runSql('DELETE FROM activities WHERE team_id IN (1,2)');
  runSql('DELETE FROM teams WHERE id IN (1,2)');
  runSql('DELETE FROM users WHERE id = 1');
  const afterPerm = one('SELECT COUNT(*) AS n FROM permissions')?.n;
  const afterRoles = one('SELECT COUNT(*) AS n FROM roles')?.n;
  check('I. teardown 后 permissions = 83 (S2-6e seed)', afterPerm === 83, `permissions=${afterPerm}`);
  check('I. teardown 后 roles 仍为 6', afterRoles === 6, `roles=${afterRoles}`);

  db.close();

  console.error(`\n=== 结果：${failed === 0 ? 'ALL PASS ✅' : failed + ' 项失败 ❌'} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}
