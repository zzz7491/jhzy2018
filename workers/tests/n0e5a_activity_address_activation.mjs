// =============================================================================
// N0-E5A — Activity Main Address Activation
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
//
// 冻结契约：
//   THING6_CONTRACT = ACTIVITY_MAIN_ADDRESS
//   activities.address = 活动对报名者公开的人类可读主地址（唯一激活字段）
//   province / city / district / latitude / longitude / geo_radius / checkin_config
//   一律保持 dormant（本轮不激活、不拼接、不新增字段、不新增 migration）。
//
// 覆盖（对应任务 §10）：
//   A  create address 正常 trim + persistence
//   B  blank address → NULL
//   C  invalid / non-string address → 400（且不落库）
//   D  over-limit address → 400；边界 200 → 201
//   E  update address（trim 落库；未提供时不动）
//   F  clear address（显式 null / 空白串 → NULL）
//   G  detail / read projection 返回 address
//   H  volunteer-visible projection 不丢 address（detail + list）
//   I  existing activity behavior 不回归（status/audit 权威、其他字段不变、跨团队 404）
//
// 运行：node tests/n0e5a_activity_address_activation.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

/** address 长度上限（与 ActivityAdminService.ACTIVITY_ADDRESS_MAX_LENGTH 对齐）。 */
const ADDRESS_MAX = 200;

let __c = 0;
function pid(tag) {
  __c++;
  return (tag + __c.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
}

// ---------- D1 适配器（node:sqlite 后端）----------
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
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
      const out = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
  };
}

