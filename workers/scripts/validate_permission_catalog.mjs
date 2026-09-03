#!/usr/bin/env node
// =============================================================================
// S2-6d 静态一致性 validator（不写数据库，纯内存校验）
// 读取 scripts/permission-catalog.json（冻结设计候选），按用户 §十六 15 项检查 + 增强项校验。
// 纪律：绝不 INSERT；本脚本只读 JSON + grep migrations 目录确认无种子写入。
// 运行：node scripts/validate_permission_catalog.mjs
// =============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CATALOG_PATH = join(__dirname, 'permission-catalog.json');

let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const warn = (msg) => console.log(`⚠️  WARN  ${msg}`);

// ---- 加载 ----
let catalog;
try {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
} catch (e) {
  console.error('无法解析 JSON:', e.message);
  process.exit(2);
}
const { roles, domains, permissions, rolePermissions, meta } = catalog;
const permByCode = new Map(permissions.map((p) => [p.code, p]));
const roleByCode = new Map(roles.map((r) => [r.code, r]));
const FROZEN_ROLES = ['platform_super_admin', 'platform_operator', 'team_owner', 'team_admin', 'team_auditor', 'volunteer'];
const SCOPE_TYPES = ['PLATFORM', 'TEAM', 'USER', 'AUDIT'];
const RISKS = ['LOW', 'MEDIUM', 'HIGH'];
const RISK_LEVELS = [1, 2, 3];
// S2-6d 收口：permission code 最少 3 段 <domain>.<resource>.<action>[.<qualifier>]，最多 4 段。
// 旧的 2 段草案（user.view / team.create / signup.review 等）SUPERSEDED。
// resource 与 domain 同名时仍显式写成 domain.resource.action（如 team.team.create）。
const NAME_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+){2,3}$/; // 3~4 段：domain.resource.action | ...qualifier
const AUDITOR_ALLOWED_ACTIONS = new Set(['view', 'review', 'grade', 'audit', 'handle', 'use']);

console.log('=== S2-6d Permission Catalog 静态校验 ===\n');

// 1. Permission code 唯一
{
  const seen = new Map();
  let dup = false;
  for (const p of permissions) {
    if (seen.has(p.code)) { dup = true; warn(`重复 code: ${p.code}`); }
    seen.set(p.code, true);
  }
  log(!dup, `1. Permission code 唯一（共 ${permissions.length} 条，无重复）`);
}

// 2. Permission code 命名合法
{
  let bad = 0;
  for (const p of permissions) {
    if (!NAME_RE.test(p.code)) { bad++; warn(`非法命名: ${p.code}`); }
    // 禁止角色名作为权限、禁止 team_id（数字）写进 code
    if (/\d/.test(p.code)) { bad++; warn(`code 含数字(疑似 team_id): ${p.code}`); }
    if (FROZEN_ROLES.some((r) => p.code.includes(r))) { bad++; warn(`code 含角色名: ${p.code}`); }
  }
  log(bad === 0, `2. 命名合法（最少 3 段 <domain>.<resource>.<action>[.<qualifier>]，无数字/角色名/无 2 段码）`);
}

// 3. 所有 permission 有 domain 且 domain 存在
{
  const domainCodes = new Set(domains.map((d) => d.code));
  let bad = 0;
  for (const p of permissions) {
    if (!p.domain || !domainCodes.has(p.domain)) { bad++; warn(`未知 domain: ${p.code} -> ${p.domain}`); }
  }
  log(bad === 0, `3. 所有 permission 有合法 domain（${domains.length} 个域）`);
}

// 4. 所有 permission 有 risk + riskLevel 合法 + 映射正确
{
  let bad = 0;
  for (const p of permissions) {
    if (!RISKS.includes(p.risk)) { bad++; warn(`非法 risk: ${p.code}=${p.risk}`); }
    if (!RISK_LEVELS.includes(p.riskLevel)) { bad++; warn(`非法 riskLevel: ${p.code}=${p.riskLevel}`); }
    const expect = meta.riskMapping[p.risk];
    if (p.riskLevel !== expect) { bad++; warn(`risk→riskLevel 映射错误: ${p.code} ${p.risk}→${p.riskLevel} (期望 ${expect})`); }
  }
  log(bad === 0, `4. risk / riskLevel 合法且映射正确（存储档 1/2/3）`);
}

// 5. 所有 permission 有 scopeType 合法
{
  let bad = 0;
  for (const p of permissions) {
    if (!SCOPE_TYPES.includes(p.scopeType)) { bad++; warn(`非法 scopeType: ${p.code}=${p.scopeType}`); }
  }
  log(bad === 0, `5. 所有 permission 有合法 scopeType（${SCOPE_TYPES.join('/')}）`);
}

