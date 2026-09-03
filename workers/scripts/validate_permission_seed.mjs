#!/usr/bin/env node
/**
 * 嘉禾志愿 2.0 —— Permission Seed DB Validator（S2-6e）
 *
 * 读取：
 *   - scripts/permission-catalog.json（唯一事实源）
 *   - LOCAL D1（.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite，含 roles 表者）
 *
 * 仅做集合/约束校验，不写 D1。纯本地、不连 Production。
 *
 * 重点：不止 COUNT()，做逐集合 equality，防止“少了 A 多了 B 数量仍为 83”假阳性。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CATALOG = join(ROOT, 'scripts', 'permission-catalog.json');
const STATE_DIR = join(ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const jsonPerms = catalog.permissions;
const jsonRolePerms = catalog.rolePermissions;
const jsonRoles = catalog.roles.map((r) => r.code);

// ---- 定位本地业务库 ----
const files = readdirSync(STATE_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
let dbPath = null;
for (const f of files) {
  const p = join(STATE_DIR, f);
  const probe = new DatabaseSync(p);
  try {
    const has = probe.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='roles'").get().c;
    if (has) { dbPath = p; break; }
  } finally { probe.close(); }
}
if (!dbPath) { console.error('NO local business DB found'); process.exit(2); }
const db = new DatabaseSync(dbPath);

// ---- 期望 ----
const jsonCodeSet = new Set(jsonPerms.map((p) => p.code));
const jsonRiskLevels = new Set(jsonPerms.map((p) => p.riskLevel));
const expectedRolePerm = Object.values(jsonRolePerms).reduce((a, b) => a + b.length, 0);

// ---- 从 DB 读取 ----
const dbPerms = db.prepare('SELECT code, name, perm_group, risk_level FROM permissions').all();
const dbCodeSet = new Set(dbPerms.map((r) => r.code));
const dbRolePermRows = db.prepare(`
  SELECT r.code AS role_code, p.code AS perm_code
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
`).all();

// 每角色 DB 权限集合
const dbRolePermMap = new Map();
for (const row of dbRolePermRows) {
  if (!dbRolePermMap.has(row.role_code)) dbRolePermMap.set(row.role_code, new Set());
  dbRolePermMap.get(row.role_code).add(row.perm_code);
}

// JSON: code -> scopeType
const codeScope = new Map(jsonPerms.map((p) => [p.code, p.scopeType]));
// JSON: 角色 -> 权限集合
const jsonRolePermMap = new Map();
for (const rc of jsonRoles) jsonRolePermMap.set(rc, new Set(jsonRolePerms[rc] || []));

// ---- 校验 ----
let failures = 0;
const log = (ok, label) => {
  console.log(`${ok ? '✅ PASS ' : '❌ FAIL'}  ${label}`);
  if (!ok) failures++;
};
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const segCount = (c) => c.split('.').length;

// 1. permissions = 83
log(dbPerms.length === 83, `1. permissions 行数 = 83（实际 ${dbPerms.length}）`);
// 2. code 全唯一
const uniq = new Set(dbPerms.map((r) => r.code));
log(uniq.size === dbPerms.length, `2. permission code 全唯一（${uniq.size}/${dbPerms.length}）`);
// 3. 所有 code 3-4 段
const badSeg = dbPerms.filter((r) => { const n = segCount(r.code); return n < 3 || n > 4; });
log(badSeg.length === 0, `3. 所有 code 为 3-4 段（异常 ${badSeg.length}：${badSeg.map((r) => r.code).join(',')}）`);
// 4. risk_level 只 1/2/3
const badRisk = dbPerms.filter((r) => ![1, 2, 3].includes(r.risk_level));
log(badRisk.length === 0, `4. risk_level 仅 1/2/3（异常 ${badRisk.length}）`);
// 5. 无 CRITICAL（DB 无第 4 档；最大 risk_level <=3）
const maxRisk = Math.max(...dbPerms.map((r) => r.risk_level));
log(maxRisk <= 3, `5. 无 CRITICAL（max risk_level=${maxRisk}）`);
// 6. DB code set == JSON code set（逐集合）
log(setEq(dbCodeSet, jsonCodeSet), `6. DB Permission Set == JSON Set（DB ${dbCodeSet.size} / JSON ${jsonCodeSet.size}；差集 ${[...dbCodeSet].filter(x=>!jsonCodeSet.has(x)).concat([...jsonCodeSet].filter(x=>!dbCodeSet.has(x))).join(',') || '无'}）`);
// 7. roles = 6
const dbRoles = db.prepare('SELECT code FROM roles').all().map((r) => r.code);
log(dbRoles.length === 6, `7. roles 行数 = 6（实际 ${dbRoles.length}）`);
// 8. 六冻结 role code 全存在
const missingRoles = jsonRoles.filter((c) => !dbRoles.includes(c));
log(missingRoles.length === 0, `8. 六冻结 role code 全存在（缺 ${missingRoles.join(',') || '无'}）`);
// 9. role_permissions 总数 = EXPECTED
log(dbRolePermRows.length === expectedRolePerm, `9. role_permissions 总数 = ${expectedRolePerm}（实际 ${dbRolePermRows.length}）`);
// 10. 逐角色 count
let allCountsOk = true;
for (const rc of jsonRoles) {
  const exp = (jsonRolePerms[rc] || []).length;
  const act = dbRolePermMap.get(rc)?.size || 0;
  if (exp !== act) { allCountsOk = false; console.log(`     ↳ ${rc}: 期望 ${exp} / 实际 ${act}`); }
}
log(allCountsOk, `10. 六角色逐角色 count 正确（super=${jsonRolePerms.platform_super_admin.length}/op=${jsonRolePerms.platform_operator.length}/owner=${jsonRolePerms.team_owner.length}/admin=${jsonRolePerms.team_admin.length}/auditor=${jsonRolePerms.team_auditor.length}/vol=${jsonRolePerms.volunteer.length}）`);
// 11. 无孤儿 permission 引用
const orphanPerm = dbRolePermRows.filter((r) => !dbCodeSet.has(r.perm_code));
log(orphanPerm.length === 0, `11. 无引用不存在 permission（${orphanPerm.length}）`);
// 12. 无孤儿 role 引用
const orphanRole = dbRolePermRows.filter((r) => !dbRoles.includes(r.role_code));
log(orphanRole.length === 0, `12. 无引用不存在 role（${orphanRole.length}）`);
// 13. 无重复 (role_id, permission_id)
const pairKeys = dbRolePermRows.map((r) => `${r.role_code}::${r.perm_code}`);
log(new Set(pairKeys).size === pairKeys.length, `13. 无重复 (role, permission) 对（${new Set(pairKeys).size}/${pairKeys.length}）`);
// 14. volunteer 无 PLATFORM 管理权限
const volPlat = [...(dbRolePermMap.get('volunteer') || [])].filter((c) => codeScope.get(c) === 'PLATFORM');
log(volPlat.length === 0, `14. volunteer 无 PLATFORM 管理权限（${volPlat.join(',') || '无'}）`);
// 15. TEAM 角色无 PLATFORM role-management 权限
const platRoleMgmt = ['rbac.role.assign.platform', 'rbac.role.revoke.platform', 'rbac.permission.assign'];
const teamRoles = ['team_owner', 'team_admin', 'team_auditor', 'volunteer'];
let teamOk = true;
for (const tr of teamRoles) {
  const got = [...(dbRolePermMap.get(tr) || [])].filter((c) => platRoleMgmt.includes(c));
  if (got.length) { teamOk = false; console.log(`     ↳ ${tr} 含 PLATFORM role-mgmt: ${got.join(',')}`); }
}
log(teamOk, `15. TEAM 角色无 PLATFORM role-management 权限（platform/team 越权路径已封堵）`);
// 16. team_auditor 符合冻结矩阵（逐集合）
const audJson = jsonRolePermMap.get('team_auditor');
const audDb = dbRolePermMap.get('team_auditor') || new Set();
log(setEq(audJson, audDb), `16. team_auditor 集合 == 冻结矩阵（${audJson.size}/${audDb.size}）`);
// 17. super_admin 显式 = 全部 83
const saJson = jsonRolePermMap.get('platform_super_admin');
const saDb = dbRolePermMap.get('platform_super_admin') || new Set();
log(setEq(saJson, saDb) && saDb.size === 83, `17. super_admin 显式关联全部 83（DB ${saDb.size}）`);
// 18. 无 wildcard
const wild = dbPerms.filter((r) => r.code.includes('*'));
log(wild.length === 0, `18. 无 wildcard '*'（${wild.length}）`);

// ---- 每角色集合 equality（额外强化）----
console.log('\n--- 每角色 集合 equality（JSON vs DB）---');
let setAllOk = true;
for (const rc of jsonRoles) {
  const j = jsonRolePermMap.get(rc);
  const d = dbRolePermMap.get(rc) || new Set();
  const ok = setEq(j, d);
  if (!ok) setAllOk = false;
  console.log(`${ok ? '✅' : '❌'}  ${rc}: JSON ${j.size} / DB ${d.size}`);
}
log(setAllOk, `19. 六角色逐集合 equality（无能力漂移）`);

db.close();
console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===`);
process.exit(failures === 0 ? 0 : 1);
