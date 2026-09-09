// =============================================================================
// P34-C1 — Activity Publication Approval Foundation（Schema + RBAC）
//
// 纯 migration / schema / RBAC 层验证，不启动 app、不改 runtime 行为。
//
// 覆盖（对应任务 §13）：
//   A  0027 迁移可应用
//   B  activities 具备 audit_status/submitted_by/submitted_at/reviewed_by/reviewed_at/reject_reason
//   C  audit_status 缺省 = 0，且 CHECK 拒绝非法值
//   D–K 遗留 status 0..7 → audit_status 确定性映射（6/7 安全缺省为 DRAFT）
//   L  遗留 lifecycle status 不被改写
//   M  publish_audit_by 仍存在（LEGACY_DORMANT）
//   N  新索引 idx_activities_team_audit_status 存在
//   O  content_audit_logs 支持 target_type='activity'
//   P–S 支持 action submit / approve / reject / publish
//   T/U permission 定义存在
//   V/W submit / review 绑定集合精确匹配
//   X  volunteer 两者均无
//   Y  team_auditor 有 review 无 submit
//   Z  platform_operator 有 review 无 submit
//   附加：publish_audit_by 在 workers/src 中仍无 runtime 使用（LEGACY_DORMANT 证明）
//
// 运行：node tests/p34_c1_activity_approval_foundation.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = join(WORKERS_DIR, 'migrations');

