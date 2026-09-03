#!/usr/bin/env node
/**
 * 嘉禾志愿 2.0 —— Permission Seed Generator（S2-6e）
 *
 * 单向机械生成：permission-catalog.json  →  workers/migrations/<NEXT>_seed_permissions.sql
 *
 * 纪律（用户授权边界）：
 * - 唯一事实源 = scripts/permission-catalog.json（由 S2-6d 冻结）。
 * - SQL 由本脚本机械生成，禁止手工维护第二份 INSERT。
 * - 确定性：同 JSON → 同 SQL（byte-for-byte）。无时间戳 / 无随机 / 稳定排序。
 *   - permissions 按 code ASC；
 *   - role_permissions 按 (role code ASC, permission code ASC)。
 * - 外键解析：一律用 SELECT id FROM roles/permissions WHERE code=? 子查询，
 *   绝不假设 rowid / “第 N 个 INSERT”。
 * - 列映射（以 0002_rbac_structure.sql 真实 Schema 为准，不得新增列）：
 *     permissions.code      <- p.code
 *     permissions.name      <- p.description   (NOT NULL；存中文说明)
 *     permissions.perm_group<- p.domain         (存业务域，便于分组)
 *     permissions.risk_level<- p.riskLevel      (1/2/3)
 *     role_permissions.role_id     <- (SELECT id FROM roles WHERE code=role)
 *     role_permissions.permission_id<- (SELECT id FROM permissions WHERE code=perm)
 * - 禁止写入 description/status/updated_at 等不存在的列。
 *
 * 用法：
 *   node scripts/gen_permission_seed.mjs                 # 写入默认 migrations/0003_seed_permissions.sql
 *   node scripts/gen_permission_seed.mjs <outPath>       # 写入指定路径（用于确定性测试）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CATALOG = join(ROOT, 'scripts', 'permission-catalog.json');
const DEFAULT_OUT = join(ROOT, 'migrations', '0003_seed_permissions.sql');

const outPath = process.argv[2] || DEFAULT_OUT;

// ---- 读取唯一事实源 ----
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const permissions = catalog.permissions;
const rolePermissions = catalog.rolePermissions;
const roles = catalog.roles;

// ---- SQL 字符串安全转义（' -> ''）----
const esc = (s) => String(s).replace(/'/g, "''");

// ---- 排序（稳定、locale-independent，因全 ASCII/数字）----
const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const permsSorted = [...permissions].sort(byCode);
const roleCodesSorted = [...roles].map((r) => r.code).sort();

// ---- 预计算期望 role_permissions 总行数 ----
let expectedRolePermRows = 0;
for (const rc of roleCodesSorted) {
  const arr = rolePermissions[rc] || [];
  expectedRolePermRows += arr.length;
}

// ---- 构建 SQL ----
const L = [];
L.push('-- =============================================================================');
L.push('-- 嘉禾志愿 2.0 —— D1 Migration 0003：Permission Seed（S2-6e）');
L.push('-- =============================================================================');
L.push('-- GENERATED FROM:');
L.push('--   workers/scripts/permission-catalog.json');
L.push('--');
L.push('-- DO NOT EDIT BY HAND.');
L.push('-- 本文件由 scripts/gen_permission_seed.mjs 单向机械生成；');
L.push('-- 任何修改必须改 JSON 事实源后重新生成，保证 Git diff 稳定。');
L.push('--');
L.push('-- 列映射（以 0002_rbac_structure.sql 真实 Schema 为准，未新增任何列）：');
L.push('--   permissions.code       <- p.code');
L.push('--   permissions.name       <- p.description (NOT NULL, 中文说明)');
L.push('--   permissions.perm_group <- p.domain');
L.push('--   permissions.risk_level <- p.riskLevel (1=LOW / 2=MEDIUM / 3=HIGH)');
L.push('--   role_permissions.role_id      <- (SELECT id FROM roles WHERE code=role)');
L.push('--   role_permissions.permission_id<- (SELECT id FROM permissions WHERE code=perm)');
L.push('--');
L.push(`-- EXPECTED_PERMISSIONS = ${permsSorted.length}`);
L.push(`-- EXPECTED_ROLE_PERMISSION_ROWS = ${expectedRolePermRows}`);
L.push('-- =============================================================================');
L.push('');
L.push('PRAGMA defer_foreign_keys = ON;');
L.push('');

// ---- permissions INSERT（单条多值，code ASC）----
L.push('-- permissions：83 条冻结权限（来自 JSON，按 code ASC）');
L.push('INSERT INTO permissions (code, name, perm_group, risk_level) VALUES');
const permRows = permsSorted.map(
  (p) => `  ('${esc(p.code)}', '${esc(p.description)}', '${esc(p.domain)}', ${Number(p.riskLevel)})`
);
L.push(permRows.join(',\n') + ';');
L.push('');

// ---- role_permissions INSERT（role code ASC, perm code ASC，子查询解析 FK）----
L.push('-- role_permissions：六角色显式绑定（禁止 *；super_admin 显式关联全部 83 条）');
for (const rc of roleCodesSorted) {
  const arr = [...(rolePermissions[rc] || [])].sort();
  L.push(`-- role: ${rc} (${arr.length} bindings)`);
  for (const pc of arr) {
    L.push(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES (` +
        `(SELECT id FROM roles WHERE code = '${esc(rc)}'), ` +
        `(SELECT id FROM permissions WHERE code = '${esc(pc)}'));`
    );
  }
  L.push('');
}

const sql = L.join('\n');

// ---- 写出 ----
writeFileSync(outPath, sql, 'utf8');

// ---- 摘要（stdout，供确定性测试与报告捕获 EXPECTED）----
console.log(`WROTE: ${outPath}`);
console.log(`PERMISSIONS = ${permsSorted.length}`);
console.log(`EXPECTED_ROLE_PERMISSION_ROWS = ${expectedRolePermRows}`);
for (const rc of roleCodesSorted) {
  console.log(`  ${rc} = ${rolePermissions[rc]?.length || 0}`);
}
