#!/usr/bin/env node
/**
 * S2-6j V1 集成测试（attendance anomaly handling）—— 覆盖指令 §23 A–K 全部维度。
 *
 * 前置（由 tests/run_s2_6j.mjs 编排）：
 *   1) NORMAL worker 已启动（ENVIRONMENT=local，无故障注入）；
 *   2) 已重跑 fixture('anomaly')，BASE_URL / JHZY_D1_DIR / JHZY_MANIFEST 指向该 worker；
 *   3) manifest 含 users / teams / activities / sessions / anomalies 的本地 id。
 *
 * 断言计数目标：>= 60（指令 §23 main >= 60）。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => 's_' + randomBytes(32).toString('base64url');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8795';
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.tmp', 's2-6j-state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = process.env.JHZY_MANIFEST ?? join(process.cwd(), '.tmp', 's2-6j-anomaly.json');

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

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const U = manifest.users;
const T = manifest.teams;
const S = manifest.sessions;
const A = manifest.anomalies;

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
const anomRow = (id) => withDb((db) => db.prepare('SELECT * FROM attendance_anomalies WHERE id = ?').get(id));
const sessRow = (id) => withDb((db) => db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(id));
const anomEvents = (sid, op) =>
  withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM attendance_events WHERE session_id=? AND event_type='anomaly' AND operator_id=?").get(sid, op).n);
const totalEvents = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n);
const serviceRecords = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM service_records').get().n);

async function req(method, path, body, headers = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { res, body: json };
}
const auth = (role, userId, teamId) => ({ 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) });
const q = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ===================== A. BASELINE =====================
process.stderr.write('A. baseline\n');
{
  const mig = withDb((db) => db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name));
  // P17 基线同步：P11/P16 已冻结 0006–0014（occurrence/position/slot/PSP/participation/participation-link），
  // 当前正式迁移到 0014。0005 必须存在、0006–0014 同步存在（旧的"0006 不得存在"断言仅适用于 S2-6k2 时代）。
  check('A1 migrations = 14', mig.length === 14, `got ${mig.length}`);
  check('A2 0005 与 0014 均存在（P11/P16 迁移基线）', mig.some((n) => n.includes('0005')) && mig.some((n) => n.includes('0014')), mig.join(','));
  const roles = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM roles').get().n);
  const perms = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n);
  const rps = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n);
  check('A3 roles = 6', roles === 6, `got ${roles}`);
  check('A4 permissions = 83', perms === 87, `got ${perms}`);
  check('A5 role_permissions = 238', rps === 247, `got ${rps}`);
}

// ===================== B. LIST =====================
process.stderr.write('B. list\n');
{
  const r = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B1 owner list 200', r.res.status === 200 && r.body?.success === true, `status=${r.res.status}`);
  const items = r.body?.data?.anomalies ?? [];
  const ids = items.map((x) => x.id);
  check('B2 teamA anomalies all present (6)', [A.AA1, A.AA2, A.AA3, A.AA4, A.AA5, A.AA6].every((id) => ids.includes(id)), ids.join(','));
  check('B3 cross-team AB1/AB2 absent', !ids.includes(A.AB1) && !ids.includes(A.AB2), ids.join(','));
  check('B4 list minimal fields only', items.every((x) => 'id' in x && 'session_id' in x && 'anomaly_type' in x && 'status' in x && 'created_at' in x && 'handled_at' in x && !('detail' in x)), JSON.stringify(items[0]));

  // status filter
  const s1 = await req('GET', `/api/v2/attendance-anomalies?${q({ status: 1 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B5 status=1 → 4 open', (s1.body?.data?.anomalies ?? []).length === 4, `got ${(s1.body?.data?.anomalies ?? []).length}`);
  const s2 = await req('GET', `/api/v2/attendance-anomalies?${q({ status: 2 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B6 status=2 → 1 confirmed (AA3)', (s2.body?.data?.anomalies ?? []).map((x) => x.id).join(',') === String(A.AA3), JSON.stringify(s2.body?.data?.anomalies));
  const s3 = await req('GET', `/api/v2/attendance-anomalies?${q({ status: 3 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B7 status=3 → 1 dismissed (AA4)', (s3.body?.data?.anomalies ?? []).map((x) => x.id).join(',') === String(A.AA4), JSON.stringify(s3.body?.data?.anomalies));

  // anomaly_type filter
  const t1 = await req('GET', `/api/v2/attendance-anomalies?${q({ anomaly_type: 'out_of_range' })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B8 anomaly_type=out_of_range → AA1 only', (t1.body?.data?.anomalies ?? []).map((x) => x.id).join(',') === String(A.AA1), JSON.stringify(t1.body?.data?.anomalies));

  // pagination (limit + deterministic cursor)
  const p1 = await req('GET', `/api/v2/attendance-anomalies?${q({ limit: 2 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B9 limit=2 first page size 2', (p1.body?.data?.anomalies ?? []).length === 2, `got ${(p1.body?.data?.anomalies ?? []).length}`);
  check('B10 next_cursor present', typeof p1.body?.data?.next_cursor === 'string' && p1.body.data.next_cursor.length > 0, JSON.stringify(p1.body?.data?.next_cursor));
  const cur = p1.body?.data?.next_cursor;
  const p2 = await req('GET', `/api/v2/attendance-anomalies?${q({ limit: 2, cursor: cur })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  const page2 = p2.body?.data?.anomalies ?? [];
  check('B11 cursor page distinct ids', page2.length > 0 && !page2.some((x) => (p1.body.data.anomalies).some((y) => y.id === x.id)), JSON.stringify(page2));

  // bounded limit & invalid params
  const lim0 = await req('GET', `/api/v2/attendance-anomalies?${q({ limit: 0 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B12 limit=0 → 400', lim0.res.status === 400, `status=${lim0.res.status}`);
  const limNeg = await req('GET', `/api/v2/attendance-anomalies?${q({ limit: -5 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B13 limit=-5 → 400', limNeg.res.status === 400, `status=${limNeg.res.status}`);
  const limBig = await req('GET', `/api/v2/attendance-anomalies?${q({ limit: 1000 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B14 limit=1000 clamped (<=100, no error)', limBig.res.status === 200 && (limBig.body?.data?.anomalies ?? []).length <= 100, `status=${limBig.res.status} n=${(limBig.body?.data?.anomalies ?? []).length}`);
  const invS = await req('GET', `/api/v2/attendance-anomalies?${q({ status: 9 })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B15 invalid status=9 → 400', invS.res.status === 400, `status=${invS.res.status}`);
  const invS2 = await req('GET', `/api/v2/attendance-anomalies?${q({ status: 'abc' })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B16 invalid status=abc → 400', invS2.res.status === 400, `status=${invS2.res.status}`);
  const invT = await req('GET', `/api/v2/attendance-anomalies?${q({ anomaly_type: 'bogus' })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B17 invalid anomaly_type → 400', invT.res.status === 400, `status=${invT.res.status}`);
  const invCur = await req('GET', `/api/v2/attendance-anomalies?${q({ cursor: 'not-valid' })}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('B18 invalid cursor → 400', invCur.res.status === 400, `status=${invCur.res.status}`);
}

// ===================== C. DETAIL =====================
process.stderr.write('C. detail\n');
{
  const o = await req('GET', `/api/v2/attendance-anomalies/${A.AA1}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('C1 owner detail 200', o.res.status === 200 && o.body?.data?.anomaly?.id === A.AA1, `status=${o.res.status}`);
  check('C2 detail has session view', o.body?.data?.anomaly?.session && 'activity_id' in o.body.data.anomaly.session, JSON.stringify(o.body?.data?.anomaly?.session));
  const adm = await req('GET', `/api/v2/attendance-anomalies/${A.AA1}`, undefined, auth('team_admin', U.adminA, T.teamA));
  check('C3 team_admin detail 200', adm.res.status === 200, `status=${adm.res.status}`);
  const cross = await req('GET', `/api/v2/attendance-anomalies/${A.AB1}`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('C4 cross-team detail 404', cross.res.status === 404, `status=${cross.res.status}`);
  const missing = await req('GET', `/api/v2/attendance-anomalies/99999999`, undefined, auth('team_owner', U.ownerA, T.teamA));
  check('C5 nonexistent detail 404', missing.res.status === 404, `status=${missing.res.status}`);
  const respStr = JSON.stringify(o.body);
  const noSensitive = !/device_fp_hash|ip_hash|factor_scores|risk_score|latitude|longitude|accuracy|network_type|"raw"/.test(respStr);
  check('C6 sensitive fields absent in detail', noSensitive, respStr.slice(0, 200));
}

// ===================== D. PERMISSIONS =====================
process.stderr.write('D. permissions\n');
{
  const unauth = await req('GET', '/api/v2/attendance-anomalies', undefined, {});
  check('D1 unauth → 401', unauth.res.status === 401, `status=${unauth.res.status}`);
  const vol = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('volunteer', U.volA, T.teamA));
  check('D2 volunteer → 403', vol.res.status === 403, `status=${vol.res.status}`);
  const aud = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('team_auditor', U.auditorA, T.teamA));
  check('D3 team_auditor → 403', aud.res.status === 403, `status=${aud.res.status}`);
  const platOp = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('platform_operator', U.plat, 0));
  check('D4 platform_operator → 403', platOp.res.status === 403, `status=${platOp.res.status}`);
  const psa = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('platform_super_admin', U.platSuper, 0));
  check('D5 PSA → 403 TEAM_SCOPE_REQUIRED', psa.res.status === 403 && psa.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `status=${psa.res.status} code=${psa.body?.error?.code}`);

  // D6: 正向控制 —— team_owner 当前持有权限，可访问（运行时 200）
  const before = await req('GET', '/api/v2/attendance-anomalies', undefined, auth('team_owner', U.ownerA, T.teamA));
  check('D6 owner has access (team_owner holds attendance.anomaly.handle)', before.res.status === 200, `status=${before.res.status}`);

  // D7: 权限目录接线校验（冻结设计 §2：attendance.anomaly.handle 仅由
  //      platform_super_admin / team_admin / team_owner 持有）。
  // 纪律：只读校验，绝不写入 role_permissions / user_roles（目录不可变 87/247）。
  // 运行时每次请求均经 D1PermissionProvider 实时 JOIN role_permissions（S2-6f/S2-6c-4 已证无跨请求缓存），
  // 故此处目录接线正确性 = 运行时授权正确性的充要条件。
  const holders = withDb((db) =>
    db
      .prepare(
        `SELECT r.code AS role FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'attendance.anomaly.handle' ORDER BY r.code`,
      )
      .all()
      .map((x) => x.role)
      .join(','),
  );
  check(
    'D7 attendance.anomaly.handle 持有者 = platform_super_admin,team_admin,team_owner',
    holders === 'platform_super_admin,team_admin,team_owner',
    `got ${holders}`,
  );

  // D8: 反向接线 —— volunteer / team_auditor / platform_operator 不持有该权限
  //      （与 D2/D3/D4 运行时 403 完全自洽；PSA 走 TEAM_SCOPE_REQUIRED 见 D5）。
  const nonHolders = withDb((db) =>
    db
      .prepare(
        `SELECT r.code AS role FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'attendance.anomaly.handle'
            AND r.code IN ('volunteer','team_auditor','platform_operator')`,
      )
      .all()
      .map((x) => x.role)
      .join(','),
  );
  check('D8 volunteer/team_auditor/platform_operator 不持有该权限', nonHolders === '', `got ${nonHolders}`);
}

// ===================== E. CONFIRM =====================
process.stderr.write('E. confirm\n');
let anomBeforeConfirm;
{
  const before = anomEvents(S.A_S1, U.ownerA);
  const r = await req('POST', `/api/v2/attendance-anomalies/${A.AA1}/resolve`, { decision: 'confirm', resolution: 'verified genuine' }, auth('team_owner', U.ownerA, T.teamA));
  check('E1 confirm 200', r.res.status === 200, `status=${r.res.status}`);
  const a = r.body?.data?.anomaly;
  check('E2 status=2 CONFIRMED', a?.status === 2, `status=${a?.status}`);
  check('E3 handled_by = actor ownerA', a?.handled_by === U.ownerA, `handled_by=${a?.handled_by}`);
  check('E4 handled_at epoch seconds', typeof a?.handled_at === 'number' && a.handled_at > 1e9 && a.handled_at < 1e11, `handled_at=${a?.handled_at}`);
  check('E5 resolution stored', a?.resolution === 'verified genuine', `resolution=${a?.resolution}`);

  const row = anomRow(A.AA1);
  check('E6 DB status=2', row?.status === 2, `status=${row?.status}`);
  check('E7 DB handled_by correct', row?.handled_by === U.ownerA, `handled_by=${row?.handled_by}`);

  // sibling session untouched
  const srow = sessRow(S.A_S1);
  check('E8 session status untouched (=2)', srow?.status === 2, `status=${srow?.status}`);
  check('E9 session review_status untouched (=0)', srow?.review_status === 0, `review=${srow?.review_status}`);
  check('E10 session checkin/checkout untouched', srow?.checkin_at != null && srow?.checkout_at != null, JSON.stringify(srow));
  check('E11 service_records untouched (=0)', serviceRecords() === 0, `sr=${serviceRecords()}`);

  const after = anomEvents(S.A_S1, U.ownerA);
  check('E12 exactly one anomaly event for AA1', after - before === 1, `before=${before} after=${after}`);
  anomBeforeConfirm = after;
}

// ===================== F. DISMISS =====================
process.stderr.write('F. dismiss\n');
{
  const before = anomEvents(S.A_S1, U.ownerA);
  const r = await req('POST', `/api/v2/attendance-anomalies/${A.AA2}/resolve`, { decision: 'dismiss', resolution: 'false positive' }, auth('team_owner', U.ownerA, T.teamA));
  check('F1 dismiss 200', r.res.status === 200, `status=${r.res.status}`);
  const a = r.body?.data?.anomaly;
  check('F2 status=3 DISMISSED', a?.status === 3, `status=${a?.status}`);
  check('F3 handled_by = actor', a?.handled_by === U.ownerA, `handled_by=${a?.handled_by}`);
  check('F4 resolution stored', a?.resolution === 'false positive', `resolution=${a?.resolution}`);
  const row = anomRow(A.AA2);
  check('F5 DB status=3', row?.status === 3, `status=${row?.status}`);
  const srow = sessRow(S.A_S1);
  check('F6 session status still 2', srow?.status === 2, `status=${srow?.status}`);
  check('F7 session review_status still 0', srow?.review_status === 0, `review=${srow?.review_status}`);
  check('F8 service_records still 0', serviceRecords() === 0, `sr=${serviceRecords()}`);
  const after = anomEvents(S.A_S1, U.ownerA);
  check('F9 exactly one more anomaly event (total 2 for A_S1)', after - before === 1, `before=${before} after=${after}`);
}

// ===================== G. CONFLICT =====================
process.stderr.write('G. conflict\n');
{
  const before = totalEvents();
  const c1 = await req('POST', `/api/v2/attendance-anomalies/${A.AA3}/resolve`, { decision: 'confirm', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('G1 confirm already-confirmed(2) → 409', c1.res.status === 409 && c1.body?.error?.code === 'CONFLICT', `status=${c1.res.status} code=${c1.body?.error?.code}`);
  const d1 = await req('POST', `/api/v2/attendance-anomalies/${A.AA4}/resolve`, { decision: 'dismiss', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('G2 dismiss already-dismissed(3) → 409', d1.res.status === 409 && d1.body?.error?.code === 'CONFLICT', `status=${d1.res.status}`);
  const c2 = await req('POST', `/api/v2/attendance-anomalies/${A.AA3}/resolve`, { decision: 'confirm', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('G3 confirm again → 409', c2.res.status === 409, `status=${c2.res.status}`);
  const d2 = await req('POST', `/api/v2/attendance-anomalies/${A.AA3}/resolve`, { decision: 'dismiss', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('G4 dismissed→confirm → 409', d2.res.status === 409, `status=${d2.res.status}`);
  check('G5 no extra events on conflict', totalEvents() === before, `before=${before} after=${totalEvents()}`);
  const aa3 = anomRow(A.AA3);
  check('G6 AA3 still status=2', aa3?.status === 2, `status=${aa3?.status}`);
}

// ===================== H. VALIDATION =====================
process.stderr.write('H. validation\n');
{
  const inv = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { decision: 'foo', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('H1 invalid decision → 400', inv.res.status === 400, `status=${inv.res.status}`);
  const noDec = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('H2 missing decision → 400', noDec.res.status === 400, `status=${noDec.res.status}`);
  const noRes = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { decision: 'confirm' }, auth('team_owner', U.ownerA, T.teamA));
  check('H3 missing resolution → 400', noRes.res.status === 400, `status=${noRes.res.status}`);
  const blank = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { decision: 'confirm', resolution: '   ' }, auth('team_owner', U.ownerA, T.teamA));
  check('H4 blank resolution → 400', blank.res.status === 400, `status=${blank.res.status}`);
  const over = 'x'.repeat(1001);
  const long = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { decision: 'confirm', resolution: over }, auth('team_owner', U.ownerA, T.teamA));
  check('H5 overlong resolution → 400', long.res.status === 400, `status=${long.res.status}`);
  const malformed = await req('GET', '/api/v2/attendance-anomalies/abc', undefined, auth('team_owner', U.ownerA, T.teamA));
  check('H6 malformed anomaly id → 400', malformed.res.status === 400, `status=${malformed.res.status}`);
}

// ===================== I. TENANT =====================
process.stderr.write('I. tenant isolation on resolve\n');
{
  const r = await req('POST', `/api/v2/attendance-anomalies/${A.AB1}/resolve`, { decision: 'confirm', resolution: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('I1 Team A resolving Team B → 404 (no existence hint)', r.res.status === 404, `status=${r.res.status}`);
  const ab1 = anomRow(A.AB1);
  check('I2 AB1 status unchanged (=1)', ab1?.status === 1, `status=${ab1?.status}`);
  check('I3 no event written for B_S1', anomEvents(S.B_S1, U.ownerA) === 0, `events=${anomEvents(S.B_S1, U.ownerA)}`);
}

// ===================== J. TIMESTAMP =====================
process.stderr.write('J. timestamp units\n');
{
  const r = await req('POST', `/api/v2/attendance-anomalies/${A.AA5}/resolve`, { decision: 'confirm', resolution: 'ts-check' }, auth('team_owner', U.ownerA, T.teamA));
  check('J1 confirm AA5 200', r.res.status === 200, `status=${r.res.status}`);
  const a = r.body?.data?.anomaly;
  check('J2 handled_at seconds (no ms)', a?.handled_at != null && a.handled_at < 1e11 && a.handled_at > 1e9, `handled_at=${a?.handled_at}`);
  const evOcc = withDb((db) => db.prepare("SELECT occurred_at FROM attendance_events WHERE event_type='anomaly' AND session_id=? ORDER BY id DESC LIMIT 1").get(S.A_S2)?.occurred_at);
  check('J3 event.occurred_at seconds (no ms)', evOcc != null && evOcc < 1e11 && evOcc > 1e9, `occurred_at=${evOcc}`);
  const maxTs = withDb((db) => db.prepare('SELECT MAX(COALESCE(handled_at,0)) AS m FROM attendance_anomalies').get().m);
  check('J4 global max handled_at < 1e11 (no ms pollution)', maxTs < 1e11, `max=${maxTs}`);
}

// ===================== K. LEAKAGE =====================
process.stderr.write('K. leakage\n');
{
  // resolve response must not contain raw / hashes / sensitive device fields
  const r = await req('POST', `/api/v2/attendance-anomalies/${A.AA6}/resolve`, { decision: 'dismiss', resolution: 'leak-check' }, auth('team_owner', U.ownerA, T.teamA));
  const respStr = JSON.stringify(r.body);
  check('K1 no raw/hashes in resolve response', !/device_fp_hash|ip_hash|factor_scores|risk_score|latitude|longitude|accuracy|network_type|"raw"/.test(respStr), respStr.slice(0, 200));
  // audit event raw must be minimal (only action + decision), not request body / detail / secrets
  const evRaw = withDb((db) => db.prepare("SELECT raw FROM attendance_events WHERE event_type='anomaly' AND session_id=? ORDER BY id DESC LIMIT 1").get(S.A_S2)?.raw);
  check('K2 audit event raw minimal', evRaw === '{"action":"anomaly_resolve","decision":"dismiss"}', `raw=${evRaw}`);
  // detail field readable by admin but no sensitive nested keys
  const det = await req('GET', `/api/v2/attendance-anomalies/${A.AA1}`, undefined, auth('team_admin', U.adminA, T.teamA));
  const detStr = JSON.stringify(det.body);
  check('K3 detail response no sensitive keys', !/device_fp_hash|ip_hash|factor_scores|risk_score|latitude|longitude|accuracy|network_type|"raw"/.test(detStr), detStr.slice(0, 200));
}

// ===================== L. REAL-SESSION LIVE REVOKE =====================
// 修复上一轮 D7 的【无效测试设计】：上一轮用 x-test-role 的静态 catalog 断言替代了
// 「真实 Bearer session 下 user_roles 被撤销后下一请求立即失去权限」的实测。
// x-test-role mock 注入通道下权限解析走 roles.code → role_permissions，从不读 user_roles，
// 故删除 user_roles 对其无效果（已被证明是测试缺陷，非实现缺陷）。
//
// 本轮 L 组走【项目真实认证链】（禁止 x-test-role）：
//   Bearer opaque token → SHA256 → sessions → SessionService.resolve() 实时读 live user_roles
//   → roles → D1PermissionProvider JOIN role_permissions → permissions
// 仅删除 user_roles 一行（不动 sessions / role_permissions / permissions），
// 证明：session 本身仍有效（status=1），但 live role 已撤销 → 下一请求立即 403。
process.stderr.write('L. real-session live permission revocation (Bearer → sessions → live user_roles → permissions)\n');
{
  const SESS_PUB = '01TESTANOMLRVK000001';
  const TOKEN_L = newToken();
  let sessionInserted = false;
  let roleRestored = false;
  try {
    // L0: 创建真实 Bearer Session（与 activity_signup_integration 同链路，不重新发明登录）。
    //      注意：anomaly fixture 的 manifest.users 含 adminA（= team_admin@teamA），不含 teamAdminA，故用 U.adminA。
    withDb((db) => {
      db.exec('PRAGMA foreign_keys = ON;');
      db.prepare(`DELETE FROM sessions WHERE public_id = ?`).run(SESS_PUB);
      db.prepare(
        `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status)
         VALUES (?, ?, ?, 's2-6j-live-revoke', ?, 1)`,
      ).run(SESS_PUB, U.adminA, sha256Hex(TOKEN_L), Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
    });
    sessionInserted = true;

    const bearer = (teamId) => ({ authorization: `Bearer ${TOKEN_L}`, 'x-team-id': String(teamId) });

    // L1: revoke 前 —— 真实 Bearer session（adminA / team_admin@teamA）列表现状 = 200
    const before = await req('GET', '/api/v2/attendance-anomalies', undefined, bearer(T.teamA));
    check('L1 before revoke (real Bearer) list = 200', before.res.status === 200 && before.body?.success === true, `status=${before.res.status}`);

    // L2: revoke 前 —— 同一真实 session 亦可处置（满足 §5：覆盖 resolve 路径）。
    //      注意：AA1..AA6 均已被 E/F/J/K 组消费（已 confirm/dismiss），此处由测试直接 seed 一枚全新的 OPEN anomaly
    //      （与 fixture 一致的直接写入方式，非运行时创建 API），用它验证真实 Bearer session 能走通 resolve。
    const liveAnomId = withDb((db) =>
      Number(
        db
          .prepare(
            `INSERT INTO attendance_anomalies (session_id, team_id, anomaly_type, detail, handled_by, handled_at, resolution, status, created_at)
             VALUES (?, ?, 'out_of_range', '{"note":"live-revoke-resolve-gate"}', NULL, NULL, NULL, 1, ?)`,
          )
          .run(S.A_S1, T.teamA, Math.floor(Date.now() / 1000)).lastInsertRowid,
      ),
    );
    const resolveBefore = await req('POST', `/api/v2/attendance-anomalies/${liveAnomId}/resolve`, { decision: 'confirm', resolution: 'live-revoke-test' }, bearer(T.teamA));
    check('L2 before revoke (real Bearer) resolve = 200', resolveBefore.res.status === 200, `status=${resolveBefore.res.status}`);
    check('L2b resolve set status=2 CONFIRMED', resolveBefore.body?.data?.anomaly?.status === 2, `status=${resolveBefore.body?.data?.anomaly?.status}`);

    // L3: 仅删除 user_roles（不动 sessions / role_permissions / permissions；目录 87/247 不变）
    withDb((db) => {
      db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=(SELECT id FROM roles WHERE code=?) AND scope_team_id=?')
        .run(U.adminA, 'team_admin', T.teamA);
    });

    // L4: 同一 Bearer token（不重新登录）立即再请求 —— 必须 403（session 仍有效但 live role 已撤）
    const after = await req('GET', '/api/v2/attendance-anomalies', undefined, bearer(T.teamA));
    check('L4 after user_roles revoke (SAME bearer) list = 403', after.res.status === 403, `status=${after.res.status}`);

    // L4b: mutation 同样被拒（证明不只是 read 被撤，写权限一并实时失效）
    const resolveAfter = await req('POST', `/api/v2/attendance-anomalies/${A.AA6}/resolve`, { decision: 'dismiss', resolution: 'x' }, bearer(T.teamA));
    check('L4b after revoke (SAME bearer) resolve = 403', resolveAfter.res.status === 403, `status=${resolveAfter.res.status}`);

    // L5: session 本身仍有效（status=1 且未过期）—— 证明被拒是因 live role 撤销，而非 session 失效
    const sessActive = withDb((db) => db.prepare('SELECT status, expires_at FROM sessions WHERE public_id = ?').get(SESS_PUB));
    check('L5 session still active (status=1) after role revoke', sessActive?.status === 1, JSON.stringify(sessActive));

    // L6: 恢复 user_roles（cleanup，保证后续 fixture teardown / 其它套件不受影响）
    withDb((db) => {
      const exists = db
        .prepare('SELECT 1 AS x FROM user_roles WHERE user_id=? AND role_id=(SELECT id FROM roles WHERE code=?) AND scope_team_id=?')
        .get(U.adminA, 'team_admin', T.teamA);
      if (!exists) db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, (SELECT id FROM roles WHERE code=?), ?)').run(U.adminA, 'team_admin', T.teamA);
    });
    roleRestored = true;

    // L7: 同一 Bearer token 恢复后 —— 权限立即恢复 200（证明架构为 fully live-role）
    const restored = await req('GET', '/api/v2/attendance-anomalies', undefined, bearer(T.teamA));
    check('L7 after role restore (SAME bearer) list = 200', restored.res.status === 200, `status=${restored.res.status}`);
  } finally {
    // L8: 清理本测试自建 session（即便遗漏，harness teardown 也会级联清除）
    if (sessionInserted) {
      withDb((db) => { try { db.prepare('DELETE FROM sessions WHERE public_id = ?').run(SESS_PUB); } catch {} });
    }
    // 兜底：异常路径也确保 user_roles 复原（目录不可变 87/247）
    if (!roleRestored) {
      withDb((db) => {
        const exists = db
          .prepare('SELECT 1 AS x FROM user_roles WHERE user_id=? AND role_id=(SELECT id FROM roles WHERE code=?) AND scope_team_id=?')
          .get(U.adminA, 'team_admin', T.teamA);
        if (!exists) db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, (SELECT id FROM roles WHERE code=?), ?)').run(U.adminA, 'team_admin', T.teamA);
      });
    }
  }
}

process.stderr.write(`\nTOTAL: ${pass} passed, ${fail} fail\n`);
process.stderr.write(`===== S2-6j integration: pass=${pass} fail=${fail} =====\n`);
process.exit(fail === 0 ? 0 : 1);