// ---------- 结果收集 ----------
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
  const bundlePath = join(tmpdir(), `n0e5a_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration（不新增 migration）
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // 3) 用户与团队
  const U = { alice: pid('U'), carol: pid('U'), vol: pid('U'), bob: pid('U') };
  for (const n of Object.keys(U)) {
    seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U[n], n);
  }
  const uid = {};
  for (const n of Object.keys(U)) uid[n] = q('SELECT id FROM users WHERE public_id=?', U[n]).id;

  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uid.alice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uid.bob);
  const tA = q('SELECT id FROM teams WHERE public_id=?', T.A).id;
  const tB = q('SELECT id FROM teams WHERE public_id=?', T.B).id;

  // 4) 请求驱动
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const addrOf = (pub) => q('SELECT address FROM activities WHERE public_id=?', pub)?.address;
  const t0 = 1_700_000_000;

  async function createRaw(role, user, team, extra = {}, title = 'act') {
    return call('POST', '/api/v2/activities', {
      role, user, team,
      body: { title, start_time: t0, end_time: t0 + 7200, quota: 10, ...extra },
    });
  }
  async function createActivity(role, user, team, extra = {}, title = 'act') {
    const r = await createRaw(role, user, team, extra, title);
    return r.json?.data?.activity?.public_id;
  }
  const update = (pub, role, user, team, body) => call('PUT', `/api/v2/activities/${pub}`, { role, user, team, body });
  const submit = (pub, role, user, team) => call('POST', `/api/v2/activities/${pub}/submit`, { role, user, team });
  const approve = (pub, role, user, team) => call('POST', `/api/v2/activities/${pub}/approve`, { role, user, team });
  const detail = (pub, role, user, team) => call('GET', `/api/v2/activities/${pub}`, { role, user, team });
  const list = (role, user, team) => call('GET', '/api/v2/activities', { role, user, team });

  // ======================= A：create 正常 trim + persistence =======================
  const A_TRIMMED = '浙江省嘉兴市南湖区某某路 1 号';
  const rA = await createRaw('team_admin', uid.alice, tA, { address: `   ${A_TRIMMED}   ` }, 'addr-normal');
  const pubA = rA.json?.data?.activity?.public_id;
  check('A create 带 address → 201', rA.status === 201, `status=${rA.status}`);
  check('A address trim 后持久化', addrOf(pubA) === A_TRIMMED, `db=${JSON.stringify(addrOf(pubA))}`);

  // ======================= B：blank address → NULL =======================
  const pubB1 = await createActivity('team_admin', uid.alice, tA, { address: '     ' }, 'addr-blank');
  check('B 纯空白 address → NULL', addrOf(pubB1) === null, `db=${JSON.stringify(addrOf(pubB1))}`);
  const pubB2 = await createActivity('team_admin', uid.alice, tA, { address: '' }, 'addr-empty');
  check('B 空串 address → NULL', addrOf(pubB2) === null, `db=${JSON.stringify(addrOf(pubB2))}`);

  // ======================= C：invalid / non-string → 400（不落库） =======================
  const cNum = await createRaw('team_admin', uid.alice, tA, { address: 123 }, 'addr-num');
  const cObj = await createRaw('team_admin', uid.alice, tA, { address: { x: 1 } }, 'addr-obj');
  const cArr = await createRaw('team_admin', uid.alice, tA, { address: ['a'] }, 'addr-arr');
  const cBool = await createRaw('team_admin', uid.alice, tA, { address: false }, 'addr-bool');
  check('C 非 string address → 400（number/object/array/bool）',
    cNum.status === 400 && cObj.status === 400 && cArr.status === 400 && cBool.status === 400,
    `statuses=${[cNum.status, cObj.status, cArr.status, cBool.status].join(',')}`);
  const leaked = q("SELECT COUNT(*) n FROM activities WHERE title IN ('addr-num','addr-obj','addr-arr','addr-bool')").n;
  check('C 非法 address 不落库（校验先于 batch）', leaked === 0, `rows=${leaked}`);

  // ======================= D：over-limit → 400；边界 200 → 201 =======================
  const rOver = await createRaw('team_admin', uid.alice, tA, { address: 'x'.repeat(ADDRESS_MAX + 1) }, 'addr-over');
  check(`D ${ADDRESS_MAX + 1} 字符 → 400`, rOver.status === 400, `status=${rOver.status}`);
  const rExact = await createRaw('team_admin', uid.alice, tA, { address: 'y'.repeat(ADDRESS_MAX) }, 'addr-exact');
  const pubD = rExact.json?.data?.activity?.public_id;
  check(`D 恰好 ${ADDRESS_MAX} 字符 → 201`, rExact.status === 201, `status=${rExact.status}`);
  check(`D 边界值完整持久化（无截断）`,
    addrOf(pubD) === 'y'.repeat(ADDRESS_MAX), `len=${addrOf(pubD)?.length}`);

  // ======================= E：update address =======================
  const pubE = await createActivity('team_admin', uid.alice, tA, { address: '旧地址 1 号' }, 'update-addr');
  const rE = await update(pubE, 'team_admin', uid.alice, tA, { address: '  嘉兴市秀洲区新地址 2 号  ' });
  check('E update address → 200', rE.status === 200, `status=${rE.status}`);
  check('E update 后 address = trim 值', addrOf(pubE) === '嘉兴市秀洲区新地址 2 号', `db=${JSON.stringify(addrOf(pubE))}`);
  const rE2 = await update(pubE, 'team_admin', uid.alice, tA, { title: '仅改标题' });
  check('E 未提供 address 的 update → 200', rE2.status === 200, `status=${rE2.status}`);
  check('E 未提供 address → 保留原值（不误清空）',
    addrOf(pubE) === '嘉兴市秀洲区新地址 2 号', `db=${JSON.stringify(addrOf(pubE))}`);
  const rEOver = await update(pubE, 'team_admin', uid.alice, tA, { address: 'z'.repeat(ADDRESS_MAX + 1) });
  check('E update 超长 address → 400', rEOver.status === 400, `status=${rEOver.status}`);
  check('E 超长 update 被拒后原值保持',
    addrOf(pubE) === '嘉兴市秀洲区新地址 2 号', `db=${JSON.stringify(addrOf(pubE))}`);

  // ======================= F：clear address =======================
  const rF1 = await update(pubE, 'team_admin', uid.alice, tA, { address: null });
  check('F update address=null → 200', rF1.status === 200, `status=${rF1.status}`);
  check('F 显式 null → 清空为 NULL', addrOf(pubE) === null, `db=${JSON.stringify(addrOf(pubE))}`);
  await update(pubE, 'team_admin', uid.alice, tA, { address: '临时地址' });
  const rF2 = await update(pubE, 'team_admin', uid.alice, tA, { address: '   ' });
  check('F 空白串 → 200 且清空为 NULL', rF2.status === 200 && addrOf(pubE) === null, `db=${JSON.stringify(addrOf(pubE))}`);

  // ======================= G：detail / read projection 返回 address =======================
  await update(pubE, 'team_admin', uid.alice, tA, { address: 'G 路 9 号' });
  const rG = await detail(pubE, 'team_admin', uid.alice, tA);
  check('G admin detail → 200', rG.status === 200, `status=${rG.status}`);
  check('G detail 投影返回 address', rG.json?.data?.activity?.address === 'G 路 9 号',
    `addr=${JSON.stringify(rG.json?.data?.activity?.address)}`);
  const rGl = await list('team_admin', uid.alice, tA);
  const gItem = (rGl.json?.data?.items ?? []).find((x) => x.public_id === pubE);
  check('G admin list 投影返回 address', !!gItem && gItem.address === 'G 路 9 号',
    `addr=${JSON.stringify(gItem?.address)}`);

  // ======================= H：volunteer-visible projection 不丢 address =======================
  const VOL_ADDR = '志愿者可见活动地址 18 号';
  const pubH = await createActivity('team_admin', uid.alice, tA, { address: VOL_ADDR }, 'vol-addr');
  await submit(pubH, 'team_admin', uid.alice, tA);
  const rHapp = await approve(pubH, 'team_auditor', uid.carol, tA);
  check('H 前置：APPROVED + SIGNUP_OPEN', rHapp.status === 200, `status=${rHapp.status}`);
  const rHd = await detail(pubH, 'volunteer', uid.vol, tA);
  check('H volunteer detail → 200', rHd.status === 200, `status=${rHd.status}`);
  check('H volunteer detail 返回 address',
    rHd.json?.data?.activity?.address === VOL_ADDR, `addr=${JSON.stringify(rHd.json?.data?.activity?.address)}`);
  const rHl = await list('volunteer', uid.vol, tA);
  const hItem = (rHl.json?.data?.items ?? []).find((x) => x.public_id === pubH);
  check('H volunteer list item 含 address', !!hItem && hItem.address === VOL_ADDR,
    `addr=${JSON.stringify(hItem?.address)}`);

  // ======================= I：existing activity behavior 不回归 =======================
  const rI = await createRaw('team_admin', uid.alice, tA, {}, 'no-addr-field');
  const pubI = rI.json?.data?.activity?.public_id;
  check('I 完全未提供 address → 仍 201', rI.status === 201, `status=${rI.status}`);
  const sI = q('SELECT status, audit_status, title, summary, quota FROM activities WHERE public_id=?', pubI);
  check('I 未提供 address → NULL', addrOf(pubI) === null, `db=${JSON.stringify(addrOf(pubI))}`);
  check('I create 仍强制 status=0 / audit_status=0', sI.status === 0 && sI.audit_status === 0,
    `status=${sI.status} audit=${sI.audit_status}`);
  check('I 其他标量字段不受影响', sI.title === 'no-addr-field' && sI.summary === null && sI.quota === 10,
    `title=${sI.title} summary=${sI.summary} quota=${sI.quota}`);

  // 其他字段编辑仍触发 UNIFORM RE-REVIEW（address 不改变该规则）
  const pubI2 = await createActivity('team_admin', uid.alice, tA, { address: 'I 路 2 号' }, 're-re-review');
  await submit(pubI2, 'team_admin', uid.alice, tA);
  await approve(pubI2, 'team_auditor', uid.carol, tA);
  const beforeI = q('SELECT status, audit_status FROM activities WHERE public_id=?', pubI2);
  await update(pubI2, 'team_admin', uid.alice, tA, { address: 'I 路 3 号' });
  const afterI = q('SELECT status, audit_status FROM activities WHERE public_id=?', pubI2);
  check('I 编辑 address 仍回到草稿待审（UNIFORM RE-REVIEW）',
    beforeI.status === 1 && beforeI.audit_status === 2 && afterI.status === 0 && afterI.audit_status === 0,
    `before=${beforeI.status}/${beforeI.audit_status} after=${afterI.status}/${afterI.audit_status}`);
  check('I RE-REVIEW 后 address 已更新', addrOf(pubI2) === 'I 路 3 号', `db=${JSON.stringify(addrOf(pubI2))}`);

  // 跨团队：先证明 teamB 的 team_admin 在本团队可 update（权限存在），再验证跨团队 A 活动 → 404
  const pubB3 = await createActivity('team_admin', uid.bob, tB, { address: 'B 团队地址' }, 'teamB-addr');
  const rBIn = await update(pubB3, 'team_admin', uid.bob, tB, { address: 'B 团队地址改' });
  check('I 前置：teamB team_admin 可 update 本团队活动 → 200', rBIn.status === 200, `status=${rBIn.status}`);
  const rCross = await update(pubI, 'team_admin', uid.bob, tB, { address: '跨团队篡改' });
  check('I 跨团队 update address → 404（不泄露存在性）', rCross.status === 404, `status=${rCross.status}`);
  check('I 跨团队被拒后 A 团队 address 未被篡改', addrOf(pubI) !== '跨团队篡改', `db=${JSON.stringify(addrOf(pubI))}`);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`N0-E5A RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== N0-E5A = BLOCKED ===' : '=== N0-E5A = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
