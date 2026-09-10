// =============================================================================
// P35-C2 — Service Time Adjustment · Approval State Machine (backend runtime)
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration，含 0028）。
//
// 覆盖（对应任务 §16 端点 / §7-§11 冻结设计）：
//   A   requested_minutes == 当前 → approve 后 SR 分钟/积分不变（零业务效果）
//   B   分钟变化但积分阈值内仍 0（minutes 25→20，points 恒 0）→ 分钟变、积分不变
//   C   申请人自审 approve → 403（含 team_admin，无 bypass）
//   D   申请人自审 reject  → 403
//   E   reviewer（team_auditor）approve → 200
//   F   分钟变化 → SR.minutes 更新，积分按权威公式重算
//   G   积分按 SR_CTE target-net 只协调一次（settlement + correction 共 2 条 ledger）
//   H   reject 仅更新 request 行，SR / points / audit 零副作用
//   I   reject 缺 reason → 400；纯空白 reason → 400
//   J   approve 前并发改 minutes → 409 STALE
//   K   跨团队 approve → 404（team scope 隔离）
//   L   列表投影无内部 numeric FK（id/user_id/team_id/requester_id/reviewer_id…）
//   M   同一 SR 第二个 PENDING 申请 → 409 ADJUSTMENT_PENDING_EXISTS
//   N   APPROVED 后再 approve → 409 INVALID_TRANSITION
//   O   REJECTED 后再 review → 409 INVALID_TRANSITION
//   P   旧直接 adjust 端点已移除 → POST /:id/adjust → 404（DIRECT_ADJUST_RUNTIME=REMOVED）
//   Q   PENDING 期间 SR.source 保持 'auto'（申请零业务效果）
//   R   approve 后 SR.source = 'correction'
//   S   approve 写 1 条 audit（operator=申请人 / approved_by=审批人 / trace_id=申请 public_id）
//   T   PENDING 期间 settlement_status 保持 EFFECTIVE(1)
//   U   申请捕获三快照 == 申请时 SR 当前值
//   V   approve 前并发改 points → 409 STALE
//   W   approve 前并发改 settlement_status → 409 STALE
//   X   STALE 后 request 保持 PENDING、SR 不变、无 audit、无 ledger 增量
//   Y   audit.approved_by == reviewer uid
//   Z   audit.operator_id == requester uid
//   AA  reject 不产生 audit 行
//   AB  platform_super_admin 无法绕过 team scope 审批团队修正 → 403（无 bypass；平台角色 scopeTeamId=null 在更外层即拒）
//   AC  team_auditor 可审核（approve → 200）
//   AD  volunteer 既不能 request（403）也不能 review（403）
//   AE* 非 EFFECTIVE(1) SR 申请 → 409 ADJUSTMENT_NOT_ALLOWABLE（资格守卫，bonus）
//   AF  并发漂移 minutes   → approve 409 且真实 DB 终态零业务效果（audit/ledger/request/SR/revision 全不变）
//   AG  并发漂移 points    → 同上（points 快照维度）
//   AH  并发漂移 settlement → 同上（settlement_status 快照维度）
//   AI  直调 repo 原语制造 optimistic SR UPDATE = 0 → changes=0，证明 db.batch 内无 partial commit
//   AJ  approve × reject 并发（request 已 REJECTED）→ changes=0，证明无「请求已拒但时长被改」的部分提交
//   AK  super_admin 自审（fixture seed requester_id=super_admin）→ 403 且零副作用（SELF_APPROVAL_BYPASS 不可达）
//
// 运行（在 workers/ 目录）：node tests/p35_c2_service_time_adjustment_approval.mjs
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
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
let _n = 2000;
function nid() {
  return ++_n;
}

// ---------- D1 适配器（node:sqlite 后端，对齐 Cloudflare D1 API）----------
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
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
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
  'id', 'service_record_id', 'user_id', 'team_id', 'requester_id', 'reviewer_id',
  'activity_id', 'session_id', 'source_id', 'operator_id', 'approved_by',
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

const SETTLEMENT = { UNVERIFIED: 0, EFFECTIVE: 1, REVOKED: 2 };
const REQ_STATUS = { PENDING: 0, APPROVED: 1, REJECTED: 2 };

