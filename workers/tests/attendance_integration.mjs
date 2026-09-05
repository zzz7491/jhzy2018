#!/usr/bin/env node
/**
 * S2-6h Activity Attendance Vertical Slice 集成测试（A–F 组，≥36 项）。
 *
 * 前置：`node tests/fixture.mjs attendance` + wrangler dev 已启动（BASE_URL 见下）。
 * 通过【真实 Worker 运行时】验证本阶段授权闭环：
 *
 *   Session → Role → Permission(D1) → Tenant Scope → Ownership → Repository Write
 *
 * 冻结权限码（唯一事实 = workers/scripts/permission-catalog.json，本套件不新增/不改码）：
 *   attendance.record.checkin  —— 本人签到（scopeType USER / risk LOW）   持有人：platform_super_admin, volunteer
 *   attendance.record.checkout —— 本人签退（scopeType USER / risk LOW）   持有人：platform_super_admin, volunteer
 *   attendance.record.force / review / anomaly 为 TEAM scope —— 本阶段不使用（管理员操作他人属后续切片）
 *
 * 纪律（用户 §八/§九/§十/§十二/§十四/§十五/§十六/§十九/§二十/§二十一）：
 * - 权限完全来自 D1（87/247），无 mock、无角色名短路。
 * - 跨团队一律 404（不泄露存在性）；无权限 403；未认证 401；业务状态冲突 409；平台角色无 team 上下文 → 403 team scope。
 * - 套件内不写 permissions / role_permissions；E 组临时改 user_roles 后必须恢复。
 * - 不创建 migration、不改 Schema、不改 Catalog。
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

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => 's_' + randomBytes(32).toString('base64url');

const IDS = {
  volA: '01TESTUSERAAAAAAAAAAAAAAAA',
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD',
  teamAdminA: '01TESTUSERCFADMIN000000000A',
  plat: '01TESTUSERCPPPPPPPPPPPPPPP',
  platSuper: '01TESTUSERSUPER0000000000A',
  teamA: '01TESTTEAMAAAAAAAAAAAAAAAA',
  teamB: '01TESTTEAMBBBBBBBBBBBBBBBB',
  actAtt1: '01TESTATT1AAAAAAAAAAAAAAAA',
  actAtt2: '01TESTATT2AAAAAAAAAAAAAAAA',
  actAtt3: '01TESTATT3AAAAAAAAAAAAAAAA',
  actAtt4: '01TESTATT4AAAAAAAAAAAAAAAA',
  actAtt5: '01TESTATT5AAAAAAAAAAAAAAAA',
  actAttB: '01TESTATTBAAAAAAAAAAAAAAAA',
  // 合法 ULID 但库中不存在（用于 404 与"不泄露存在性"对照）。
  actMissing: '01TESTATTZZZZZZZZZZZZZZZZZ',
  // SQL 注入载荷（必须被 ULID 校验拦截在 DB 之前 → 400）。
  actInjection: "01TESTATT1AAAAAAAAAAAAAAAA' OR '1'='1",
  // S2-NEW-ARCH-P16：合法 participation_public_id（fixture attendance 模式播种）。
  partAtt1: '01TESTPART1AAAAAAAAAAAAAAA',          // volA → actAtt1，活跃
  partAtt1Cancelled: '01TESTPART2AAAAAAAAAAAAAAA', // volA → actAtt1，已取消 → 409 NOT_ACTIVE
  partAtt2: '01TESTPART3AAAAAAAAAAAAAAA',          // volA → actAtt2，活跃
  partAtt3: '01TESTPART4AAAAAAAAAAAAAAA',          // volA → actAtt3（signup 已取消）→ 409 NOT_SIGNED_UP
  partAtt4: '01TESTPART5AAAAAAAAAAAAAAA',          // volA → actAtt4，活跃
  partAtt5: '01TESTPART6AAAAAAAAAAAAAAA',          // volA → actAtt5，活跃
  partAtt5Owner: '01TESTPART7AAAAAAAAAAAAAAA',     // ownerA → actAtt5，活跃
  partAttB: '01TESTPARTBAAAAAAAAAAAAAAA',          // volB → actAttB（跨团队 → 404）
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
const teamIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM teams WHERE public_id = ?').get(pub)?.id);
const actIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM activities WHERE public_id = ?').get(pub)?.id);
const roleIdOf = (code) => withDb((db) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id);
const partIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM activity_participations WHERE public_id = ?').get(pub)?.id);

/** 读取某活动下某用户的考勤会话行。 */
function sessionRow(activityId, userId) {
  return withDb((db) =>
    db.prepare('SELECT * FROM attendance_sessions WHERE activity_id = ? AND user_id = ?').get(activityId, userId),
  );
}
const sessionCount = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n);
const eventCount = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n);
const eventCountForSession = (sid) =>
  withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE session_id = ?').get(sid).n);

