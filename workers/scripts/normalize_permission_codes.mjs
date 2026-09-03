#!/usr/bin/env node
// =============================================================================
// S2-6d 最终规范化收口（一次性脚本，仅改 JSON 设计源，绝不写 D1/Schema/migrations）
// 1) 将 40 个 2 段 permission code 规范化为 3 段（domain.resource.action）
// 2) 将 11 个 CRITICAL 风险重分类为 HIGH（risk_level 已为 3，仅改标签）
// 3) 同步 rolePermissions 引用 + meta（riskMapping 去掉 CRITICAL，命名约定改为最少 3 段）
// 运行：node scripts/normalize_permission_codes.mjs
// =============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, 'permission-catalog.json');

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// old code -> { code, resource, action }（description/scopeType/mvp/evidence/riskLevel 保持不变）
const RENAME = {
  'team.create':                 { code: 'team.team.create',                 resource: 'team',      action: 'create' },
  'team.update':                 { code: 'team.team.update',                 resource: 'team',      action: 'update' },
  'team.disband':                { code: 'team.team.disband',                resource: 'team',      action: 'disband' },
  'activity.create':             { code: 'activity.activity.create',          resource: 'activity',  action: 'create' },
  'activity.update':             { code: 'activity.activity.update',          resource: 'activity',  action: 'update' },
  'activity.publish':            { code: 'activity.activity.publish',         resource: 'activity',  action: 'publish' },
  'activity.cancel':             { code: 'activity.activity.cancel',          resource: 'activity',  action: 'cancel' },
  'activity.delete':             { code: 'activity.activity.delete',          resource: 'activity',  action: 'delete' },
  'signup.create':               { code: 'signup.signup.create',              resource: 'signup',    action: 'create' },
  'signup.cancel':               { code: 'signup.signup.cancel',              resource: 'signup',    action: 'cancel' },
  'signup.review':               { code: 'signup.signup.review',              resource: 'signup',    action: 'review' },
  'attendance.checkin':          { code: 'attendance.record.checkin',         resource: 'record',    action: 'checkin' },
  'attendance.checkout':         { code: 'attendance.record.checkout',        resource: 'record',    action: 'checkout' },
  'attendance.force':            { code: 'attendance.record.force',           resource: 'record',    action: 'force' },
  'training.enroll':             { code: 'training.enrollment.enroll',        resource: 'enrollment', action: 'enroll' },
  'training.learn':              { code: 'training.learning.learn',           resource: 'learning',  action: 'learn' },
  'exam.take':                   { code: 'exam.exam.take',                    resource: 'exam',      action: 'take' },
  'exam.grade':                  { code: 'exam.exam.grade',                   resource: 'exam',      action: 'grade' },
  'certificate.issue':           { code: 'certificate.certificate.issue',     resource: 'certificate', action: 'issue' },
  'certificate.revoke':          { code: 'certificate.certificate.revoke',    resource: 'certificate', action: 'revoke' },
  'certificate.view':            { code: 'certificate.certificate.view',      resource: 'certificate', action: 'view' },
  'certificate.verify':          { code: 'certificate.certificate.verify',    resource: 'certificate', action: 'verify' },
  'points.adjust':               { code: 'points.ledger.adjust',             resource: 'ledger',    action: 'adjust' },
  'honor.manage':                { code: 'honor.honor.manage',                resource: 'honor',     action: 'manage' },
  'honor.award':                 { code: 'honor.honor.award',                 resource: 'honor',     action: 'award' },
  'content.create':              { code: 'content.article.create',           resource: 'article',   action: 'create' },
  'content.update':              { code: 'content.article.update',           resource: 'article',   action: 'update' },
  'content.publish':             { code: 'content.article.publish',          resource: 'article',   action: 'publish' },
  'content.delete':              { code: 'content.article.delete',           resource: 'article',   action: 'delete' },
  'content.audit':               { code: 'content.article.audit',            resource: 'article',   action: 'audit' },
  'content.comment':             { code: 'content.comment.create',           resource: 'comment',   action: 'create' },
  'content.like':                { code: 'content.like.create',              resource: 'like',      action: 'create' },
  'content.report':              { code: 'content.report.create',            resource: 'report',    action: 'create' },
  'notification.view':           { code: 'notification.notification.view',   resource: 'notification', action: 'view' },
  'notification.send':           { code: 'notification.notification.send',   resource: 'notification', action: 'send' },
  'file.upload':                 { code: 'file.file.upload',                 resource: 'file',      action: 'upload' },
  'file.view':                   { code: 'file.file.view',                   resource: 'file',      action: 'view' },
  'file.delete':                 { code: 'file.file.delete',                 resource: 'file',      action: 'delete' },
  'system.config':               { code: 'system.config.manage',             resource: 'config',    action: 'manage' },
  'system.backup':               { code: 'system.backup.manage',             resource: 'backup',    action: 'manage' }
};