// 6. 所有 role 仅引用存在的 permission
{
  let bad = 0;
  for (const [role, codes] of Object.entries(rolePermissions)) {
    for (const c of codes) {
      if (!permByCode.has(c)) { bad++; warn(`角色 ${role} 引用不存在的权限: ${c}`); }
    }
  }
  log(bad === 0, `6. 角色仅引用存在的 permission`);
}

// 7. 六角色全部存在
{
  const missing = FROZEN_ROLES.filter((r) => !roleByCode.has(r));
  log(missing.length === 0, `7. 六角色全部存在${missing.length ? '，缺失: ' + missing.join(',') : ''}`);
}

// 8. volunteer 没有平台权限
{
  const vol = rolePermissions['volunteer'] || [];
  const viol = vol.filter((c) => permByCode.get(c)?.scopeType === 'PLATFORM');
  log(viol.length === 0, `8. volunteer 无 PLATFORM 权限${viol.length ? '，违规: ' + viol.join(',') : ''}`);
}

// 9. team roles 没有 PLATFORM scope 权限（含 PLATFORM 角色管理）
{
  const teamRoles = ['team_owner', 'team_admin', 'team_auditor', 'volunteer'];
  let viol = [];
  for (const r of teamRoles) {
    for (const c of rolePermissions[r] || []) {
      if (permByCode.get(c)?.scopeType === 'PLATFORM') viol.push(`${r}:${c}`);
    }
  }
  log(viol.length === 0, `9. 团队角色无 PLATFORM scope 权限（租户正交；含禁止授予 PLATFORM 角色）${viol.length ? '，违规: ' + viol.join(',') : ''}`);
}

// 10. team_auditor 不拥有高风险普通管理写权限
{
  const aud = rolePermissions['team_auditor'] || [];
  let viol = [];
  for (const c of aud) {
    const p = permByCode.get(c);
    if (!AUDITOR_ALLOWED_ACTIONS.has(p.action)) viol.push(c);
  }
  log(viol.length === 0, `10. team_auditor 仅持 read/review/audit 类权限（动作白名单: ${[...AUDITOR_ALLOWED_ACTIONS].join('/')}）${viol.length ? '，违规写权限: ' + viol.join(',') : ''}`);
}

// 11. 不存在 wildcard '*'
{
  const star = permissions.filter((p) => p.code.includes('*'));
  log(star.length === 0, `11. 不存在 wildcard '*'${star.length ? '，违规: ' + star.join(',') : ''}`);
}

// 12. 不存在 team_id 编入 permission code（数字检测，已在 #2 覆盖；此处显式确认）
{
  const withDigit = permissions.filter((p) => /\d/.test(p.code));
  log(withDigit.length === 0, `12. 无 team_id 编入 code${withDigit.length ? '，违规: ' + withDigit.join(',') : ''}`);
}

// 13. 不存在明显 CRUD 爆炸（总数受控 + 无裸表名资源）
{
  const total = permissions.length;
  let bad = 0;
  if (total > 100) { bad++; warn(`权限数 ${total} > 100，需重新审查 CRUD 爆炸`); }
  for (const p of permissions) {
    // 资源不应直接等于原始表名（应为业务语义）
    const rawTables = new Set(['activity_signups','attendance_sessions','service_records','course_enrollments','exam_sessions','content_articles','team_members','points_ledger','certificates']);
    if (rawTables.has(p.resource)) { bad++; warn(`resource 为裸表名（应业务化）: ${p.code} -> ${p.resource}`); }
  }
  log(bad === 0, `13. 无 CRUD 爆炸（总数 ${total} ≤ 100，资源均业务化）`);
}

