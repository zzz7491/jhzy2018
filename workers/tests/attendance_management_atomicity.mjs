#!/usr/bin/env node
/**
 * S2-6i 原子性故障注入测试（§10 / §17-L 硬门禁）。
 *
 * 前置（由 tests/run_s2_6i_final.mjs 编排）：
 *   1) fault worker 已启动（JHZY_FAULT_INJECT 经 wrangler 配置文件 vars 注入 —— 实测 `--var` 不进入 c.env）；
 *   2) 已重跑 fixture（干净 19 行会话、0 事件），BASE_URL 指向该 worker；
 *   3) JHZY_FAULT_MODE 与 worker 的 JHZY_FAULT_INJECT 一致（1 或 2）。
 *
 * ── 为什么需要两种故障模式 ───────────────────────────────────────────────
 * S2-6i-R1 把原子守卫重构为「stmt[0]=audit INSERT，stmt[1]=条件 UPDATE，两者共享同一 PRE-state 谓词」，
 * 不再依赖毫秒时间戳唯一性。为此原子性证明必须覆盖两个方向：
 *
 *   MODE 1（L 组）：令 **stmt[0]（INSERT）** 失败（event_type='__FAULT__' 违反 event_type CHECK）。
 *     证明：整批失败 → UPDATE 从未生效 → 会话 status / review_status / checkout_at / updated_at
 *     全部保持原值，且不存在 event。此为用户 §4 的字面要求。
 *
 *   MODE 2（P 组）：令 **stmt[1]（UPDATE）** 失败（写入越界 status/review_status=9 违反 CHECK）。
 *     此时 stmt[0] 的 INSERT 【已经成功执行】，因此若 event 最终不存在，即证明
 *     D1Database.batch 是【真实事务回滚】，而非"前一条失败所以后一条没跑"的短路假象。
 *     这一路是本次重构后原子性成立的关键证据（P4 / P9）。
 *
 * 判定：注入后 API 返回 500 INTERNAL_ERROR，且目标会话字段【完全未变】、无任何审计事件。
 * 若状态被部分修改或产生孤儿事件 → 原子性不成立 → S2-6i = BLOCK。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8799';
const D1_DIR = process.env.JHZY_D1_DIR
  ?? join(process.cwd(), '.tmp', 's2-6i-final-state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFEST = process.env.JHZY_MANIFEST ?? join(process.cwd(), '.tmp', 's2-6i-sessions.json');
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
const totalEvents = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM attendance_events').get().n);

async function req(method, path, body, headers = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}
const auth = (role, userId, teamId) => ({ 'x-test-role': role, 'x-test-user': String(userId), 'x-test-team': String(teamId) });

/** 会话的"可变字段快照"—— 用于逐字段证明零变更（含 updated_at，§4 明确要求）。 */
const snap = (r) => JSON.stringify({
  status: r?.status,
  review_status: r?.review_status,
  checkin_at: r?.checkin_at,
  checkout_at: r?.checkout_at,
  updated_at: r?.updated_at,
});