// ---- 1) permissions 数组 ----
let renamedCount = 0;
let criticalCount = 0;
const segCount = (s) => s.split('.').length;

for (const p of catalog.permissions) {
  if (RENAME[p.code]) {
    const t = RENAME[p.code];
    p.code = t.code;
    p.resource = t.resource;
    p.action = t.action;
    renamedCount++;
  }
  if (p.risk === 'CRITICAL') {
    p.risk = 'HIGH';
    criticalCount++;
  }
}

// ---- 2) rolePermissions 引用同步 ----
for (const role of Object.keys(catalog.rolePermissions)) {
  catalog.rolePermissions[role] = catalog.rolePermissions[role].map((c) => RENAME[c] ? RENAME[c].code : c);
}

// ---- 3) meta 更新 ----
catalog.meta.riskMapping = { LOW: 1, MEDIUM: 2, HIGH: 3 };
catalog.meta.riskMappingNote = 'Schema 仅允许 1/2/3 三档（permissions.risk_level CHECK (risk_level IN (1,2,3))）。S2-6d 规范化冻结：1=LOW、2=MEDIUM、3=HIGH。不存在 CRITICAL 数据库风险等级；特别敏感操作统一为 risk_level=3 (HIGH) 并叠加 security policy（显式确认 / 强审计 / 资源归属检查 / 租户 scope 检查 / 业务不变式 / 不可伪造历史 / 未来 step-up auth），而非创建 DB 无法区分的第四档。';
catalog.meta.namingRule = '<domain>.<resource>.<action>[.<qualifier>]；最少 3 段；lowercase / ASCII / 用 "."；resource 与 domain 同名时仍显式写成 domain.resource.action（如 team.team.create、activity.activity.create）；不使用中文 / 角色名 / team_id；不把 scope 写死到 code 除非语义确不同（如 rbac.role.assign.platform vs .team）。旧的 2 段草案（user.view / team.create / signup.review 等）SUPERSEDED BY S2-6d。';
catalog.meta.namingDecision = 'Permission code minimum segments = 3（规范化于 S2-6d 收口，旧 2 段草案 SUPERSEDED）。';
catalog.meta.riskDecision = '1=LOW / 2=MEDIUM / 3=HIGH；无 CRITICAL DB risk level（规范化于 S2-6d 收口）。';

// ---- 防御性自检 ----
const errors = [];
for (const p of catalog.permissions) {
  if (segCount(p.code) < 3) errors.push(`2 段残留: ${p.code}`);
  if (p.risk === 'CRITICAL') errors.push(`CRITICAL 残留: ${p.code}`);
}
const codes = new Set(catalog.permissions.map((p) => p.code));
if (codes.size !== catalog.permissions.length) errors.push('permission code 重复');

writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`renamed 2-seg codes : ${renamedCount}`);
console.log(`CRITICAL->HIGH      : ${criticalCount}`);
console.log(`total permissions   : ${catalog.permissions.length}`);
console.log(`unique codes        : ${codes.size}`);
if (errors.length) {
  console.error('SELF-CHECK FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('SELF-CHECK OK: 无 2 段残留 / 无 CRITICAL / 无重复');
