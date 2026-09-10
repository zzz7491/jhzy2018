/**
 * P37-C1 — Backend Analytics Foundation CONTRACT TEST
 *
 * 在「真实 src/app.ts（esbuild 打包）+ 完整迁移链 + node:sqlite D1 适配器 +
 * 真实中间件链（authContext → tenantContext → csrf → analytics gate → route）」上验证：
 *   A. migration 0030 仅建 idx_tm_team，无新表/新列
 *   B. 11 指标在已知 fixture 下的正确性（对照独立参考 SQL）
 *   C. TEAM 隔离（team A ≠ team B，且无法注入 team_id）
 *   D. PLATFORM 全局聚合、不要求 active team、权限必需
 *   E. 权限（analytics.team.view / analytics.platform.view，DB-backed，不硬编码角色）
 *   F. range：默认 7d / today / 7d / 30d / month / 非法 → 400 / 未知 key → 400
 *   G. 时间边界：[start,end) 半开 / Asia/Shanghai 日界 / month 边界
 *   H. 状态语义：cancelled 排除 / draft+unpublished 计入 activity_count / active 只 1,2 / settlement !=1 排除
 *   I. 隐私：无 PII / numeric id / provider / model / raw AI
 *   J. 仅两个 analytics endpoint
 *
 * 纯契约测试：不修改源码 / 迁移 / frontend / 历史 WIP；不 git add / commit / push。
 * 运行（workers/ 目录）：node tests/p37_c1_analytics_backend.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { D1Database } from './lib/d1-shim.mjs';

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
async function main() {
  // -------------------------------------------------------------------------
  // 0) 冻结时间（上海 2026-09-10 15:30 → UTC 2026-09-10 07:30），
  //    使 range 计算确定性；同时证明 Shanghai 日界（非 UTC）。
  // -------------------------------------------------------------------------
  const FIXED_NOW_MS = Date.UTC(2026, 8, 10, 7, 30, 0); // UTC
  const realNow = Date.now;
  Date.now = () => FIXED_NOW_MS;

  // -------------------------------------------------------------------------
  // A) migration 0030 静态检查
  // -------------------------------------------------------------------------
  section('A. migration 0030 (idx_tm_team only)');
  const migDir = join(WORKERS, 'migrations');
  const migFiles = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  const MIG = '0030_analytics_index.sql';
  check('A1 0030 文件存在', migFiles.includes(MIG));
  check('A2 0030 是最新迁移', migFiles[migFiles.length - 1] === MIG, `latest=${migFiles[migFiles.length - 1]}`);
  const migSql = readFileSync(join(migDir, MIG), 'utf8');
  check('A3 仅含 CREATE INDEX idx_tm_team', /CREATE INDEX IF NOT EXISTS idx_tm_team/i.test(migSql));
  check('A4 无 CREATE TABLE', !/CREATE TABLE/i.test(migSql));
  check('A5 无 ALTER TABLE / ADD COLUMN', !/ALTER TABLE|ADD COLUMN/i.test(migSql));
  check('A6 无 INSERT（不动 RBAC / seeds）', !/INSERT\s+INTO/i.test(migSql));
  check('A7 索引精确 (team_members(team_id, join_status))',
    /idx_tm_team\s*\n?\s*ON\s+team_members\s*\(\s*team_id\s*,\s*join_status\s*\)/i.test(migSql));

  // -------------------------------------------------------------------------
  // 1) 打包真实 app.ts + range helpers
  // -------------------------------------------------------------------------
  const entry = `
export { createApp } from './src/app';
export { computeRange, parseRangeQuery, DEFAULT_RANGE, VALID_RANGES, FORBIDDEN_QUERY_KEYS } from './src/services/analytics-service';
`;
  const entryPath = join(WORKERS, '.p37_c1_entry.ts');
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
  const bundlePath = join(tmpdir(), `p37_c1_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const M = await import(pathToFileURL(bundlePath).href);
  const app = M.createApp();
  const { computeRange, parseRangeQuery, DEFAULT_RANGE, VALID_RANGES, FORBIDDEN_QUERY_KEYS } = M;

  // -------------------------------------------------------------------------
  // 2) sqlite + 完整迁移链 + D1 adapter
  // -------------------------------------------------------------------------
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  for (const f of migFiles) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const d1 = new D1Database(sqlite);

  const ins = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // 索引存在性（迁移已应用）
  const idx = q(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tm_team'`);
  check('A8 idx_tm_team 已创建', !!idx);
  check('A9 仅有 idx_tm_team 一项新增（migration 内）', (migSql.replace(/--.*$/gm, '').match(/CREATE INDEX/gi) || []).length === 1);

  // -------------------------------------------------------------------------
  // 3) 种子（users / teams）。角色与权限来自迁移 seed，不改 RBAC。
  // -------------------------------------------------------------------------
  const U = { a: 11, b: 12, c: 13, d: 14, e: 15, plat: 19 };
  const T = { A: 101, B: 102 };
  for (const [id, pub, nick] of [
    [U.a, 'USERA0000000000000000000011', 'alice'],
    [U.b, 'USERB0000000000000000000012', 'bob'],
    [U.c, 'USERC0000000000000000000013', 'carol'],
    [U.d, 'USERD0000000000000000000014', 'dave'],
    [U.e, 'USERE0000000000000000000015', 'erin'],
    [U.plat, 'USERP0000000000000000000019', 'plat'],
  ]) {
    ins('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)', id, pub, nick);
  }
  // 一个被禁用用户（status=2）与一个软删除用户（status=1 + deleted_at）
  ins('UPDATE users SET status=2 WHERE id=?', U.c);
  ins('UPDATE users SET deleted_at=1757000000 WHERE id=?', U.d);
  // 两个团队
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.A, 'TEAMA0000000000000000000001', '团队A', U.a);
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.B, 'TEAMB0000000000000000000002', '团队B', U.b);

  // -------------------------------------------------------------------------
  // 4) 业务 fixture（覆盖 11 指标 + 双 team + 边界值 + 状态语义）
  // -------------------------------------------------------------------------
  const TODAY = computeRange('today');
  const RANGE7 = computeRange('7d');
  const inRange = TODAY.start + 3600;      // 今日区间内
  const atStart = TODAY.start;             // 区间起点（含）
  const atEnd = TODAY.end;                 // 区间终点（不含）
  const beforeRange = RANGE7.start - 86400; // 7d 之前

  // ---- team_members（volunteer_count / new_volunteer_count）----
  // team A：a(有效,在范围) b(有效,在范围) c(有效,在范围) e(有效,区间外) d(join_status=2 无效)
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.a, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.b, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.c, inRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.A, U.e, beforeRange);
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,2,?)', T.A, U.d, inRange);
  // team B：a(有效,在范围)
  ins('INSERT INTO team_members (team_id,user_id,join_status,joined_at) VALUES (?,?,1,?)', T.B, U.a, inRange);

  // ---- activities（activity_count / active_activity_count / activity_review_pending）----
  // team A：
  //  - status 0 (DRAFT) audit 2          → activity_count 计入；active 不计
  //  - status 1 (SIGNUP_OPEN) audit 2    → activity_count 计入；active 计入
  //  - status 2 (IN_PROGRESS) audit 2    → activity_count 计入；active 计入
  //  - status 3 (ENDED) audit 2          → activity_count 计入；active 不计(status 3 不在 1,2)
  //  - status 4 (CANCELLED) audit 2      → 全部不计
  //  - status 5 (UNPUBLISHED) audit 2    → activity_count 计入；active 不计
  //  - status 1 audit 1 (待审核)          → activity_count 计入；active 不计；review_pending +1
  //  - status 1 audit 0 (DRAFT)           → activity_count 计入；review_pending 不计
  const actA = [
    [201, 'ACTA01', 0, 2], [202, 'ACTA02', 1, 2], [203, 'ACTA03', 2, 2], [204, 'ACTA04', 3, 2],
    [205, 'ACTA05', 4, 2], [206, 'ACTA06', 5, 2], [207, 'ACTA07', 1, 1], [208, 'ACTA08', 1, 0],
  ];
  for (const [id, pub, st, aud] of actA) {
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      id, pub, T.A, 'act'+pub, 1757000000, 1757003600, st, aud, U.a);
  }
  // team B：一个有效活动 (status1 audit2)
  ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    251, 'ACTB01', T.B, 'bact', 1757000000, 1757003600, 1, 2, U.b);
  // 一个全局被取消活动（team B，status4）→ platform activity_count 不计

  // ---- attendance_sessions（service_records.session_id FK；FK OFF 下仅需值唯一，不依赖真实签到行）----
  // 保证 session_id 唯一（service_records UNIQUE(session_id)）。
  const sess = (id, act) =>
    ins('INSERT INTO attendance_sessions (id,signup_id,activity_id,user_id,team_id,status,review_status,checkin_at,checkout_at,created_at,updated_at) VALUES (?,?,?,?,?,2,0,0,0,0,0)',
      id, id + 8000, act, id, T.A);
  sess(901, 201); sess(902, 201); sess(903, 201); sess(904, 201); sess(905, 201); sess(951, 251);

  // ---- service_records（service_participation_count / service_minutes_total）----
  // team A：两条 settlement_status=1 且在范围；一条 settlement_status=0（不计）；一条超出范围（atEnd）
  ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    301, 901, U.a, T.A, 201, 30, 'auto', 1, 0, atStart, 0, 0, 'SR0000000000000000000000301', 1);
  ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    302, 902, U.b, T.A, 201, 45, 'auto', 1, 0, inRange, 0, 0, 'SR0000000000000000000000302', 1);
  ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    303, 903, U.c, T.A, 201, 99, 'auto', 1, 0, inRange, 0, 0, 'SR0000000000000000000000303', 0);
  ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    304, 904, U.e, T.A, 201, 10, 'auto', 1, 0, atEnd, 0, 0, 'SR0000000000000000000000304', 1); // 终点不含
  // team B：一条 settlement=1 在范围
  ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    351, 951, U.b, T.B, 251, 60, 'auto', 1, 0, inRange, 0, 0, 'SR0000000000000000000000351', 1);

  // ---- service_record_adjustment_requests（service_adjustment_pending）----
  // 列：(public_id, service_record_public_id, team_id, requester_id, old_minutes_snapshot,
  //      old_points_awarded_units_snapshot, old_settlement_status_snapshot, requested_minutes,
  //      reason, status, requested_at, created_at, updated_at)
  ins(`INSERT INTO service_record_adjustment_requests
        (public_id, service_record_public_id, team_id, requester_id,
         old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
         requested_minutes, reason, status, requested_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    'ADJ000000000000000000000401', 'SR0000000000000000000000301', T.A, U.a, 30, 0, 1, 40, 'r', inRange, inRange, inRange);
  ins(`INSERT INTO service_record_adjustment_requests
        (public_id, service_record_public_id, team_id, requester_id,
         old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
         requested_minutes, reason, status, requested_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    'ADJ000000000000000000000402', 'SR0000000000000000000000301', T.A, U.a, 30, 0, 1, 40, 'r', inRange, inRange, inRange); // 已审批
  ins(`INSERT INTO service_record_adjustment_requests
        (public_id, service_record_public_id, team_id, requester_id,
         old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
         requested_minutes, reason, status, requested_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    'ADJ000000000000000000000451', 'SR0000000000000000000000351', T.B, U.b, 60, 0, 1, 70, 'r', inRange, inRange, inRange);

  // ---- content_articles（community_review_pending）----
  // team A：audit_status=1 & status<>4（计入）；audit_status=4（不计）；audit_status=1 & status=4（不计）；deleted（不计）
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,NULL)', 501, 'CA0000000000000000000000001', T.A, 'ca1', 'story');
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,4,1,NULL)', 502, 'CA0000000000000000000000002', T.A, 'ca2', 'story'); // status=4 排除
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,4,NULL)', 503, 'CA0000000000000000000000003', T.A, 'ca3', 'story'); // audit 非待审
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,1757000000)', 504, 'CA0000000000000000000000004', T.A, 'ca4', 'story'); // 已删除
  // team B：一条待审
  ins('INSERT INTO content_articles (id,public_id,team_id,title,content_type,status,audit_status,deleted_at) VALUES (?,?,?,?,?,1,1,NULL)', 551, 'CA0000000000000000000000051', T.B, 'cb1', 'story');

  // ---- ai_usage_logs（ai_call_count / ai_active_user_count）----
  // team A：a 两条在范围（count=2, active=1）；b 一条在范围（active+1）；一条 atEnd（不含）
  ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', 601, T.A, U.a, 'test', 'test', atStart);
  ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', 602, T.A, U.a, 'test', 'test', inRange);
  ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', 603, T.A, U.b, 'test', 'test', inRange);
  ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', 604, T.A, U.a, 'test', 'test', atEnd); // 终点不含
  // team B：b 一条在范围
  ins('INSERT INTO ai_usage_logs (id,team_id,user_id,provider,model,created_at) VALUES (?,?,?,?,?,?)', 651, T.B, U.b, 'test', 'test', inRange);

  // -------------------------------------------------------------------------
  // 参考聚合（独立 SQL，与 repository 实现分离，用于对照）
  // -------------------------------------------------------------------------
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
    ai_active_user_count: q(`SELECT COUNT(DISTINCT user_id) c FROM ai_usage_logs WHERE team_id=? AND created_at>=? AND created_at<?`, teamId, range.start, range.end)?.c ?? 0,
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
    ai_active_user_count: q(`SELECT COUNT(DISTINCT user_id) c FROM ai_usage_logs WHERE created_at>=? AND created_at<?`, range.start, range.end)?.c ?? 0,
  });
  const sameMetrics = (a, b) => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
  };

  // -------------------------------------------------------------------------
  // 5) 请求驱动
  // -------------------------------------------------------------------------
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = { 'x-test-role': opts.role, 'x-test-user': String(opts.user), 'x-test-team': String(opts.team) };
    if (opts.q != null) path = path + (path.includes('?') ? '&' : '?') + opts.q;
    const res = await app.request(path, { method, headers: opts.body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  // ====================== B. 指标正确性 + C. 隔离 ======================
  section('B/C. metric correctness & TEAM isolation (default range=7d)');
  {
    const rA = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('B1 team A 200', rA.status === 200, `status=${rA.status}`);
    const mA = rA.json?.data?.metrics ?? {};
    const refA = refTeam(T.A, RANGE7);
    check('B2 team A 11 指标 = 参考聚合', sameMetrics(mA, refA), JSON.stringify({ got: mA, want: refA }));

    const rB = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.B });
    const mB = rB.json?.data?.metrics ?? {};
    const refB = refTeam(T.B, RANGE7);
    check('B3 team B 11 指标 = 参考聚合', sameMetrics(mB, refB), JSON.stringify({ got: mB, want: refB }));
    check('C1 team A ≠ team B（隔离）', JSON.stringify(mA) !== JSON.stringify(mB));
    check('C2 team A volunteer_count=4（a,b,c 有效；e 区间外不计；d join_status=2 不计）', mA.volunteer_count === 4, `got ${mA.volunteer_count}`);
    check('C3 team A new_volunteer_count=3（a,b,c 在范围；e 区间外）', mA.new_volunteer_count === 3, `got ${mA.new_volunteer_count}`);
    check('C4 team A ai_call_count=3（a×2,b×1 在范围；atEnd 不含）', mA.ai_call_count === 3, `got ${mA.ai_call_count}`);
    check('C5 team A ai_active_user_count=2（a,b）', mA.ai_active_user_count === 2, `got ${mA.ai_active_user_count}`);
    check('C6 team A service_minutes_total=75（30+45；atEnd 10 不含；settlement=0 的 99 不计）', mA.service_minutes_total === 75, `got ${mA.service_minutes_total}`);
    check('C7 team B volunteer_count=1（仅 a）', mB.volunteer_count === 1, `got ${mB.volunteer_count}`);
  }

  // ====================== D. PLATFORM ======================
  section('D. PLATFORM global aggregate (no active team required)');
  {
    const r = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    check('D1 platform 200（无 team 头）', r.status === 200, `status=${r.status}`);
    const m = r.json?.data?.metrics ?? {};
    const ref = refPlatform(RANGE7);
    check('D2 platform 11 指标 = 全局参考聚合', sameMetrics(m, ref), JSON.stringify({ got: m, want: ref }));
    // 全局 volunteer_count 应包含全部 status=1 & 未删除用户
    const expectVol = q(`SELECT COUNT(*) c FROM users WHERE status=1 AND deleted_at IS NULL`)?.c ?? 0;
    check('D3 platform volunteer_count 全局', m.volunteer_count === expectVol, `got ${m.volunteer_count} want ${expectVol}`);
    // platform 应包括 team A + team B 的 service_minutes（30+45+60=135；atEnd/settlement0 不计）
    check('D4 platform service_minutes_total=135', m.service_minutes_total === 135, `got ${m.service_minutes_total}`);
    // team_auditor（无 platform 权限）访问 platform → 403
    const denied = await call('GET', '/api/v2/analytics/platform/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('D5 team_auditor → platform 403', denied.status === 403, `status=${denied.status}`);
  }

  // ====================== E. 权限（DB-backed，不硬编码角色）======================
  section('E. permission (DB-backed, no hardcoded role)');
  {
    // volunteer 无 analytics.team.view → 403
    const vol = await call('GET', '/api/v2/analytics/team/overview', { role: 'volunteer', user: U.a, team: T.A });
    check('E1 volunteer → team 403', vol.status === 403, `status=${vol.status}`);
    check('E2 volunteer code=FORBIDDEN', vol.json?.error?.code === 'FORBIDDEN');
    // 临时摘除 team_auditor → analytics.team.view 绑定，证明判定是 DB-backed 而非角色名
    ins(`DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='team_auditor') AND permission_id=(SELECT id FROM permissions WHERE code='analytics.team.view')`);
    const auditorRevoked = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('E3 摘除绑定后 team_auditor → 403', auditorRevoked.status === 403, `status=${auditorRevoked.status}`);
    ins(`INSERT INTO role_permissions (role_id,permission_id) SELECT r.id,p.id FROM roles r,permissions p WHERE r.code='team_auditor' AND p.code='analytics.team.view'`);
    const restored = qa(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='team_auditor' AND p.code='analytics.team.view'`);
    check('E4 绑定已还原', restored.length === 1);
    // platform_super_admin 无 active team 访问 team endpoint → 403 TEAM_SCOPE_REQUIRED
    const psa = await call('GET', '/api/v2/analytics/team/overview', { role: 'platform_super_admin', user: U.plat });
    check('E5 platform_super_admin 无 team → team 403', psa.status === 403, `status=${psa.status}`);
    check('E6 code=TEAM_SCOPE_REQUIRED', psa.json?.error?.code === 'TEAM_SCOPE_REQUIRED');
    // team_owner 持有 analytics.team.view（有 team）→ 200
    const owner = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_owner', user: U.a, team: T.A });
    check('E7 team_owner 有 team → team 200', owner.status === 200, `status=${owner.status}`);
  }

  // ====================== F. range ======================
  section('F. range query');
  {
    const def = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('F1 缺省 range=7d', def.json?.data?.range === DEFAULT_RANGE && DEFAULT_RANGE === '7d', `range=${def.json?.data?.range}`);
    for (const rk of ['today', '7d', '30d', 'month']) {
      const r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: `range=${rk}` });
      check(`F2 range=${rk} → 200 & data.range=${rk}`, r.status === 200 && r.json?.data?.range === rk, `status=${r.status}`);
    }
    const bad = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: 'range=bogus' });
    check('F3 非法 range → 400', bad.status === 400, `status=${bad.status}`);
    check('F4 非法 range code=INVALID_PARAM', bad.json?.error?.code === 'INVALID_PARAM');
    const unk = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: 'foo=1' });
    check('F5 未知 query key → 400', unk.status === 400, `status=${unk.status}`);
    const inj = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A, q: 'team_id=999' });
    check('F6 拒绝 team_id query key → 400', inj.status === 400, `status=${inj.status}`);
    check('F7 FORBIDDEN_QUERY_KEYS 含 team_id/user_id 等', FORBIDDEN_QUERY_KEYS.includes('team_id') && FORBIDDEN_QUERY_KEYS.includes('user_id'));
  }

  // ====================== G. 时间边界 ======================
  section('G. time boundary ([start,end) / Asia/Shanghai / month)');
  {
    // Shanghai 日界：上海 00:00 对应 UTC 16:00（前一天）→ epoch % 86400 === 57600（=16h）
    const today = computeRange('today');
    check('G1 today.start 为上海 00:00（epoch%86400===57600）', today.start % 86400 === 57600, `start=${today.start}`);
    check('G2 today 区间长度 = 1 天', today.end - today.start === 86400);
    const r7 = computeRange('7d');
    check('G3 7d 区间长度 = 7 天', r7.end - r7.start === 7 * 86400);
    const r30 = computeRange('30d');
    check('G4 30d 区间长度 = 30 天', r30.end - r30.start === 30 * 86400);
    const rMonth = computeRange('month');
    // 2026-09 → 30 天
    check('G5 month(2026-09) 区间长度 = 30 天', rMonth.end - rMonth.start === 30 * 86400, `len=${rMonth.end - rMonth.start}`);
    check('G6 month.start 为本月 1 日 00:00 上海', rMonth.start % 86400 === 57600 && new Date(rMonth.start * 1000 + 8 * 3600 * 1000).getUTCDate() === 1);
    // [start,end) 半开：atStart 含 / atEnd 不含（已在 B/C 的 ai_call_count=3 间接验证）
    const rA = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('G7 [start,end) 半开：atStart 计入、atEnd 不计入（ai_call_count=3）', rA.json?.data?.metrics?.ai_call_count === 3);
  }

  // ====================== H. 状态语义 ======================
  section('H. status semantics');
  {
    const base = refTeam(T.A, RANGE7);
    // 新增 CANCELLED 活动 → activity_count 不变
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 209, 'ACTA09', T.A, 'cancelled', 1757000000, 1757003600, 4, 2, U.a);
    let r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('H1 CANCELLED 不计入 activity_count', r.json?.data?.metrics?.activity_count === base.activity_count, `got ${r.json?.data?.metrics?.activity_count} want ${base.activity_count}`);
    // 新增 DRAFT(0)/UNPUBLISHED(5) → activity_count 各 +1
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 210, 'ACTA10', T.A, 'draft', 1757000000, 1757003600, 0, 2, U.a);
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 211, 'ACTA11', T.A, 'unpub', 1757000000, 1757003600, 5, 2, U.a);
    r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('H2 DRAFT+UNPUBLISHED 各计入 activity_count（+2）', r.json?.data?.metrics?.activity_count === base.activity_count + 2);
    // active_activity_count 只含 audit=2 & status IN(1,2)
    const beforeActive = base.active_activity_count;
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 212, 'ACTA12', T.A, 'active', 1757000000, 1757003600, 1, 2, U.a);
    ins('INSERT INTO activities (id,public_id,team_id,title,start_time,end_time,status,audit_status,created_by) VALUES (?,?,?,?,?,?,?,?,?)', 213, 'ACTA13', T.A, 'pend', 1757000000, 1757003600, 1, 1, U.a); // audit=1 不计 active
    r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('H3 active 仅 audit=2 & status 1,2（+1）', r.json?.data?.metrics?.active_activity_count === beforeActive + 1, `got ${r.json?.data?.metrics?.active_activity_count} want ${beforeActive + 1}`);
    // service settlement_status !=1 排除
    ins('INSERT INTO service_records (id,session_id,user_id,team_id,activity_id,minutes,source,status,review_status,service_date,created_at,updated_at,public_id,settlement_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 305, 905, U.a, T.A, 201, 777, 'auto', 1, 0, atStart, 0, 0, 'SR0000000000000000000000305', 2);
    r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('H4 settlement_status=2 不计入 service_minutes_total', r.json?.data?.metrics?.service_minutes_total === base.service_minutes_total, `got ${r.json?.data?.metrics?.service_minutes_total}`);
    // service_adjustment_pending 仅 status=0
    const baseAdj = base.service_adjustment_pending;
    ins(`INSERT INTO service_record_adjustment_requests
          (public_id, service_record_public_id, team_id, requester_id,
           old_minutes_snapshot, old_points_awarded_units_snapshot, old_settlement_status_snapshot,
           requested_minutes, reason, status, requested_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,2,?,?,?)`,
      'ADJ000000000000000000000403', 'SR0000000000000000000000301', T.A, U.a, 30, 0, 1, 40, 'r', inRange, inRange, inRange);
    r = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('H5 已审批(status=2) adjustment 不计入 pending', r.json?.data?.metrics?.service_adjustment_pending === baseAdj, `got ${r.json?.data?.metrics?.service_adjustment_pending}`);
  }

  // ====================== I. 隐私 ======================
  section('I. privacy / no PII / no numeric id / no provider');
  {
    const r = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    const body = JSON.stringify(r.json?.data ?? {});
    const banned = ['"id"', '"user_id"', '"team_id"', '"real_name"', '"real_name_enc"', '"phone"', '"phone_enc"', '"id_card"', '"id_card_hash"', '"identity_hash"', '"provider"', '"model"', '"prompt"', '"system prompt"', '"conversation"', '"raw"'];
    check('I1 响应 data 不含 banned 键/子串', banned.every((b) => !body.includes(b)), `leak=${banned.filter((b) => body.includes(b)).join(',')}`);
    const data = r.json?.data ?? {};
    check('I2 data 仅含 scope/range/period/metrics', Object.keys(data).sort().join(',') === 'metrics,period,range,scope', Object.keys(data).sort().join(','));
    check('I3 scope=platform', data.scope === 'platform');
    check('I4 metrics 恰好 11 键', Object.keys(data.metrics ?? {}).length === 11);
    check('I5 全部指标为非负整数', Object.values(data.metrics ?? {}).every((v) => Number.isInteger(v) && v >= 0));
    check('I6 period 含 start/end（epoch 秒）', typeof data.period?.start === 'number' && typeof data.period?.end === 'number');
  }

  // ====================== J. endpoint 数量 ======================
  section('J. exactly two analytics endpoints');
  {
    const ok1 = await call('GET', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    const ok2 = await call('GET', '/api/v2/analytics/platform/overview', { role: 'platform_operator', user: U.plat });
    check('J1 team/overview → 200', ok1.status === 200);
    check('J2 platform/overview → 200', ok2.status === 200);
    for (const p of ['/api/v2/analytics', '/api/v2/analytics/team', '/api/v2/analytics/platform', '/api/v2/analytics/team/overview/extra', '/api/v2/analytics/stats']) {
      const r = await call('GET', p, { role: 'platform_operator', user: U.plat });
      check(`J3 ${p} → 非 2xx`, r.status >= 400, `status=${r.status}`);
    }
    // POST 不应被允许（只读）
    const post = await call('POST', '/api/v2/analytics/team/overview', { role: 'team_auditor', user: U.a, team: T.A });
    check('J4 POST team/overview → 非 2xx（只读）', post.status >= 400, `status=${post.status}`);
  }

  // 还原时间
  Date.now = realNow;

  // 清理临时入口文件 & bundle
  try { writeFileSync(entryPath, ''); } catch {}
  try { unlink(bundlePath); } catch {}

  console.log('\n========================================');
  console.log(`P37-C1 RESULT: PASS=${pass}  FAIL=${fail}`);
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
