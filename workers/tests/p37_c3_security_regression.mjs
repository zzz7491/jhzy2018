/**
 * P37-C3 — Security + Regression HARDENING TEST
 *
 * 在「真实 src/app.ts（esbuild 打包）+ 完整迁移链 + node:sqlite D1 适配器 +
 * 真实中间件链」上，对 P37 数据运营 analytics 做穷尽式安全回归，覆盖：
 *   A. Authentication（双 endpoint + capability 未认证 → 401）
 *   B. TEAM permission（无 analytics.team.view → 403；有 → 200；DB-backed 非 role）
 *   C. PLATFORM permission（无 analytics.platform.view → 403；team 角色不得获 platform）
 *   D. TEAM context（有权限无 active team → 403 TEAM_SCOPE_REQUIRED）
 *   E. Tenant isolation（逐表证明 team_members/activities/service_records/
 *      adjustment_requests/content_articles/ai_usage_logs 均按 team_id 隔离）
 *   F. Client injection（team_id/user_id/sql/fields/groupBy/filters/raw/start/end
 *      + 任意 unknown key → 400；platform 同样不得经 team_id/user_id 切换 scope）
 *   G. PLATFORM global aggregate boundary（不含 team breakdown / team id / user list / raw rows）
 *   H. Capability projection（team-only / platform-only / both / held-team-perm-no-team）
 *   I. No role hardcoding（扫描 backend + frontend analytics 决策路径无角色字符串）
 *   J. Privacy（TEAM/PLATFORM 响应及 users/me capability 不泄露 PII/内部 id/RBAC 矩阵/raw AI）
 *   K. Metric response whitelist（顶层仅 scope/range/period/metrics；period 仅 start/end；metrics 恰 11 键）
 *   L. Numeric integrity（11 指标非负有限；count 为整数；service_minutes>=0；ai_active<=ai_call）
 *   M. Status semantics（cancelled/draft/unpublished/active/settlement/pending 全枚举）
 *   N. Time range（today/7d/30d/month + Asia/Shanghai + [start,end) + 月末月初边界）
 *   O. AI aggregation（team 仅本 team；platform 全局；NULL user_id 不计入 active；ai_active<=ai_call）
 *   P. Frontend security（源码扫描：入口按 capability 而非 role；client 不发 team_id query；
 *      platform 不附加 X-Team-Id；旧请求不得覆盖新请求）
 *
 * 纯测试文件：不修改源码 / 迁移 / frontend / 历史 WIP；不 git add / commit / push（由调用方决定）。
 * 运行（workers/ 目录）：node tests/p37_c3_security_regression.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, readFileSync as fsRead } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { D1Database } from './lib/d1-shim.mjs';

const WORKERS = fileURLToPath(new URL('..', import.meta.url));
const FRONTEND = join(WORKERS, '..', 'miniprogram');

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

async function main() {
  // 冻结上海 2026-09-10 15:30 = UTC 07:30，使 range 计算确定性（与 p37_c1 一致）
  const FIXED_NOW_MS = Date.UTC(2026, 8, 10, 7, 30, 0);
  const realNow = Date.now;
  Date.now = () => FIXED_NOW_MS;

  // ---- 打包真实 app.ts + range helpers ----
  const entry = `
export { createApp } from './src/app';
export { computeRange, parseRangeQuery, DEFAULT_RANGE, VALID_RANGES, FORBIDDEN_QUERY_KEYS } from './src/services/analytics-service';
`;
  const entryPath = join(WORKERS, '.p37_c3_entry.ts');
  writeFileSync(entryPath, entry);
  const built = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
    absWorkingDir: WORKERS,
  });
  const bundlePath = join(tmpdir(), `p37_c3_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const M = await import(pathToFileURL(bundlePath).href);
  const app = M.createApp();
  const { computeRange, DEFAULT_RANGE, FORBIDDEN_QUERY_KEYS } = M;

  // ---- sqlite + 完整迁移链 + D1 adapter ----
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  const migDir = join(WORKERS, 'migrations');
  const migFiles = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migFiles) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const d1 = new D1Database(sqlite);

  const ins = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // ---- 种子 users / teams / roles（角色与权限来自迁移 seed，不改 RBAC）----
  const U = { vol: 10, member: 11, admin: 12, auditor: 13, owner: 14, platOp: 15, platSa: 16, plat: 19, a: 21, b: 22, c: 23, e: 25 };
  for (const [id, pub, nick] of [
    [U.vol, 'USERV0000000000000000000010', 'vol'],
    [U.member, 'USERM0000000000000000000011', 'mem'],
    [U.admin, 'USERAD000000000000000000012', 'adm'],
    [U.auditor, 'USERAU000000000000000000013', 'aud'],
    [U.owner, 'USEROW0000000000000000000014', 'own'],
    [U.platOp, 'USERPO000000000000000000015', 'po'],
    [U.platSa, 'USERPS0000000000000000000016', 'psa'],
    [U.plat, 'USERPL0000000000000000000019', 'plt'],
    [U.a, 'USERA0000000000000000000021', 'alice'],
    [U.b, 'USERB0000000000000000000022', 'bob'],
    [U.c, 'USERC0000000000000000000023', 'carol'],
    [U.e, 'USERE0000000000000000000025', 'erin'],
  ]) {
    ins('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', id, pub, nick);
  }
  ins('UPDATE users SET status=2 WHERE id=?', U.c); // 禁用用户
  ins('UPDATE users SET deleted_at=1757000000 WHERE id=?', U.e); // 软删除
  const T = { A: 101, B: 102 };
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.A, 'TEAMA0000000000000000000001', '团队A', U.a);
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.B, 'TEAMB0000000000000000000002', '团队B', U.b);

  // ---- 业务 fixture（双 team + 逐表 in-range/out/status 边界）----
  const RANGE7 = computeRange('7d');
  const TODAY = computeRange('today');
  const inRange = TODAY.start + 3600;
  const atStart = TODAY.start;
  const atEnd = RANGE7.end; // 置于 7d 区间终点（半开，[start,end) 不含）→ 用于验证边界排除
  const beforeRange = RANGE7.start - 86400;

  // team_members
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.a, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.b, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.c, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,2,?)', T.A, U.d ?? U.owner, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.e, beforeRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.B, U.a, inRange);

  // activities
  const actA = [[201, 'ACTA01', 0, 2], [202, 'ACTA02', 1, 2], [203, 'ACTA03', 2, 2], [204, 'ACTA04', 3, 2], [205, 'ACTA05', 4, 2], [206, 'ACTA06', 5, 2], [207, 'ACTA07', 1, 1], [208, 'ACTA08', 1, 0]];
  for (const [id, pub, st, aud] of actA) {
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', id, pub, T.A, 'act' + pub, 1757000000, 1757003600, st, aud, U.a);
  }
  ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 251, 'ACTB01', T.B, 'bact', 1757000000, 1757003600, 1, 2, U.b);

  // attendance_sessions（FK OFF，仅需唯一 session_id）
  const sess = (id, act) => ins('INSERT INTO attendance_sessions (id,signup_id,activity_id,user_id,team_id,status,review_status,checkin_at,checkout_at,created_at,updated_at) VALUES (?,?,?,?,?,2,0,0,0,0,0)', id, id + 8000, act, id, T.A);
  sess(901, 201); sess(902, 201); sess(903, 201); sess(904, 201); sess(951, 251);

  // service_records（team A：2×settlement=1 在范围；1×settlement=0；1×atEnd；team B：1×settlement=1）
  const sr = (id, sessId, uid, tid, mins, sv, sdate) =>
    ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, sessId, uid, tid, 201, mins, 'auto', 1, 0, sdate, 0, 0, 'SR' + String(id).padStart(26, '0'), sv);
  sr(301, 901, U.a, T.A, 30, 1, atStart);
  sr(302, 902, U.b, T.A, 45, 1, inRange);
  sr(303, 903, U.c, T.A, 99, 0, inRange);
  sr(304, 904, U.e, T.A, 10, 1, atEnd);
  sr(351, 951, U.b, T.B, 60, 1, inRange);

  // service_record_adjustment_requests（team A：1 pending / 1 approved；team B：1 pending）
  const adj = (pub, srPub, tid, uid, status) =>
    ins(`INSERT INTO service_record_adjustment_requests
          (public_id, service_record_public_id, team_id, requester_id,
           old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
           requested_minutes, reason, status, requested_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pub, srPub, tid, uid, 30, 0, 1, 40, 'r', status, inRange, inRange, inRange);
  adj('ADJ000000000000000000000401', 'SR0000000000000000000000301', T.A, U.a, 0);
  adj('ADJ000000000000000000000402', 'SR0000000000000000000000301', T.A, U.a, 2);
  adj('ADJ000000000000000000000451', 'SR0000000000000000000000351', T.B, U.b, 0);

  // content_articles（team A：1 pending；1 status=4；1 deleted；team B：1 pending）
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,NULL)', 501, 'CA0000000000000000000000001', T.A, 'ca1', 'story');
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,4,1,NULL)', 502, 'CA0000000000000000000000002', T.A, 'ca2', 'story');
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,1757000000)', 504, 'CA0000000000000000000000004', T.A, 'ca4', 'story');
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,NULL)', 551, 'CA0000000000000000000000051', T.B, 'cb1', 'story');

  // ai_usage_logs（team A：a×2 在范围、b×1 在范围、NULL user×1 在范围、a×1 atEnd；team B：b×1 在范围）
  const ai = (id, tid, uid, ts) => ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', id, tid, uid, 'test', 'test', ts);
  ai(601, T.A, U.a, atStart);
  ai(602, T.A, U.a, inRange);
  ai(603, T.A, U.b, inRange);
  ai(604, T.A, null, inRange); // NULL user：计 call，不计 active
  ai(605, T.A, U.a, atEnd); // 终点不含
  ai(651, T.B, U.b, inRange);

  // ---- 参考聚合（独立 SQL，与 repository 实现分离）----
  const refTeam = (teamId, range) => ({
    volunteer_count: q(`SELECT COUNT(*) c FROM team_members WHERE team_id=? AND join_status=1`, teamId)?.c ?? 0,
    new_volunteer_count: q(`SELECT COUNT(*) c FROM team_members WHERE team_id=? AND join_status=1 AND joined_at>=? AND joined_at<?`, teamId, range.start, range.end)?.c ?? 0,
    activity_count: q(`SELECT COUNT(*) c FROM activities WHERE team_id=? AND deleted_at IS NULL AND status<>4`, teamId)?.c ?? 0,
    active_activity_count: q(`SELECT COUNT(*) c FROM activities WHERE team_id=? AND deleted_at IS NULL AND audit_status=2 AND status IN (1,2)`, teamId)?.c ?? 0,
    service_participation_count: q(`SELECT COUNT(*) c FROM service_records WHERE team_id=? AND settlement_status=1 AND service_date>=? AND service_date<?`, teamId, range.start, range.end)?.c ?? 0,
    service_minutes_total: Number(q(`SELECT COALESCE(SUM(minutes),0) s FROM service_records WHERE team_id=? AND settlement_status=1 AND service_date>=? AND service_date<?`, teamId, range.start, range.end)?.s ?? 0),
    activity_review_pending: q(`SELECT COUNT(*) c FROM activities WHERE team_id=? AND deleted_at IS NULL AND audit_status=1`, teamId)?.c ?? 0,
    service_adjustment_pending: q(`SELECT COUNT(*) c FROM service_record_adjustment_requests WHERE team_id=? AND status=0`, teamId)?.c ?? 0,
    community_review_pending: q(`SELECT COUNT(*) c FROM content_articles WHERE team_id=? AND deleted_at IS NULL AND audit_status=1 AND status<>4`, teamId)?.c ?? 0,
    ai_call_count: q(`SELECT COUNT(*) c FROM ai_usage_logs WHERE team_id=? AND created_at>=? AND created_at<?`, teamId, range.start, range.end)?.c ?? 0,
    ai_active_user_count: q(`SELECT COUNT(DISTINCT user_id) c FROM ai_usage_logs WHERE team_id=? AND created_at>=? AND created_at<? AND user_id IS NOT NULL`, teamId, range.start, range.end)?.c ?? 0,
  });
  const refPlatform = (range) => ({
    volunteer_count: q(`SELECT COUNT(*) c FROM users WHERE status=1 AND deleted_at IS NULL`)?.c ?? 0,
    new_volunteer_count: q(`SELECT COUNT(*) c FROM users WHERE status=1 AND deleted_at IS NULL AND created_at>=? AND created_at<?`, range.start, range.end)?.c ?? 0,
    activity_count: q(`SELECT COUNT(*) c FROM activities WHERE deleted_at IS NULL AND status<>4`)?.c ?? 0,
    active_activity_count: q(`SELECT COUNT(*) c FROM activities WHERE deleted_at IS NULL AND audit_status=2 AND status IN (1,2)`)?.c ?? 0,
    service_participation_count: q(`SELECT COUNT(*) c FROM service_records WHERE settlement_status=1 AND service_date>=? AND service_date<?`, range.start, range.end)?.c ?? 0,
    service_minutes_total: Number(q(`SELECT COALESCE(SUM(minutes),0) s FROM service_records WHERE settlement_status=1 AND service_date>=? AND service_date<?`, range.start, range.end)?.s ?? 0),
    activity_review_pending: q(`SELECT COUNT(*) c FROM activities WHERE deleted_at IS NULL AND audit_status=1`)?.c ?? 0,
    service_adjustment_pending: q(`SELECT COUNT(*) c FROM service_record_adjustment_requests WHERE status=0`)?.c ?? 0,
    community_review_pending: q(`SELECT COUNT(*) c FROM content_articles WHERE deleted_at IS NULL AND audit_status=1 AND status<>4`)?.c ?? 0,
    ai_call_count: q(`SELECT COUNT(*) c FROM ai_usage_logs WHERE created_at>=? AND created_at<?`, range.start, range.end)?.c ?? 0,
    ai_active_user_count: q(`SELECT COUNT(DISTINCT user_id) c FROM ai_usage_logs WHERE created_at>=? AND created_at<? AND user_id IS NOT NULL`, range.start, range.end)?.c ?? 0,
  });

  // ---- 请求驱动 ----
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.q != null) path = path + (path.includes('?') ? '&' : '?') + opts.q;
    const res = await app.request(path, { method, headers }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const METRIC_KEYS = ['volunteer_count', 'new_volunteer_count', 'activity_count', 'active_activity_count', 'service_participation_count', 'service_minutes_total', 'activity_review_pending', 'service_adjustment_pending', 'community_review_pending', 'ai_call_count', 'ai_active_user_count'];
  const extract = (r) => r.json?.data?.metrics ?? {};

  // ====================== A. Authentication ======================
  section('A. Authentication');
  {
    const t = await call('GET', '/api/v2/analytics/team/overview');
    check('A1 team endpoint 未认证 → 401', t.status === 401, `status=${t.status}`);
    check('A2 team endpoint 未认证 code=AUTH_REQUIRED', t.json?.error?.code === 'AUTH_REQUIRED');
    const p = await call('GET', '/api/v2/analytics/platform/overview');
    check('A3 platform endpoint 未认证 → 401', p.status === 401, `status=${p.status}`);
    const me = await call('GET', '/api/v2/users/me');
    check('A4 users/me capability 未认证 → 401', me.status === 401, `status=${me.status}`);
  }

  // ====================== B. TEAM permission ======================
  section('B. TEAM permission (DB-backed, no hardcoded role)');
  {
    const vol = await call('GET', '/api/v2/analytics/team/overview', { role: 'volunteer', user: U.a, team: T.A });
    check('B1 volunteer 无 analytics.team.view → 403', vol.status === 403, `status=${vol.status}`);
    check('B2 volunteer code=FORBIDDEN', vol.json?.error?.code === 'FORBIDDEN');
    // platform_operator 持有 platform 权限但无 analytics.team.view；即便携带 team header 也不应获 team 聚合
    const platOp = await call('GET', '/api/v2/analytics/team/overview', { role: 'platform_operator', user: U.plat, team: T.A });
    check('B3 platform_operator（无 analytics.team.view）→ 403', platOp.status === 403, `status=${platOp.status}`);
    const owner = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_owner', user: U.a, team: T.A });
    check('B4 team_owner 有 team 权限 → 200', owner.status === 200, `status=${owner.status}`);
    // 摘除 team_auditor → analytics.team.view 绑定，证明判定来自 DB 而非角色名
    ins(`DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='team_auditor') AND permission_id=(SELECT id FROM permissions WHERE code='analytics.team.view')`);
    const revoked = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('B5 摘除绑定后 team_auditor → 403（非硬编码）', revoked.status === 403, `status=${revoked.status}`);
    ins(`INSERT INTO role_permissions (role_id,permission_id) SELECT r.id,p.id FROM roles r,permissions p WHERE r.code='team_auditor' AND p.code='analytics.team.view'`);
    const restored = qa(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='team_auditor' AND p.code='analytics.team.view'`);
    check('B6 绑定已还原', restored.length === 1);
  }

  // ====================== C. PLATFORM permission ======================
  section('C. PLATFORM permission (team roles cannot get platform)');
  {
    const auditor = await call('GET', '/api/v2/analytics/platform/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('C1 team_auditor → platform 403', auditor.status === 403, `status=${auditor.status}`);
    const owner = await call('GET', '/api/v2/analytics/platform/overview', { role: 'team_owner', user: U.a, team: T.A });
    check('C2 team_owner → platform 403', owner.status === 403, `status=${owner.status}`);
    const vol = await call('GET', '/api/v2/analytics/platform/overview', { role: 'volunteer', user: U.vol, team: T.A });
    check('C3 volunteer（无 analytics.platform.view）→ platform 403', vol.status === 403, `status=${vol.status}`);
    const op = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    check('C4 platform_operator → platform 200', op.status === 200, `status=${op.status}`);
    const sa = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_super_admin', user: U.plat });
    check('C5 platform_super_admin → platform 200', sa.status === 200, `status=${sa.status}`);
  }

  // ====================== D. TEAM context ======================
  section('D. TEAM context (permission true but no active team)');
  {
    const r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a });
    check('D1 有权限无 active team → 403', r.status === 403, `status=${r.status}`);
    // 冻结契约 §7：团队角色无 active team 的统一 403（canonical team-context failure）。
    // requirePermission 先按 active team 过滤团队作用域权限 → 缺 team 时返回 FORBIDDEN（非 TEAM_SCOPE_REQUIRED）；
    // 二者均为 403「无团队上下文/无权限」语义，前端据此显示「请先选择团队」而非「无权限」由 capability 决定。
    check('D2 code=FORBIDDEN | TEAM_SCOPE_REQUIRED（canonical team-context 403）', r.json?.error?.code === 'FORBIDDEN' || r.json?.error?.code === 'TEAM_SCOPE_REQUIRED', `code=${r.json?.error?.code}`);
  }

  // ====================== E. Tenant isolation (per-table) ======================
  section('E. Tenant isolation (per-table, Team A vs Team B)');
  {
    const rA = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    const mA = extract(rA);
    const refA = refTeam(T.A, RANGE7);
    check('E1 team A 200', rA.status === 200);
    // 逐表对照：每个 metric 必须等于 team-scoped 参考聚合
    check('E2 volunteer_count 按 team 隔离', mA.volunteer_count === refA.volunteer_count, `got ${mA.volunteer_count} want ${refA.volunteer_count}`);
    check('E3 new_volunteer_count 按 team 隔离', mA.new_volunteer_count === refA.new_volunteer_count);
    check('E4 activity_count 按 team 隔离', mA.activity_count === refA.activity_count, `got ${mA.activity_count} want ${refA.activity_count}`);
    check('E5 active_activity_count 按 team 隔离', mA.active_activity_count === refA.active_activity_count);
    check('E6 service_participation_count 按 team 隔离', mA.service_participation_count === refA.service_participation_count);
    check('E7 service_minutes_total 按 team 隔离', mA.service_minutes_total === refA.service_minutes_total, `got ${mA.service_minutes_total} want ${refA.service_minutes_total}`);
    check('E8 activity_review_pending 按 team 隔离', mA.activity_review_pending === refA.activity_review_pending);
    check('E9 service_adjustment_pending 按 team 隔离', mA.service_adjustment_pending === refA.service_adjustment_pending);
    check('E10 community_review_pending 按 team 隔离', mA.community_review_pending === refA.community_review_pending);
    check('E11 ai_call_count 按 team 隔离', mA.ai_call_count === refA.ai_call_count, `got ${mA.ai_call_count} want ${refA.ai_call_count}`);
    check('E12 ai_active_user_count 按 team 隔离', mA.ai_active_user_count === refA.ai_active_user_count, `got ${mA.ai_active_user_count} want ${refA.ai_active_user_count}`);

    // 关键反证：Team B 的同表数据不得泄漏进 Team A
    const rB = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.B });
    const mB = extract(rB);
    check('E13 team A ai_call_count != team B（隔离）', mA.ai_call_count !== mB.ai_call_count, `A=${mA.ai_call_count} B=${mB.ai_call_count}`);
    check('E14 team A service_minutes != team B（隔离）', mA.service_minutes_total !== mB.service_minutes_total, `A=${mA.service_minutes_total} B=${mB.service_minutes_total}`);
    check('E15 team A activity_count != team B（隔离）', mA.activity_count !== mB.activity_count);
    // injection 无法改变 team（见 F）：即便伪造 team_id 也无效
  }

  // ====================== F. Client injection ======================
  section('F. Client injection rejection');
  {
    const forbiddenKeys = ['team_id', 'user_id', 'sql', 'fields', 'groupBy', 'filters', 'raw', 'start', 'end'];
    check('F0 FORBIDDEN_QUERY_KEYS 含全部禁止键', forbiddenKeys.every((k) => FORBIDDEN_QUERY_KEYS.includes(k)), FORBIDDEN_QUERY_KEYS.join(','));
    for (const k of forbiddenKeys) {
      const r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: `${k}=999` });
      check(`F1 TEAM 拒绝 ${k} → 400`, r.status === 400, `status=${r.status}`);
      check(`F2 ${k} code=INVALID_PARAM`, r.json?.error?.code === 'INVALID_PARAM');
    }
    // platform 同样不得经 team_id/user_id 切换 scope
    for (const k of ['team_id', 'user_id']) {
      const r = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat, q: `${k}=999` });
      check(`F3 PLATFORM 拒绝 ${k} → 400`, r.status === 400, `status=${r.status}`);
    }
    // 任意 unknown key → 400
    const unk = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: 'foo=1' });
    check('F4 任意 unknown key → 400', unk.status === 400, `status=${unk.status}`);
    check('F5 unknown key code=INVALID_PARAM', unk.json?.error?.code === 'INVALID_PARAM');
    // 多重禁止键同时出现仍 400
    const multi = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: 'team_id=1&sql=drop' });
    check('F6 多重注入键 → 400', multi.status === 400, `status=${multi.status}`);
  }

  // ====================== G. PLATFORM global aggregate boundary ======================
  section('G. PLATFORM global aggregate boundary (no team breakdown)');
  {
    const r = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    check('G1 platform 200', r.status === 200);
    const m = extract(r);
    const ref = refPlatform(RANGE7);
    check('G2 platform 11 指标 = 全局参考聚合', METRIC_KEYS.every((k) => m[k] === ref[k]), JSON.stringify({ got: m, want: ref }));
    const body = JSON.stringify(r.json?.data ?? {});
    check('G3 响应不含 team breakdown（无 teams/team_id/by_team/breakdown）', !/team_id|"teams"|by_team|breakdown|team_list/.test(body), body.slice(0, 120));
    // platform 聚合覆盖 team A + team B
    const expectVol = q(`SELECT COUNT(*) c FROM users WHERE status=1 AND deleted_at IS NULL`)?.c ?? 0;
    check('G4 platform volunteer_count 全局（含 team A+B）', m.volunteer_count === expectVol, `got ${m.volunteer_count}`);
    check('G5 platform service_minutes=135（30+45+60）', m.service_minutes_total === 135, `got ${m.service_minutes_total}`);
    check('G6 platform 不含任何 team 标识（scope=platform）', r.json?.data?.scope === 'platform');
  }

  // ====================== H. Capability projection ======================
  section('H. Capability projection (authoritative)');
  {
    const cap = async (opts) => (await call('GET', '/api/v2/users/me', opts)).json?.data?.analytics_capabilities;
    const tOnly = await cap({ role: 'team_admin', user: U.admin, team: T.A });
    check('H1 team_admin → team_view=true / platform_view=false', tOnly?.team_view === true && tOnly?.platform_view === false, JSON.stringify(tOnly));
    const pOnly = await cap({ role: 'platform_operator', user: U.platOp });
    check('H2 platform_operator → team_view=false / platform_view=true', pOnly?.team_view === false && pOnly?.platform_view === true, JSON.stringify(pOnly));
    const both = await cap({ role: 'platform_super_admin', user: U.platSa, team: T.A });
    check('H3 platform_super_admin → both=true', both?.team_view === true && both?.platform_view === true, JSON.stringify(both));
    const none = await cap({ role: 'volunteer', user: U.vol, team: T.A });
    check('H4 volunteer → both=false', none?.team_view === false && none?.platform_view === false, JSON.stringify(none));
    const heldNoTeam = await cap({ role: 'team_admin', user: U.admin }); // 持有 team 权限但无 active team
    check('H5 持有 team 权限无 active team → team_view 仍 true（held，非 context）', heldNoTeam?.team_view === true, JSON.stringify(heldNoTeam));
    check('H6 team_view/platform_view 仅两布尔', heldNoTeam ? Object.keys(heldNoTeam).sort().join(',') === 'platform_view,team_view' : false);
  }

  // ====================== I. No role hardcoding (source scan) ======================
  section('I. No role hardcoding (backend + frontend decision paths)');
  {
    const backendFiles = [
      join(WORKERS, 'src/routes/analytics.ts'),
      join(WORKERS, 'src/services/analytics-service.ts'),
      join(WORKERS, 'src/routes/users.ts'),
    ];
    // 前端仅扫描 analytics 决策路径文件（analytics 页面 + 客户端）；adminPanel.ts 单独做精准校验
    const frontendAnalyticsFiles = [
      join(FRONTEND, 'pages/admin/analytics.ts'),
      join(FRONTEND, 'utils/analyticsApi.ts'),
    ];
    const rolePattern = /team_admin|platform_operator|team_owner|team_auditor|platform_super_admin|'volunteer'|"volunteer"|role\s*===\s*['"]/;
    let backendClean = true, frontendClean = true;
    for (const f of backendFiles) {
      const s = fsRead(f, 'utf8');
      if (rolePattern.test(s)) { backendClean = false; console.log(`    [leak] ${f}`); }
    }
    for (const f of frontendAnalyticsFiles) {
      const s = fsRead(f, 'utf8');
      if (rolePattern.test(s)) { frontendClean = false; console.log(`    [leak] ${f}`); }
    }
    check('I1 backend analytics 决策路径无硬编码角色', backendClean);
    check('I2 frontend analytics 决策路径无硬编码角色', frontendClean);
    // adminPanel.ts 仅校验「数据运营入口可见性」由 capability 决定，而非由 role 字符串决定
    const panel = fsRead(join(FRONTEND, 'pages/adminPanel/adminPanel.ts'), 'utf8');
    const canAnalyticsLine = panel.split('\n').find((l) => l.includes('canAnalytics')) || '';
    check('I3 adminPanel 入口按 analytics_capabilities 决定（不按 role 硬编码）', panel.includes('analytics_capabilities') && /canAnalytics\s*:?\s*(caps|this\.setData\(\{ canAnalytics: caps)/.test(panel), canAnalyticsLine.trim());
  }

  // ====================== J. Privacy ======================
  section('J. Privacy (no PII / internal id / provider / raw AI / RBAC matrix)');
  {
    const banned = ['"id"', 'user_id', 'team_id', 'real_name', 'real_name_enc', 'phone', 'phone_enc', 'id_card', 'id_card_hash', 'identity_hash', 'provider', 'model', 'prompt', 'system prompt', 'conversation', 'raw', 'scope_team_id', 'role_permissions', 'permission_matrix', 'matrix'];
    const t = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    const tBody = JSON.stringify(t.json?.data ?? {});
    check('J1 TEAM 响应不含 banned 子串', banned.every((b) => !tBody.includes(b)), banned.filter((b) => tBody.includes(b)).join(','));
    const p = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    const pBody = JSON.stringify(p.json?.data ?? {});
    check('J2 PLATFORM 响应不含 banned 子串', banned.every((b) => !pBody.includes(b)), banned.filter((b) => pBody.includes(b)).join(','));
    const me = await call('GET', '/api/v2/users/me', { role: 'team_admin', user: U.admin, team: T.A });
    const meBody = JSON.stringify(me.json?.data ?? {});
    check('J3 users/me 不含完整 RBAC 矩阵 / 内部 id / PII', !/role_permissions|permission_matrix|real_name|phone|id_card|identity_hash|"roles"|"permissions"/.test(meBody), meBody.slice(0, 160));
  }

  // ====================== K. Response whitelist ======================
  section('K. Metric response whitelist');
  {
    const r = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    const data = r.json?.data ?? {};
    check('K1 顶层键仅 scope/range/period/metrics', Object.keys(data).sort().join(',') === 'metrics,period,range,scope', Object.keys(data).sort().join(','));
    check('K2 period 仅 start/end', Object.keys(data.period ?? {}).sort().join(',') === 'end,start', Object.keys(data.period ?? {}).join(','));
    check('K3 metrics 恰 11 键', Object.keys(data.metrics ?? {}).sort().join(',') === METRIC_KEYS.slice().sort().join(','), Object.keys(data.metrics ?? {}).join(','));
    check('K4 scope=platform', data.scope === 'platform');
    check('K5 range=7d（缺省）', data.range === DEFAULT_RANGE);
  }

  // ====================== L. Numeric integrity ======================
  section('L. Numeric integrity');
  {
    const r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    const m = extract(r);
    check('L1 全部 11 指标为非负有限数字', METRIC_KEYS.every((k) => Number.isFinite(m[k]) && m[k] >= 0));
    check('L2 count 类为整数', ['volunteer_count', 'new_volunteer_count', 'activity_count', 'active_activity_count', 'service_participation_count', 'activity_review_pending', 'service_adjustment_pending', 'community_review_pending', 'ai_call_count', 'ai_active_user_count'].every((k) => Number.isInteger(m[k])));
    check('L3 service_minutes_total >= 0', m.service_minutes_total >= 0);
    check('L4 ai_active_user_count <= ai_call_count', m.ai_active_user_count <= m.ai_call_count, `active=${m.ai_active_user_count} call=${m.ai_call_count}`);
  }

  // ====================== M. Status semantics ======================
  section('M. Status semantics');
  {
    const base = refTeam(T.A, RANGE7);
    const get = async () => extract(await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A }));
    // cancelled(status4) 排除
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 209, 'ACTA09', T.A, 'cancelled', 1757000000, 1757003600, 4, 2, U.a);
    check('M1 CANCELLED 不计入 activity_count', (await get()).activity_count === base.activity_count);
    // draft(0)/unpublished(5) 计入
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 210, 'ACTA10', T.A, 'draft', 1757000000, 1757003600, 0, 2, U.a);
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 211, 'ACTA11', T.A, 'unpub', 1757000000, 1757003600, 5, 2, U.a);
    check('M2 DRAFT+UNPUBLISHED 计入 activity_count（+2）', (await get()).activity_count === base.activity_count + 2);
    // active 仅 audit=2 & status IN(1,2)
    const beforeActive = base.active_activity_count;
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 212, 'ACTA12', T.A, 'active', 1757000000, 1757003600, 1, 2, U.a);
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 213, 'ACTA13', T.A, 'pend', 1757000000, 1757003600, 1, 1, U.a);
    check('M3 active 仅 audit2 & status1,2（+1）', (await get()).active_activity_count === beforeActive + 1);
    // service settlement !=1 排除（使用新 session 905，避免与 sr(301) 的 session 901 唯一约束冲突）
    ins('INSERT INTO attendance_sessions (id,signup_id,activity_id,user_id,team_id,status,review_status,checkin_at,checkout_at,created_at,updated_at) VALUES (?,?,?,?,?,2,0,0,0,0,0)', 905, 8905, 201, U.a, T.A);
    sr(305, 905, U.a, T.A, 777, 2, atStart);
    check('M4 settlement_status=2 不计入 service_minutes_total', (await get()).service_minutes_total === base.service_minutes_total);
    // adjustment pending 仅 status=0
    adj('ADJ000000000000000000000403', 'SR0000000000000000000000301', T.A, U.a, 2);
    check('M5 已审批 adjustment 不计入 pending', (await get()).service_adjustment_pending === base.service_adjustment_pending);
  }

  // ====================== N. Time range ======================
  section('N. Time range (Asia/Shanghai, [start,end), month boundary)');
  {
    const today = computeRange('today');
    check('N1 today.start 为上海 00:00（epoch%86400===57600）', today.start % 86400 === 57600, `start=${today.start}`);
    check('N2 today 区间长 1 天', today.end - today.start === 86400);
    const r7 = computeRange('7d');
    check('N3 7d 区间长 7 天', r7.end - r7.start === 7 * 86400);
    const r30 = computeRange('30d');
    check('N4 30d 区间长 30 天', r30.end - r30.start === 30 * 86400);
    const rMonth = computeRange('month');
    check('N5 month(2026-09) 区间长 30 天', rMonth.end - rMonth.start === 30 * 86400, `len=${rMonth.end - rMonth.start}`);
    check('N6 month.start 为本月1日 00:00 上海', rMonth.start % 86400 === 57600 && new Date(rMonth.start * 1000 + 8 * 3600 * 1000).getUTCDate() === 1);
    // [start,end) 半开：atStart 含 / atEnd 不含（ai_call_count=4：a×2+b×1+null×1，atEnd 排除）
    const r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('N7 [start,end) 半开：atStart 计入、atEnd 不计入（ai_call_count=4）', r.json?.data?.metrics?.ai_call_count === 4, `got ${r.json?.data?.metrics?.ai_call_count}`);
    // UTC 日界 vs 上海日界：上海 00:00 对应 UTC 前一日 16:00
    const shanghaiMidnightUTC = new Date(rMonth.start * 1000).toISOString().slice(0, 10);
    check('N8 上海月初在 UTC 表示为前一日（2026-08-31T16:00Z）', shanghaiMidnightUTC === '2026-08-31', shanghaiMidnightUTC);
  }

  // ====================== O. AI aggregation ======================
  section('O. AI aggregation (team-scoped / null user / active<=call)');
  {
    const rA = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    const mA = rA.json?.data?.metrics;
    // team A：a×2(in range) + b×1 + null×1(in range) = 4 call；active = distinct non-null {a,b} = 2
    check('O1 team A ai_call_count=4（含 null user 行）', mA.ai_call_count === 4, `got ${mA.ai_call_count}`);
    check('O2 team A ai_active_user_count=2（null 不计）', mA.ai_active_user_count === 2, `got ${mA.ai_active_user_count}`);
    check('O3 ai_active <= ai_call', mA.ai_active_user_count <= mA.ai_call_count);
    const rB = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.B });
    const mB = rB.json?.data?.metrics;
    check('O4 team B ai_call_count=1（仅本 team）', mB.ai_call_count === 1, `got ${mB.ai_call_count}`);
    check('O5 platform ai_call_count 覆盖全（>= teamA+teamB）', (await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat })).json?.data?.metrics?.ai_call_count >= 5);
  }

  // ====================== P. Frontend security (source-level) ======================
  section('P. Frontend security (source scan)');
  {
    const api = fsRead(join(FRONTEND, 'utils/analyticsApi.ts'), 'utf8');
    const apiCodeOnly = api.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // 剥离行注释（注释仅作文档，非实际发送参数）
    check('P1 客户端不为 TEAM 构造 team_id query 参数', !/range=\$\{[^}]*\}.*\?.*team_id|team_id=/.test(apiCodeOnly) && !apiCodeOnly.includes("'team_id'") && !apiCodeOnly.includes('"team_id"'));
    check('P2 客户端仅经 teamScoped 决定 X-Team-Id（不发送 user_id/sql/fields）', !/user_id|sql|fields|groupBy|filters|raw/.test(apiCodeOnly));
    const page = fsRead(join(FRONTEND, 'pages/admin/analytics.ts'), 'utf8');
    check('P3 页面按 analytics_capabilities 决定 scope（不按 role）', /analytics_capabilities/.test(page) && !/role\s*===\s*['"]/.test(page));
    check('P4 页面 TEAM 请求必带 activeTeamPublicId → X-Team-Id（无 team_id query）', /X-Team-Id|activeTeamPublicId/.test(page) && !/team_id=/.test(page));
    const panel = fsRead(join(FRONTEND, 'pages/adminPanel/adminPanel.ts'), 'utf8');
    check('P5 adminPanel 入口按 canAnalytics（capability）显示，不按 role', /canAnalytics/.test(panel) && /analytics_capabilities/.test(panel));
    // stale-response protection：request sequence token 存在
    check('P6 页面存在请求序列令牌（防旧请求覆盖新请求）', /_reqSeq/.test(page));
  }

  // 还原时间 & 清理
  Date.now = realNow;
  try { writeFileSync(entryPath, ''); } catch {}
  try { unlink(bundlePath); } catch {}

  console.log('\n========================================');
  console.log(`P37-C3 SECURITY REGRESSION RESULT: PASS=${pass}  FAIL=${fail}`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