if (MODE === '1') {
  // =====================================================================
  // L. 故障模式 1：stmt[0]（audit event INSERT）失败 → 整批回滚，UPDATE 从未生效
  // =====================================================================
  process.stderr.write('L. 原子性故障注入 MODE 1（INSERT 失败 → UPDATE 不生效）\n');

  // L1–L4 Review
  const r1Before = sessionRow(S.R1);
  const r = await req('POST', `/api/v2/attendance-sessions/${S.R1}/review`, { decision: 'approve', reason: 'fault' }, auth('team_owner', U.ownerA, T.teamA));
  check('L1 故障注入 review → 500 INTERNAL_ERROR', r.res.status === 500 && r.body?.error?.code === 'INTERNAL_ERROR', `got ${r.res.status}/${r.body?.error?.code}`);
  const r1After = sessionRow(S.R1);
  check('L2 review_status 未变（仍 0）', r1After?.review_status === r1Before?.review_status && r1After?.review_status === 0, `before=${r1Before?.review_status} after=${r1After?.review_status}`);
  check('L3 status / checkin_at / checkout_at 未变', r1After?.status === r1Before?.status && r1After?.checkin_at === r1Before?.checkin_at && r1After?.checkout_at === r1Before?.checkout_at, snap(r1After));
  check('L4 updated_at 保持原值（UPDATE 未生效）', r1After?.updated_at === r1Before?.updated_at, `before=${r1Before?.updated_at} after=${r1After?.updated_at}`);
  check('L5 故障 review 未写孤儿事件', eventCount(S.R1) === 0, `got ${eventCount(S.R1)}`);

  // L6–L10 Force
  const f1Before = sessionRow(S.F1);
  const f = await req('POST', `/api/v2/attendance-sessions/${S.F1}/force-checkout`, { reason: 'fault' }, auth('team_owner', U.ownerA, T.teamA));
  check('L6 故障注入 force → 500 INTERNAL_ERROR', f.res.status === 500 && f.body?.error?.code === 'INTERNAL_ERROR', `got ${f.res.status}/${f.body?.error?.code}`);
  const f1After = sessionRow(S.F1);
  check('L7 status 未变（仍 1 CHECKED_IN）', f1After?.status === f1Before?.status && f1After?.status === 1, `before=${f1Before?.status} after=${f1After?.status}`);
  check('L8 checkout_at 未变（仍 NULL）', f1After?.checkout_at === f1Before?.checkout_at && f1After?.checkout_at == null, `before=${f1Before?.checkout_at} after=${f1After?.checkout_at}`);
  check('L9 updated_at 保持原值（UPDATE 未生效）', f1After?.updated_at === f1Before?.updated_at, `before=${f1Before?.updated_at} after=${f1After?.updated_at}`);
  check('L10 故障 force 未写孤儿事件', eventCount(S.F1) === 0, `got ${eventCount(S.F1)}`);

  // L11–L13 二次校验（证明是 batch 契约而非偶发）
  const r2Before = sessionRow(S.R2);
  const r2 = await req('POST', `/api/v2/attendance-sessions/${S.R2}/review`, { decision: 'reject', reason: 'fault' }, auth('team_owner', U.ownerA, T.teamA));
  check('L11 二次故障 review → 500', r2.res.status === 500, `got ${r2.res.status}`);
  const r2After = sessionRow(S.R2);
  check('L12 R2 review_status + updated_at 均未变', r2After?.review_status === 0 && r2After?.updated_at === r2Before?.updated_at, `${snap(r2Before)} -> ${snap(r2After)}`);
  check('L13 R2 无孤儿事件', eventCount(S.R2) === 0, `got ${eventCount(S.R2)}`);

  // L14 全局一致性
  check('L14 故障阶段全局审计事件=0（全部回滚）', totalEvents() === 0, `got ${totalEvents()}`);

  // L15 时间戳单位守护：故障阶段不得因回滚残留任何毫秒值
  const maxTs = withDb((db) =>
    db.prepare('SELECT MAX(COALESCE(updated_at,0)) AS m FROM attendance_sessions').get().m,
  );
  check('L15 会话 updated_at 全局最大值 < 1e11（无毫秒污染）', maxTs < 100000000000, `max=${maxTs}`);
} else if (MODE === '2') {
  // =====================================================================
  // P. 故障模式 2：stmt[1]（条件 UPDATE）失败 → 已执行的 stmt[0] INSERT 必须被回滚
  //    这是「db.batch 是真实事务」的关键证据（否则 event 会残留）。
  // =====================================================================
  process.stderr.write('P. 原子性故障注入 MODE 2（UPDATE 失败 → 已执行的 INSERT 被真实回滚）\n');

  // P1–P4 Review：UPDATE 写入越界 review_status=9 违反 CHECK
  const r1Before = sessionRow(S.R1);
  const r = await req('POST', `/api/v2/attendance-sessions/${S.R1}/review`, { decision: 'approve', reason: 'fault2' }, auth('team_owner', U.ownerA, T.teamA));
  check('P1 故障注入(UPDATE 违例) review → 500 INTERNAL_ERROR', r.res.status === 500 && r.body?.error?.code === 'INTERNAL_ERROR', `got ${r.res.status}/${r.body?.error?.code}`);
  const r1After = sessionRow(S.R1);
  check('P2 review_status 未变（仍 0，未被写入越界值 9）', r1After?.review_status === 0, `got ${r1After?.review_status}`);
  check('P3 updated_at 保持原值', r1After?.updated_at === r1Before?.updated_at, `before=${r1Before?.updated_at} after=${r1After?.updated_at}`);
  check('P4 【真实回滚证明】已执行的 audit INSERT 被撤销：R1 事件数=0', eventCount(S.R1) === 0, `got ${eventCount(S.R1)}`);

  // P5–P9 Force：UPDATE 写入越界 status=9 违反 CHECK
  const f1Before = sessionRow(S.F1);
  const f = await req('POST', `/api/v2/attendance-sessions/${S.F1}/force-checkout`, { reason: 'fault2' }, auth('team_owner', U.ownerA, T.teamA));
  check('P5 故障注入(UPDATE 违例) force → 500 INTERNAL_ERROR', f.res.status === 500 && f.body?.error?.code === 'INTERNAL_ERROR', `got ${f.res.status}/${f.body?.error?.code}`);
  const f1After = sessionRow(S.F1);
  check('P6 status 未变（仍 1，未被写入越界值 9）', f1After?.status === 1, `got ${f1After?.status}`);
  check('P7 checkout_at 未变（仍 NULL）', f1After?.checkout_at == null, `got ${f1After?.checkout_at}`);
  check('P8 updated_at 保持原值', f1After?.updated_at === f1Before?.updated_at, `before=${f1Before?.updated_at} after=${f1After?.updated_at}`);
  check('P9 【真实回滚证明】已执行的 audit INSERT 被撤销：F1 事件数=0', eventCount(S.F1) === 0, `got ${eventCount(S.F1)}`);

  // P10 全局一致性：两次故障后全库零事件（若 batch 非事务，此处必为 2）
  check('P10 故障阶段全局审计事件=0（若非真事务则应为 2）', totalEvents() === 0, `got ${totalEvents()}`);
} else {
  process.stderr.write(`FATAL: unsupported JHZY_FAULT_MODE=${MODE} (expect 1|2)\n`);
  process.exit(2);
}

process.stderr.write(`\n===== S2-6i atomicity(fault mode ${MODE}): pass=${pass} fail=${fail} =====\n`);
process.exit(fail === 0 ? 0 : 1);
