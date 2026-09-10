/**
 * P37-C2A — 最小 capability 端点安全/权限测试
 *
 * 验证 GET /api/v2/users/me 新增的 analytics_capabilities 投影：
 *   1. permission result correctness（team-only / platform-only / both / no-team-team-perm / none）
 *   2. 不硬编码 role（结果完全由 DB 角色绑定推导）
 *   3. 不泄露 numeric internal id（analytics_capabilities 仅含两个 boolean）
 *   4. 不泄露 PII / 完整 RBAC 矩阵（无 roles / permissions / role_permissions / matrix 等键）
 *
 * 纯契约测试：真实 app.ts（esbuild 打包）+ 完整迁移链 + node:sqlite D1 适配器 + 真实中间件链。
 * 不修改源码 / 迁移 / frontend / 历史 WIP；不 git add / commit / push。
 *
 * 运行（workers/ 目录）：node tests/p37_c2a_capability_endpoint.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS = fileURLToPath(new URL('..', import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  ✗ FAIL: ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// D1 适配器（与 p36_c3_2 同款；纯查询/写入，不模拟 provider 故障）
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) {
        params = p;
        return stmt;
      },
      async all(...override) {
        const p = override.length ? override : params;
        return { results: sqlite.prepare(sql).all(...p) };
      },
      async first(...override) {
        const p = override.length ? override : params;
        const rows = sqlite.prepare(sql).all(...p);
        return rows.length ? rows[0] : null;
      },
      async run(...override) {
        const p = override.length ? override : params;
        const r = sqlite.prepare(sql).run(...p);
        return { meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) await s.run();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// 生成合法 26 位 ULID 形态标识（纯数字，避开 Crockford 禁用字符；供 fixture 直插）。
const mkId = (n) => String(n).padStart(26, '0');

async function main() {
  // ---- 1) 打包真实 app.ts ----
  const appPath = join(WORKERS, 'src/app.ts');
  const built = await build({
    entryPoints: [appPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `p37_c2a_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // ---- 2) sqlite + 完整迁移链 ----
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  const migDir = join(WORKERS, 'migrations');
  const migs = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migs) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const d1 = makeD1(sqlite);

  const ins = (sql, ...p) => sqlite.prepare(sql).run(...p);

  // ---- 3) 种子 users（findMe 需要存在行；id 取自 x-test-user）----
  const U = { alice: 101, bob: 102, carol: 103 };
  for (const [name, id] of Object.entries(U)) {
    ins('INSERT INTO users (id, public_id, nickname, status, cert_level) VALUES (?,?,?,1,0)', id, `USER${name.toUpperCase()}000000000000000000${id}`, name);
  }

  // ---- 4) 请求驱动 ----
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    const res = await app.request('/api/v2/users/me', { method: 'GET', headers }, { ...ENV });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }

  // =========================================================================
  section('AUTH. 未认证 / 认证基础');
  // =========================================================================
  {
    const r = await call();
    check('A1 未认证 → 401', r.status === 401, `status=${r.status}`);
    check('A2 未认证 code = AUTH_REQUIRED', r.json?.error?.code === 'AUTH_REQUIRED');
  }

  // =========================================================================
  section('CAPABILITY. analytics_capabilities 权限正确性');
  // =========================================================================
  {
    const r = await call({ role: 'team_admin', user: U.alice, team: 201 });
    check('B1 team_admin + active team → 200', r.status === 200, `status=${r.status}`);
    const caps = r.json?.data?.analytics_capabilities;
    check('B2 team_admin → team_view=true', caps?.team_view === true, JSON.stringify(caps));
    check('B3 team_admin → platform_view=false', caps?.platform_view === false, JSON.stringify(caps));

    const r2 = await call({ role: 'platform_operator', user: U.bob, team: 201 });
    const caps2 = r2.json?.data?.analytics_capabilities;
    check('B4 platform_operator → team_view=false', caps2?.team_view === false, JSON.stringify(caps2));
    check('B5 platform_operator → platform_view=true', caps2?.platform_view === true, JSON.stringify(caps2));

    const r3 = await call({ role: 'platform_super_admin', user: U.carol, team: 201 });
    const caps3 = r3.json?.data?.analytics_capabilities;
    check('B6 platform_super_admin → team_view=true', caps3?.team_view === true, JSON.stringify(caps3));
    check('B7 platform_super_admin → platform_view=true', caps3?.platform_view === true, JSON.stringify(caps3));

    // §7：持有团队权限但无 active team（scopeTeamId=-1）→ TEAM_CONTEXT_MISSING，仍应识别 team_view=true
    const r4 = await call({ role: 'team_admin', user: U.alice });
    const caps4 = r4.json?.data?.analytics_capabilities;
    check('B8 team_admin 无 active team → team_view=true（区分 TEAM_CONTEXT_MISSING）', caps4?.team_view === true, JSON.stringify(caps4));
    check('B9 team_admin 无 active team → platform_view=false', caps4?.platform_view === false, JSON.stringify(caps4));

    const r5 = await call({ role: 'volunteer', user: U.bob, team: 201 });
    const caps5 = r5.json?.data?.analytics_capabilities;
    check('B10 volunteer → team_view=false', caps5?.team_view === false, JSON.stringify(caps5));
    check('B11 volunteer → platform_view=false', caps5?.platform_view === false, JSON.stringify(caps5));
  }

  // =========================================================================
  section('SECURITY. 投影最小、不泄露矩阵 / 内部 id / PII');
  // =========================================================================
  {
    const r = await call({ role: 'team_admin', user: U.alice, team: 201 });
    const caps = r.json?.data?.analytics_capabilities;
    const capsKeys = caps ? Object.keys(caps).sort().join(',') : '';
    check('C1 analytics_capabilities 仅含 team_view,platform_view', capsKeys === 'platform_view,team_view', capsKeys);
    check('C2 analytics_capabilities 不含 numeric id 键', !/user_id|team_id|role_id|permission_id/.test(capsKeys));

    const data = r.json?.data ?? {};
    const dataStr = JSON.stringify(data);
    check('C3 响应不含完整 RBAC 矩阵（无 roles/permissions/role_permissions/matrix 键）',
      !/(^|[^a-z])roles([^a-z]|$)/.test(dataStr) &&
      !/(^|[^a-z])permissions([^a-z]|$)/.test(dataStr) &&
      !/role_permissions/.test(dataStr) &&
      !/permission_matrix/.test(dataStr),
      dataStr.slice(0, 200));
    check('C4 响应不含 PII 字面量（real_name/phone/id_card/identity_hash）',
      !/real_name|phone|id_card|identity_hash/i.test(dataStr));
    check('C5 响应不含 internal scope_team_id 等内部建模', !/scope_team_id|scopeTeamId/.test(dataStr));
    check('C6 未新增 analytics.* 之外的能力投影键', !/capabilities\b/.test(dataStr.replace('analytics_capabilities', '')));
  }

  // =========================================================================
  section('NO ROLE HARDCODE（结果由 DB 绑定推导，非代码 if/else）');
  // =========================================================================
  {
    // 临时摘除 team_admin → analytics.team.view（仅改本次内存 DB，不改 RBAC seed 文件），
    // 验证 team_view 立即变为 false（证明结果来自 DB，而非硬编码 true）。
    ins(
      `DELETE FROM role_permissions
        WHERE role_id = (SELECT id FROM roles WHERE code = ?)
          AND permission_id = (SELECT id FROM permissions WHERE code = ?)`,
      'team_admin',
      'analytics.team.view',
    );
    const r = await call({ role: 'team_admin', user: U.alice, team: 201 });
    const caps = r.json?.data?.analytics_capabilities;
    check('D1 摘除 team_admin→analytics.team.view 绑定后 team_view=false（非硬编码）', caps?.team_view === false, JSON.stringify(caps));
    // 还原
    ins(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
        WHERE r.code = ? AND p.code = ?`,
      'team_admin',
      'analytics.team.view',
    );
    const r2 = await call({ role: 'team_admin', user: U.alice, team: 201 });
    check('D2 绑定已还原 → team_view 恢复 true', r2.json?.data?.analytics_capabilities?.team_view === true, JSON.stringify(r2.json?.data?.analytics_capabilities));
  }
}

main()
  .then(() => {
    console.log('\n========================================');
    console.log(`P37-C2A CAPABILITY ENDPOINT RESULT: PASS=${pass}  FAIL=${fail}`);
    console.log('========================================');
    if (fail > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\n[FATAL]', err);
    process.exit(1);
  });