// ===== 会话：直接向本地 D1 插入 sessions 行 =====
const TOKENS = {};
function insertSessions() {
  withDb((db) => {
    db.prepare(`DELETE FROM sessions WHERE public_id LIKE '01TESTSESSATT%'`).run();
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare(
      `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 'attendance-test', ?, 1)`,
    );
    const mk = (suffix, userPid) => {
      const t = newToken();
      ins.run(`01TESTSESSATT${suffix}`, userIdOf(userPid), sha256Hex(t), now + 30 * 24 * 3600);
      return t;
    };
    TOKENS.volA = mk('VOLAAAAAAAAAA', IDS.volA);
    TOKENS.volB = mk('VOLBBBBBBBBBB', IDS.volB);
    TOKENS.ownerA = mk('OWNERCCCCCCCC', IDS.ownerA);
    TOKENS.teamAdminA = mk('ADMINDDDDDDDD', IDS.teamAdminA);
    TOKENS.plat = mk('PLATEEEEEEEEE', IDS.plat);
    TOKENS.platSuper = mk('SUPERFFFFFFFF', IDS.platSuper);
  });
}

// ===== E 组：临时撤销 / 恢复 volA 的 volunteer@teamA（验证权限未固化进 Session）=====
function revokeVolunteerAtTeamA() {
  withDb((db) => {
    db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').run(
      userIdOf(IDS.volA),
      roleIdOf('volunteer'),
      teamIdOf(IDS.teamA),
    );
  });
}
function restoreVolunteerAtTeamA() {
  withDb((db) => {
    const u = userIdOf(IDS.volA);
    const t = teamIdOf(IDS.teamA);
    const r = roleIdOf('volunteer');
    const exists = db
      .prepare('SELECT 1 AS x FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?')
      .get(u, r, t);
    if (!exists) db.prepare('INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?,?,?)').run(u, r, t);
  });
}