let __c = 0;
function pid(tag) {
  __c++;
  return (tag + __c.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
}

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function migrationFiles() {
  return readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort();
}

function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// =============================================================================
// DB1：应用全部 migration（含 0027）→ schema / permission / binding 验证
// =============================================================================
const db1 = newDb();
let applyErr = null;
try {
  for (const f of migrationFiles()) {
    db1.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
  }
} catch (e) {
  applyErr = e;
}
check('A 0027 迁移可应用（全部 migration 顺序执行无异常）', !applyErr, applyErr ? String(applyErr.message) : `共 ${migrationFiles().length} 个 migration`);
if (applyErr) {
  console.log('\n=== P34-C1 = BLOCKED ===');
  process.exit(1);
}

const cols = db1.prepare('PRAGMA table_info(activities)').all();
const colMap = new Map(cols.map((c) => [c.name, c]));
for (const c of [
  'audit_status', 'submitted_by', 'submitted_at',
  'reviewed_by', 'reviewed_at', 'reject_reason',
]) {
  check(`B activities 具备列 ${c}`, colMap.has(c));
}

// C：缺省值 + CHECK 约束
const dflt = colMap.get('audit_status');
check('C audit_status 缺省 = 0', dflt && String(dflt.dflt_value) === '0', `dflt_value=${dflt && dflt.dflt_value}`);
check('C audit_status NOT NULL', dflt && dflt.notnull === 1);

// 种子（DB1）
const T1 = pid('T');
const U1 = pid('U');
db1.prepare('INSERT INTO users (public_id, nickname) VALUES (?,?)').run(U1, 'tester');
const u1 = db1.prepare('SELECT id FROM users WHERE public_id=?').get(U1).id;
db1.prepare('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)').run(T1, 'team1', u1);
const t1 = db1.prepare('SELECT id FROM teams WHERE public_id=?').get(T1).id;

function insertActivity(db, { teamId, userId, status, audit_status }) {
  const p = pid('A');
  if (audit_status === undefined) {
    db.prepare(
      `INSERT INTO activities (public_id, team_id, title, start_time, end_time, status, created_by)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(p, teamId, 't', 1000, 2000, status, userId);
  } else {
    db.prepare(
      `INSERT INTO activities (public_id, team_id, title, start_time, end_time, status, audit_status, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(p, teamId, 't', 1000, 2000, status, audit_status, userId);
  }
  return p;
}

const p1 = insertActivity(db1, { teamId: t1, userId: u1, status: 0 });
const row1 = db1.prepare('SELECT audit_status FROM activities WHERE public_id=?').get(p1);
check('C 新插入行 audit_status 缺省落库 = 0', row1.audit_status === 0, `audit_status=${row1.audit_status}`);

let checkErr = null;
try {
  insertActivity(db1, { teamId: t1, userId: u1, status: 0, audit_status: 4 });
} catch (e) {
  checkErr = e;
}
check('C audit_status CHECK 拒绝非法值 4', !!checkErr, checkErr ? 'CHECK constraint 生效' : '未拒绝');

// M：publish_audit_by 保留
check('M publish_audit_by 仍存在（LEGACY_DORMANT，未删除/未 rename）', colMap.has('publish_audit_by'));

// N：索引
const idx = db1.prepare(
  `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_activities_team_audit_status'`,
).all();
check('N 索引 idx_activities_team_audit_status 存在', idx.length === 1);

// O–S：content_audit_logs 兼容性
let logErr = null;
try {
  db1.prepare(
    `INSERT INTO content_audit_logs (target_type, target_id, action, operator_id, team_id)
     VALUES ('activity', ?, 'submit', ?, ?)`,
  ).run(1, u1, t1);
} catch (e) {
  logErr = e;
}
check('O content_audit_logs 支持 target_type=activity', !logErr, logErr ? logErr.message : '');

for (const act of ['submit', 'approve', 'reject', 'publish']) {
  let err = null;
  try {
    db1.prepare(
      `INSERT INTO content_audit_logs (target_type, target_id, action, operator_id, team_id)
       VALUES ('activity', ?, ?, ?, ?)`,
    ).run(1, act, u1, t1);
  } catch (e) {
    err = e;
  }
  check(`${act.toUpperCase()} content_audit_logs 支持 action=${act}`, !err, err ? err.message : '');
}

// T–Z：权限与绑定
const permSubmit = db1.prepare(`SELECT id FROM permissions WHERE code='activity.activity.submit'`).get();
const permReview = db1.prepare(`SELECT id FROM permissions WHERE code='activity.activity.review'`).get();
check('T permission activity.activity.submit 存在', !!permSubmit);
check('U permission activity.activity.review 存在', !!permReview);

const rolesOf = (permId) =>
  db1
    .prepare(
      `SELECT r.code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_id = ? ORDER BY r.code`,
    )
    .all(permId)
    .map((x) => x.code);

const submitRoles = rolesOf(permSubmit.id);
const reviewRoles = rolesOf(permReview.id);
const EXPECTED_SUBMIT = ['platform_super_admin', 'team_admin', 'team_owner'];
const EXPECTED_REVIEW = ['platform_operator', 'platform_super_admin', 'team_admin', 'team_auditor', 'team_owner'];

const eqSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
check('V submit 绑定精确匹配 [platform_super_admin, team_owner, team_admin]',
  eqSet(submitRoles, EXPECTED_SUBMIT), `actual=[${submitRoles.join(', ')}]`);
check('W review 绑定精确匹配 [platform_super_admin, platform_operator, team_owner, team_admin, team_auditor]',
  eqSet(reviewRoles, EXPECTED_REVIEW), `actual=[${reviewRoles.join(', ')}]`);
check('X volunteer 既无 submit 也无 review',
  !submitRoles.includes('volunteer') && !reviewRoles.includes('volunteer'));
check('Y team_auditor 有 review 但无 submit',
  reviewRoles.includes('team_auditor') && !submitRoles.includes('team_auditor'));
check('Z platform_operator 有 review 但无 submit',
  reviewRoles.includes('platform_operator') && !submitRoles.includes('platform_operator'));

// 附加：activity.activity.publish 定义保留（未被删除）
const permPublish = db1.prepare(`SELECT id FROM permissions WHERE code='activity.activity.publish'`).get();
check('附加 activity.activity.publish 定义保留兼容', !!permPublish);

// =============================================================================
// DB2：0001–0026 → 播种 status 0..7 → 仅应用 0027 → 遗留映射验证
// =============================================================================
const db2 = newDb();
for (const f of migrationFiles().filter((x) => x !== '0027_p34_activity_approval_foundation.sql')) {
  db2.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
}
const T2 = pid('T');
const U2 = pid('U');
db2.prepare('INSERT INTO users (public_id, nickname) VALUES (?,?)').run(U2, 'tester2');
const u2 = db2.prepare('SELECT id FROM users WHERE public_id=?').get(U2).id;
db2.prepare('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)').run(T2, 'team2', u2);
const t2 = db2.prepare('SELECT id FROM teams WHERE public_id=?').get(T2).id;

const seeded = {};
for (const st of [0, 1, 2, 3, 4, 5, 6, 7]) {
  seeded[st] = insertActivity(db2, { teamId: t2, userId: u2, status: st });
}

db2.exec(readFileSync(join(MIG_DIR, '0027_p34_activity_approval_foundation.sql'), 'utf8'));

const EXPECTED_MAP = { 0: 0, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 0, 7: 0 };
const LABEL = { 0: 'DRAFT', 1: 'PENDING', 2: 'APPROVED', 3: 'REJECTED' };
for (const st of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const r = db2.prepare('SELECT status, audit_status FROM activities WHERE public_id=?').get(seeded[st]);
  const ok = r.audit_status === EXPECTED_MAP[st] && r.status === st;
  check(
    `${String.fromCharCode(68 + st)} status=${st} → audit_status=${EXPECTED_MAP[st]} (${LABEL[EXPECTED_MAP[st]]})`,
    ok,
    ok ? '' : `actual status=${r.status} audit_status=${r.audit_status}`,
  );
}

// L：lifecycle status 全量未被改写
const changed = db2
  .prepare('SELECT public_id, status FROM activities')
  .all()
  .filter((r) => ![0, 1, 2, 3, 4, 5, 6, 7].includes(r.status));
check('L 遗留 lifecycle status 未被改写', changed.length === 0, `异常行数=${changed.length}`);

const allMapped = db2.prepare('SELECT status, audit_status FROM activities').all();
check('L 全部活动 audit_status 均落在合法域 {0,1,2,3}', allMapped.every((r) => [0, 1, 2, 3].includes(r.audit_status)));
check('L 无任何遗留活动被强行置为 APPROVED', allMapped.filter((r) => r.status === 0).every((r) => r.audit_status === 0));

// 附加：publish_audit_by 仍无 runtime 使用（LEGACY_DORMANT 静态证明）
const SRC_DIR = join(WORKERS_DIR, 'src');
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const srcHits = walk(SRC_DIR).filter((f) => readFileSync(f, 'utf8').includes('publish_audit_by'));
check('附加 publish_audit_by 在 workers/src 中仍无 runtime 使用', srcHits.length === 0,
  srcHits.length ? srcHits.join(', ') : 'LEGACY_DORMANT 成立');

// ---------- 汇总 ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n==============================');
console.log(`P34-C1 RESULT: ${passed}/${results.length} PASS`);
if (failed) {
  console.log('FAILED:');
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
}
console.log(failed ? '=== P34-C1 = BLOCKED ===' : '=== P34-C1 = PASS ===');
process.exit(failed ? 1 : 0);