async function main() {
  // 1) 打包真实 app.ts + computePointsUnits（临时 bundle-entry 重新导出，避免运行时改动 src）
  const ENTRY = `
export { createApp } from './src/app';
export { computePointsUnits, ServiceRecordRepository } from './src/repository/service-records';
export { generateUlid } from './src/utils/crypto';
`;
  const entryPath = join(WORKERS_DIR, '.p35_c2_bundle_entry.ts');
  writeFileSync(entryPath, ENTRY);
  const bundlePath = join(tmpdir(), `p35_c2_app_${Date.now()}.mjs`);
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: bundlePath,
    absWorkingDir: WORKERS_DIR,
    logLevel: 'error',
  });
  unlinkSync(entryPath);
  const M = await import(pathToFileURL(bundlePath).href);
  const { createApp, computePointsUnits } = M;
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration（含 0028）
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;'); // 测试种子不强制 FK（与生产迁移解耦）
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const get1 = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // 3) 团队与身份（RBAC 由 role_permissions 解析，role 经 x-test-role 注入）
  const T = { A: 10, B: 20 };
  seed('INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)',
    T.A, pid('T'), 'teamA', 900);
  seed('INSERT OR IGNORE INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)',
    T.B, pid('T'), 'teamB', 901);

  // 身份（numeric id 用于在 x-test-user / 审计 owner_id 中引用；SR 由独立 owner 持有）
  const U = {
    alice: 101,   // team A, team_admin（有 adjust + review）
    bob: 102,     // team A, team_auditor（有 review，无 adjust）
    carol: 103,   // team A, team_admin
    superEve: 104,// platform_super_admin（平台级 adjust + review）
    volley: 105,  // team A, volunteer（无 adjust/review/view）
    crossAuditor: 106, // team B, team_auditor
    ownerA: 900,  // team A SR owner（普通用户）
    ownerB: 901,  // team B SR owner
  };
  for (const [k, id] of Object.entries(U)) {
    seed('INSERT OR IGNORE INTO users (id, public_id, nickname) VALUES (?,?,?)', id, pid('U'), k);
  }
  const teamOf = { alice: T.A, bob: T.A, carol: T.A, superEve: T.A, volley: T.A, crossAuditor: T.B, ownerA: T.A, ownerB: T.B };

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
    // 统一响应信封：{ success, data, request_id }；成功时解包 data 便于断言。
    const data = json && json.success === true ? json.data : json;
    return { status: res.status, json: data };
  }

  // ---------- 支撑链 + EFFECTIVE service record 播种 ----------
  /**
   * 创建一个 EFFECTIVE service record（含最小支撑链 teams/users/activities/sessions）。
   * points = computePointsUnits(minutes,minMin,base,pct)；seedSettlement 时一并播种
   * settlement ledger（request_id = 'svc:sr:<pub>:1'），使后续 correction 的
   * SR_CTE target-net 协调语义真实（delta = correction - settlement，而非全额）。
   */
  function seedEffectiveSR(teamId, { minutes, pct = 100, base = 100, minMin = 30, seedSettlement = true }) {
    const ownerId = teamId === T.A ? U.ownerA : U.ownerB;
    const points = computePointsUnits(minutes, minMin, base, pct);
    const aid = nid();
    const sessId = nid();
    const signupId = nid();
    const partId = nid();
    const srid = nid();
    const srPub = pid('SR');

    seed('INSERT OR IGNORE INTO activities (id, public_id, team_id, title, start_time, end_time, status, points_multiplier_pct, max_session_minutes, created_by) VALUES (?,?,?,?,0,0,1,?,?,?)',
      aid, pid('A'), teamId, 'act' + aid, pct, null, 199);
    seed('INSERT OR IGNORE INTO activity_signups (id, user_id, activity_id, status) VALUES (?,?,?,1)', signupId, ownerId, aid);
    seed('INSERT OR IGNORE INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) VALUES (?,?,?,?,1,0)',
      partId, pid('P'), signupId, 9001);
    seed(`INSERT OR IGNORE INTO attendance_sessions
            (id, signup_id, activity_id, user_id, team_id, participation_id, service_date, slot, checkin_at, checkout_at, status, review_status, business_service_date, created_at, updated_at)
          VALUES (?,?,?,?,?,?,1,'',?,?,?,?,?,0,0)`,
      sessId, signupId, aid, ownerId, teamId, partId, 1000, 3700, 2, 0, '2026-09-01');
    seed(`INSERT INTO service_records
            (id, public_id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status,
             service_date, business_service_date, points_min_minutes, points_base_units_per_hour, points_multiplier_pct,
             points_awarded_units, settlement_status, points_revision, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      srid, srPub, sessId, ownerId, teamId, aid, minutes, 'auto', 1, 0,
      1700000000, '2026-09-01', minMin, base, pct, points, SETTLEMENT.EFFECTIVE, 1, 1700000000, 1700000000);

    if (seedSettlement && points > 0) {
      seed('INSERT OR IGNORE INTO points_accounts (user_id, balance, total_earned, total_spent, total_debits, updated_at) VALUES (?,?,?,?,?,?)',
        ownerId, points, points, 0, 0, 1700000000);
      seed(`INSERT INTO points_ledger
              (user_id, direction, amount, balance_after, type, source_type, source_id, request_id, remark, operator_id, created_at)
            VALUES (?,1,?,?, 'service','service_record',(SELECT id FROM service_records WHERE public_id=?), ?, 'checkout', NULL, ?)`,
        ownerId, points, points, srPub, 'svc:sr:' + srPub + ':1', 1700000000);
    }
    return { srPub, srid, ownerId, points };
  }

  // ---------- 直接查询（断言 SR / request / audit / ledger 状态）----------
  const srState = (pub) => get1('SELECT * FROM service_records WHERE public_id=?', pub);
  const reqState = (pub) => get1('SELECT * FROM service_record_adjustment_requests WHERE public_id=?', pub);
  const auditRows = (srPub) =>
    qa('SELECT * FROM service_record_audits WHERE service_record_id=(SELECT id FROM service_records WHERE public_id=?) ORDER BY id', srPub);
  const ledgerRows = (srPub) =>
    qa(`SELECT * FROM points_ledger
          WHERE source_type='service_record' AND source_id=(SELECT id FROM service_records WHERE public_id=?)
          ORDER BY id`, srPub);

  // ---------- 路由快捷封装 ----------
  const requestAdjustment = (srPub, user, team, role, body) =>
    call('POST', `/api/v2/service-records/${srPub}/adjustments`, { role, user, team, body });
  const listAdjustments = (srPub, user, team, role) =>
    call('GET', `/api/v2/service-records/${srPub}/adjustments`, { role, user, team });
  const approve = (adjPub, user, team, role) =>
    call('POST', `/api/v2/service-record-adjustments/${adjPub}/approve`, { role, user, team });
  const reject = (adjPub, user, team, role, reason) =>
    call('POST', `/api/v2/service-record-adjustments/${adjPub}/reject`, { role, user, team, body: { reason } });

  // 直调 repository 原语（用于模拟 HTTP pre-check 与 db.batch 之间的 TOCTOU——
  // 单线程 HTTP 无法注入并发写者，故必须绕过 service pre-check 直达原子原语）。
  const makeRepo = (userId, teamId, role) => new M.ServiceRecordRepository({
    db: d1,
    ctx: {
      auth: { authenticated: true, userId, teamId, roles: [{ role, scopeTeamId: teamId }] },
      tenant: { scope: 'TEAM_SCOPED', teamId, userId },
    },
  });

  // =========================================================================
  // A — requested_minutes == 当前 → approve 后 SR 分钟/积分不变（零业务效果）
  // =========================================================================
  {
    const m0 = 60;
    const sr = seedEffectiveSR(T.A, { minutes: m0 }); // points = 100
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: m0, reason: 'r' });
    check('A 请求（分钟不变） → 200', r.status === 200, `status=${r.status}`);
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('A approve → 200', ap.status === 200, `status=${ap.status}`);
    const st = srState(sr.srPub);
    check('A approve 后 minutes 不变 (=60)', st.minutes === 60, `minutes=${st.minutes}`);
    check('A approve 后 points 不变 (=100)', st.points_awarded_units === 100, `points=${st.points_awarded_units}`);
    check('A approve 后 settlement 保持 EFFECTIVE', st.settlement_status === SETTLEMENT.EFFECTIVE, `ss=${st.settlement_status}`);
  }

  // =========================================================================
  // B — 分钟变化（25→20，均 <30 阈值）但积分恒 0 → 分钟变、积分不变
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 25 }); // points = 0
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 20, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('B approve → 200', ap.status === 200, `status=${ap.status}`);
    const st = srState(sr.srPub);
    check('B minutes 变化 (25→20)', st.minutes === 20, `minutes=${st.minutes}`);
    check('B points 不变 (=0)', st.points_awarded_units === 0, `points=${st.points_awarded_units}`);
  }

  // =========================================================================
  // C / D — 申请人自审 → 403（team_admin 同时有 adjust+review，验证无 bypass）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.alice, T.A, 'team_admin');
    check('C 申请人自审 approve → 403', ap.status === 403, `status=${ap.status}`);
    const rj = await reject(adjPub, U.alice, T.A, 'team_admin', 'self-reject');
    check('D 申请人自审 reject → 403', rj.status === 403, `status=${rj.status}`);
    check('C/D 自审后 request 仍 PENDING', reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
  }

  // =========================================================================
  // E — team_auditor 审批通过 → 200
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('E team_auditor approve → 200', ap.status === 200, `status=${ap.status}`);
    check('E request → APPROVED', reqState(adjPub).status === REQ_STATUS.APPROVED, `status=${reqState(adjPub)?.status}`);
  }

  // =========================================================================
  // F — 分钟变化 → SR.minutes 更新，积分按权威公式重算（60→120 ⇒ 100→200）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 }); // points=100
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await approve(adjPub, U.bob, T.A, 'team_auditor');
    const st = srState(sr.srPub);
    check('F minutes 60→120', st.minutes === 120, `minutes=${st.minutes}`);
    check('F points 100→200（权威公式）', st.points_awarded_units === 200, `points=${st.points_awarded_units}`);
  }

  // =========================================================================
  // G — 积分按 SR_CTE target-net 只协调一次（settlement + correction 共 2 条）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 }); // points=100, 已播种 settlement ledger(:1)
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await approve(adjPub, U.bob, T.A, 'team_auditor');
    const led = ledgerRows(sr.srPub);
    check('G ledger 共 2 条（settlement + correction）', led.length === 2, `len=${led.length}`);
    const corr = led[led.length - 1];
    check('G correction 金额 = |200-100| = 100', corr && corr.amount === 100, `amount=${corr?.amount}`);
    // 再 approve 一次（已 APPROVED）→ 409，ledger 不增
    const again = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('G 已审批再 approve → 409', again.status === 409, `status=${again.status}`);
    check('G ledger 仍 2 条', ledgerRows(sr.srPub).length === 2, `len=${ledgerRows(sr.srPub).length}`);
  }

  // =========================================================================
  // H — reject 仅更新 request 行，SR / points / audit 零副作用
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const rj = await reject(adjPub, U.bob, T.A, 'team_auditor', 'not justified');
    check('H reject → 200', rj.status === 200, `status=${rj.status}`);
    const st = srState(sr.srPub);
    check('H SR.minutes 不变 (=60)', st.minutes === 60, `minutes=${st.minutes}`);
    check('H SR.points 不变 (=100)', st.points_awarded_units === 100, `points=${st.points_awarded_units}`);
    check('H SR.source 仍 auto', st.source === 'auto', `source=${st.source}`);
    check('H 无 audit 行', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
    check('H request → REJECTED', reqState(adjPub).status === REQ_STATUS.REJECTED, `status=${reqState(adjPub)?.status}`);
  }

  // =========================================================================
  // I — reject 缺 reason → 400；纯空白 reason → 400
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const noReason = await reject(adjPub, U.bob, T.A, 'team_auditor', undefined);
    check('I reject 缺 reason → 400', noReason.status === 400, `status=${noReason.status}`);
    const blank = await reject(adjPub, U.bob, T.A, 'team_auditor', '   ');
    check('I reject 空白 reason → 400', blank.status === 400, `status=${blank.status}`);
  }

  // =========================================================================
  // J — approve 前并发改 minutes → 409 STALE
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    seed('UPDATE service_records SET minutes=? WHERE public_id=?', 999, sr.srPub); // 并发漂移
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('J 并发改 minutes → 409 STALE', ap.status === 409, `status=${ap.status}`);
  }

  // =========================================================================
  // K — 跨团队 approve → 404（team scope 隔离）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.crossAuditor, T.B, 'team_auditor'); // 团队 B 审批人
    check('K 跨团队 approve → 404', ap.status === 404, `status=${ap.status}`);
  }

  // =========================================================================
  // L — 列表投影无内部 numeric FK
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const lst = await listAdjustments(sr.srPub, U.bob, T.A, 'team_auditor');
    check('L GET adjustments → 200', lst.status === 200, `status=${lst.status}`);
    const banned = scanForBanned(lst.json?.adjustments);
    check('L 投影无内部 numeric FK', banned === null, banned ? `发现 ${banned}` : 'ok');
  }

  // =========================================================================
  // M — 同一 SR 第二个 PENDING 申请 → 409 ADJUSTMENT_PENDING_EXISTS
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r1 = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r1' });
    check('M 第一次请求 → 200', r1.status === 200, `status=${r1.status}`);
    const r2 = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 90, reason: 'r2' });
    check('M 第二个 PENDING 申请 → 409', r2.status === 409, `status=${r2.status}`);
    const r3 = await requestAdjustment(sr.srPub, U.carol, T.A, 'team_admin', { requested_minutes: 90, reason: 'r3' });
    check('M 他人第二个 PENDING 申请 → 409', r3.status === 409, `status=${r3.status}`);
  }

  // =========================================================================
  // N — APPROVED 后再 approve → 409 INVALID_TRANSITION
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await approve(adjPub, U.bob, T.A, 'team_auditor');
    const again = await approve(adjPub, U.carol, T.A, 'team_admin');
    check('N APPROVED 再 approve → 409', again.status === 409, `status=${again.status}`);
  }

  // =========================================================================
  // O — REJECTED 后再 review → 409 INVALID_TRANSITION
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await reject(adjPub, U.bob, T.A, 'team_auditor', 'no');
    const ap = await approve(adjPub, U.carol, T.A, 'team_admin');
    check('O REJECTED 再 approve → 409', ap.status === 409, `status=${ap.status}`);
  }

  // =========================================================================
  // P — 旧直接 adjust 端点已移除 → 404（DIRECT_ADJUST_RUNTIME=REMOVED）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const old = await call('POST', `/api/v2/service-records/${sr.srPub}/adjust`, {
      role: 'team_admin', user: U.alice, team: T.A,
      body: { effective_minutes: 25, reason: 'legacy' },
    });
    check('P 旧 /adjust 端点 → 404（已移除）', old.status === 404, `status=${old.status}`);
  }

  // =========================================================================
  // Q / T — PENDING 期间 SR.source 保持 'auto'，settlement 保持 EFFECTIVE
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const st = srState(sr.srPub);
    check('Q PENDING 期间 source 仍 auto', st.source === 'auto', `source=${st.source}`);
    check('T PENDING 期间 settlement 仍 EFFECTIVE', st.settlement_status === SETTLEMENT.EFFECTIVE, `ss=${st.settlement_status}`);
    check('Q/T PENDING 期间 minutes 不变 (=60)', st.minutes === 60, `minutes=${st.minutes}`);
  }

  // =========================================================================
  // R — approve 后 SR.source = 'correction'
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('R approve 后 source = correction', srState(sr.srPub).source === 'correction', `source=${srState(sr.srPub).source}`);
  }

  // =========================================================================
  // S / Y / Z — approve 写 1 条 audit（operator=申请人 / approved_by=审批人 / trace_id=申请 public_id）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await approve(adjPub, U.bob, T.A, 'team_auditor');
    const auds = auditRows(sr.srPub);
    check('S 恰好 1 条 audit', auds.length === 1, `len=${auds.length}`);
    const a = auds[0];
    check('S audit.operator_id = 申请人(alice)', a.operator_id === U.alice, `op=${a?.operator_id}`);
    check('Y audit.approved_by = 审批人(bob)', a.approved_by === U.bob, `appr=${a?.approved_by}`);
    check('Z audit.trace_id = 申请 public_id', a.trace_id === adjPub, `trace=${a?.trace_id}`);
    check('S audit.old_minutes=60/new_minutes=120', a.old_minutes === 60 && a.new_minutes === 120, `old=${a?.old_minutes} new=${a?.new_minutes}`);
  }

  // =========================================================================
  // U — 申请捕获三快照 == 申请时 SR 当前值
  // =========================================================================
  {
    const min0 = 60;
    const sr = seedEffectiveSR(T.A, { minutes: min0 }); // points=100, ss=1
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const req = reqState(adjPub);
    check('U old_minutes_snapshot == 60', req.old_minutes_snapshot === 60, `snap=${req.old_minutes_snapshot}`);
    check('U old_points_snapshot == 100', req.old_points_awarded_units_snapshot === 100, `snap=${req.old_points_awarded_units_snapshot}`);
    check('U old_settlement_snapshot == 1', req.old_settlement_status_snapshot === 1, `snap=${req.old_settlement_status_snapshot}`);
  }

  // =========================================================================
  // V — approve 前并发改 points → 409 STALE
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    seed('UPDATE service_records SET points_awarded_units=? WHERE public_id=?', 777, sr.srPub);
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('V 并发改 points → 409 STALE', ap.status === 409, `status=${ap.status}`);
  }

  // =========================================================================
  // W — approve 前并发改 settlement_status → 409 STALE
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    seed('UPDATE service_records SET settlement_status=? WHERE public_id=?', SETTLEMENT.REVOKED, sr.srPub);
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('W 并发改 settlement → 409 STALE', ap.status === 409, `status=${ap.status}`);
  }

  // =========================================================================
  // X — STALE 后 request 保持 PENDING、SR 不变、无 audit、无 ledger 增量
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 }); // 已 settlement ledger(:1)
    const ledBefore = ledgerRows(sr.srPub).length;
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    seed('UPDATE service_records SET minutes=? WHERE public_id=?', 999, sr.srPub);
    await approve(adjPub, U.bob, T.A, 'team_auditor'); // → 409 STALE
    check('X request 仍 PENDING', reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
    const st = srState(sr.srPub);
    check('X SR.minutes 不变 (=999，未被原子更新)', st.minutes === 999, `minutes=${st.minutes}`);
    check('X 无 audit 行', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
    check('X ledger 无增量', ledgerRows(sr.srPub).length === ledBefore, `ledger=${ledgerRows(sr.srPub).length}`);
  }

  // =========================================================================
  // AA — reject 不产生 audit 行
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    await reject(adjPub, U.bob, T.A, 'team_auditor', 'no');
    check('AA reject 后无 audit 行', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
  }

  // =========================================================================
  // AB — platform_super_admin 无法绕过 team scope 审批团队修正（无 bypass）
  // 平台角色 scopeTeamId=null → requireActor() 抛 teamScopeRequired → 403；
  // 因此 super_admin 既不能在团队上下文提交也不能审批修正申请，自审 bypass 在更外层即被拒。
  // 该约束与 §7「requester 不得自审（含 platform_super_admin，无 bypass）」一致——
  // 平台角色甚至无法进入团队级修正工作流，故不可能出现自审越权。
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    check('AB 申请已建（alice 提交）', r.status === 200 && !!adjPub, `status=${r.status}`);
    const ap = await approve(adjPub, U.superEve, T.A, 'platform_super_admin');
    check('AB platform_super_admin 审批 → 403（team scope 不可绕过）', ap.status === 403, `status=${ap.status}`);
    check('AB 申请仍 PENDING（未被 super_admin 改动）', reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
  }

  // =========================================================================
  // AC — team_auditor 可审核（approve → 200）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
    check('AC team_auditor approve → 200', ap.status === 200, `status=${ap.status}`);
  }

  // =========================================================================
  // AD — volunteer 既不能 request（403）也不能 review（403）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const req = await requestAdjustment(sr.srPub, U.volley, T.A, 'volunteer', { requested_minutes: 120, reason: 'r' });
    check('AD volunteer 申请 → 403（无 adjust）', req.status === 403, `status=${req.status}`);
    // volunteer 也无法 review 他人已存在的申请
    const r2 = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 90, reason: 'r' });
    const adjPub = r2.json?.adjustment?.public_id;
    const ap = await approve(adjPub, U.volley, T.A, 'volunteer');
    check('AD volunteer 审核 → 403（无 review）', ap.status === 403, `status=${ap.status}`);
  }

  // =========================================================================
  // AE* — 非 EFFECTIVE(1) SR 申请 → 409 ADJUSTMENT_NOT_ALLOWABLE（资格守卫，bonus）
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    seed('UPDATE service_records SET settlement_status=? WHERE public_id=?', SETTLEMENT.REVOKED, sr.srPub);
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    check('AE 非 EFFECTIVE SR 申请 → 409 NOT_ALLOWABLE', r.status === 409, `status=${r.status}`);
  }

  // =========================================================================
  // AF / AG / AH — stale（HTTP 路径）：三快照任一漂移 → 409，且【真实 DB 终态】零业务效果
  //   (A) minutes / (B) points / (C) settlement_status 三个维度分别验证：
  //   audit 不新增 / ledger 不增 / request 仍 PENDING / SR 不变 / source 不变 / revision 不变。
  // =========================================================================
  {
    const dims = [
      { tag: 'AF', label: 'minutes', mutate: (pub) => seed('UPDATE service_records SET minutes=? WHERE public_id=?', 999, pub), expectMin: 999 },
      { tag: 'AG', label: 'points', mutate: (pub) => seed('UPDATE service_records SET points_awarded_units=? WHERE public_id=?', 777, pub), expectMin: 60 },
      { tag: 'AH', label: 'settlement', mutate: (pub) => seed('UPDATE service_records SET settlement_status=? WHERE public_id=?', SETTLEMENT.REVOKED, pub), expectMin: 60 },
    ];
    for (const d of dims) {
      const sr = seedEffectiveSR(T.A, { minutes: 60 }); // points=100, ledger(:1)
      const ledBefore = ledgerRows(sr.srPub).length;
      const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
      const adjPub = r.json?.adjustment?.public_id;
      d.mutate(sr.srPub); // 并发漂移
      const ap = await approve(adjPub, U.bob, T.A, 'team_auditor');
      check(`${d.tag} ${d.label} stale → approve 409`, ap.status === 409, `status=${ap.status}`);
      check(`${d.tag} request 仍 PENDING`, reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
      check(`${d.tag} audit 不新增 (=0)`, auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
      check(`${d.tag} ledger 不增 (=${ledBefore})`, ledgerRows(sr.srPub).length === ledBefore, `ledger=${ledgerRows(sr.srPub).length}`);
      const st = srState(sr.srPub);
      check(`${d.tag} SR.minutes 未被原子更新 (=${d.expectMin})`, st.minutes === d.expectMin, `minutes=${st.minutes}`);
      check(`${d.tag} SR.source 仍 auto`, st.source === 'auto', `source=${st.source}`);
      check(`${d.tag} SR.points_revision 未变 (=1)`, st.points_revision === 1, `rev=${st.points_revision}`);
    }
  }

  // =========================================================================
  // AI — 故意制造 optimistic SR UPDATE = 0（绕过 service pre-check，直调 repo 原语）：
  //   模拟 pre-check 与 db.batch 之间的 TOCTOU（单线程 HTTP 不可注入并发写者）。
  //   证明：D1 batch 内【不存在 partial commit】——audit / SR / ledger / request 全不落地。
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 }); // points=100, ledger(:1)
    const ledBefore = ledgerRows(sr.srPub).length;
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const req0 = reqState(adjPub);
    const srBefore = srState(sr.srPub);
    // 并发写者在 batch 之前改写了 SR（minutes 漂移），使 old 快照谓词失效（revision 不变）
    seed('UPDATE service_records SET minutes=? WHERE public_id=?', 999, sr.srPub);
    const repo = makeRepo(U.bob, T.A, 'team_auditor');
    const changes = await repo.approveAdjustmentAtomically({
      adjustmentRequestId: req0.id,
      serviceRecordPublicId: sr.srPub,
      teamId: T.A,
      requesterId: req0.requester_id,
      reviewerId: U.bob,
      oldMinutesSnapshot: req0.old_minutes_snapshot,
      oldPointsAwardedUnitsSnapshot: req0.old_points_awarded_units_snapshot,
      oldSettlementStatusSnapshot: req0.old_settlement_status_snapshot,
      newMinutes: 120,
      newPoints: 200,
      sessionId: srBefore.session_id,
      reason: req0.reason,
      traceId: req0.public_id,
      now: 1700009999,
    });
    check('AI optimistic SR UPDATE = 0 → changes=0', changes === 0, `changes=${changes}`);
    check('AI 无 partial commit：audit 行数不变 (=0)', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
    check('AI 无 partial commit：ledger 不增', ledgerRows(sr.srPub).length === ledBefore, `ledger=${ledgerRows(sr.srPub).length}`);
    check('AI 无 partial commit：request 仍 PENDING', reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
    check('AI 无 partial commit：SR.minutes 仍 999', srState(sr.srPub).minutes === 999, `minutes=${srState(sr.srPub).minutes}`);
    check('AI 无 partial commit：SR.source 仍 auto', srState(sr.srPub).source === 'auto', `source=${srState(sr.srPub).source}`);
  }

  // =========================================================================
  // AJ — 【本次修复的原子性阻塞点】approve × reject 并发：
  //   request 在本 approve 的 batch 之前被并发置为 REJECTED（pre-check 已通过）。
  //   修复前：old 快照仍成立 → audit+SR+ledger 落地，但 request 不翻 APPROVED
  //           → “请求已拒、时长却被改、API 返回 200”的部分提交。
  //   修复后：SR/audit 语句增加 request status=0 门控 → 全语句 0 行 → 零业务效果。
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 }); // points=100, ledger(:1)
    const ledBefore = ledgerRows(sr.srPub).length;
    const r = await requestAdjustment(sr.srPub, U.alice, T.A, 'team_admin', { requested_minutes: 120, reason: 'r' });
    const adjPub = r.json?.adjustment?.public_id;
    const req0 = reqState(adjPub);
    const srBefore = srState(sr.srPub);
    // 并发：另一审批人已把 request 置为 REJECTED（模拟 pre-check 与 batch 之间的窗口）
    seed(`UPDATE service_record_adjustment_requests
            SET status=2, reviewer_id=?, reviewed_at=1, review_reason=?, updated_at=1
          WHERE public_id=?`,
      U.carol, 'concurrent reject', adjPub);
    const repo = makeRepo(U.bob, T.A, 'team_auditor');
    const changes = await repo.approveAdjustmentAtomically({
      adjustmentRequestId: req0.id,
      serviceRecordPublicId: sr.srPub,
      teamId: T.A,
      requesterId: req0.requester_id,
      reviewerId: U.bob,
      oldMinutesSnapshot: req0.old_minutes_snapshot,
      oldPointsAwardedUnitsSnapshot: req0.old_points_awarded_units_snapshot,
      oldSettlementStatusSnapshot: req0.old_settlement_status_snapshot,
      newMinutes: 120,
      newPoints: 200,
      sessionId: srBefore.session_id,
      reason: req0.reason,
      traceId: req0.public_id,
      now: 1700009999,
    });
    check('AJ 并发 REJECTED → approve changes=0', changes === 0, `changes=${changes}`);
    check('AJ 无 partial commit：SR.minutes 不变 (=60)', srState(sr.srPub).minutes === 60, `minutes=${srState(sr.srPub).minutes}`);
    check('AJ 无 partial commit：SR.points 不变 (=100)', srState(sr.srPub).points_awarded_units === 100, `points=${srState(sr.srPub).points_awarded_units}`);
    check('AJ 无 partial commit：SR.source 仍 auto', srState(sr.srPub).source === 'auto', `source=${srState(sr.srPub).source}`);
    check('AJ 无 partial commit：points_revision 未变 (=1)', srState(sr.srPub).points_revision === 1, `rev=${srState(sr.srPub).points_revision}`);
    check('AJ 无 partial commit：audit 行数不变 (=0)', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
    check('AJ 无 partial commit：ledger 不增', ledgerRows(sr.srPub).length === ledBefore, `ledger=${ledgerRows(sr.srPub).length}`);
    check('AJ request 仍 REJECTED（未被改写）', reqState(adjPub).status === REQ_STATUS.REJECTED, `status=${reqState(adjPub)?.status}`);
  }

  // =========================================================================
  // AK — super admin 自审不可达性（fixture 直接 seed requester_id = platform_super_admin 用户）
  //   真实 auth：平台角色 scopeTeamId=null → requireActor() 在【更外层】即抛 teamScopeRequired(403)，
  //   根本进不到自审判定。故本用例证明：requester_id == reviewer_id 的 approve 被拒，
  //   且 request/SR/audit 零副作用 → SELF_APPROVAL_BYPASS 仍不可达（未改任何 auth/RBAC）。
  // =========================================================================
  {
    const sr = seedEffectiveSR(T.A, { minutes: 60 });
    const adjPub = M.generateUlid(); // 真实 ULID（Crockford，排除 I/L/O/U）
    seed(`INSERT INTO service_record_adjustment_requests
            (public_id, service_record_public_id, team_id, requester_id,
             old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
             requested_minutes, reason, status, requested_at, trace_id, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      adjPub, sr.srPub, T.A, U.superEve, 60, 100, 1, 120, 'super admin self request',
      1700000000, M.generateUlid(), 1700000000, 1700000000);
    const ap = await approve(adjPub, U.superEve, T.A, 'platform_super_admin');
    check('AK super_admin 自审（requester==reviewer）→ 403', ap.status === 403, `status=${ap.status}`);
    check('AK request 仍 PENDING', reqState(adjPub).status === REQ_STATUS.PENDING, `status=${reqState(adjPub)?.status}`);
    check('AK reviewer_id 仍 NULL（未被写为 requester 自身）', reqState(adjPub).reviewer_id == null, `reviewer=${reqState(adjPub)?.reviewer_id}`);
    check('AK SR 零副作用（minutes=60/points=100/source=auto）',
      srState(sr.srPub).minutes === 60 && srState(sr.srPub).points_awarded_units === 100 && srState(sr.srPub).source === 'auto',
      `min=${srState(sr.srPub).minutes} pts=${srState(sr.srPub).points_awarded_units} src=${srState(sr.srPub).source}`);
    check('AK 无 audit 行', auditRows(sr.srPub).length === 0, `audits=${auditRows(sr.srPub).length}`);
  }

  // =========================================================================
  // 汇总
  // =========================================================================
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== P35-C2 汇总: ${passed}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} — ${f.detail}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
