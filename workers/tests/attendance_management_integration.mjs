#!/usr/bin/env node
/**
 * S2-6i Attendance Review + Force Checkout 集成测试（A–E / M 组，≥55 项）。
 *
 * 前置（由 tests/run_s2_6i.mjs 编排）：
 *   1) wrangler dev --local --persist-to .tmp/s2-6i-state 已启动（BASE_URL 见下，默认 :8799）；
 *   2) tests/fixture.mjs attendance-management 已写入 16 行 attendance_sessions + manifest。
 *
 * 通过【真实 Worker 运行时】验证授权闭环：
 *   Permission(D1 87/247) → Tenant Scope → Repository team_id WHERE → Atomic batch(UPDATE+event) → Audit
 *
 * 冻结纪律（用户 §0–§23）：
 * - 跨团队 sessionId → 404（不泄露存在性，无元数据泄漏）；无权限 → 403 FORBIDDEN；
 *   平台角色无 team 上下文 → 403 TEAM_SCOPE_REQUIRED（已知 architecture gap，不在本阶段修复，禁止 bypass）；
 *   业务状态冲突 → 409（reason 稳定 token）；未认证 → 401；参数非法 → 400。
 * - Review 只改 review_status；Force 只改 status/checkout_at；二者均写 audit event（operator_id=执行管理员）；
 *   禁止产生孤儿事件、禁止越权改他人记录、禁止改其他字段。
 * - §10 原子性（db.batch 真实回滚）由 tests/attendance_management_atomicity.mjs（L 组，fault worker）单独证明。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8799';
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.tmp', 's2-6i-state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = process.env.JHZY_MANIFEST ?? join(process.cwd(), '.tmp', 's2-6i-sessions.json');

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

// ===== DB helpers（直接读隔离 state，验证落库，与 HTTP 响应交叉印证）=====
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
const sessionRow = (sid) => withDb((db) => db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(sid));
const eventCount = (sid) => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE session_id = ?').get(sid).n);
const eventRows = (sid) =>
  withDb((db) => db.prepare('SELECT event_type, operator_id, reason, raw FROM attendance_events WHERE session_id = ? ORDER BY id').all(sid));
const activeCount = (uid) =>
  withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE user_id = ? AND status = 1 AND checkout_at IS NULL').get(uid).n);

// ===== HTTP helpers =====
const RESPONSE_LOG = [];
async function req(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const text = JSON.stringify(json ?? {});
  RESPONSE_LOG.push(text);
  return { res, body: json, text };
}
function auth(role, userId, teamId) {
  const h = { 'content-type': 'application/json' };
  if (role) h['x-test-role'] = role;
  if (userId != null) h['x-test-user'] = String(userId);
  if (teamId != null) h['x-test-team'] = String(teamId);
  return h;
}
const review = (sid, body, headers) => req('POST', `/api/v2/attendance-sessions/${sid}/review`, body, headers);
const force = (sid, body, headers) => req('POST', `/api/v2/attendance-sessions/${sid}/force-checkout`, body, headers);

const reason500 = 'x'.repeat(501);
const reasonOk = '管理审核：符合要求';

// =====================================================================
// A. Baseline
// =====================================================================
process.stderr.write('A. Baseline：目录 92/266 + roles=6 + fixture 就绪\n');
{
  const probe = await req('GET', '/probe');
  check('A1 permissions=92', probe.body?.data?.permissions === 92, `got ${probe.body?.data?.permissions}`);
  check('A2 role_permissions=266', probe.body?.data?.role_permissions === 266, `got ${probe.body?.data?.role_permissions}`);
  check('A3 roles=6', probe.body?.data?.roles === 6, `got ${probe.body?.data?.roles}`);

  const cat = withDb((db) =>
    db
      .prepare(`SELECT code FROM permissions WHERE code IN ('attendance.record.review','attendance.record.force')`)
      .all()
      .map((r) => r.code)
      .sort()
      .join(','),
  );
  check('A4 catalog 含 review+force 两权限', cat === 'attendance.record.force,attendance.record.review', `got ${cat}`);

  const fx = withDb((db) => ({
    ss: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n,
    ev: db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n,
  }));
  check('A5 fixture 就绪：sessions=19 events=0', fx.ss === 19 && fx.ev === 0, JSON.stringify(fx));
}

// =====================================================================
// B. Review（审核）
// =====================================================================
process.stderr.write('B. Review 审核\n');
{
  // B1 ownerA 审核 R1 approve
  const r = await review(S.R1, { decision: 'approve', reason: reasonOk }, auth('team_owner', U.ownerA, T.teamA));
  check('B1 ownerA 审核 R1 approve → 200', r.res.status === 200, `got ${r.res.status}/${r.body?.error?.code}`);
  check('B2 响应回显 review_status=1', r.body?.data?.session?.review_status === 1, `got ${r.body?.data?.session?.review_status}`);
  const r1 = sessionRow(S.R1);
  check('B3 DB: R1 review_status=1 且 status 不变(=2)', r1?.review_status === 1 && r1?.status === 2, JSON.stringify(r1));
  check('B4 DB: R1 checkout_at 未改动', r1?.checkout_at === 1756500100, `got ${r1?.checkout_at}`);
  const ev1 = eventRows(S.R1);
  check('B5 写 manual 审计事件', ev1.length === 1 && ev1[0].event_type === 'manual', JSON.stringify(ev1));
  check('B6 事件 operator_id = 执行管理员(ownerA=3) 非会话属主(volA=1)', ev1[0]?.operator_id === U.ownerA && ev1[0]?.operator_id !== U.volA, `got ${ev1[0]?.operator_id}`);
  check('B7 事件 reason 回写', ev1[0]?.reason === reasonOk, `got ${ev1[0]?.reason}`);

  // B8 ownerA 审核 R2 reject（带 reason）
  const r2 = await review(S.R2, { decision: 'reject', reason: '材料不全' }, auth('team_owner', U.ownerA, T.teamA));
  check('B8 ownerA 审核 R2 reject → 200', r2.res.status === 200, `got ${r2.res.status}`);
  check('B9 R2 review_status=2(rejected)', sessionRow(S.R2)?.review_status === 2, `got ${sessionRow(S.R2)?.review_status}`);
  const ev2 = eventRows(S.R2);
  check('B10 R2 写 manual 事件且 raw 含 reject', ev2.length === 1 && ev2[0].event_type === 'manual' && /reject/.test(ev2[0].raw ?? ''), JSON.stringify(ev2));

  // B11 reject 无 reason → 400
  const rj = await review(S.R5, { decision: 'reject' }, auth('team_owner', U.ownerA, T.teamA));
  check('B11 reject 无 reason → 400 INVALID_PARAM', rj.res.status === 400 && rj.body?.error?.code === 'INVALID_PARAM', `got ${rj.res.status}/${rj.body?.error?.code}`);
  check('B12 拒绝后 R5 仍待审(未改动)', sessionRow(S.R5)?.review_status === 0, `got ${sessionRow(S.R5)?.review_status}`);

  // B13 非法 decision → 400
  const rd = await review(S.R5, { decision: 'maybe' }, auth('team_owner', U.ownerA, T.teamA));
  check('B13 非法 decision → 400', rd.res.status === 400 && rd.body?.error?.code === 'INVALID_PARAM', `got ${rd.res.status}/${rd.body?.error?.code}`);

  // B14 未认证 → 401
  const ru = await review(S.R5, { decision: 'approve', reason: reasonOk });
  check('B14 未认证 → 401 AUTH_REQUIRED', ru.res.status === 401 && ru.body?.error?.code === 'AUTH_REQUIRED', `got ${ru.res.status}/${ru.body?.error?.code}`);

  // B15 volunteer（无 review 权限）→ 403 FORBIDDEN
  const rv = await review(S.R5, { decision: 'approve', reason: reasonOk }, auth('volunteer', U.volA, T.teamA));
  check('B15 volunteer 审核 → 403 FORBIDDEN', rv.res.status === 403 && rv.body?.error?.code === 'FORBIDDEN', `got ${rv.res.status}/${rv.body?.error?.code}`);

  // B16 team_auditor（持 review 权限，catalog 授予 team_auditor attendance.record.review）→ 200
  const ra = await review(S.R6, { decision: 'approve', reason: reasonOk }, auth('team_auditor', U.auditorA, T.teamA));
  check('B16 team_auditor 审核 R6 → 200', ra.res.status === 200 && ra.body?.data?.session?.review_status === 1, `got ${ra.res.status}`);

  // B17 team_admin（持 review 权限）→ 200
  const rad = await review(S.R7, { decision: 'approve', reason: reasonOk }, auth('team_admin', U.adminA, T.teamA));
  check('B17 team_admin 审核 R7 → 200', rad.res.status === 200 && rad.body?.data?.session?.review_status === 1, `got ${rad.res.status}`);

  // B18 platform_super_admin（catalog 持有 review/force 但无 team 上下文）→ 403 TEAM_SCOPE_REQUIRED（§0，已知 gap，禁止 bypass）
  const rps = await review(S.R5, { decision: 'approve', reason: reasonOk }, auth('platform_super_admin', U.platSuper));
  check('B18 platform_super_admin 无 team → 403 TEAM_SCOPE_REQUIRED', rps.res.status === 403 && rps.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `got ${rps.res.status}/${rps.body?.error?.code}`);

  // B19 platform_operator（catalog 未授予 attendance.record.* 权限，且无 team 上下文）→ 403 FORBIDDEN
  // 说明：冻结 catalog（role_permissions=247）中 platform_operator 不持有 review/force，
  // 故 requirePermission 直接 forbidden()（无授权），这是正确的目录驱动行为，而非 TEAM_SCOPE_REQUIRED。
  const rpo = await review(S.R5, { decision: 'approve', reason: reasonOk }, auth('platform_operator', U.plat));
  check('B19 platform_operator 无 review 权限 → 403 FORBIDDEN', rpo.res.status === 403 && rpo.body?.error?.code === 'FORBIDDEN', `got ${rpo.res.status}/${rpo.body?.error?.code}`);

  // B20 重复审核 R1（已 approve）→ 409 ATTENDANCE_ALREADY_REVIEWED
  const rr = await review(S.R1, { decision: 'reject', reason: 'again' }, auth('team_owner', U.ownerA, T.teamA));
  check('B20 重复审核 R1 → 409 ATTENDANCE_ALREADY_REVIEWED', rr.res.status === 409 && rr.body?.error?.details?.reason === 'attendance_already_reviewed', `got ${rr.res.status}/${rr.body?.error?.details?.reason}`);
  check('B21 重复审核未产生新事件', eventCount(S.R1) === 1, `got ${eventCount(S.R1)}`);

  // B22 跨团队审核 B_R（teamB 会话）by ownerA@teamA → 404（不泄露存在性）
  const rb = await review(S.B_R, { decision: 'approve', reason: reasonOk }, auth('team_owner', U.ownerA, T.teamA));
  check('B22 跨团队审核 B_R → 404 NOT_FOUND', rb.res.status === 404 && rb.body?.error?.code === 'NOT_FOUND', `got ${rb.res.status}/${rb.body?.error?.code}`);
  check('B23 跨团队审核未写事件(无 IDOR 写)', eventCount(S.B_R) === 0, `got ${eventCount(S.B_R)}`);
  check('B24 B_R 状态未被改动', sessionRow(S.B_R)?.review_status === 0, `got ${sessionRow(S.B_R)?.review_status}`);

  // B25 reason 超长 → 400
  const rlong = await review(S.R5, { decision: 'approve', reason: reason500 }, auth('team_owner', U.ownerA, T.teamA));
  check('B25 reason 超 500 → 400', rlong.res.status === 400 && rlong.body?.error?.code === 'INVALID_PARAM', `got ${rlong.res.status}`);

  // B26 畸形 sessionId → 400
  const rmal = await req('POST', '/api/v2/attendance-sessions/abc/review', { decision: 'approve', reason: reasonOk }, auth('team_owner', U.ownerA, T.teamA));
  check('B26 畸形 sessionId → 400 INVALID_PARAM', rmal.res.status === 400 && rmal.body?.error?.code === 'INVALID_PARAM', `got ${rmal.res.status}`);

  // B27 不存在 sessionId → 404
  const rmiss = await review(999999, { decision: 'approve', reason: reasonOk }, auth('team_owner', U.ownerA, T.teamA));
  check('B27 不存在 sessionId → 404 NOT_FOUND', rmiss.res.status === 404 && rmiss.body?.error?.code === 'NOT_FOUND', `got ${rmiss.res.status}`);

  // B28 Review 不改动 status/checkout_at（R5 仍待审，确认 B12 后仍未改动）
  check('B28 R5 历经多次非法请求仍待审', sessionRow(S.R5)?.review_status === 0, `got ${sessionRow(S.R5)?.review_status}`);
}

// =====================================================================
// C. Force Checkout（强制签退）
// =====================================================================
process.stderr.write('C. Force Checkout 强制签退\n');
{
  // C1 ownerA 强制签退 F1（活跃）→ 200
  const f = await force(S.F1, { reason: '紧急离场' }, auth('team_owner', U.ownerA, T.teamA));
  check('C1 ownerA 强制签退 F1 → 200', f.res.status === 200, `got ${f.res.status}`);
  check('C2 响应回显 status=2(CHECKED_OUT)', f.body?.data?.session?.status === 2, `got ${f.body?.data?.session?.status}`);
  const f1 = sessionRow(S.F1);
  check('C3 DB: F1 status=2 且 checkout_at 已写', f1?.status === 2 && f1?.checkout_at != null, JSON.stringify(f1));
  check('C4 DB: F1 review_status 不变(=0)', f1?.review_status === 0, `got ${f1?.review_status}`);
  const ef1 = eventRows(S.F1);
  check('C5 写 force_checkout 事件', ef1.length === 1 && ef1[0].event_type === 'force_checkout', JSON.stringify(ef1));
  check('C6 事件 operator_id = 执行管理员(ownerA=3)', ef1[0]?.operator_id === U.ownerA, `got ${ef1[0]?.operator_id}`);

  // C7 强制签退无 reason → 400
  const fnr = await force(S.F2, { }, auth('team_owner', U.ownerA, T.teamA));
  check('C7 强制签退无 reason → 400', fnr.res.status === 400 && fnr.body?.error?.code === 'INVALID_PARAM', `got ${fnr.res.status}`);

  // C8 未认证 → 401
  const fu = await force(S.F2, { reason: 'x' });
  check('C8 未认证强制签退 → 401', fu.res.status === 401 && fu.body?.error?.code === 'AUTH_REQUIRED', `got ${fu.res.status}`);

  // C9 volunteer（无 force 权限）→ 403 FORBIDDEN
  const fv = await force(S.F2, { reason: 'x' }, auth('volunteer', U.volA, T.teamA));
  check('C9 volunteer 强制签退 → 403 FORBIDDEN', fv.res.status === 403 && fv.body?.error?.code === 'FORBIDDEN', `got ${fv.res.status}`);

  // C10 team_auditor（无 force 权限）→ 403 FORBIDDEN
  const fa = await force(S.F2, { reason: 'x' }, auth('team_auditor', U.auditorA, T.teamA));
  check('C10 team_auditor 强制签退 → 403 FORBIDDEN', fa.res.status === 403 && fa.body?.error?.code === 'FORBIDDEN', `got ${fa.res.status}`);

  // C11 team_admin（持 force 权限）强制签退 F6（ownerA 活跃会话）→ 200
  const fad = await force(S.F6, { reason: '管理员操作' }, auth('team_admin', U.adminA, T.teamA));
  check('C11 team_admin 强制签退 F6 → 200', fad.res.status === 200 && fad.body?.data?.session?.status === 2, `got ${fad.res.status}`);

  // C12 platform_super_admin 无 team → 403 TEAM_SCOPE_REQUIRED
  const fps = await force(S.F3, { reason: 'x' }, auth('platform_super_admin', U.platSuper));
  check('C12 platform_super_admin 无 team 强制签退 → 403 TEAM_SCOPE_REQUIRED', fps.res.status === 403 && fps.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `got ${fps.res.status}`);

  // C13 强制签退 F2 已签退 → 409 ATTENDANCE_NOT_ACTIVE
  const f2a = await force(S.F2, { reason: 'again' }, auth('team_owner', U.ownerA, T.teamA));
  check('C13 重复强制签退 F2 → 409 ATTENDANCE_NOT_ACTIVE', f2a.res.status === 409 && f2a.body?.error?.details?.reason === 'attendance_not_active', `got ${f2a.res.status}/${f2a.body?.error?.details?.reason}`);

  // C14 强制签退 F3(status=2 已签退) → 409
  const f3 = await force(S.F3, { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('C14 强制签退 F3(已签退) → 409', f3.res.status === 409 && f3.body?.error?.details?.reason === 'attendance_not_active', `got ${f3.res.status}`);

  // C15 强制签退 F4(status=3 异常) → 409
  const f4 = await force(S.F4, { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('C15 强制签退 F4(异常态) → 409', f4.res.status === 409 && f4.body?.error?.details?.reason === 'attendance_not_active', `got ${f4.res.status}`);

  // C16 强制签退 F5(status=4 取消) → 409（禁止用 status=4）
  const f5 = await force(S.F5, { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('C16 强制签退 F5(取消态) → 409（不用 status=4）', f5.res.status === 409 && f5.body?.error?.details?.reason === 'attendance_not_active', `got ${f5.res.status}`);

  // C17 重复强制签退 F1 → 409
  const f1a = await force(S.F1, { reason: 'again' }, auth('team_owner', U.ownerA, T.teamA));
  check('C17 重复强制签退 F1 → 409', f1a.res.status === 409 && f1a.body?.error?.details?.reason === 'attendance_not_active', `got ${f1a.res.status}`);

  // C18 跨团队强制签退 B_F by ownerA@teamA → 404
  const fb = await force(S.B_F, { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('C18 跨团队强制签退 B_F → 404', fb.res.status === 404 && fb.body?.error?.code === 'NOT_FOUND', `got ${fb.res.status}`);
  check('C19 跨团队强制签退未写事件', eventCount(S.B_F) === 0, `got ${eventCount(S.B_F)}`);

  // C20 畸形 sessionId → 400
  const fmal = await req('POST', '/api/v2/attendance-sessions/abc/force-checkout', { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('C20 畸形 sessionId → 400', fmal.res.status === 400 && fmal.body?.error?.code === 'INVALID_PARAM', `got ${fmal.res.status}`);

  // C21 强制签退不改动 review_status（F2 的 review_status 仍 0）
  check('C21 F2 review_status 未被 force 改动', sessionRow(S.F2)?.review_status === 0, `got ${sessionRow(S.F2)?.review_status}`);

  // C22 teamB 管理员可操作本团队活跃会话 B_F → 200
  const fbt = await force(S.B_F, { reason: 'teamB 操作' }, auth('team_owner', U.ownerB, T.teamB));
  check('C22 ownerB 强制签退本团队 B_F → 200', fbt.res.status === 200 && fbt.body?.data?.session?.status === 2, `got ${fbt.res.status}`);
}

// =====================================================================
// D. 多参加模型（Multi-participation）：同一 signup → 多 session，操作必须精准命中指定 sessionId
// =====================================================================
process.stderr.write('D. 多参加模型（同一 signup → 多 session）\n');
{
  // D1 ownerA 强制签退 mpUserA 当前活跃会话 MP_F_NEW → 200
  const d1 = await force(S.MP_F_NEW, { reason: '多参加当前会话签退' }, auth('team_owner', U.ownerA, T.teamA));
  check('D1 强制签退 MP_F_NEW → 200', d1.res.status === 200 && d1.body?.data?.session?.status === 2, `got ${d1.res.status}`);

  // D2 强制签退 MP_F_OLD（历史已签退 status=2）→ 409（不误伤历史会话）
  const d2 = await force(S.MP_F_OLD, { reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('D2 强制签退 MP_F_OLD(历史) → 409', d2.res.status === 409 && d2.body?.error?.details?.reason === 'attendance_not_active', `got ${d2.res.status}`);

  // D3 ownerA 审核 mpUserA 待审会话 MP_R_NEW → 200
  const d3 = await review(S.MP_R_NEW, { decision: 'approve', reason: '多参加审核' }, auth('team_owner', U.ownerA, T.teamA));
  check('D3 审核 MP_R_NEW → 200', d3.res.status === 200 && d3.body?.data?.session?.review_status === 1, `got ${d3.res.status}`);

  // D4 审核 MP_R_OLD（历史已审核 review_status=1）→ 409（不误伤历史会话）
  const d4 = await review(S.MP_R_OLD, { decision: 'approve', reason: 'x' }, auth('team_owner', U.ownerA, T.teamA));
  check('D4 审核 MP_R_OLD(历史已审) → 409 ATTENDANCE_ALREADY_REVIEWED', d4.res.status === 409 && d4.body?.error?.details?.reason === 'attendance_already_reviewed', `got ${d4.res.status}`);

  // D5 多参加隔离：MP_F_NEW 被签退后，mpUserA 不再有活跃会话（单一活跃约束释放）
  check('D5 mpUserA 强制签退后无活跃会话', activeCount(U.mpUserA) === 0, `got ${activeCount(U.mpUserA)}`);

  // D6 审核/签退精准命中：MP_R_NEW 审核未影响 MP_R_OLD（仍 review_status=1，历史已审值未被误改）
  check('D6 MP_R_OLD 未被 MP_R_NEW 审核误改', sessionRow(S.MP_R_OLD)?.review_status === 1, `got ${sessionRow(S.MP_R_OLD)?.review_status}`);
}

// =====================================================================
// E. uq_active_attendance（单一活跃会话约束交互）
// =====================================================================
process.stderr.write('E. 单一活跃会话约束交互\n');
{
  // E1 F1 被强制签退后 volA 无活跃会话（释放单一活跃槽）
  check('E1 volA 强制签退 F1 后无活跃会话', activeCount(U.volA) === 0, `got ${activeCount(U.volA)}`);

  // E2 uq_active_attendance 索引存在
  const idxExists = withDb((db) =>
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='uq_active_attendance'").get()?.x === 1,
  );
  check('E2 uq_active_attendance 索引存在', idxExists === true, `got ${idxExists}`);

  // E3 uq_active_attendance 并发兜底：同一 user 插入第二条活跃(session status=1)会话必须被部分唯一索引拒绝。
  // 注意：本组之前 F1 已被强制签退（status=2），volA 当前无活跃会话，故先插入一条活跃会话，
  // 再对其同 user 插入第二条活跃会话，第二条必须抛错（部分唯一索引仅约束 status=1）。
  let dupThrew = false;
  let insertedIds = [];
  try {
    withDb((db) => {
      const base = db.prepare('SELECT signup_id, activity_id, user_id, team_id, service_date, slot, checkin_at, created_at FROM attendance_sessions WHERE id = ?').get(S.F1);
      const ins = db.prepare(
        `INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, service_date, slot, status, checkin_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      );
      const id1 = Number(
        ins.run(base.signup_id, base.activity_id, base.user_id, base.team_id, base.service_date, base.slot, base.checkin_at, base.created_at, base.created_at).lastInsertRowid,
      );
      insertedIds.push(id1);
      // 第二条同 user 活跃会话 → 必须违反 uq_active_attendance 抛错
      ins.run(base.signup_id, base.activity_id, base.user_id, base.team_id, base.service_date, base.slot, base.checkin_at, base.created_at, base.created_at);
    });
  } catch {
    dupThrew = true;
  }
  // 清理测试插入行（仅删本用例写入的 id，不动 fixture 行）
  withDb((db) => {
    for (const id of insertedIds) {
      try {
        db.prepare('DELETE FROM attendance_sessions WHERE id = ?').run(id);
      } catch {}
    }
  });
  check('E3 并发兜底：volA 第二条活跃会话被 uq_active_attendance 拒绝', dupThrew === true, `threw=${dupThrew}`);
}

// =====================================================================
// M. 安全 / IDOR / 泄漏（不泄露存在性、无内部标识符、无孤儿写）
// =====================================================================
process.stderr.write('M. 安全 / IDOR / 泄漏\n');
{
  const LEAK_SQL = /\b(SELECT\s+FROM|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|UNION\s+ALL|sqlite_master|attendance_sessions|attendance_events)\b/i;
  const LEAK_ID = /(role_id|permission_id|roleId|permissionId|scope_team_id|user_id":\s*\d+.*operator)/i;
  const sqlLeaks = RESPONSE_LOG.filter((t) => LEAK_SQL.test(t));
  check('M1 全部响应无 SQL / 表名泄露', sqlLeaks.length === 0, `${sqlLeaks.length} 条`);
  const idLeaks = RESPONSE_LOG.filter((t) => LEAK_ID.test(t));
  check('M2 全部响应无 role_id / permission_id 泄露', idLeaks.length === 0, `${idLeaks.length} 条`);

  // M3 跨团队请求未产生任何孤儿事件（IDOR 写）：B_R 全程无任何事件；B_F 仅允许 ownerB 的合法强制签退事件
  const bFEv = withDb((db) => db.prepare('SELECT operator_id FROM attendance_events WHERE session_id = ?').all(S.B_F));
  const noOrphan = eventCount(S.B_R) === 0 && bFEv.length >= 1 && bFEv.every((e) => e.operator_id === U.ownerB);
  check('M3 跨团队 B_R/B_F 无孤儿事件（B_R=0 且 B_F 仅 ownerB 合法写）', noOrphan, `B_R=${eventCount(S.B_R)} B_F=${JSON.stringify(bFEv)}`);

  // M4 最终一致性：会话数=19，无孤儿会话（所有会话均指向真实 signup）
  const cons = withDb((db) => ({
    ss: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n,
    orphan: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions s LEFT JOIN activity_signups su ON su.id = s.signup_id WHERE su.id IS NULL').get().n,
  }));
  check('M4 会话总数=19 且无孤儿会话', cons.ss === 19 && cons.orphan === 0, JSON.stringify(cons));

  // M5 审计事件总数 = review 成功 5（R1,R2,R6,R7,MP_R_NEW） + force 成功 4（F1,F6,MP_F_NEW,B_F） = 9
  // （不含被拒 / 跨团队攻击 / 重复 / 非法请求；C22 ownerB 对 B_F 的合法 force 已计入）
  const totalEvents = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n);
  check('M5 审计事件总数=9（5 review + 4 force 成功写）', totalEvents === 9, `got ${totalEvents}`);
}

// =====================================================================
// T. 时间戳单位（S2-6i-R1 新增）—— 冻结 schema 语义：INTEGER Unix epoch SECONDS
//
// 背景（本轮 BLOCKER A）：上一轮为了用 `updated_at = now` 作为 batch 内的事务标记，
// 曾把 service 的 now 改成 Date.now()（13 位毫秒），违反冻结 schema 的时间语义。
// 原子守卫已重构为「先 INSERT 后 UPDATE + 同一 PRE-state 谓词」，不再依赖时间戳唯一性，
// now 已回退为 Math.floor(Date.now()/1000)。本组是防止该回归再次发生的硬门禁。
//
// 哨兵：epoch seconds 现值约 1.75e9（10 位）；13 位毫秒必然 >= 1e12。
// 取 1e11 作上界哨兵 → 任何 >= 1e11 的值一律判为毫秒污染。
// =====================================================================
process.stderr.write('T. 时间戳单位（epoch seconds 硬门禁）\n');
{
  const MS_SENTINEL = 100000000000; // 1e11
  const EPOCH_MIN = 1000000000; // 2001-09-09，合理 epoch-seconds 下界
  const nowSec = Math.floor(Date.now() / 1000);
  const WINDOW = 600; // 允许测试与服务端之间的合理时钟/执行偏移

  // T1–T4 attendance_sessions 全部时间列：不存在 >= 1e11 的毫秒值
  const sBad = withDb((db) => ({
    updated: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE updated_at IS NOT NULL AND updated_at >= ?').get(MS_SENTINEL).n,
    checkout: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE checkout_at IS NOT NULL AND checkout_at >= ?').get(MS_SENTINEL).n,
    checkin: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE checkin_at IS NOT NULL AND checkin_at >= ?').get(MS_SENTINEL).n,
    created: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE created_at IS NOT NULL AND created_at >= ?').get(MS_SENTINEL).n,
  }));
  check('T1 attendance_sessions.updated_at 无毫秒值(<1e11)', sBad.updated === 0, `bad=${sBad.updated}`);
  check('T2 attendance_sessions.checkout_at 无毫秒值(<1e11)', sBad.checkout === 0, `bad=${sBad.checkout}`);
  check('T3 attendance_sessions.checkin_at 无毫秒值(<1e11)', sBad.checkin === 0, `bad=${sBad.checkin}`);
  check('T4 attendance_sessions.created_at 无毫秒值(<1e11)', sBad.created === 0, `bad=${sBad.created}`);

  // T5–T6 attendance_events 时间列：同上
  const eBad = withDb((db) => ({
    occurred: db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE occurred_at IS NOT NULL AND occurred_at >= ?').get(MS_SENTINEL).n,
    created: db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE created_at IS NOT NULL AND created_at >= ?').get(MS_SENTINEL).n,
  }));
  check('T5 attendance_events.occurred_at 无毫秒值(<1e11)', eBad.occurred === 0, `bad=${eBad.occurred}`);
  check('T6 attendance_events.created_at 无毫秒值(<1e11)', eBad.created === 0, `bad=${eBad.created}`);

  // T7 Review 成功路径：R1.updated_at 落在当前 epoch-seconds 合理窗口（既非毫秒、也非未更新）
  const r1 = sessionRow(S.R1);
  check(
    'T7 Review 成功写入的 updated_at 是当前 epoch seconds',
    r1?.updated_at > EPOCH_MIN && r1.updated_at < MS_SENTINEL && Math.abs(nowSec - r1.updated_at) <= WINDOW,
    `updated_at=${r1?.updated_at} nowSec=${nowSec}`,
  );

  // T8 Force 成功路径：F1.checkout_at 是当前 epoch seconds
  const f1 = sessionRow(S.F1);
  check(
    'T8 Force 成功写入的 checkout_at 是当前 epoch seconds',
    f1?.checkout_at > EPOCH_MIN && f1.checkout_at < MS_SENTINEL && Math.abs(nowSec - f1.checkout_at) <= WINDOW,
    `checkout_at=${f1?.checkout_at} nowSec=${nowSec}`,
  );

  // T9 Force 的 checkout_at 与 updated_at 同源（同一 now，单一时间源）
  check('T9 Force 的 checkout_at === updated_at（同一 epoch-seconds 时间源）', f1?.checkout_at === f1?.updated_at, `checkout=${f1?.checkout_at} updated=${f1?.updated_at}`);

  // T10 审计事件 occurred_at 与被更新会话 updated_at 严格一致（证明 event 与 UPDATE 共享同一 now）
  const evTs = withDb((db) => db.prepare('SELECT occurred_at, created_at FROM attendance_events WHERE session_id = ? ORDER BY id LIMIT 1').get(S.F1));
  check(
    'T10 event.occurred_at === session.updated_at 且同为 epoch seconds',
    evTs?.occurred_at === f1?.updated_at && evTs?.created_at === f1?.updated_at,
    `event=${JSON.stringify(evTs)} session.updated_at=${f1?.updated_at}`,
  );

  // T11 全库聚合硬门禁：两表所有时间列的最大值均 < 1e11
  const maxTs = withDb((db) =>
    db
      .prepare(
        `SELECT MAX(v) AS m FROM (
           SELECT MAX(COALESCE(updated_at,0)) AS v FROM attendance_sessions
           UNION ALL SELECT MAX(COALESCE(checkout_at,0)) FROM attendance_sessions
           UNION ALL SELECT MAX(COALESCE(checkin_at,0))  FROM attendance_sessions
           UNION ALL SELECT MAX(COALESCE(created_at,0))  FROM attendance_sessions
           UNION ALL SELECT MAX(COALESCE(occurred_at,0)) FROM attendance_events
           UNION ALL SELECT MAX(COALESCE(created_at,0))  FROM attendance_events
         )`,
      )
      .get().m,
  );
  check('T11 两表时间列全局最大值 < 1e11（无 13 位毫秒污染）', maxTs != null && maxTs < MS_SENTINEL, `max=${maxTs}`);
}

// ===== 汇总 =====
process.stderr.write(`\n===== S2-6i attendance-management: pass=${pass} fail=${fail} =====\n`);
process.exit(fail === 0 ? 0 : 1);