// 14. permissions DB rows 仍然 = 0
{
  let dbWrite = 0;
  try {
    const migDir = join(ROOT, '..', 'docs', 'migrations');
    for (const d of readdirSync(migDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const up = join(migDir, d.name, 'up.sql');
      try {
        const txt = readFileSync(up, 'utf8');
        if (/INSERT\s+INTO\s+permissions\b/i.test(txt)) { dbWrite++; warn(`发现 INSERT INTO permissions: ${d.name}/up.sql`); }
      } catch {}
    }
  } catch (e) { warn('无法扫描 migrations: ' + e.message); }
  const metaOk = meta.permissionsRowCount === permissions.length;
  log(metaOk, `14. catalog meta.permissionsRowCount 与权限条目数一致（meta=${meta.permissionsRowCount} / 目录 ${permissions.length}；S2-6e 已生成 LOCAL seed，不再要求 =0）`);
}

// 15. role_permissions DB rows 仍然 = 0
{
  let dbWrite = 0;
  try {
    const migDir = join(ROOT, '..', 'docs', 'migrations');
    for (const d of readdirSync(migDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const up = join(migDir, d.name, 'up.sql');
      try {
        const txt = readFileSync(up, 'utf8');
        if (/INSERT\s+INTO\s+role_permissions\b/i.test(txt)) { dbWrite++; warn(`发现 INSERT INTO role_permissions: ${d.name}/up.sql`); }
      } catch {}
    }
  } catch (e) { warn('无法扫描 migrations: ' + e.message); }
  const rpExpected = Object.values(rolePermissions).reduce((a, b) => a + b.length, 0);
  const metaOk = meta.rolePermissionsRowCount === rpExpected;
  log(metaOk, `15. catalog meta.rolePermissionsRowCount 与矩阵绑定数一致（meta=${meta.rolePermissionsRowCount} / 矩阵 ${rpExpected}；S2-6e 已生成 LOCAL seed，不再要求 =0）`);
}

// ---- 增强一致性（非用户清单但有益）----
console.log('\n--- 增强校验 ---');

// E1. platform_super_admin 拥有全部权限（"全部业务权限" 的显式表达，非 '*'）
{
  const sa = new Set(rolePermissions['platform_super_admin'] || []);
  const missing = permissions.filter((p) => !sa.has(p.code)).map((p) => p.code);
  log(missing.length === 0, `E1. platform_super_admin 显式持有全部 ${permissions.length} 条权限（非 '*'）${missing.length ? '，缺失: ' + missing.join(',') : ''}`);
}

// E2. 每个权限至少被一个角色持有（覆盖度）
{
  const held = new Set();
  for (const codes of Object.values(rolePermissions)) for (const c of codes) held.add(c);
  const orphan = permissions.filter((p) => !held.has(p.code)).map((p) => p.code);
  log(orphan.length === 0, `E2. 权限覆盖度：全部权限均被 ≥1 角色持有${orphan.length ? '，孤儿: ' + orphan.join(',') : ''}`);
}

// E3. team_admin 与 team_owner 的实际差异（owner 独有：成员角色调整 + 撤销证书 + 删活动 + 分配团队角色）
{
  const owner = new Set(rolePermissions['team_owner']);
  const admin = new Set(rolePermissions['team_admin']);
  const ownerOnly = [...owner].filter((c) => !admin.has(c));
  const expected = ['team.member.role.update','certificate.certificate.revoke','activity.activity.delete','rbac.role.assign.team','rbac.role.revoke.team'];
  const miss = expected.filter((c) => !ownerOnly.includes(c));
  log(miss.length === 0, `E3. team_owner 相对 team_admin 的确切差异已体现（owner 独有: ${ownerOnly.join(', ')}）${miss.length ? '，期望但未出现: ' + miss.join(',') : ''}`);
}

// E4. platform_operator 不能授角色 / 不能调积分 / 不能发撤销证书 / 不能改平台配置 / 不能解密敏感
{
  const op = new Set(rolePermissions['platform_operator']);
  const forbidden = ['rbac.role.assign.platform','rbac.role.assign.team','rbac.role.revoke.platform','rbac.role.revoke.team','rbac.permission.assign','points.ledger.adjust','certificate.certificate.issue','certificate.certificate.revoke','system.config.manage','audit.sensitive.access','audit.sensitive.view','account.status.update'];
  const viol = forbidden.filter((c) => op.has(c));
  log(viol.length === 0, `E4. platform_operator 受限（无角色授予/无积分调整/无证书发撤/无平台配置/无敏感解密）${viol.length ? '，违规: ' + viol.join(',') : ''}`);
}

// E5. 权限总数与 meta.totalPermissions 一致（规范化不应改变总数）
{
  const ok = permissions.length === catalog.meta.totalPermissions;
  log(ok, `E5. 权限总数一致（permissions=${permissions.length}, meta.totalPermissions=${catalog.meta.totalPermissions}）${ok ? '' : '，不一致！'}`);
}

// E6. meta.riskMapping 不含 CRITICAL 枚举（Schema 仅 1/2/3）
{
  const hasCritical = Object.prototype.hasOwnProperty.call(catalog.meta.riskMapping, 'CRITICAL');
  const levels = Object.values(catalog.meta.riskMapping).sort();
  const ok = !hasCritical && JSON.stringify(levels) === JSON.stringify([1, 2, 3]);
  log(ok, `E6. riskMapping 仅含 LOW/MEDIUM/HIGH → 1/2/3，无 CRITICAL 枚举（${JSON.stringify(catalog.meta.riskMapping)}）${hasCritical ? '，仍含 CRITICAL！' : ''}`);
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===`);
process.exit(failures === 0 ? 0 : 1);
