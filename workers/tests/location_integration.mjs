#!/usr/bin/env node
/**
 * S2-6k2 V1 — Location Capture Foundation 集成测试（LOC-REQ / LOC-BND / LOC-ACC / LOC-PERS / LOC-CKO / LOC-TIME）。
 *
 * 验证本轮只落地的「签到位置采集」能力：
 *   - 仅 check-in 解析 body.location（GCJ-02 契约，服务端只验数值合法性）
 *   - 合法 location → attendance_events 写 latitude/longitude/accuracy；distance 恒为 NULL
 *   - 缺失 / null / {} → 合法且坐标列全 NULL（GPS 不可用策略），签到照常 2xx
 *   - 畸形（partial / string / 越界 / accuracy<=0）→ 400 INVALID_PARAM
 *   - checkout 不采位置（CHECK-IN ONLY）
 *   - S2-6k1 时间语义不被破坏（legacy service_date + business_service_date 仍正确）
 *
 * 纪律：纯验证，不创建 detector / 不写 anomaly / 不计算距离 / 不读 activity geo。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8795';
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

// runtime time-util 再审实现（与 src/utils/time.ts 算法一致）
const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
function toBusinessDate(epochSeconds) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochSeconds * 1000));
  const m = {};
  for (const p of parts) if (p.type === 'year' || p.type === 'month' || p.type === 'day') m[p.type] = p.value;
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

const IDS = { actAtt1: '01TESTATT1AAAAAAAAAAAAAAAA' };
const volA = userIdOf('01TESTUSERAAAAAAAAAAAAAAAA');
const teamA = teamIdOf('01TESTTEAMAAAAAAAAAAAAAAAA');
const a1 = actIdOf(IDS.actAtt1);

// 注入真实 Bearer session（与 time_policy / activity_signup 同构）
const TOKEN = newToken();
const SESS_PUB = '01TESTSESSLOCVL0000001';
withDb((db) => {
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare('DELETE FROM sessions WHERE public_id = ?').run(SESS_PUB);
  db.prepare(
    `INSERT INTO sessions (public_id, user_id, token_hash, user_agent, expires_at, status) VALUES (?, ?, ?, 's2-6k2-loc', ?, 1)`,
  ).run(SESS_PUB, volA, sha256Hex(TOKEN), NOW_SEC() + 30 * 24 * 3600);
});

// ===== HTTP helpers =====
async function checkInBody(body) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-team-id': String(teamA) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v2/activities/${encodeURIComponent(IDS.actAtt1)}/attendance/checkin`, {
    method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function checkOutReset() {
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-team-id': String(teamA) };
  await fetch(`${BASE}/api/v2/activities/${encodeURIComponent(IDS.actAtt1)}/attendance/checkout`, { method: 'POST', headers });
}
function latestEvent(eventType) {
  return withDb((db) => db.prepare(
    `SELECT ae.* FROM attendance_events ae
       JOIN attendance_sessions s ON s.id = ae.session_id
      WHERE ae.event_type = ? AND ae.user_id = ? AND ae.activity_id = ?
      ORDER BY ae.id DESC LIMIT 1`,
  ).get(eventType, volA, a1));
}

// 成功签到 + 验证 + 签退重置（释放 uq_active_attendance）
async function okCheckIn(label, body, inspect) {
  const r = await checkInBody(body);
  const ok = r.status === 200 || r.status === 201;
  check(`${label} → 2xx`, ok, `status=${r.status}`);
  if (ok && inspect) await inspect(r);
  if (ok) await checkOutReset();
  return r;
}

async function main() {
  check('LOC-0 fixture ID 就绪', volA > 0 && teamA > 0 && a1 > 0, `volA=${volA} teamA=${teamA} a1=${a1}`);

  // ========================= LOC-REQ 请求解析（§19）=========================
  process.stderr.write('LOC-REQ 请求解析\n');
  await okCheckIn('REQ1 无 body', undefined);
  await okCheckIn('REQ2 空 body {}', {});
  await okCheckIn('REQ3 location 缺失', { foo: 1 });
  await okCheckIn('REQ4 location=null', { location: null });
  await okCheckIn('REQ5 valid lat+lng', { location: { latitude: 31.2304, longitude: 121.4737 } });
  await okCheckIn('REQ6 valid lat+lng+accuracy', { location: { latitude: 31.2304, longitude: 121.4737, accuracy: 12.5 } });

  {
    const r = await checkInBody({ location: {} });
    check('REQ7 location={} → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 31.2 } });
    check('REQ8 只有 latitude → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { longitude: 121.4 } });
    check('REQ9 只有 longitude → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: '31.2', longitude: 121.4 } });
    check('REQ10 latitude 为 string → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: '121.4' } });
    check('REQ11 longitude 为 string → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: 121.4, accuracy: '12' } });
    check('REQ12 accuracy 为 string → 400', r.status === 400, `status=${r.status}`);
  }

  // ========================= LOC-BND 坐标边界（§20）=========================
  process.stderr.write('LOC-BND 坐标边界\n');
  await okCheckIn('BND1 lat=-90 合法', { location: { latitude: -90, longitude: 121.4 } });
  await okCheckIn('BND2 lat=90 合法', { location: { latitude: 90, longitude: 121.4 } });
  {
    const r = await checkInBody({ location: { latitude: -91, longitude: 121.4 } });
    check('BND3 lat<-90 → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 91, longitude: 121.4 } });
    check('BND4 lat>90 → 400', r.status === 400, `status=${r.status}`);
  }
  await okCheckIn('BND5 lng=-180 合法', { location: { latitude: 31.2, longitude: -180 } });
  await okCheckIn('BND6 lng=180 合法', { location: { latitude: 31.2, longitude: 180 } });
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: -181 } });
    check('BND7 lng<-180 → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: 181 } });
    check('BND8 lng>180 → 400', r.status === 400, `status=${r.status}`);
  }

  // ========================= LOC-ACC accuracy（§21）=========================
  process.stderr.write('LOC-ACC accuracy\n');
  await okCheckIn('ACC1 accuracy 缺失 合法', { location: { latitude: 31.2, longitude: 121.4 } });
  await okCheckIn('ACC2 accuracy 正小数 合法', { location: { latitude: 31.2, longitude: 121.4, accuracy: 8.3 } });
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: 121.4, accuracy: 0 } });
    check('ACC3 accuracy=0 → 400', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await checkInBody({ location: { latitude: 31.2, longitude: 121.4, accuracy: -5 } });
    check('ACC4 accuracy<0 → 400', r.status === 400, `status=${r.status}`);
  }

  // ========================= LOC-PERS 持久化硬门（§22）=========================
  process.stderr.write('LOC-PERS 持久化硬门\n');
  await okCheckIn('PERS1 合法位置签到', { location: { latitude: 31.2304, longitude: 121.4737, accuracy: 12.5 } }, () => {
    const ev = latestEvent('checkin');
    check('PERS1a checkin 事件存在', !!ev, '');
    if (ev) {
      check('PERS1b latitude 落库 = 请求值', ev.latitude === 31.2304, `got ${ev.latitude}`);
      check('PERS1c longitude 落库 = 请求值', ev.longitude === 121.4737, `got ${ev.longitude}`);
      check('PERS1d accuracy 落库 = 请求值', ev.accuracy === 12.5, `got ${ev.accuracy}`);
      check('PERS1e distance 恒为 NULL', ev.distance === null, `got ${ev.distance}`);
      check('PERS1f raw 不重复存坐标（NULL）', ev.raw === null, `got ${ev.raw}`);
    }
  });

  await okCheckIn('PERS2 location=null 签到', { location: null }, () => {
    const ev = latestEvent('checkin');
    check('PERS2a checkin 事件存在', !!ev, '');
    if (ev) {
      check('PERS2b latitude NULL', ev.latitude === null, `got ${ev.latitude}`);
      check('PERS2c longitude NULL', ev.longitude === null, `got ${ev.longitude}`);
      check('PERS2d accuracy NULL', ev.accuracy === null, `got ${ev.accuracy}`);
      check('PERS2e distance NULL', ev.distance === null, `got ${ev.distance}`);
    }
  });

  // ========================= LOC-CKO checkout 隐私门（§23）=========================
  process.stderr.write('LOC-CKO checkout 隐私门\n');
  {
    const r = await checkInBody({ location: { latitude: 31.2304, longitude: 121.4737, accuracy: 9 } });
    check('CKO0 签到成功', r.status === 200 || r.status === 201, `status=${r.status}`);
    if (r.status === 200 || r.status === 201) {
      await checkOutReset();
      const ev = latestEvent('checkout');
      check('CKO1 checkout 事件存在', !!ev, '');
      if (ev) {
        check('CKO2 checkout latitude NULL（CHECK-IN ONLY）', ev.latitude === null, `got ${ev.latitude}`);
        check('CKO3 checkout longitude NULL', ev.longitude === null, `got ${ev.longitude}`);
        check('CKO4 checkout accuracy NULL', ev.accuracy === null, `got ${ev.accuracy}`);
        check('CKO5 checkout distance NULL', ev.distance === null, `got ${ev.distance}`);
      }
    } else {
      check('CKO1-5 因签到失败跳过', false, 'check-in returned ' + r.status);
    }
  }

  // ========================= LOC-TIME S2-6k1 时间语义不被破坏（§26）=========================
  process.stderr.write('LOC-TIME S2-6k1 时间语义\n');
  await okCheckIn('TIME1 带位置签到', { location: { latitude: 31.23, longitude: 121.47 } }, () => {
    const row = withDb((db) => db.prepare(
      'SELECT * FROM attendance_sessions WHERE activity_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    ).get(a1, volA));
    check('TIME1a legacy service_date = floor(checkin_at/86400)（UTC 桶未变）',
      row && row.service_date === Math.floor(row.checkin_at / 86400), `sd=${row?.service_date} chk=${row?.checkin_at}`);
    check('TIME1b business_service_date 非 NULL（Asia/Shanghai）',
      row && !!row.business_service_date, `biz=${row?.business_service_date}`);
    check('TIME1c business_service_date = runtime Asia/Shanghai',
      row && row.business_service_date === toBusinessDate(row.checkin_at),
      `biz=${row?.business_service_date} exp=${row ? toBusinessDate(row.checkin_at) : 'n/a'}`);
  });

  // cleanup token session
  withDb((db) => db.prepare('DELETE FROM sessions WHERE public_id = ?').run(SESS_PUB));

  console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write('ERROR ' + (e?.stack ?? e) + '\n');
  process.exit(1);
});
