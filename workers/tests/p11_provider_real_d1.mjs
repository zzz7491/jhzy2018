#!/usr/bin/env node
/**
 * P11 —— D1PermissionProvider 真实 LOCAL D1 验证。
 * 直接对真实本地 D1（已 seed 87/247）运行 authorizePermissionDecision，
 * 验证 4 个新权限码不再返回 unknown_permission，且角色授权矩阵正确。
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Database } from './lib/d1-shim.mjs';
import { authorizePermissionDecision } from '../src/services/permission-provider.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

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
const db = new D1Database(new DatabaseSync(dbPath));
const env = { DB: db };

const authCtx = (roles, teamId, userId = 1) => ({
  authenticated: true,
  userId,
  teamId,
  scope: 'team',
  roles: roles.map((r) => ({ role: r, scopeTeamId: teamId })),
});

const scenarios = [
  { name: 'volunteer create',    auth: authCtx(['volunteer'], 1),            code: 'participation.assignment.create',  expect: 'allow' },
  { name: 'volunteer cancel',    auth: authCtx(['volunteer'], 1),            code: 'participation.assignment.cancel',  expect: 'allow' },
  { name: 'volunteer update',    auth: authCtx(['volunteer'], 1),            code: 'participation.assignment.update',  expect: 'allow' },
  { name: 'volunteer manage',    auth: authCtx(['volunteer'], 1),            code: 'participation.assignment.manage',  expect: 'forbidden' },
  { name: 'team_owner manage',   auth: authCtx(['team_owner'], 1),           code: 'participation.assignment.manage',  expect: 'allow' },
  { name: 'team_admin manage',   auth: authCtx(['team_admin'], 1),           code: 'participation.assignment.manage',  expect: 'allow' },
  { name: 'team_auditor manage', auth: authCtx(['team_auditor'], 1),         code: 'participation.assignment.manage',  expect: 'forbidden' },
  { name: 'super_admin create',  auth: authCtx(['platform_super_admin'], null), code: 'participation.assignment.create', expect: 'allow' },
  { name: 'super_admin manage',  auth: authCtx(['platform_super_admin'], null), code: 'participation.assignment.manage', expect: 'allow' },
  { name: 'unknown code',        auth: authCtx(['volunteer'], 1),            code: 'participation.assignment.nope',    expect: 'unknown_permission' },
  { name: 'unauthenticated',     auth: { authenticated: false, userId: null, teamId: null, roles: [] }, code: 'participation.assignment.create', expect: 'unauthenticated' },
];

let fail = 0;
for (const s of scenarios) {
  const d = await authorizePermissionDecision(env, s.auth, s.code);
  const ok = d === s.expect;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'}  ${s.name}: got=${d} expect=${s.expect}`);
}
console.log(`\n=== ${fail === 0 ? 'ALL PASS ✅' : fail + ' 项失败 ❌'} ===`);
process.exit(fail === 0 ? 0 : 1);
