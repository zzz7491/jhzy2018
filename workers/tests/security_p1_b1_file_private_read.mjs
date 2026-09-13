/**
 * P1-B1 — FILE PRIVATE READ AUTHORIZATION HARDENING — 安全契约与行为矩阵测试
 *
 * 运行（无需 live server / 无需执行 migration / 无需真实 provider / 无需 remote D1）：
 *   node --experimental-transform-types --loader ./_p1b1_loader.mjs tests/security_p1_b1_file_private_read.mjs
 *
 * 设计：
 * - 行为测试直接 import 真实 TS 模块（FileService / authorizePermissionDecision），
 *   以 mock D1 / R2 注入，证明：
 *     (a) FileService 不再按角色名鉴权，仅依据 allowPrivate 布尔能力；
 *     (b) 路由层经统一授权 machinery 解析 file.private.read，仅 platform_super_admin 裁决为 allow；
 *     (c) 行为矩阵与 P1-B1 授权完全一致（同团队 PRIVATE 非上传者：仅 PSA=ALLOW）。
 * - 静态契约检查：catalog / migration / file-service.ts / files.ts 源码级断言。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileService } from '../src/services/file-service.ts';
import { authorizePermissionDecision } from '../src/services/permission-provider.ts';
import { AppError } from '../src/utils/errors.ts';
import { FILE_VISIBILITY } from '../src/utils/file-policy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CATALOG = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'permission-catalog.json'), 'utf8'),
);
const MIG_DIR = path.join(ROOT, 'migrations');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const ULID = '01JTEAMAP33AAAAAAAAAAAAAAA'; // 26 位 Crockford ULID（isUlid 通过）

// ===== mock D1（仅服务 FileService 的 findByPublicIdAndTeam）=====
function makeFileDb(row) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return row;
            },
            async all() {
              return { results: row ? [row] : [] };
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
}
const bucket = { async get() { return { body: { _stub: true } }; } };

// 平台角色（platform_super_admin / platform_operator）的 role binding scopeTeamId=null（恒生效），
// 但仍需处于某 team 上下文（teamId=101）才能读取 TEAM_SCOPED 的 files 表。
function makeAuth(userId, role, teamId = 101) {
  const isPlatformRole = role === 'platform_super_admin' || role === 'platform_operator';
  return {
    authenticated: true,
    userId,
    role,
    teamId,
    roles: [{ role, scopeTeamId: isPlatformRole ? null : teamId }],
  };
}
function makeTenant(userId) {
  return { scope: 'TEAM_SCOPED', teamId: 101, userId };
}

// ===== mock D1（服务统一权限 provider，依据真实 catalog 解析）=====
// 兼容 D1 真实 API：prepare(sql) 既可直接 .all()/.first()，也可 .bind(...).all()。
function makeProviderDb(catalog) {
  const permCodes = catalog.permissions.map((p) => p.code);
  const rolePerms = catalog.rolePermissions;
  function makeStmt(sql, boundArgs) {
    return {
      async all() {
        if (sql.includes('SELECT code FROM permissions')) {
          return { results: permCodes.map((c) => ({ code: c })) };
        }
        if (sql.includes('role_permissions rp')) {
          const out = [];
          for (const role of boundArgs) {
            for (const pc of rolePerms[role] || []) out.push({ code: pc });
          }
          return { results: out };
        }
        return { results: [] };
      },
      async first() {
        const r = (await this.all()).results;
        return r[0] ?? null;
      },
      async run() {
        return {};
      },
      bind(...more) {
        return makeStmt(sql, more);
      },
    };
  }
  return {
    prepare(sql) {
      return makeStmt(sql, []);
    },
  };
}
const providerEnv = { DB: makeProviderDb(CATALOG) };

// 取一份 PRIVATE 行（uploader=201，team=101）
function privateRow(uploaderId) {
  return {
    id: 1,
    public_id: ULID,
    team_id: 101,
    uploader_id: uploaderId,
    original_name: 'x.jpg',
    object_key: 'community/01JTEAMAP33AAAAAAAAAAAAAAA/2026/01/' + ULID + '.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 64,
    checksum: 'deadbeef',
    visibility: FILE_VISIBILITY.PRIVATE,
    exif_stripped: 0,
    scan_status: 0,
    created_at: 0,
    deleted_at: null,
  };
}
function teamRow() {
  return { ...privateRow(201), visibility: FILE_VISIBILITY.TEAM };
}
function publicRow() {
  return { ...privateRow(201), visibility: FILE_VISIBILITY.PUBLIC };
}

async function readPrivate(allowPrivate, userId, role, teamId = 101) {
  const svc = new FileService({
    db: makeFileDb(privateRow(201)),
    bucket,
    auth: makeAuth(userId, role, teamId),
    tenant: makeTenant(userId),
    env: { ENVIRONMENT: 'local' },
  });
  return svc.getFileStream(ULID, { allowPrivate });
}

// =====================================================================
// 1) 行为矩阵：FileService 仅依据 allowPrivate（由统一授权在路由层解析）
// =====================================================================
async function expectDenied(promise) {
  try {
    const r = await promise;
    return !(r && r.body); // 若返回了 body 视为未拒绝
  } catch (e) {
    return e instanceof AppError && e.status === 404;
  }
}
async function expectAllowed(promise) {
  try {
    const r = await promise;
    return !!(r && r.body);
  } catch {
    return false;
  }
}

{
  // 同团队 PRIVATE 非上传者：PSA(allowPrivate=true)=ALLOW；其余(allowPrivate=false)=DENY
  check(
    'M1 PSA private override preserved (allowPrivate=true → ALLOW)',
    await expectAllowed(readPrivate(true, 999, 'platform_super_admin')),
  );
  check(
    'M2 platform_operator private override denied (allowPrivate=false → 404)',
    await expectDenied(readPrivate(false, 999, 'platform_operator')),
  );
  check(
    'M3 team_owner private override denied',
    await expectDenied(readPrivate(false, 999, 'team_owner')),
  );
  check(
    'M4 team_admin private override denied',
    await expectDenied(readPrivate(false, 999, 'team_admin')),
  );
  check(
    'M5 team_auditor private override denied',
    await expectDenied(readPrivate(false, 999, 'team_auditor')),
  );
  check(
    'M6 volunteer private override denied',
    await expectDenied(readPrivate(false, 999, 'volunteer')),
  );

  // 同团队 PRIVATE 上传者：无论 allowPrivate 与否均 ALLOW
  check(
    'M7 uploader private read preserved (allowPrivate=false)',
    await expectAllowed(readPrivate(false, 201, 'volunteer')),
  );
  check(
    'M7b uploader private read preserved (allowPrivate=true)',
    await expectAllowed(readPrivate(true, 201, 'volunteer')),
  );

  // PUBLIC + 既有合法 mime：当前 V1 不服务 public → 404
  const pubSvc = new FileService({
    db: makeFileDb(publicRow()),
    bucket,
    auth: makeAuth(201, 'volunteer'),
    tenant: makeTenant(201),
    env: { ENVIRONMENT: 'local' },
  });
  check('M8 public read preserved (V1 → 404)', await expectDenied(pubSvc.getFileStream(ULID)));

  // TEAM 文件：同团队可读
  const teamSvc = new FileService({
    db: makeFileDb(teamRow()),
    bucket,
    auth: makeAuth(201, 'volunteer'),
    tenant: makeTenant(201),
    env: { ENVIRONMENT: 'local' },
  });
  check('M9 team visibility read preserved (200)', await expectAllowed(teamSvc.getFileStream(ULID)));

  // 跨团队 PRIVATE：findByPublicIdAndTeam 返回 null → 404（即使 allowPrivate=true 也不绕过 team scope）
  const crossSvc = new FileService({
    db: makeFileDb(null), // 模拟跨团队：查不到行
    bucket,
    auth: makeAuth(201, 'platform_super_admin', 101),
    tenant: makeTenant(201),
    env: { ENVIRONMENT: 'local' },
  });
  check(
    'M10 cross-team denial preserved (allowPrivate=true 不绕过 team scope)',
    await expectDenied(crossSvc.getFileStream(ULID, { allowPrivate: true })),
  );
}

// =====================================================================
// 2) 路由层统一授权解析：file.private.read 仅 PSA 裁决 allow
// =====================================================================
{
  const roles = [
    'platform_super_admin',
    'platform_operator',
    'team_owner',
    'team_admin',
    'team_auditor',
    'volunteer',
  ];
  let psaAllow = false;
  for (const role of roles) {
    const decision = await authorizePermissionDecision(
      providerEnv,
      makeAuth(999, role),
      'file.private.read',
    );
    check(
      `R-authz ${role} decision=${decision}`,
      (role === 'platform_super_admin') === (decision === 'allow'),
    );
    if (role === 'platform_super_admin') psaAllow = decision === 'allow';
  }
  check('R-authz file.private.read bound only to PSA (allow)', psaAllow);

  // 未知 code 不应被误判为 allow（证明是真绑定检查，非恒真）
  const unknown = await authorizePermissionDecision(
    providerEnv,
    makeAuth(999, 'platform_super_admin', 101),
    'file.private.read.nonexistent',
  );
  check('R-authz unknown code → not allow (unknown_permission)', unknown === 'unknown_permission');

  // file.file.view 仍对 volunteer 可用（证明该权限未被破坏）
  const viewDecision = await authorizePermissionDecision(
    providerEnv,
    makeAuth(999, 'volunteer'),
    'file.file.view',
  );
  check('R-authz file.file.view still granted to volunteer', viewDecision === 'allow');
}

// =====================================================================
// 3) 静态契约：源码级断言
// =====================================================================
{
  const fsSrc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'file-service.ts'), 'utf8');
  check(
    'S1 FileService 不再包含 platform_super_admin 角色名硬编码',
    !fsSrc.includes('platform_super_admin'),
  );
  check(
    'S2 FileService 不再按角色名鉴权（无 .roles.some 角色判定）',
    !/\.roles\.some\(\s*\w+\s*=>\s*\w+\.role\s*===/.test(fsSrc),
  );
  check(
    'S3 getFileStream 接受 allowPrivate 能力参数',
    /getFileStream\(\s*filePublicId:\s*string,\s*opts\?\s*:\s*\{\s*allowPrivate\?\s*:\s*boolean/.test(fsSrc),
  );
  check(
    'S4 FileService 不访问 D1 permission provider / 不重新检查角色名',
    !fsSrc.includes('authorizePermission') && !fsSrc.includes('D1PermissionProvider'),
  );

  const routeSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'files.ts'), 'utf8');
  check(
    'S5 route 保留 requirePermission(file.file.view) 门禁',
    /requirePermission\(\s*'file\.file\.view'\s*\)/.test(routeSrc),
  );
  check(
    'S6 route 经统一授权解析 file.private.read',
    /authorizePermissionDecision\(\s*c\.env,\s*c\.get\('auth'\),\s*'file\.private\.read'\s*\)/.test(routeSrc),
  );
  check(
    'S7 route 将 allowPrivate 传给 getFileStream',
    /getFileStream\(\s*filePublicId,\s*\{\s*allowPrivate\s*\}\s*\)/.test(routeSrc),
  );
}

// =====================================================================
// 4) 静态契约：catalog
// =====================================================================
{
  const def = CATALOG.permissions.find((p) => p.code === 'file.private.read');
  check('C1 catalog 含 file.private.read 定义', !!def);
  check('C2 定义 scopeType=TEAM', def && def.scopeType === 'TEAM');
  check('C3 定义 risk=MEDIUM/riskLevel=2', def && def.risk === 'MEDIUM' && def.riskLevel === 2);
  const binders = Object.entries(CATALOG.rolePermissions)
    .filter(([, list]) => list.includes('file.private.read'))
    .map(([r]) => r);
  check('C4 file.private.read 仅绑定 platform_super_admin', binders.join(',') === 'platform_super_admin');
  check('C5 不绑定 platform_operator', !CATALOG.rolePermissions['platform_operator'].includes('file.private.read'));
  check('C6 不绑定 team_owner', !CATALOG.rolePermissions['team_owner'].includes('file.private.read'));
  check('C7 不绑定 team_admin', !CATALOG.rolePermissions['team_admin'].includes('file.private.read'));
  check('C8 不绑定 team_auditor', !CATALOG.rolePermissions['team_auditor'].includes('file.private.read'));
  check('C9 不绑定 volunteer', !CATALOG.rolePermissions['volunteer'].includes('file.private.read'));
  check('C10 permissions 计数=102', CATALOG.permissions.length === 102);
  check(
    'C11 rolePermissions 总数=287',
    Object.values(CATALOG.rolePermissions).reduce((a, b) => a + b.length, 0) === 287,
  );
}

// =====================================================================
// 5) 静态契约：migration 0041
// =====================================================================
{
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  const nums = files.map((f) => parseInt(f.slice(0, 4), 10));
  const maxNum = Math.max(...nums);
  check('MIG1 最高 migration 编号=41（紧随 0040）', maxNum === 41, `max=${maxNum}`);
  const migName = '0041_p1_b1_file_private_read.sql';
  check('MIG2 本迁移文件存在', files.includes(migName));
  const sql = fs.readFileSync(path.join(MIG_DIR, migName), 'utf8');
  check(
    'MIG3 仅 INSERT OR IGNORE permissions(file.private.read)',
    /INSERT OR IGNORE INTO permissions\s*\([^)]*\)\s*VALUES\s*\(\s*'file\.private\.read'/.test(sql),
  );
  check(
    'MIG4 仅 INSERT OR IGNORE role_permissions(platform_super_admin, file.private.read)',
    /INSERT OR IGNORE INTO role_permissions[^;]*platform_super_admin[^;]*file\.private\.read/.test(sql) ||
      /INSERT OR IGNORE INTO role_permissions[^;]*file\.private\.read[^;]*platform_super_admin/.test(sql),
  );
  check('MIG5 无 UPDATE', !/\bUPDATE\b/i.test(sql));
  check('MIG6 无 DELETE FROM', !/DELETE FROM/i.test(sql));
  check('MIG7 无 CREATE TABLE（不改 schema）', !/CREATE TABLE/i.test(sql));
  check('MIG8 无 ALTER TABLE', !/ALTER TABLE/i.test(sql));
  // 仅出现一个角色绑定（platform_super_admin）
  const roleBindings = [...sql.matchAll(/WHERE code = '([a-z_]+)'/g)].map((m) => m[1]);
  const distinctRoles = [...new Set(roleBindings)];
  check('MIG9 绑定角色严格仅 platform_super_admin', distinctRoles.join(',') === 'platform_super_admin', distinctRoles.join(','));
}

console.log(`\n=== P1-B1: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) {
  console.log('FAILED: ' + failures.join(' | '));
  process.exit(1);
}