// ===== HTTP helpers =====
async function req(method, path, headers = {}, body) {
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${path}`, init);
  let bodyRes = null;
  try {
    bodyRes = await res.json();
  } catch {
    bodyRes = null;
  }
  return { res, body: bodyRes, text: JSON.stringify(bodyRes ?? {}) };
}
const authHeaders = (token, team) => {
  const h = { authorization: `Bearer ${token}` };
  if (team != null) h['x-team-id'] = String(team);
  return h;
};
// P17：新 check-in 必须提交合法 participation_public_id（body），location 可选（S2-6k2 保留）。
const checkIn = (activityId, token, team, participationPublicId, location) =>
  req(
    'POST',
    `/api/v2/activities/${encodeURIComponent(activityId)}/attendance/checkin`,
    { ...authHeaders(token, team), 'content-type': 'application/json' },
    JSON.stringify({ participation_public_id: participationPublicId, ...(location !== undefined ? { location } : {}) }),
  );
const checkOut = (activityId, token, team) =>
  req('POST', `/api/v2/activities/${encodeURIComponent(activityId)}/attendance/checkout`, authHeaders(token, team));

// ===== 泄漏扫描（F 组，仅针对本切片新增业务面）=====
const ATTENDANCE_RESPONSE_LOG = [];
const LEAK_SQL_RE = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|UNION\s+ALL|sqlite_master)\b/i;
const LEAK_TABLE_RE = /(attendance_sessions|attendance_events|role_permissions|user_roles|permissions\s*\.)/i;
const LEAK_ID_RE = /(role_id|permission_id|roleId|permissionId)/i;
const logAtt = (r) => ATTENDANCE_RESPONSE_LOG.push(r.text);

// 成功写计数（用于 F 组最终一致性断言）
let expSessions = 0;
let expEvents = 0;

// ===== 主流程 =====
insertSessions();
const teamA = teamIdOf(IDS.teamA);
const teamB = teamIdOf(IDS.teamB);
const volAId = userIdOf(IDS.volA);
const volBId = userIdOf(IDS.volB);
const a1 = actIdOf(IDS.actAtt1);
const a2 = actIdOf(IDS.actAtt2);
const a3 = actIdOf(IDS.actAtt3);
const a4 = actIdOf(IDS.actAtt4);
const a5 = actIdOf(IDS.actAtt5);
const aB = actIdOf(IDS.actAttB);

// ---------------------------------------------------------------- A. Baseline
process.stderr.write('A. Baseline（目录 87/247 + 冻结签到权限 + fixture 就绪）\n');
{
  const probe = await req('GET', '/probe');
  // 注意：/probe 是基础设施探针，刻意回显表行数；不参与 F 组业务面泄漏扫描。
  check('A1 permissions=87', probe.body?.data?.permissions === 87, `got ${probe.body?.data?.permissions}`);
  check('A2 role_permissions=247', probe.body?.data?.role_permissions === 247, `got ${probe.body?.data?.role_permissions}`);

  const codes = withDb((db) =>
    db
      .prepare(
        `SELECT code FROM permissions WHERE code IN ('attendance.record.checkin','attendance.record.checkout','attendance.record.force')`,
      )
      .all()
      .map((r) => r.code),
  );
  check('A3 冻结签到权限存在（checkin/checkout/force = 3）', codes.length === 3, `got ${JSON.stringify(codes)}`);

  const holders = withDb((db) =>
    db
      .prepare(
        `SELECT r.code AS role FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'attendance.record.checkin' ORDER BY r.code`,
      )
      .all()
      .map((r) => r.role)
      .join(','),
  );
  check(
    'A3b attendance.record.checkin 持有者 = platform_super_admin,volunteer',
    holders === 'platform_super_admin,volunteer',
    `got ${holders}`,
  );

  const fx = withDb((db) => ({
    teams: db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
    acts: db.prepare('SELECT COUNT(*) AS n FROM activities').get().n,
    su: db.prepare('SELECT COUNT(*) AS n FROM activity_signups').get().n,
    occ: db.prepare('SELECT COUNT(*) AS n FROM activity_occurrences').get().n,
    part: db.prepare('SELECT COUNT(*) AS n FROM activity_participations').get().n,
    ss: db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n,
    ev: db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n,
  }));
  check('A4 fixture 就绪：teams=2 activities=6 signups=7 occurrences=6 participations=8 sessions=0 events=0',
    fx.teams === 2 && fx.acts === 6 && fx.su === 7 && fx.occ === 6 && fx.part === 8 && fx.ss === 0 && fx.ev === 0, JSON.stringify(fx));
}

// ---------------------------------------------------------------- B. Check-in (Create)
process.stderr.write('B. 本人签到（Check-in）\n');
{
  const r = await checkIn(IDS.actAtt1, TOKENS.volA, teamA, IDS.partAtt1, { latitude: 31.2304, longitude: 121.4737, accuracy: 12.5 });
  logAtt(r);
  check('B5 volA 合法签到 actAtt1 → 201', r.res.status === 201 && r.body?.data?.attendance?.session_id > 0, `got ${r.res.status}/${r.body?.error?.code}`);
  if (r.res.status === 201) { expSessions += 1; expEvents += 1; }
  check('B6 返回统一响应 envelope', r.body?.success === true && r.body?.data?.attendance != null, JSON.stringify(r.body).slice(0, 80));
  const row = sessionRow(a1, volAId);
  check('B7 会话写入正确 user_id', row?.user_id === volAId, `got ${row?.user_id}`);
  check('B7b 会话 participation_id 绑定 resolved Participation（P16 契约）', row?.participation_id === partIdOf(IDS.partAtt1), `got ${row?.participation_id}`);
  check('B8 会话对应正确 activity', row?.activity_id === a1, `got ${row?.activity_id}`);
  check('B9 会话对应正确 team', row?.team_id === teamA, `got ${row?.team_id}`);
  check('B10 会话 status=1（已签到）', row?.status === 1, `got ${row?.status}`);
  check('B11 会话 checkin_at 已写入', row?.checkin_at != null, `got ${row?.checkin_at}`);
  const ev = row ? eventCountForSession(row.id) : 0;
  check('B12 写最小 checkin 事件证据行', ev >= 1, `got ${ev}`);
  const locEv = withDb((db) => db.prepare('SELECT latitude, longitude, accuracy, distance FROM attendance_events WHERE session_id=? AND event_type=\'checkin\'').get(row.id));
  check('B12b 带 location 签到坐标落库（S2-6k2 契约保留）', locEv?.latitude === 31.2304 && locEv?.longitude === 121.4737 && locEv?.accuracy === 12.5 && locEv?.distance === null, `got ${JSON.stringify(locEv)}`);

  // R2 模型：同一用户任意时刻至多一条活跃会话（uq_active_attendance）。
  // volA 已持有 actAtt1 活跃会话，跨活动签到 actAtt2 必须被拦截。
  const r2 = await checkIn(IDS.actAtt2, TOKENS.volA, teamA, IDS.partAtt2);
  logAtt(r2);
  check('B13 volA 跨活动签到 actAtt2（actAtt1 已活跃）→ 409 ALREADY_CHECKED_IN（单一活跃会话）',
    r2.res.status === 409 && r2.body?.error?.details?.reason === 'attendance_already_checked_in',
    `got ${r2.res.status}/${r2.body?.error?.details?.reason}`);

  const rno = await checkIn(IDS.actAtt1, null, teamA, IDS.partAtt1);
  logAtt(rno);
  check('B14 无 Session → 401 AUTH_REQUIRED', rno.res.status === 401 && rno.body?.error?.code === 'AUTH_REQUIRED', `got ${rno.res.status}/${rno.body?.error?.code}`);

  const radm = await checkIn(IDS.actAtt1, TOKENS.teamAdminA, teamA, IDS.partAtt1);
  logAtt(radm);
  check('B15 无 checkin 权限（team_admin@teamA）→ 403 FORBIDDEN', radm.res.status === 403 && radm.body?.error?.code === 'FORBIDDEN', `got ${radm.res.status}/${radm.body?.error?.code}`);

  const rmiss = await checkIn(IDS.actMissing, TOKENS.volA, teamA, IDS.partAtt1);
  logAtt(rmiss);
  check('B16 活动不存在（合法 ULID）→ 404 NOT_FOUND', rmiss.res.status === 404 && rmiss.body?.error?.code === 'NOT_FOUND', `got ${rmiss.res.status}`);

  const rx = await checkIn(IDS.actAttB, TOKENS.volA, teamA, IDS.partAttB);
  logAtt(rx);
  check('B17 跨团队 Participation（teamB 的 partAttB，active=teamA）→ 404 NOT_FOUND（不泄露存在）', rx.res.status === 404 && rx.body?.error?.code === 'NOT_FOUND', `got ${rx.res.status}/${rx.body?.error?.code}`);

  const rinj = await checkIn(IDS.actInjection, TOKENS.volA, teamA, IDS.partAtt1);
  logAtt(rinj);
  check('B18 SQL 注入 activityId → 400 INVALID_PARAM（先于 DB）', rinj.res.status === 400 && rinj.body?.error?.code === 'INVALID_PARAM', `got ${rinj.res.status}/${rinj.body?.error?.code}`);

  const rns = await checkIn(IDS.actAtt3, TOKENS.volA, teamA, IDS.partAtt3);
  logAtt(rns);
  check('B19 signup 非 REGISTERED（actAtt3 已取消报名）→ 409 CONFLICT reason=attendance_not_signed_up', rns.res.status === 409 && rns.body?.error?.details?.reason === 'attendance_not_signed_up', `got ${rns.res.status}/${rns.body?.error?.details?.reason}`);

  const rdup = await checkIn(IDS.actAtt1, TOKENS.volA, teamA, IDS.partAtt1);
  logAtt(rdup);
  check('B20 重复签到 → 409 reason=attendance_already_checked_in', rdup.res.status === 409 && rdup.body?.error?.details?.reason === 'attendance_already_checked_in', `got ${rdup.res.status}/${rdup.body?.error?.details?.reason}`);

  const n = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE activity_id=? AND user_id=?').get(a1, volAId).n);
  check('B21 重复签到后数据库仍只有 1 条', n === 1, `got ${n}`);

  // P16：缺 participation_public_id → 400（body 契约）。
  const rmissBody = await req(
    'POST',
    `/api/v2/activities/${encodeURIComponent(IDS.actAtt1)}/attendance/checkin`,
    { ...authHeaders(TOKENS.volA, teamA), 'content-type': 'application/json' },
    JSON.stringify({}),
  );
  logAtt(rmissBody);
  check('B22 缺 participation_public_id → 400 INVALID_PARAM', rmissBody.res.status === 400 && rmissBody.body?.error?.code === 'INVALID_PARAM', `got ${rmissBody.res.status}/${rmissBody.body?.error?.code}`);

  // P16：已取消 Participation → 409（与 not_signed_up 区分）。
  const rcancel = await checkIn(IDS.actAtt1, TOKENS.volA, teamA, IDS.partAtt1Cancelled);
  logAtt(rcancel);
  check('B23 已取消 Participation → 409 reason=attendance_participation_not_active', rcancel.res.status === 409 && rcancel.body?.error?.details?.reason === 'attendance_participation_not_active', `got ${rcancel.res.status}/${rcancel.body?.error?.details?.reason}`);
}

// ---------------------------------------------------------------- C. Check-out Own
process.stderr.write('C. 本人签退（Check-out）\n');
{
  // 当前 volA 唯一活跃会话是 actAtt1（来自 B5），签退它。
  const r = await checkOut(IDS.actAtt1, TOKENS.volA, teamA);
  logAtt(r);
  check('C5 volA 签退自己 actAtt1（活跃）→ 200 status=2', r.res.status === 200 && r.body?.data?.attendance?.status === 2, `got ${r.res.status}/${r.body?.data?.attendance?.status}`);
  if (r.res.status === 200) expEvents += 1;
  const row = sessionRow(a1, volAId);
  check('C6 DB 会话 status=2 且 checkout_at 已写', row?.status === 2 && row?.checkout_at != null, `status=${row?.status} co=${row?.checkout_at}`);
  check('C7 写最小 checkout 事件证据行', row ? eventCountForSession(row.id) >= 2 : false, `ev=${row ? eventCountForSession(row.id) : 0}`);

  // actAtt1 已在 C5 签退；签退后该 signup 下不再有活跃会话（单一活跃会话模型），
  // 再次签退 → 无活跃会话可操作 → 409 attendance_checkin_required（无副作用，与 S2-6h 的 409 语义一致）。
  const r1 = await checkOut(IDS.actAtt1, TOKENS.volA, teamA);
  logAtt(r1);
  check('C8 volA 重复签退 actAtt1 → 409（无活跃会话，需先签到）', r1.res.status === 409 && r1.body?.error?.details?.reason === 'attendance_checkin_required', `got ${r1.res.status}/${r1.body?.error?.details?.reason}`);

  const rrdup = await checkOut(IDS.actAtt1, TOKENS.volA, teamA);
  logAtt(rrdup);
  check('C9 重复签退 → 409 reason=attendance_checkin_required（一致行为）', rrdup.res.status === 409 && rrdup.body?.error?.details?.reason === 'attendance_checkin_required', `got ${rrdup.res.status}/${rrdup.body?.error?.details?.reason}`);

  const rns = await checkOut(IDS.actAtt4, TOKENS.volA, teamA);
  logAtt(rns);
  check('C10 已报名未签到活动（actAtt4）→ 409 reason=attendance_checkin_required', rns.res.status === 409 && rns.body?.error?.details?.reason === 'attendance_checkin_required', `got ${rns.res.status}/${rns.body?.error?.details?.reason}`);

  // 他人考勤：volB 先签到 actAttB，volA 尝试签退（volA 未报名 actAttB）→ 必须不影响 volB 会话。
  const rb = await checkIn(IDS.actAttB, TOKENS.volB, teamB, IDS.partAttB);
  logAtt(rb);
  check('C11 volB 签到自己 actAttB → 201', rb.res.status === 201 && rb.body?.data?.attendance?.session_id > 0, `got ${rb.res.status}`);
  if (rb.res.status === 201) { expSessions += 1; expEvents += 1; }
  const rbout = await checkOut(IDS.actAtt1, TOKENS.ownerA, teamA);
  logAtt(rbout);
  check('C12 同团队他人报名（ownerA 签退 volA 的 actAtt1）→ 409 NOT_SIGNED_UP（非本人资源）', rbout.res.status === 409 && rbout.body?.error?.details?.reason === 'attendance_not_signed_up', `got ${rbout.res.status}/${rbout.body?.error?.details?.reason}`);
  const volBSession = sessionRow(aB, volBId);
  check('C13 他人会话不受影响（volB 会话仍为 status=1）', volBSession?.status === 1, `got ${volBSession?.status}`);

  const rx = await checkOut(IDS.actAtt1, TOKENS.volA, teamB);
  logAtt(rx);
  check('C14 切换 active=teamB（volA 无 teamB 角色）→ 403 FORBIDDEN（Permission 随租户上下文失效）', rx.res.status === 403 && rx.body?.error?.code === 'FORBIDDEN', `got ${rx.res.status}/${rx.body?.error?.code}`);

  // C15 跨团队签退（数据层）：volB(active=teamB) 签退 teamA 的 actAtt1 → 404（不泄露存在性）
  const rxc = await checkOut(IDS.actAtt1, TOKENS.volB, teamB);
  logAtt(rxc);
  check('C15 跨团队签退（volB→teamA 活动）→ 404 NOT_FOUND', rxc.res.status === 404 && rxc.body?.error?.code === 'NOT_FOUND', `got ${rxc.res.status}/${rxc.body?.error?.code}`);
}

// ---------------------------------------------------------------- D. Permission + Tenant
process.stderr.write('D. 权限 + 租户作用域\n');
{
  const r1 = await checkIn(IDS.actAtt4, TOKENS.volA, teamA, IDS.partAtt4);
  logAtt(r1);
  check('D1 TeamA volunteer + active A 签到 actAtt4 → 201', r1.res.status === 201, `got ${r1.res.status}`);
  if (r1.res.status === 201) { expSessions += 1; expEvents += 1; }

  const r2 = await checkIn(IDS.actAtt4, TOKENS.teamAdminA, teamA, IDS.partAtt4);
  logAtt(r2);
  check('D2 TeamA admin（无 checkin 权限）→ 403 FORBIDDEN', r2.res.status === 403 && r2.body?.error?.code === 'FORBIDDEN', `got ${r2.res.status}`);

  const r3 = await checkIn(IDS.actAtt1, TOKENS.volA, teamB, IDS.partAtt1);
  logAtt(r3);
  check('D3 切换 active=teamB（volA 无 teamB 角色绑定）→ 403 FORBIDDEN（权限随团队上下文失效）', r3.res.status === 403 && r3.body?.error?.code === 'FORBIDDEN', `got ${r3.res.status}`);

  const r4 = await checkIn(IDS.actAtt4, TOKENS.plat, teamA, IDS.partAtt4);
  logAtt(r4);
  check('D4 platform_operator（无 checkin 权限）→ 403 FORBIDDEN', r4.res.status === 403 && r4.body?.error?.code === 'FORBIDDEN', `got ${r4.res.status}`);

  const r5 = await checkIn(IDS.actAtt4, TOKENS.platSuper, teamA, IDS.partAtt4);
  logAtt(r5);
  check('D5 platform_super_admin（持 checkin 但无 team 上下文）→ 403 TEAM_SCOPE_REQUIRED（Permission ≠ Tenant Scope）', r5.res.status === 403 && r5.body?.error?.code === 'TEAM_SCOPE_REQUIRED', `got ${r5.res.status}/${r5.body?.error?.code}`);

  const r6 = await checkIn(IDS.actAtt5, TOKENS.ownerA, teamA, IDS.partAtt5Owner);
  logAtt(r6);
  check('D6 team_owner（兼 volunteer）→ 201（持有 checkin 且本人已报名）', r6.res.status === 201, `got ${r6.res.status}`);
  if (r6.res.status === 201) { expSessions += 1; expEvents += 1; }

  const r7 = await checkIn(IDS.actAttB, TOKENS.ownerA, teamA, IDS.partAttB);
  logAtt(r7);
  check('D7 team_owner 跨团队 Participation（actAttB/partAttB）→ 404 NOT_FOUND', r7.res.status === 404 && r7.body?.error?.code === 'NOT_FOUND', `got ${r7.res.status}`);
}

// ---------------------------------------------------------------- E. Live Authorization
process.stderr.write('E. 实时授权（权限未固化进 Session）\n');
{
  // 收尾 D1 留下的活跃会话（actAtt4），使 volA 恢复无活跃状态，后续 E1 才能签到 actAtt5。
  const e0 = await checkOut(IDS.actAtt4, TOKENS.volA, teamA);
  logAtt(e0);
  check('E0 volA 签退 actAtt4（收尾 D1 活跃会话）→ 200', e0.res.status === 200 && e0.body?.data?.attendance?.status === 2, `got ${e0.res.status}`);
  if (e0.res.status === 200) expEvents += 1;

  const r1 = await checkIn(IDS.actAtt5, TOKENS.volA, teamA, IDS.partAtt5);
  logAtt(r1);
  check('E1 volA 签到 actAtt5 → 201（基线，权限生效）', r1.res.status === 201, `got ${r1.res.status}`);
  if (r1.res.status === 201) { expSessions += 1; expEvents += 1; }

  revokeVolunteerAtTeamA();
  const afterRevoke = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').get(volAId, roleIdOf('volunteer'), teamA).n);
  check('E2 撤销 volA volunteer@teamA 已落库（user_roles 行移除）', afterRevoke === 0, `got ${afterRevoke}`);

  const r3 = await checkIn(IDS.actAtt5, TOKENS.volA, teamA, IDS.partAtt5);
  logAtt(r3);
  check('E3 角色撤销后下一请求 → 403（权限即时失效）', r3.res.status === 403 && r3.body?.error?.code === 'FORBIDDEN', `got ${r3.res.status}`);

  const r4 = await checkIn(IDS.actAtt5, TOKENS.volA, teamA, IDS.partAtt5);
  logAtt(r4);
  check('E4 撤销期间重复请求仍 403（稳定）', r4.res.status === 403, `got ${r4.res.status}`);

  restoreVolunteerAtTeamA();
  const afterRestore = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE user_id=? AND role_id=? AND scope_team_id=?').get(volAId, roleIdOf('volunteer'), teamA).n);
  check('E5 恢复 volA volunteer@teamA 已落库', afterRestore === 1, `got ${afterRestore}`);

  const r6 = await checkOut(IDS.actAtt5, TOKENS.volA, teamA);
  logAtt(r6);
  check('E6 角色恢复后下一请求 → 200（同一 token 无需重新登录，权限未固化）', r6.res.status === 200 && r6.body?.data?.attendance?.status === 2, `got ${r6.res.status}`);
  if (r6.res.status === 200) expEvents += 1;
}

// ---------------------------------------------------------------- F. Security / IDOR
process.stderr.write('F. 安全 / IDOR / 泄漏\n');
{
  const sqlLeaks = ATTENDANCE_RESPONSE_LOG.filter((t) => LEAK_SQL_RE.test(t) || LEAK_TABLE_RE.test(t));
  check('F1 全部响应无 SQL / 表名泄露', sqlLeaks.length === 0, `${sqlLeaks.length} 条：${sqlLeaks.slice(0, 2).join(' | ')}`);

  const idLeaks = ATTENDANCE_RESPONSE_LOG.filter((t) => LEAK_ID_RE.test(t));
  check('F2 全部响应无 role_id / permission_id 泄露', idLeaks.length === 0, `${idLeaks.length} 条：${idLeaks.slice(0, 2).join(' | ')}`);

  const testOnly = ATTENDANCE_RESPONSE_LOG.filter((t) => /TEST_ONLY_PERMISSION/.test(t));
  check('F3 响应不含 TEST_ONLY_PERMISSION', testOnly.length === 0, `${testOnly.length} 条`);

  // 跨团队签到不得落库：volA 对 actAttB 的 B17 请求应 0 写入。
  const volASessionInB = sessionRow(aB, volAId);
  check('F4 跨团队请求未创建任何 volA 在 teamB 的会话（无 IDOR 写）', volASessionInB == null, `got ${volASessionInB?.id}`);

  // 所有权失败（C12）未改动 volB 会话 → 已断言 C13；此处再确认 volB 会话状态未被签退。
  const volBSession = sessionRow(aB, volBId);
  check('F5 所有权拒绝未改变他人记录（volB 会话仍 status=1）', volBSession?.status === 1, `got ${volBSession?.status}`);

  // 最终一致性：套件内成功写计数 === 实际 DB 计数。
  const ss = sessionCount();
  const ev = eventCount();
  check('F6 考勤会话数 = 预期写入数', ss === expSessions, `expected ${expSessions}, got ${ss}`);
  check('F7 考勤事件数 = 预期写入数', ev === expEvents, `expected ${expEvents}, got ${ev}`);

  // 孤儿校验：每个 attendance_sessions 必须对应存在的 signup。
  const orphan = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions s LEFT JOIN activity_signups su ON su.id = s.signup_id WHERE su.id IS NULL').get().n,
  );
  check('F8 无孤儿会话（所有会话均指向真实 signup）', orphan === 0, `got ${orphan}`);
}

// ---------------------------------------------------------------- G. Multi-Participation (S2-6h-R2)
process.stderr.write('G. 多次参加 / 单一活跃会话（S2-6h-R2 模型修复）\n');
{
  // 进入本组时：volA 已无活跃会话（actAtt1/actAtt4/actAtt5 均已签退）。
  // 先验证 actAtt5（E6 已签退）的重复签退被拦截，再验证"签退后可再次签到同一活动"。
  const g1 = await checkOut(IDS.actAtt5, TOKENS.volA, teamA);
  logAtt(g1);
  check('G1 volA 重复签退 actAtt5（已签退，无活跃会话）→ 409 attendance_checkin_required', g1.res.status === 409 && g1.body?.error?.details?.reason === 'attendance_checkin_required', `got ${g1.res.status}/${g1.body?.error?.details?.reason}`);

  // 已有 actAtt1 的签退会话（C8）；签退后再签到 = 第二次参加（R2 核心修复：UNIQUE(signup_id) 已移除）。
  const activeBefore = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE user_id=? AND status=1 AND checkout_at IS NULL').get(volAId).n,
  );
  check('G2 进入前 volA 活跃会话数=0', activeBefore === 0, `got ${activeBefore}`);

  const g2 = await checkIn(IDS.actAtt1, TOKENS.volA, teamA, IDS.partAtt1);
  logAtt(g2);
  check('G3 签退后再次签到 actAtt1（同一报名多次参加）→ 201', g2.res.status === 201 && g2.body?.data?.attendance?.session_id > 0, `got ${g2.res.status}`);
  if (g2.res.status === 201) { expSessions += 1; expEvents += 1; }

  const newRow = withDb((db) =>
    db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(g2.body?.data?.attendance?.session_id),
  );
  check('G4 新会话 service_date 已锚定（>0）', newRow?.service_date > 0, `got ${newRow?.service_date}`);
  check('G5 新会话 slot 默认值（空串）', newRow?.slot === '', `got ${JSON.stringify(newRow?.slot)}`);
  check('G6 新会话 status=1 活跃', newRow?.status === 1 && newRow?.checkout_at == null, `status=${newRow?.status}`);
  check('G6b 新会话 participation_id 绑定 partAtt1（P16）', newRow?.participation_id === partIdOf(IDS.partAtt1), `got ${newRow?.participation_id}`);

  const g4 = await checkIn(IDS.actAtt1, TOKENS.volA, teamA, IDS.partAtt1);
  logAtt(g4);
  check('G7 同活动未签退再次签到 → 409 ALREADY_CHECKED_IN（同报名单一活跃）', g4.res.status === 409 && g4.body?.error?.details?.reason === 'attendance_already_checked_in', `got ${g4.res.status}/${g4.body?.error?.details?.reason}`);

  const a1Sessions = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE activity_id=? AND user_id=?').get(a1, volAId).n,
  );
  check('G8 actAtt1 下 volA 会话累计=2（1 签退 + 1 活跃，证明重复参加成功）', a1Sessions === 2, `got ${a1Sessions}`);

  const g6 = await checkOut(IDS.actAtt1, TOKENS.volA, teamA);
  logAtt(g6);
  check('G9 volA 签退 actAtt1（第二次）→ 200', g6.res.status === 200 && g6.body?.data?.attendance?.status === 2, `got ${g6.res.status}`);
  if (g6.res.status === 200) expEvents += 1;

  // 跨活动单一活跃会话：volA 已签退全部 → 签到 actAtt2（已有签退会话）→ 新活跃；
  // 此时再签到 actAtt5（不同活动）必须 409（uq_active_attendance 跨活动兜底）。
  const g7 = await checkIn(IDS.actAtt2, TOKENS.volA, teamA, IDS.partAtt2);
  logAtt(g7);
  check('G10 签退后签到 actAtt2（多次参加另一活动）→ 201', g7.res.status === 201, `got ${g7.res.status}`);
  if (g7.res.status === 201) { expSessions += 1; expEvents += 1; }

  // 直接 DB 写入第二条 volA 活跃会话，验证 partial unique index 作为并发兜底（必须抛唯一约束冲突）。
  const idxExists = withDb((db) =>
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='uq_active_attendance'").get()?.x === 1,
  );
  check('G11 uq_active_attendance 索引存在（每用户单一活跃会话）', idxExists === true, `got ${idxExists}`);

  let dupInsertThrew = false;
  try {
    withDb((db) => {
      const base = db.prepare('SELECT signup_id, activity_id, user_id, team_id, service_date, slot, checkin_at, created_at FROM attendance_sessions WHERE id = ?').get(g7.body?.data?.attendance?.session_id);
      db.prepare(
        `INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, service_date, slot, status, checkin_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(base.signup_id, base.activity_id, base.user_id, base.team_id, base.service_date, base.slot, base.checkin_at, base.created_at, base.created_at);
    });
  } catch {
    dupInsertThrew = true;
  }
  check('G12 并发兜底：直接写入第二条 volA 活跃会话被 uq_active_attendance 拒绝', dupInsertThrew === true, `threw=${dupInsertThrew}`);

  const g9 = await checkIn(IDS.actAtt5, TOKENS.volA, teamA, IDS.partAtt5);
  logAtt(g9);
  check('G13 已有活跃会话时跨活动签到 actAtt5 → 409 ALREADY_CHECKED_IN（R1 背景第 5 条）', g9.res.status === 409 && g9.body?.error?.details?.reason === 'attendance_already_checked_in', `got ${g9.res.status}/${g9.body?.error?.details?.reason}`);

  const g10 = await checkOut(IDS.actAtt2, TOKENS.volA, teamA);
  logAtt(g10);
  check('G14 volA 签退 actAtt2（收尾）→ 200', g10.res.status === 200, `got ${g10.res.status}`);
  if (g10.res.status === 200) expEvents += 1;

  const activeEnd = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE user_id=? AND status=1 AND checkout_at IS NULL').get(volAId).n,
  );
  check('G15 收尾后 volA 活跃会话数=0（无悬挂活跃会话）', activeEnd === 0, `got ${activeEnd}`);

  const volATotal = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions WHERE user_id=?').get(volAId).n,
  );
  check('G16 volA 会话累计=5（actAtt1×2 + actAtt4 + actAtt5 + actAtt2，多次参加正确落库）', volATotal === 5, `got ${volATotal}`);
}

// ===== 汇总 =====
process.stderr.write(`\n===== S2-6h attendance: pass=${pass} fail=${fail} =====\n`);
process.exit(fail === 0 ? 0 : 1);
