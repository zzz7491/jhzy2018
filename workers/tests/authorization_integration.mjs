#!/usr/bin/env node
/**
 * S2-6f Runtime Authorization Core 集成测试（A–G 组，≥36 项）。
 *
 * 前置：`node tests/fixture.mjs authz`（含多角色/多团队 user_roles + team_admin）+ wrangler dev 已启动。
 * 通过【真实 Worker 运行时】验证：
 *   AuthContext.roles（每请求来自 D1 user_roles）→ D1PermissionProvider →
 *   PlatformPermissions(user) UNION TeamPermissions(user, activeTeam) 解析。
 *
 * 纪律（用户 §三/§四/§五/§六/§七/§九/§十三/§十五/§十七）：
 * - 授权完全 DB-backed（D1 role_permissions），不读 JSON、不硬编码角色→权限、无 super_admin 捷径、
 *   无 wildcard、无 N+1、request-local 缓存、角色变化下一请求立即生效。
 * - 仅 local 可达；不写任何 permissions / role_permissions 数据；§13 临时改 user_roles 后恢复。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// D1 persistence dir 可被 JHZY_D1_DIR 覆盖（S2-6i Final Regression 隔离 state）；默认沿用 .wrangler/state。
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
function newToken() {
  return 's_' + randomBytes(32).toString('base64url');
}

const IDS = {
  volA: '01TESTUSERAAAAAAAAAAAAAAAA',
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD',
  auditorA: '01TESTUSERCEEEEEEEEEEEEEE1',
  teamAdminA: '01TESTUSERCFADMIN000000000A',
  plat: '01TESTUSERCPPPPPPPPPPPPPPP',
  disabled: '01TESTUSERDDDDDDDDDDDDDDDD',
  teamA: '01TESTTEAMAAAAAAAAAAAAAAAA',
  teamB: '01TESTTEAMBBBBBBBBBBBBBBBB',
};

function dbFile() {
  return join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    return fn(db);
  } finally {
    db.close();
  }
}
const userIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pub)?.id);
const roleIdOf = (code) => withDb((db) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id);
const teamIdOfPub = (pub) => withDb((db) => db.prepare('SELECT id FROM teams WHERE public_id = ?').get(pub)?.id);

// ===== 直接向本地 D1 插入 sessions 行（token/hash 测试侧生成）=====
function insertSessions() {
  withDb((db) => {
    db.prepare(`DELETE FROM sessions WHERE public_id LIKE '01TESTSESS%'`).run();
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare(
      `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 'authz-test', ?, ?)`,
    );
    const mk = (pub, userPid, status, exp) => {
      const t = newToken();
      ins.run(`01TESTSESS${pub}`, userIdOf(userPid), sha256Hex(t), exp, status);
      return t;
    };
    TOKENS.volA = mk('VOLAAAAAAAAAAA', IDS.volA, 1, now + 30 * 24 * 3600);
    TOKENS.volB = mk('VOLBBBBBBBBBBB', IDS.volB, 1, now + 30 * 24 * 3600);
    TOKENS.ownerA = mk('OWNERCCCCCCCCC', IDS.ownerA, 1, now + 30 * 24 * 3600);
    TOKENS.auditorA = mk('AUDDDDDDDDDDD', IDS.auditorA, 1, now + 30 * 24 * 3600);
    TOKENS.teamAdminA = mk('ADMINEEEEEEEE', IDS.teamAdminA, 1, now + 30 * 24 * 3600);
    TOKENS.plat = mk('PLATFFFFFFFFF', IDS.plat, 1, now + 30 * 24 * 3600);
    TOKENS.disabled = mk('DISABLLLLLLLL', IDS.disabled, 1, now + 30 * 24 * 3600);
  });
}

// §13：临时把 teamAdminA 的 team_admin@teamA 换成 volunteer@teamA（验证角色变化即时生效），随后恢复。
function swapTeamAdminToVolunteer() {
  withDb((db) => {
    const u = userIdOf(IDS.teamAdminA);
    const teamA = teamIdOfPub(IDS.teamA);
    const teamAdmin = roleIdOf('team_admin');
    const vol = roleIdOf('volunteer');
    db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').run(u, teamAdmin, teamA);
    db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?,?,?)').run(u, vol, teamA);
  });
}
function restoreTeamAdmin() {
  withDb((db) => {
    const u = userIdOf(IDS.teamAdminA);
    const teamA = teamIdOfPub(IDS.teamA);
    const teamAdmin = roleIdOf('team_admin');
    const vol = roleIdOf('volunteer');
    db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').run(u, vol, teamA);
    db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?,?,?)').run(u, teamAdmin, teamA);
  });
}

const TOKENS = {};

// ===== fetch helpers =====
async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
// 权限判定请求（DB-backed）。
function perm(code, token, team) {
  const h = bearer(token);
  if (team != null) h['x-team-id'] = String(team);
  return get(`/api/v2/__test/permission?code=${encodeURIComponent(code)}`, h);
}
// 有效权限集合回显（调试 / 断言）。
function perms(token, team) {
  const h = bearer(token);
  if (team != null) h['x-team-id'] = String(team);
  return get('/api/v2/__test/permissions', h);
}

// ===== 主流程 =====
insertSessions();
const teamA = teamIdOfPub(IDS.teamA);
const teamB = teamIdOfPub(IDS.teamB);

// A. 目录 / Provider 基线
process.stderr.write('A. 权限目录与 Provider 基线（permissions=83 / role_permissions=238）\n');
{
  const probe = await get('/probe');
  check('A1 permissions=83', probe.body?.data?.permissions === 83, `got ${probe.body?.data?.permissions}`);
  check('A2 role_permissions=238', probe.body?.data?.role_permissions === 238, `got ${probe.body?.data?.role_permissions}`);
  const platPerms = (await perms(TOKENS.plat, null)).body?.data?.permissions ?? [];
  check('A3 platform_operator 解析出 26 项', platPerms.length === 26, `got ${platPerms.length}`);
  check('A3b 含 platform 权限 team.team.create', platPerms.includes('team.team.create'));
  const volPerms = (await perms(TOKENS.volA, teamA)).body?.data?.permissions ?? [];
  check('A4 volunteer 解析出 19 项', volPerms.length === 19, `got ${volPerms.length}`);
  check('A4b 含 volunteer 自有 attendance.record.checkin', volPerms.includes('attendance.record.checkin'));
  check('A4c 不含 team.member.role.update', !volPerms.includes('team.member.role.update'));
  const adminPerms = (await perms(TOKENS.teamAdminA, teamA)).body?.data?.permissions ?? [];
  check('A5 team_admin 解析出 43 项', adminPerms.length === 43, `got ${adminPerms.length}`);
  const audPerms = (await perms(TOKENS.auditorA, teamA)).body?.data?.permissions ?? [];
  check('A6 team_auditor 解析出 19 项', audPerms.length === 19, `got ${audPerms.length}`);
}

// B. PLATFORM 解析（平台角色仅持平台权限；团队专属权限不可越权）
process.stderr.write('B. PLATFORM 角色解析（platform_operator）\n');
{
  const r1 = await perm('team.team.create', TOKENS.plat, null);
  check('B1 platform_operator 持平台权限 team.team.create → 200', r1.res.status === 200 && r1.body?.data?.authorized === true, `got ${r1.res.status}`);
  const r2 = await perm('system.config.manage', TOKENS.volA, teamA);
  check('B2 volunteer 无平台权限 → 403 FORBIDDEN', r2.res.status === 403 && r2.body?.error?.code === 'FORBIDDEN', `got ${r2.res.status}/${r2.body?.error?.code}`);
  const r3 = await perm('team.member.role.update', TOKENS.plat, null);
  check('B3 platform_operator 无团队专属权限 → 403', r3.res.status === 403, `got ${r3.res.status}`);
  const r4 = await perm('team.team.create', TOKENS.plat, teamA);
  check('B4 平台权限不依赖 active team（带 team 头仍 200）', r4.res.status === 200, `got ${r4.res.status}`);
}

// C. TEAM active context（team 权限仅 active team 生效）
process.stderr.write('C. TEAM 角色绑定 active team 上下文\n');
{
  const r1 = await perm('team.member.role.update', TOKENS.ownerA, teamA);
  check('C1 ownerA@teamA 持 team_owner 管理权 → 200', r1.res.status === 200, `got ${r1.res.status}`);
  const r2 = await perm('team.member.role.update', TOKENS.ownerA, teamB);
  check('C2 ownerA@teamB（仅 volunteer 绑定）→ 403', r2.res.status === 403, `got ${r2.res.status}`);
  const r3 = await perm('attendance.record.checkin', TOKENS.ownerA, teamB);
  check('C3 ownerA@teamB 持 volunteer 自有签到权 → 200', r3.res.status === 200, `got ${r3.res.status}`);
  const r4 = await perm('team.member.ban', TOKENS.teamAdminA, teamA);
  check('C4 teamAdminA@teamA（team_admin）成员封禁权 → 200', r4.res.status === 200, `got ${r4.res.status}`);
}

// D. Multi-role（同团队多角色 = 权限并集）
process.stderr.write('D. 多角色并集（team_owner + volunteer @ teamA）\n');
{
  const set = (await perms(TOKENS.ownerA, teamA)).body?.data?.permissions ?? [];
  check('D1 ownerA@teamA 并集含 team.member.role.update', set.includes('team.member.role.update'));
  check('D1b 并集含 volunteer 自有 attendance.record.checkin', set.includes('attendance.record.checkin'));
  const r1 = await perm('activity.activity.create', TOKENS.ownerA, teamA);
  check('D2 ownerA@teamA 活动创建权 → 200', r1.res.status === 200, `got ${r1.res.status}`);
  const r2 = await perm('content.comment.create', TOKENS.ownerA, teamA);
  check('D3 ownerA@teamA 评论权（volunteer 绑定）→ 200', r2.res.status === 200, `got ${r2.res.status}`);
  const r3 = await perm('content.comment.create', TOKENS.teamAdminA, teamA);
  check('D4 teamAdminA@teamA（仅 team_admin）无 volunteer 自有评论权 → 403', r3.res.status === 403 && r3.body?.error?.code === 'FORBIDDEN', `got ${r3.res.status}/${r3.body?.error?.code}`);
}

// E. 角色变化即时生效（§13：改 D1 user_roles，下一请求立即反映；不固化 Session）
process.stderr.write('E. 角色变化下一请求立即生效（真实 D1 user_roles 修改）\n');
{
  const before = await perm('team.member.ban', TOKENS.teamAdminA, teamA);
  check('E1 修改前 team_admin 成员封禁权 → 200', before.res.status === 200, `got ${before.res.status}`);
  swapTeamAdminToVolunteer();
  const after = await perm('team.member.ban', TOKENS.teamAdminA, teamA);
  check('E2 改为 volunteer 后同封禁权 → 403（未固化）', after.res.status === 403, `got ${after.res.status}`);
  const volSelf = await perm('attendance.record.checkin', TOKENS.teamAdminA, teamA);
  check('E3 改为 volunteer 后持自有签到权 → 200', volSelf.res.status === 200, `got ${volSelf.res.status}`);
  restoreTeamAdmin();
  const restored = await perm('team.member.ban', TOKENS.teamAdminA, teamA);
  check('E4 恢复 team_admin 后成员封禁权 → 200（即时恢复）', restored.res.status === 200, `got ${restored.res.status}`);
  // 配置漂移校验：恢复后目录仍 83/238，user_roles 行数不变。
  const p = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n);
  const rp = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n);
  check('E5 修改/恢复后目录仍 83/238（未漂移）', p === 83 && rp === 238, `got ${p}/${rp}`);
}

// F. 安全与越权
process.stderr.write('F. 安全与越权防护\n');
{
  const unknown = await perm('nonexistent.permission.code.xyz', TOKENS.volA, teamA);
  check('F1 不存在的 code → 500 INTERNAL_ERROR（配置错误）', unknown.res.status === 500 && unknown.body?.error?.code === 'INTERNAL_ERROR', `got ${unknown.res.status}/${unknown.body?.error?.code}`);
  check('F1b 500 不泄露请求 code', !JSON.stringify(unknown.body ?? {}).includes('nonexistent.permission.code.xyz'));
  const unauth = await perm('system.config.manage', null, null);
  check('F2 未认证 → 401 AUTH_REQUIRED', unauth.res.status === 401 && unauth.body?.error?.code === 'AUTH_REQUIRED', `got ${unauth.res.status}`);
  const dis = await perm('attendance.record.checkin', TOKENS.disabled, teamA);
  check('F3 停用用户 session → 401', dis.res.status === 401, `got ${dis.res.status}`);
  const cross = await perm('attendance.record.checkin', TOKENS.volA, teamB);
  check('F4 volA 跨团队（teamB 非其绑定）→ 403', cross.res.status === 403, `got ${cross.res.status}`);
  const aud = await perm('team.member.role.update', TOKENS.auditorA, teamA);
  check('F5 team_auditor 无团队管理权 → 403', aud.res.status === 403, `got ${aud.res.status}`);
  const platTeamOnly = await perm('team.member.role.update', TOKENS.plat, teamA);
  check('F6 平台角色带 team 头仍无团队专属权 → 403', platTeamOnly.res.status === 403, `got ${platTeamOnly.res.status}`);
  const audPlat = await perm('analytics.platform.view', TOKENS.auditorA, teamA);
  check('F7 team_auditor 无平台分析权 → 403', audPlat.res.status === 403, `got ${audPlat.res.status}`);
}

// G. Union 正交性（平台 ≠ 团队，权限矩阵严格）
process.stderr.write('G. Platform / Team 正交与矩阵严格性\n');
{
  const plat = (await perms(TOKENS.plat, null)).body?.data?.permissions ?? [];
  check('G1 platform_operator 含 team.team.create', plat.includes('team.team.create'));
  check('G2 platform_operator 不含 volunteer 自有 attendance.record.checkin', !plat.includes('attendance.record.checkin'));
  const ownerTeamCreate = await perm('team.team.create', TOKENS.ownerA, teamA);
  check('G3 team_owner 无平台专属 team.team.create → 403（平台≠团队）', ownerTeamCreate.res.status === 403, `got ${ownerTeamCreate.res.status}`);
  const volSignup = await perm('signup.signup.create', TOKENS.volA, teamA);
  check('G4 volunteer 自有报名创建权 → 200', volSignup.res.status === 200, `got ${volSignup.res.status}`);
  const volReview = await perm('signup.signup.review', TOKENS.volA, teamA);
  check('G5 volunteer 无报名审核权 → 403', volReview.res.status === 403, `got ${volReview.res.status}`);
  const audAnalytics = await perm('analytics.team.view', TOKENS.auditorA, teamA);
  check('G6 team_auditor 团队分析权 → 200', audAnalytics.res.status === 200, `got ${audAnalytics.res.status}`);
  const audPlatView = await perm('audit.log.view', TOKENS.auditorA, teamA);
  check('G7 team_auditor 审计读权 → 200', audPlatView.res.status === 200, `got ${audPlatView.res.status}`);
}

process.stderr.write(`\n===== S2-6f authorization: pass=${pass} fail=${fail} =====\n`);
process.exit(fail > 0 ? 1 : 0);
