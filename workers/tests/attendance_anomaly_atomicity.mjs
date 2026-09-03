#!/usr/bin/env node
/**
 * S2-6j 原子性故障注入测试（§15 / §18 / §24 硬门禁）。
 *
 * 前置（由 tests/run_s2_6j.mjs 编排）：
 *   1) fault worker 已启动（JHZY_FAULT_INJECT 经 wrangler 配置文件 vars 注入 —— 实测 `--var` 不进入 c.env）；
 *   2) 已重跑 fixture('anomaly')（AA1/AA2 均为 status=1、teamA），BASE_URL 指向该 worker；
 *   3) JHZY_FAULT_MODE 与 worker 的 JHZY_FAULT_INJECT 一致（1 或 2）。
 *
 * ── 两种故障模式（与 S2-6i 同构）──
 *   MODE 1（L 组）：令 **stmt[0]（audit event INSERT）** 失败（event_type='__FAULT__' 违反 event_type CHECK）。
 *     证明：整批失败 → UPDATE 从未生效 → 异常字段全部保持原值，且不存在 event。
 *   MODE 2（P 组）：令 **stmt[1]（条件 UPDATE）** 失败（写入越界 status=9 违反 status CHECK）。
 *     此时 stmt[0] 的 INSERT 【已经成功执行】，故该模式证明【已执行语句被真实回滚】（event 不存在），
 *     即 db.batch 是真事务、而非"短路未执行"。
 *
 * 判定：注入后 API 返回 500 INTERNAL_ERROR，且目标异常字段【完全未变】、无任何审计事件。
 * 若状态被部分修改或产生孤儿事件 → 原子性不成立 → S2-6j = BLOCK。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8795';
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.tmp', 's2-6j-state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = process.env.JHZY_MANIFEST ?? join(process.cwd(), '.tmp', 's2-6j-anomaly.json');
const MODE = String(process.env.JHZY_FAULT_MODE ?? '1');

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
const anomEvents = (sid, op) =>
  withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM attendance_events WHERE session_id=? AND event_type='anomaly' AND operator_id=?").get(sid, op).n);
const totalEvents = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n);

async function req(method, path, body, headers = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { res, body: json };
}
const auth = (role, userId, teamId) => ({ 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) });

if (MODE === '1') {
  process.stderr.write('L. 原子性故障注入 MODE 1（INSERT 失败 → UPDATE 不生效）\n');
  // AA1 (confirm) / AA2 (dismiss) 均为 status=1
  for (const [label, aid, decision] of [['AA1', A.AA1, 'confirm'], ['AA2', A.AA2, 'dismiss']]) {
    const before = anomRow(aid);
    const r = await req('POST', `/api/v2/attendance-anomalies/${aid}/resolve`, { decision, resolution: 'fault' }, auth('team_owner', U.ownerA, T.teamA));
    check(`L-${label} 故障注入 resolve(${decision}) → 500 INTERNAL_ERROR`, r.res.status === 500 && r.body?.error?.code === 'INTERNAL_ERROR', `got ${r.res.status}/${r.body?.error?.code}`);
    const after = anomRow(aid);
    check(`L-${label} status 未变（仍 1 OPEN）`, after?.status === 1 && after?.status === before?.status, `before=${before?.status} after=${after?.status}`);
    check(`L-${label} handled_by 仍为 NULL`, after?.handled_by == null, `handled_by=${after?.handled_by}`);
    check(`L-${label} handled_at 仍为 NULL`, after?.handled_at == null, `handled_at=${after?.handled_at}`);
    check(`L-${label} resolution 未写入（仍 NULL）`, after?.resolution == null, `resolution=${after?.resolution}`);
    check(`L-${label} 故障未写孤儿事件`, anomEvents(S.A_S1, U.ownerA) === 0, `events=${anomEvents(S.A_S1, U.ownerA)}`);
  }
  check('L-global 故障阶段全局审计事件=0（全部回滚）', totalEvents() === 0, `got ${totalEvents()}`);
} else if (MODE === '2') {
  process.stderr.write('P. 原子性故障注入 MODE 2（UPDATE 失败 → 已执行的 INSERT 被真实回滚）\n');
  for (const [label, aid, decision] of [['AA1', A.AA1, 'confirm'], ['AA2', A.AA2, 'dismiss']]) {
    const before = anomRow(aid);
    const r = await req('POST', `/api/v2/attendance-anomalies/${aid}/resolve`, { decision, resolution: 'fault2' }, auth('team_owner', U.ownerA, T.teamA));
    check(`P-${label} 故障注入(UPDATE 违例) resolve(${decision}) → 500 INTERNAL_ERROR`, r.res.status === 500 && r.body?.error?.code === 'INTERNAL_ERROR', `got ${r.res.status}/${r.body?.error?.code}`);
    const after = anomRow(aid);
    check(`P-${label} status 未变（仍 1，未被写入越界值 9）`, after?.status === 1, `got ${after?.status}`);
    check(`P-${label} handled_by 仍为 NULL`, after?.handled_by == null, `handled_by=${after?.handled_by}`);
    check(`P-${label} handled_at 仍为 NULL`, after?.handled_at == null, `handled_at=${after?.handled_at}`);
    check(`P-${label} resolution 未写入（仍 NULL）`, after?.resolution == null, `resolution=${after?.resolution}`);
    check(`P-${label} 【真实回滚证明】已执行的 audit INSERT 被撤销：事件数=0`, anomEvents(S.A_S1, U.ownerA) === 0, `events=${anomEvents(S.A_S1, U.ownerA)}`);
  }
  check('P-global 故障阶段全局审计事件=0（若非真事务则应为 2）', totalEvents() === 0, `got ${totalEvents()}`);
} else {
  process.stderr.write(`FATAL: unsupported JHZY_FAULT_MODE=${MODE} (expect 1|2)\n`);
  process.exit(2);
}

process.stderr.write(`\nTOTAL: ${pass} passed, ${fail} fail\n`);
process.stderr.write(`===== S2-6j atomicity(fault mode ${MODE}): pass=${pass} fail=${fail} =====\n`);
process.exit(fail === 0 ? 0 : 1);
