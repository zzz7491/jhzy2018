// =============================================================================
// P34-C2 — Activity Publication Approval Backend State Machine
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration，含 0027）。
//
// 覆盖（对应任务 §16）：
//   A  create 正常 → status=0 / audit_status=0
//   B  create 带 status=1 → 400          C  create 带 audit_status → 400
//   D  create 带 published_at → 400
//   E  submit DRAFT → PENDING            F  submit REJECTED → PENDING
//   G  submit PENDING → 409              H  submit APPROVED → 409
//   I  submit 记录 submitted_by/at       J  submit 清理旧 review/reject metadata
//   K  creator 自审 approve → 403        L  creator 自审 reject → 403
//   M  editor 提交后自审 → 403           N  creator 审核他人提交 → 403
//   O  team_auditor 独立审核 → 200       P  team_admin 独立审核 → 200
//   Q  approve → audit2/status1/published_at
//   R  reject 缺 reason → 400            S  whitespace reason → 400
//   T  >500 reason → 400
//   U  reject → audit3/status0/reason/reviewed_at，published_at 保持 NULL
//   V  approve 非 PENDING → 409          W  reject 非 PENDING → 409
//   X/Y/Z  跨团队 submit/approve/reject → 404
//   AA 已发布编辑 → status0/audit0 且清空发布/审核 metadata
//   AB rejected 编辑 → audit0            AC pending 编辑 → audit0
//   AD update 带 status → 400            AE update 带 audit_status → 400
//   AF 旧 direct publish 端点不可用
//   AG/AH/AI submit/approve/reject audit log
//   AJ 响应无 numeric/internal DB id     AK publish_audit_by 未被写入
//
// 运行：node tests/p34_c2_activity_approval_state_machine.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

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

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const BANNED_KEYS = new Set([
  'id', 'activity_id', 'team_id', 'user_id', 'created_by',
  'submitted_by', 'reviewed_by', 'publish_audit_by',
]);
function scanForBanned(obj) {
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = scanForBanned(it); if (r) return r; }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (BANNED_KEYS.has(k)) return `forbidden key '${k}'`;
      const r = scanForBanned(obj[k]);
      if (r) return r;
    }
  }
  return null;
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
  const bundlePath = join(tmpdir(), `p34_c2_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration
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
  const U = { alice: pid('U'), bob: pid('U'), carol: pid('U'), dave: pid('U'), erin: pid('U') };
  const USERS = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const uid = {};
  for (const n of USERS) {
    seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U[n], n);
    uid[n] = q('SELECT id FROM users WHERE public_id=?', U[n]).id;
  }
  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uid.alice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uid.dave);
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

  const state = (pub) => q(
    `SELECT id, status, audit_status, created_by, submitted_by, submitted_at,
            reviewed_by, reviewed_at, reject_reason, published_at, publish_audit_by
       FROM activities WHERE public_id=?`, pub);
  const logs = (pub) => qa(
    `SELECT action, from_status, to_status, reason, operator_id
       FROM content_audit_logs
      WHERE target_type='activity'
        AND target_id=(SELECT id FROM activities WHERE public_id=?)
      ORDER BY id`, pub);

  const t0 = 1_700_000_000;
  /** 原始 create 响应（用于断言 400 / 201 等状态码）。 */
  async function createRaw(role, user, team, extra = {}, title = 'act') {
    return call('POST', '/api/v2/activities', {
      role, user, team,
      body: { title, start_time: t0, end_time: t0 + 7200, quota: 10, ...extra },
    });
  }
  /** 便捷 create：直接返回 activity public_id（非对象）。 */
  async function createActivity(role, user, team, extra = {}, title = 'act') {
    const r = await createRaw(role, user, team, extra, title);
    return r.json?.data?.activity?.public_id;
  }
  const submit = (pub, role, user, team) => call('POST', `/api/v2/activities/${pub}/submit`, { role, user, team });
  const approve = (pub, role, user, team) => call('POST', `/api/v2/activities/${pub}/approve`, { role, user, team });
  const reject = (pub, role, user, team, reason) =>
    call('POST', `/api/v2/activities/${pub}/reject`, { role, user, team, body: { reason } });
  const update = (pub, role, user, team, body) => call('PUT', `/api/v2/activities/${pub}`, { role, user, team, body });

  /** create(alice) → submit(alice) → approve(carol) ⇒ APPROVED */
  async function makeApproved(title = 'approved') {
    const pub = await createActivity('team_admin', uid.alice, tA, {}, title);
    await submit(pub, 'team_admin', uid.alice, tA);
    await approve(pub, 'team_auditor', uid.carol, tA);
    return pub;
  }

  // ======================= A–D：create 服务端权威 =======================
  const a1r = await createRaw('team_admin', uid.alice, tA, {}, 'normal');
  const a1 = a1r.json?.data?.activity?.public_id;
  check('A create 正常 → 201', a1r.status === 201, `status=${a1r.status}`);
  const s1 = state(a1);
  check('A create 强制 status=0 / audit_status=0', s1.status === 0 && s1.audit_status === 0,
    `status=${s1.status} audit=${s1.audit_status}`);

  const b = await createRaw('team_admin', uid.alice, tA, { status: 1 }, 'bypass-status');
  check('B create 带 status=1 → 400', b.status === 400, `status=${b.status}`);

  const c = await createRaw('team_admin', uid.alice, tA, { audit_status: 2 }, 'bypass-audit');
  check('C create 带 audit_status → 400', c.status === 400, `status=${c.status}`);

  const d = await createRaw('team_admin', uid.alice, tA, { published_at: t0 }, 'bypass-pub');
  check('D create 带 published_at → 400', d.status === 400, `status=${d.status}`);

  // ======================= E–J：submit =======================
  const e1 = await createActivity('team_admin', uid.alice, tA, {}, 'submit-draft');
  const re = await submit(e1, 'team_admin', uid.alice, tA);
  check('E submit DRAFT → PENDING (200)', re.status === 200 && state(e1).audit_status === 1,
    `status=${re.status} audit=${state(e1).audit_status}`);
  check('E submit 后 status 保持 0', state(e1).status === 0, `status=${state(e1).status}`);

  const i1 = state(e1);
  check('I submit 记录 submitted_by/submitted_at',
    i1.submitted_by === uid.alice && i1.submitted_at != null,
    `submitted_by=${i1.submitted_by} submitted_at=${i1.submitted_at}`);

  // G：PENDING 再 submit → 409
  const rg = await submit(e1, 'team_admin', uid.alice, tA);
  check('G submit PENDING → 409', rg.status === 409, `status=${rg.status}`);

  // H：APPROVED submit → 409
  const hPub = await makeApproved('submit-approved');
  const rh = await submit(hPub, 'team_admin', uid.alice, tA);
  check('H submit APPROVED → 409', rh.status === 409, `status=${rh.status}`);

  // F/J：REJECTED → submit → PENDING 且清理旧 metadata
  const fPub = await createActivity('team_admin', uid.alice, tA, {}, 'reject-cycle');
  await submit(fPub, 'team_admin', uid.alice, tA);
  await reject(fPub, 'team_auditor', uid.carol, tA, 'initial reject');
  const beforeResubmit = state(fPub);
  const rf = await submit(fPub, 'team_admin', uid.alice, tA);
  const afterResubmit = state(fPub);
  check('F submit REJECTED → PENDING (200)',
    rf.status === 200 && afterResubmit.audit_status === 1, `status=${rf.status} audit=${afterResubmit.audit_status}`);
  check('F 驳回前确有 review metadata（前置有效）',
    beforeResubmit.reviewed_by === uid.carol && beforeResubmit.reject_reason === 'initial reject');
  check('J submit 清理旧 review/reject metadata',
    afterResubmit.reviewed_by === null && afterResubmit.reviewed_at === null && afterResubmit.reject_reason === null,
    `reviewed_by=${afterResubmit.reviewed_by} reviewed_at=${afterResubmit.reviewed_at} reason=${afterResubmit.reject_reason}`);

  // ======================= K–N：职责分离 =======================
  const kPub = await createActivity('team_admin', uid.alice, tA, {}, 'self-approve');
  await submit(kPub, 'team_admin', uid.alice, tA);
  const rk = await approve(kPub, 'team_admin', uid.alice, tA);
  check('K creator 自审 approve → 403', rk.status === 403, `status=${rk.status}`);

  const lPub = await createActivity('team_admin', uid.alice, tA, {}, 'self-reject');
  await submit(lPub, 'team_admin', uid.alice, tA);
  const rl = await reject(lPub, 'team_admin', uid.alice, tA, 'self reject attempt');
  check('L creator 自审 reject → 403', rl.status === 403, `status=${rl.status}`);

  // M：editor bob 提交 alice 创建的活动，bob 自审 → 403（submitted_by == reviewer）
  const mPub = await createActivity('team_admin', uid.alice, tA, {}, 'editor-submit');
  await submit(mPub, 'team_admin', uid.bob, tA);
  const rm = await approve(mPub, 'team_admin', uid.bob, tA);
  check('M editor 提交后自审 → 403', rm.status === 403, `status=${rm.status}`);

  // N：creator alice 审核 bob 提交的活动 → 403（created_by == reviewer）
  const rn = await approve(mPub, 'team_admin', uid.alice, tA);
  check('N creator 审核他人提交的活动 → 403', rn.status === 403, `status=${rn.status}`);

  // ======================= O–Q：独立审核 =======================
  const oPub = await createActivity('team_admin', uid.alice, tA, {}, 'auditor-approve');
  await submit(oPub, 'team_admin', uid.alice, tA);
  const ro = await approve(oPub, 'team_auditor', uid.carol, tA);
  check('O 独立 team_auditor approve → 200', ro.status === 200, `status=${ro.status} ${JSON.stringify(ro.json?.error ?? '')}`);

  const pPub = await createActivity('team_admin', uid.alice, tA, {}, 'admin-approve');
  await submit(pPub, 'team_admin', uid.alice, tA);
  const rp = await approve(pPub, 'team_admin', uid.bob, tA);
  check('P 独立 team_admin approve → 200', rp.status === 200, `status=${rp.status}`);

  const sq = state(oPub);
  check('Q approve → audit=2 / status=1 / published_at 非空',
    sq.audit_status === 2 && sq.status === 1 && sq.published_at != null,
    `audit=${sq.audit_status} status=${sq.status} published_at=${sq.published_at}`);
  check('Q approve 写入 reviewed_by/reviewed_at 且清空 reject_reason',
    sq.reviewed_by === uid.carol && sq.reviewed_at != null && sq.reject_reason === null);

  // ======================= R–U：reject =======================
  const rPub = await createActivity('team_admin', uid.alice, tA, {}, 'reject-reason');
  await submit(rPub, 'team_admin', uid.alice, tA);
  const rNoReason = await reject(rPub, 'team_auditor', uid.carol, tA, undefined);
  check('R reject 缺 reason → 400', rNoReason.status === 400, `status=${rNoReason.status}`);

  const rWs = await reject(rPub, 'team_auditor', uid.carol, tA, '    ');
  check('S whitespace reason → 400', rWs.status === 400, `status=${rWs.status}`);

  const rLong = await reject(rPub, 'team_auditor', uid.carol, tA, 'x'.repeat(501));
  check('T >500 reason → 400', rLong.status === 400, `status=${rLong.status}`);

  const rOk = await reject(rPub, 'team_auditor', uid.carol, tA, '需要补充场地证明');
  check('U reject 正常 → 200', rOk.status === 200, `status=${rOk.status}`);
  const su = state(rPub);
  check('U reject → audit=3 / status=0 / reason 落库 / reviewed_at 非空',
    su.audit_status === 3 && su.status === 0 && su.reject_reason === '需要补充场地证明' && su.reviewed_at != null,
    `audit=${su.audit_status} status=${su.status} reason=${su.reject_reason}`);
  check('U reject 后 published_at 保持 NULL', su.published_at === null, `published_at=${su.published_at}`);

  // ======================= V–W：非 PENDING 审核 → 409 =======================
  const vPub = await createActivity('team_admin', uid.alice, tA, {}, 'approve-nonpending');
  const rv = await approve(vPub, 'team_auditor', uid.carol, tA);
  check('V approve 非 PENDING → 409', rv.status === 409, `status=${rv.status}`);

  const rw = await reject(vPub, 'team_auditor', uid.carol, tA, 'early reject');
  check('W reject 非 PENDING → 409', rw.status === 409, `status=${rw.status}`);

  // ======================= X–Z：跨团队 → 404 =======================
  const xPub = await createActivity('team_admin', uid.dave, tB, {}, 'cross-team');
  const rx = await submit(xPub, 'team_admin', uid.alice, tA);
  check('X 跨团队 submit → 404', rx.status === 404, `status=${rx.status}`);

  await submit(xPub, 'team_admin', uid.dave, tB); // 使其在 B 团队处于 PENDING
  const ry = await approve(xPub, 'team_auditor', uid.carol, tA);
  check('Y 跨团队 approve → 404', ry.status === 404, `status=${ry.status}`);
  const rz = await reject(xPub, 'team_auditor', uid.carol, tA, 'cross team');
  check('Z 跨团队 reject → 404', rz.status === 404, `status=${rz.status}`);

  // ======================= AA–AE：编辑重新审核 =======================
  const aaPub = await makeApproved('edit-approved');
  const before = state(aaPub);
  const raa = await update(aaPub, 'team_admin', uid.bob, tA, { title: 'edited after approve' });
  const after = state(aaPub);
  check('AA 已发布编辑 → 200', raa.status === 200, `status=${raa.status}`);
  check('AA 已发布编辑 → status=0 / audit=0',
    after.status === 0 && after.audit_status === 0, `status=${after.status} audit=${after.audit_status}`);
  check('AA 编辑前确为已发布（前置有效）', before.audit_status === 2 && before.published_at != null);
  check('AA 编辑清空发布/审核 metadata',
    after.published_at === null && after.submitted_by === null && after.submitted_at === null &&
    after.reviewed_by === null && after.reviewed_at === null && after.reject_reason === null,
    `published_at=${after.published_at} submitted_by=${after.submitted_by} reviewed_by=${after.reviewed_by}`);

  const abPub = await createActivity('team_admin', uid.alice, tA, {}, 'edit-rejected');
  await submit(abPub, 'team_admin', uid.alice, tA);
  await reject(abPub, 'team_auditor', uid.carol, tA, 'reject then edit');
  await update(abPub, 'team_admin', uid.alice, tA, { title: 'edited after reject' });
  check('AB rejected 编辑 → audit=0', state(abPub).audit_status === 0, `audit=${state(abPub).audit_status}`);

  const acPub = await createActivity('team_admin', uid.alice, tA, {}, 'edit-pending');
  await submit(acPub, 'team_admin', uid.alice, tA);
  await update(acPub, 'team_admin', uid.alice, tA, { title: 'edited while pending' });
  check('AC pending 编辑 → audit=0', state(acPub).audit_status === 0, `audit=${state(acPub).audit_status}`);

  const rad = await update(aaPub, 'team_admin', uid.alice, tA, { title: 'x', status: 1 });
  check('AD update 带 status → 400', rad.status === 400, `status=${rad.status}`);
  const rae = await update(aaPub, 'team_admin', uid.alice, tA, { title: 'x', audit_status: 2 });
  check('AE update 带 audit_status → 400', rae.status === 400, `status=${rae.status}`);

  // ======================= AF：direct publish 已移除 =======================
  const afPub = await createActivity('team_admin', uid.alice, tA, {}, 'direct-publish');
  const raf = await call('POST', `/api/v2/activities/${afPub}/publish`, {
    role: 'team_owner', user: uid.alice, team: tA,
  });
  check('AF 旧 direct publish 端点不可用', raf.status === 404, `status=${raf.status}`);
  check('AF direct publish 未产生发布效果', state(afPub).audit_status === 0 && state(afPub).status === 0);

  // ======================= AG–AI：审计日志 =======================
  const lg = await createActivity('team_admin', uid.alice, tA, {}, 'log-cycle');
  await submit(lg, 'team_admin', uid.alice, tA);
  await approve(lg, 'team_auditor', uid.carol, tA);
  const lgs = logs(lg);
  const lgSubmit = lgs.find((x) => x.action === 'submit');
  const lgApprove = lgs.find((x) => x.action === 'approve');
  check('AG submit audit log 存在', !!lgSubmit && lgSubmit.from_status === 'DRAFT' && lgSubmit.to_status === 'PENDING',
    JSON.stringify(lgSubmit));
  check('AG submit log operator = 提交人', lgSubmit && lgSubmit.operator_id === uid.alice);
  check('AH approve audit log 存在',
    !!lgApprove && lgApprove.from_status === 'PENDING' && lgApprove.to_status === 'APPROVED', JSON.stringify(lgApprove));
  check('AH approve log operator = 审核人（非提交人）', lgApprove && lgApprove.operator_id === uid.carol);

  const lj = await createActivity('team_admin', uid.alice, tA, {}, 'log-reject');
  await submit(lj, 'team_admin', uid.alice, tA);
  await reject(lj, 'team_auditor', uid.carol, tA, 'log reason');
  const lgReject = logs(lj).find((x) => x.action === 'reject');
  check('AI reject audit log 存在且带 reason',
    !!lgReject && lgReject.from_status === 'PENDING' && lgReject.to_status === 'REJECTED' && lgReject.reason === 'log reason',
    JSON.stringify(lgReject));

  // ======================= AJ–AK：响应安全 / LEGACY_DORMANT =======================
  const leak = scanForBanned(ro.json?.data ?? {});
  check('AJ 响应无 numeric/internal DB id', leak === null, leak ?? '');
  check('AJ 响应含 activity_public_id / status / audit_status',
    ro.json?.data?.activity?.activity_public_id === oPub &&
    ro.json?.data?.activity?.status === 1 &&
    ro.json?.data?.activity?.audit_status === 2,
    JSON.stringify(ro.json?.data?.activity));

  const dormant = state(oPub).publish_audit_by;
  const anyDormant = qa('SELECT COUNT(*) n FROM activities WHERE publish_audit_by IS NOT NULL')[0].n;
  check('AK publish_audit_by 未被写入（LEGACY_DORMANT）',
    dormant === null && anyDormant === 0, `approved.publish_audit_by=${dormant} non-null rows=${anyDormant}`);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`P34-C2 RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== P34-C2 = BLOCKED ===' : '=== P34-C2 = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
