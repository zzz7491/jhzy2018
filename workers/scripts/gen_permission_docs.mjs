#!/usr/bin/env node
// 从 scripts/permission-catalog.json 生成 PERMISSION-CATALOG.md 与 ROLE-PERMISSION-MATRIX.md。
// 纯机械转写，保证文档与单一事实源 JSON 零漂移。不写数据库。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOC = join(ROOT, '..', 'docs', 'architecture');
const catalog = JSON.parse(readFileSync(join(__dirname, 'permission-catalog.json'), 'utf8'));
const { meta, roles, domains, permissions, rolePermissions } = catalog;

const riskBadge = (r) => ({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }[r] || r);
const mvpMark = (b) => (b ? '✅' : '⏸');

// ---------- PERMISSION-CATALOG.md ----------
let cat = `# 嘉禾志愿 2.0 —— Permission Catalog（权限目录，冻结设计候选）\n\n`;
cat += `> 阶段：**S2-6e** ｜ 状态：**SEEDED（LOCAL D1：permissions=83 / role_permissions=238，0003_seed_permissions）**；未写 Production\n`;
cat += `> 唯一机器可校验事实源：\`workers/scripts/permission-catalog.json\`（经 \`validate_permission_catalog.mjs\` 15 + 6 项校验全 PASS）。\n`;
cat += `> 命名：\`<domain>.<resource>.<action>[.<qualifier>]\`；**最少 3 段**；lowercase / ASCII / 用 \`.\`；resource 与 domain 同名时仍显式写成 \`domain.resource.action\`（如 \`team.team.create\`）。旧 2 段草案（\`user.view\` / \`team.create\` / \`signup.review\` 等）**SUPERSEDED BY S2-6d**。\n\n`;
cat += `**Total permissions = ${permissions.length}**（MVP=${permissions.filter((p) => p.mvp).length} / 非 MVP=${permissions.filter((p) => !p.mvp).length}）。\n\n`;
cat += `风险档冻结为 Schema 原生三档（\`permissions.risk_level INTEGER CHECK (risk_level IN (1,2,3))\`）：\n`;
cat += `| 命名档 | 存储 risk_level | 标准 |\n|---|---|---|\n`;
cat += `| LOW | 1 | 普通读取、公开内容 |\n| MEDIUM | 2 | 普通业务写入、审核 |\n| HIGH | 3 | 审核、积分调整、证书发放/撤销、团队成员管理、内容审核、平台配置、角色授权、安全管理、敏感数据访问 |\n\n`;
cat += `> 说明：不存在 CRITICAL 数据库风险档。特别敏感操作统一为 **risk_level=3 (HIGH)**，并叠加 security policy（显式确认 / 强审计 operation_logs / 资源归属检查 / 租户 scope 检查 / 业务不变式 / 不可伪造历史 / 未来 step-up auth），而非创建 DB 无法区分的第四档。不修改 Schema。详见 \`PERMISSION-SECURITY-REVIEW.md\` 的 High-Risk Sensitive Operations。\n\n`;

const byDomain = new Map(domains.map((d) => [d.code, []]));
for (const p of permissions) byDomain.get(p.domain).push(p);

for (const d of domains) {
  cat += `## ${d.code} —— ${d.name}\n\n`;
  cat += `_${d.description}_\n\n`;
  cat += `| code | 描述 | scope | risk | MVP | 业务证据 |\n|---|---|---|---|---|---|\n`;
  for (const p of byDomain.get(d.code)) {
    cat += `| \`${p.code}\` | ${p.description} | ${p.scopeType} | ${riskBadge(p.risk)} | ${mvpMark(p.mvp)} | ${p.evidence} |\n`;
  }
  cat += `\n`;
}

// ---------- ROLE-PERMISSION-MATRIX.md ----------
let mat = `# 嘉禾志愿 2.0 —— Role-Permission Matrix（六角色权限矩阵，冻结设计候选）\n\n`;
mat += `> 阶段：**S2-6d** ｜ 状态：**FROZEN DESIGN CANDIDATE（未 seed）**\n`;
mat += `> 来源：\`workers/scripts/permission-catalog.json\` 的 \`rolePermissions\` 字段（经 validator 校验：六角色齐全、无越权、无 wildcard）。\n\n`;

// 角色权限计数表
mat += `## 0. 各角色权限计数\n\n`;
mat += `| 角色 | scope | 权限数 | 说明 |\n|---|---|---:|---|\n`;
const roleNote = {
  platform_super_admin: '全部业务权限（显式枚举，非 *）；受不可绕过审计约束',
  platform_operator: '平台运营，无角色授予/无积分调整/无证书发撤/无平台配置/无敏感解密',
  team_owner: '团队全权（含成员角色调整、撤销证书、分配团队角色）',
  team_admin: '团队日常运营（差异：无成员角色调整、无撤销证书、无删活动、无分配团队角色）',
  team_auditor: '仅 read/review/audit（无高风险普通管理写）',
  volunteer: '仅本人业务权限（报名/签到/学习/考试/公益上报/互动），无团队管理',
};
for (const r of roles) {
  const n = (rolePermissions[r.code] || []).length;
  mat += `| \`${r.code}\` | ${r.scope} | ${n} | ${roleNote[r.code]} |\n`;
}
mat += `\n`;

// 每角色权限清单（按域分组）
const domName = new Map(domains.map((d) => [d.code, d.name]));
for (const r of roles) {
  mat += `## ${r.code}（${r.scope}）\n\n`;
  const codes = rolePermissions[r.code] || [];
  const grouped = new Map();
  for (const c of codes) {
    const dom = permissions.find((p) => p.code === c)?.domain;
    if (!grouped.has(dom)) grouped.set(dom, []);
    grouped.get(dom).push(c);
  }
  const domOrder = domains.map((d) => d.code).filter((d) => grouped.has(d));
  for (const dom of domOrder) {
    mat += `**${dom}（${domName.get(dom)}）**：\n`;
    mat += grouped.get(dom).map((c) => `- \`${c}\``).join('\n') + '\n\n';
  }
}

// 紧凑矩阵（域 × 角色 计数）
mat += `## 附录：域 × 角色 权限计数矩阵\n\n`;
mat += `| 域 \\ 角色 | ` + roles.map((r) => `\`${r.code}\``).join(' | ') + ` |\n|---|` + roles.map(() => '---').join('') + `|\n`;
for (const d of domains) {
  const row = roles.map((r) => {
    const n = (rolePermissions[r.code] || []).filter((c) => permissions.find((p) => p.code === c)?.domain === d.code).length;
    return n;
  });
  mat += `| ${d.code} | ` + row.join(' | ') + ` |\n`;
}

writeFileSync(join(DOC, 'PERMISSION-CATALOG.md'), cat, 'utf8');
writeFileSync(join(DOC, 'ROLE-PERMISSION-MATRIX.md'), mat, 'utf8');
console.log('已生成 PERMISSION-CATALOG.md 与 ROLE-PERMISSION-MATRIX.md');
console.log(`权限总数=${permissions.length}，角色数=${roles.length}`);
