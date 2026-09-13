// =============================================================================
// SECURITY P0-4 — PUBLIC PROBE PRODUCTION GUARD 回归（真实 app + local D1）
//
// 范围（S0-B1）：
//   1) production: GET /probe → 404，GET /probe/roles → 404
//   2) local:      现有 probe 行为保持（200 + 既有响应形状）
//
// 策略（对齐 n0g1_delivery_diagnostics.mjs）：esbuild 打包真实 src/app.ts →
// createApp() → node:sqlite 适配 → 应用全部 migration；同一 app 分别以
// ENVIRONMENT='local' 与 ENVIRONMENT='production' 驱动，证明环境门禁生效。
// 不联网 / 不触远端 / 不真实调用微信 / 不修改任何冻结文件。
// 运行（workers/ 目录）：node tests/security_p0_probe_guard.mjs
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) {
        params = p;
        return stmt;
      },
      async all(...o) {
        return { results: sqlite.prepare(sql).all(...(o.length ? o : params)) };
      },
      async first(...o) {
        const rows = sqlite.prepare(sql).all(...(o.length ? o : params));
        return rows.length ? rows[0] : null;
      },
      async run(...o) {
        const r = sqlite.prepare(sql).run(...(o.length ? o : params));
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

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // 1) 打包真实 app.ts
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const built = await build({
    entryPoints: [appPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `sec_probe_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 全部 migration
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // wrangler 迁移跟踪表（由 wrangler d1 migrations 创建，非 migration 文件产物）；
  // /probe 会 COUNT(*) 该表，故测试夹具需等价镜像其存在。
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations(
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     );`,
  );
  const fs = await import('node:fs');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  async function call(env, path) {
    const res = await app.request(path, { method: 'GET' }, env);
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }

  const ENV_LOCAL = { DB: d1, ENVIRONMENT: 'local' };
  const ENV_PROD = { DB: d1, ENVIRONMENT: 'production' };

  // ============ local: 行为保持 ============
  {
    const r = await call(ENV_LOCAL, '/probe');
    check('local GET /probe → 200', r.status === 200, `got ${r.status}`);
    check(
      'local GET /probe → expected shape {probe:"db", data:{...counts}}',
      r.json && r.json.probe === 'db' && r.json.data && typeof r.json.data.roles === 'number',
      JSON.stringify(r.json?.data ?? null),
    );
  }
  {
    const r = await call(ENV_LOCAL, '/probe/roles');
    check('local GET /probe/roles → 200', r.status === 200, `got ${r.status}`);
    check(
      'local GET /probe/roles → roles array + volunteerScope',
      r.json && Array.isArray(r.json.roles) && r.json.roles.length > 0 && 'volunteerScope' in r.json,
      `roles=${r.json?.roles?.length} volunteerScope=${r.json?.volunteerScope}`,
    );
  }

  // ============ production: 404 ============
  {
    const r = await call(ENV_PROD, '/probe');
    check('production GET /probe → 404', r.status === 404, `got ${r.status}`);
  }
  {
    const r = await call(ENV_PROD, '/probe/roles');
    check('production GET /probe/roles → 404', r.status === 404, `got ${r.status}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n==== SECURITY P0-4 PROBE GUARD ====`);
  console.log(`${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
