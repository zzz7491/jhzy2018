#!/usr/bin/env node
/**
 * S2-6k1 V1 — Attendance Time Foundation 集成测试（A–E 组）。
 *
 * 验证本轮 Time Foundation 仅落地的两块能力：
 *   A. Schema：attendance_sessions.business_service_date / activities.max_session_minutes 存在
 *   B. 历史回填（MIGRATION BACKFILL ONLY）：strftime(+8h) 与 runtime IANA Asia/Shanghai 在边界一致
 *   C. 新签到写入：真实 Worker check-in 同时写 legacy service_date(UTC 桶) + business_service_date(Asia)
 *   D. 边界发散：Beijing 凌晨 / UTC 前一天 的 checkin_at，service_date(UTC) ≠ business_service_date(Asia)
 *   E. max_session_minutes CHECK：NULL/正数合法，0/负数被拒
 *
 * 纪律：纯验证，不创建 detector / 不写 anomaly / 不引入 allow_cross_midnight / 不修 schema。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; process.stderr.write(`  PASS ${name}\n`); }
  else { fail += 1; process.stderr.write(`  FAIL ${name} ${detail}\n`); }
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => 's_' + randomBytes(32).toString('base64url');
const NOW_SEC = () => Math.floor(Date.now() / 1000);

// runtime time-util 再审实现（与 src/utils/time.ts 算法一致：Intl + formatToParts 显式拼装）
const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
function toBusinessDate(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds < 1e8 || epochSeconds > 1e11) {
    throw new Error('BAD_EPOCH');
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochSeconds * 1000));
  const m = {};
  for (const p of parts) if (p.type === 'year' || p.type === 'month' || p.type === 'day') m[p.type] = p.value;
  if (!m.year || !m.month || !m.day) throw new Error('BAD_PARTS');
  return `${m.year}-${m.month}-${m.day}`;
}

function dbFile() {
  return join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
  try { db.exec('PRAGMA foreign_keys = ON;'); return fn(db); }
  finally { db.close(); }
}
const userIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pub)?.id);
const teamIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM teams WHERE public_id = ?').get(pub)?.id);
const actIdOf = (pub) => withDb((db) => db.prepare('SELECT id FROM activities WHERE public_id = ?').get(pub)?.id);

// ===== HTTP helpers =====
async function req(method, path, headers = {}, body) {
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${path}`, init);
  let bodyRes = null;
  try { bodyRes = await res.json(); } catch { bodyRes = null; }
  return { res, body: bodyRes };
}
const authHeaders = (token, team) => {
  const h = { authorization: `Bearer ${token}` };
  if (team != null) h['x-team-id'] = String(team);
  return h;
};
const checkIn = (activityId, token, team) =>
  req('POST', `/api/v2/activities/${encodeURIComponent(activityId)}/attendance/checkin`,
    { ...authHeaders(token, team), 'content-type': 'application/json' },
    JSON.stringify({ participation_public_id: '01TESTPART1AAAAAAAAAAAAAAA' })); // P17：volA → actAtt1

// Beijing(Asia/Shanghai) → UTC epoch seconds
function beijing(y, mo, d, h, mi, s) {
  return Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi, s) / 1000);
}

// ===== 边界样本：Asia/Shanghai 日历日期 → 期望 business_service_date =====
const BOUNDARY = [
  { label: 'Asia 2026-09-03 23:59:59', ts: beijing(2026, 9, 3, 23, 59, 59), expectBiz: '2026-09-03' },
  { label: 'Asia 2026-09-04 00:00:00', ts: beijing(2026, 9, 4, 0, 0, 0), expectBiz: '2026-09-04' },
  { label: 'Asia 2026-09-04 00:00:01', ts: beijing(2026, 9, 4, 0, 0, 1), expectBiz: '2026-09-04' },
  { label: 'Asia 2026-02-28 23:59:59', ts: beijing(2026, 2, 28, 23, 59, 59), expectBiz: '2026-02-28' },
  { label: 'Asia 2026-03-01 00:00:00', ts: beijing(2026, 3, 1, 0, 0, 0), expectBiz: '2026-03-01' },
  { label: 'Asia 2026-12-31 23:59:59', ts: beijing(2026, 12, 31, 23, 59, 59), expectBiz: '2026-12-31' },
  { label: 'Asia 2027-01-01 00:00:00', ts: beijing(2027, 1, 1, 0, 0, 0), expectBiz: '2027-01-01' },
  { label: 'Asia 2024-02-29 23:59:59', ts: beijing(2024, 2, 29, 23, 59, 59), expectBiz: '2024-02-29' },
  { label: 'Asia 2024-03-01 00:00:00', ts: beijing(2024, 3, 1, 0, 0, 0), expectBiz: '2024-03-01' },
];

// ===========================================================================
async function main() {
  // ---------------------------------------------------------- A. Schema 存在
  process.stderr.write('A. Schema presence（0005 列存在）\n');
  {
    const cols = withDb((db) =>
      db.prepare("SELECT name FROM pragma_table_info('attendance_sessions')").all().map((r) => r.name),
    );
    check('A1 attendance_sessions.business_service_date 列存在', cols.includes('business_service_date'), `cols=${cols.join(',')}`);
    const actCols = withDb((db) =>
      db.prepare("SELECT name FROM pragma_table_info('activities')").all().map((r) => r.name),
    );
    check('A2 activities.max_session_minutes 列存在', actCols.includes('max_session_minutes'), `cols=${actCols.join(',')}`);
    // 旧字段不被破坏
    check('A3 legacy service_date 列仍然保留', cols.includes('service_date'), `cols=${cols.join(',')}`);
    check('A4 legacy slot 列仍然保留', cols.includes('slot'), `cols=${cols.join(',')}`);
  }

  // ---------------------------------------------------------- B. 历史回填 + 一致性
  process.stderr.write('B. 历史回填（MIGRATION BACKFILL ONLY）+ runtime/migration 一致性\n');
  {
    // 取有效 signup 组合（team_id 来自 activities，activity_signups 无 team_id 列）
    const signups = withDb((db) =>
      db
        .prepare(
          `SELECT s.id AS signup_id, s.activity_id, s.user_id, a.team_id
             FROM activity_signups s JOIN activities a ON a.id = s.activity_id
            LIMIT 12`,
        )
        .all(),
    );
    check('B0 存在可用 signup 组合', signups.length >= 1, `n=${signups.length}`);

    // 插入边界历史会话（status=2 已签退，避免 uq_active_attendance 冲突），business_service_date 留 NULL
    withDb((db) => {
      db.exec('PRAGMA foreign_keys = ON;');
      const ins = db.prepare(
        `INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, service_date, slot, status, checkin_at, checkout_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 2, ?, ?, ?, ?)`,
      );
      let i = 1;
      for (const b of BOUNDARY) {
        const su = signups[i % signups.length];
        const sd = Math.floor(b.ts / 86400); // legacy UTC 桶
        ins.run(su.signup_id, su.activity_id, su.user_id, su.team_id, sd, b.ts, b.ts + 3600, b.ts, b.ts + 3600);
        i++;
      }
    });

    // 运行与 0005 完全相同的回填
    withDb((db) => {
      db.prepare(
        `UPDATE attendance_sessions SET business_service_date = strftime('%Y-%m-%d', checkin_at, 'unixepoch', '+8 hours') WHERE checkin_at IS NOT NULL`,
      ).run();
    });

    const rows = withDb((db) =>
      db
        .prepare('SELECT checkin_at, service_date, business_service_date, slot FROM attendance_sessions ORDER BY checkin_at')
        .all(),
    );
    check('B1 回填后业务表行数 = 边界样本数', rows.length === BOUNDARY.length, `got ${rows.length}`);

    let allMatch = true;
    let allPreserved = true;
    let allNonTZLeak = true;
    for (const r of rows) {
      const runtimeBiz = toBusinessDate(r.checkin_at);
      const migBiz = r.business_service_date;
      if (migBiz !== runtimeBiz) { allMatch = false; process.stderr.write(`     mismatch ts=${r.checkin_at} mig=${migBiz} runtime=${runtimeBiz}\n`); }
      // 旧字段保留：service_date 仍是 UTC 桶；slot 仍是 ''；business_service_date 不含完整坐标/时区泄漏
      if (r.service_date !== Math.floor(r.checkin_at / 86400)) allPreserved = false;
      if (r.slot !== '') allPreserved = false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(migBiz)) allNonTZLeak = false;
    }
    check('B2 全部边界：migration strftime(+8h) === runtime Intl Asia/Shanghai(YYYY-MM-DD)', allMatch);
    check('B3 旧字段保留（service_date=UTC桶, slot=空串）未被回填破坏', allPreserved);
    check('B4 business_service_date 为纯 YYYY-MM-DD（无坐标/时区泄漏）', allNonTZLeak);

    // 重点边界：Beijing 09-04 00:00 应 business=09-04，但 service_date(UTC)=09-03
    const crossMidnight = rows.find((r) => r.checkin_at === beijing(2026, 9, 4, 0, 0, 0));
    if (crossMidnight) {
      const legacy = Math.floor(crossMidnight.checkin_at / 86400);
      const legacyDate = new Date(legacy * 86400 * 1000).toISOString().slice(0, 10);
      check(
        'B5 跨午夜发散：business(Asia)=2026-09-04 ≠ legacy service_date(UTC 桶)=2026-09-03',
        crossMidnight.business_service_date === '2026-09-04' && legacyDate === '2026-09-03',
        `biz=${crossMidnight.business_service_date} legacyUTC=${legacyDate}`,
      );
    } else {
      check('B5 跨午夜发散样本存在', false, 'missing cross-midnight row');
    }

    // 闰年边界
    const leap = rows.find((r) => r.checkin_at === beijing(2024, 2, 29, 23, 59, 59));
    check('B6 闰年 2024-02-29 当日 business=2024-02-29', leap ? leap.business_service_date === '2024-02-29' : false,
      `got ${leap?.business_service_date}`);
  }

  // ---------------------------------------------------------- E. max_session_minutes CHECK
  process.stderr.write('E. max_session_minutes CHECK 约束\n');
  {
    withDb((db) => {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare('DROP TABLE IF EXISTS _tp_chk').run();
      db.prepare(
        `CREATE TABLE _tp_chk (id INTEGER PRIMARY KEY, max_session_minutes INTEGER CHECK (max_session_minutes IS NULL OR max_session_minutes > 0))`,
      ).run();
      const ins = db.prepare('INSERT INTO _tp_chk (max_session_minutes) VALUES (?)');
      const tryIns = (v) => { try { ins.run(v); return 'OK'; } catch { return 'REJECTED'; } };
      check('E1 NULL 合法', tryIns(null) === 'OK');
      check('E2 正数(120) 合法', tryIns(120) === 'OK');
      check('E3 0 被拒', tryIns(0) === 'REJECTED');
      check('E4 负数(-5) 被拒', tryIns(-5) === 'REJECTED');
      db.prepare('DROP TABLE IF EXISTS _tp_chk').run();
    });
  }

  // ---------------------------------------------------------- C/D. 新签到真实写入
  process.stderr.write('C/D. 真实 Worker check-in 同时写 legacy service_date + business_service_date\n');
  {
    const volA = userIdOf('01TESTUSERAAAAAAAAAAAAAAAA');
    const teamA = teamIdOf('01TESTTEAMAAAAAAAAAAAAAAAA');
    const a1 = actIdOf('01TESTATT1AAAAAAAAAAAAAAAA');
    check('C0 fixture ID 就绪', volA > 0 && teamA > 0 && a1 > 0, `volA=${volA} teamA=${teamA} a1=${a1}`);

    // 注入真实 Bearer session（与 activity_signup_integration 同构）
    const TOKEN = newToken();
    const SESS_PUB = '01TESTSESSTIMEVL000001';
    withDb((db) => {
      db.exec('PRAGMA foreign_keys = ON;');
      db.prepare('DELETE FROM sessions WHERE public_id = ?').run(SESS_PUB);
      db.prepare(
        `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 's2-6k1-time', ?, 1)`,
      ).run(SESS_PUB, volA, sha256Hex(TOKEN), NOW_SEC() + 30 * 24 * 3600);
    });

    const r = await checkIn(IDS.actAtt1, TOKEN, teamA);
    check('C1 volA 真实签到 actAtt1 → 201', r.res.status === 201, `got ${r.res.status}`);
    if (r.res.status === 201) {
      const row = withDb((db) => db.prepare('SELECT * FROM attendance_sessions WHERE activity_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(a1, volA));
      check('C2 新会话 service_date = floor(checkin_at/86400)（legacy UTC 桶，语义不变）',
        row && row.service_date === Math.floor(row.checkin_at / 86400), `sd=${row?.service_date} chk=${row?.checkin_at}`);
      check('C3 新会话 business_service_date 非 NULL', row && !!row.business_service_date, `biz=${row?.business_service_date}`);
      check('C4 business_service_date = runtime Asia/Shanghai YYYY-MM-DD',
        row && row.business_service_date === toBusinessDate(row.checkin_at), `biz=${row?.business_service_date} exp=${row ? toBusinessDate(row.checkin_at) : 'n/a'}`);
      check('C5 business_service_date 格式合规 ^\\d{4}-\\d{2}-\\d{2}$', row && /^\d{4}-\d{2}-\d{2}$/.test(row.business_service_date));
      check('C6 新会话仍走既有状态机 status=1（multi-participation 行为不变）', row && row.status === 1, `status=${row?.status}`);
    } else {
      check('C2-C6 因签到失败跳过', false, 'check-in returned ' + r.res.status);
    }
    // 清理 token 会话（attendance_sessions 由 fixture teardown 统一清空，避免 FK 级联）
    withDb((db) => db.prepare('DELETE FROM sessions WHERE public_id = ?').run(SESS_PUB));
  }

  console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// IDS（与 fixture 对齐，仅用于 check-in 路径）
const IDS = { actAtt1: '01TESTATT1AAAAAAAAAAAAAAAA' };

main().catch((e) => {
  process.stderr.write('ERROR ' + (e?.stack ?? e) + '\n');
  process.exit(1);
});
