#!/usr/bin/env node
/**
 * P32-P2 原子性故障注入探针（TEST-ONLY，disposable）。
 * 需要 wrangler 以 JHZY_FAULT_INJECT=<fault> 运行（默认模式传 0）。
 *
 * 用法：
 *（wrangler 已用对应 fault var 启动）
 *   node tests/p32_fault.mjs --fault 1   # 令 cert INSERT 违反 CHECK → 整批回滚
 *   node tests/p32_fault.mjs --fault 2   # 令 certificate_log action 违反 CHECK → 整批回滚
 *   node tests/p32_fault.mjs --fault 3   # stale pool candidate → session 保持 IN_PROGRESS（需 wrangler fault=0）
 *
 * 每个 fault 模式独立 setup/cleanup（通过 p32_backend 的 --setup/-teardown 复用 fixture）。
 */

import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8787';
const PORT = Number(new URL(BASE).port || 80);
const D1_DIR =
  process.env.JHZY_D1_DIR ?? join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const IDS = {
  teamA: '01P32TEAMAAAAAAAAAAAAAAAAA',
  volA: '01P32VETA00000000000000000',
  paperA: '01P32PAPERAAAAAAAAAAAAAAAA',
};
const VA = 's_p32_' + IDS.volA;

function dbFile() {
  return join(
    D1_DIR,
    readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0],
  );
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

/**
 * 每请求一条独立 TCP 连接（agent: false），不复用 keep-alive 连接。
 *
 * 原因：本脚本在 fault=3 流程中用 execSync('npx wrangler d1 execute ...') 改号池，
 * 该调用会长时间同步占用事件循环；期间先前建立的 keep-alive 连接可能已被对端关闭，
 * 复用它会在紧接着的 fetch 上稳定抛 ECONNRESET（dev server 日志显示请求根本没到达）。
 *
 * 本改动只作用于传输层，不改变任何请求/断言语义与 A3 的产品行为语义。
 */
function httpJson(method, path, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${VA}`, 'x-team-id': IDS.teamA };
  if (payload) headers['Content-Length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
      });
      res.on('end', () => {
        let data = null;
        try {
          data = buf ? JSON.parse(buf) : null;
        } catch {}
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function req(method, path, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await httpJson(method, path, body);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

/** execSync 改库之后显式等待服务恢复健康，避免紧接着的请求打到已失效的连接/进程。 */
async function waitHealthy(maxMs = 20000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpJson('GET', '/health');
      if (r.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server not healthy after d1 execute: ' + (lastErr?.message ?? 'unknown'));
}

let pass = 0, fail = 0, skipped = 0;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
function check(name, cond, detail = '') {
  if (cond) { pass += 1; log(`  PASS ${name}`); }
  else { fail += 1; log(`  FAIL ${name} ${detail}`); }
}
function skip(name, why) { skipped += 1; log(`  SKIP ${name} ${why}`); }

async function startAndGetQuestions() {
  const r = await req('POST', `/api/v2/exams/${IDS.paperA}/start`, {});
  if (r.status !== 200) return null;
  const qs = r.data?.data?.attempt?.questions ?? [];
  return { sessionPid: r.data.data.attempt.session_public_id, questions: qs };
}

async function run() {
  const mode = process.argv[3] ?? '3'; // --fault <n>
  const fault = Number(mode);

  if (fault !== 1 && fault !== 2 && fault !== 3) {
    log('usage: node tests/p32_fault.mjs --fault 1|2|3');
    process.exit(2);
  }

  if (fault === 1 || fault === 2) {
    // A1/A2：需要 wrangler 以 JHZY_FAULT_INJECT=<fault> 运行。
    const s = await startAndGetQuestions();
    if (!s) return failAnd(skip, 'start', 'cannot start');
    const allRight = s.questions.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' }));
    const sub = await req('POST', `/api/v2/exams/sessions/${s.sessionPid}/submit`, { answers: allRight });
    const serr = sub.data?.error?.message ?? '';
    check(`A${fault} submit returns 500 (fault injected: ${serr.includes('__FAULT__') ? 'fault confirmed' : serr})`, sub.status === 500, `status=${sub.status} ${JSON.stringify(sub.data)}`);

    // 断言整批回滚：session 仍 IN_PROGRESS(1)、answers 未定稿、无 cert/log/pool
    const st = withDb((db) => {
      const sid = db.prepare('SELECT id, status, submitted_at, score, passed FROM exam_sessions WHERE public_id = ?').get(s.sessionPid);
      const ans = sid ? db.prepare('SELECT COUNT(*) n FROM exam_answers WHERE session_id=? AND user_answer IS NOT NULL').get(sid.id).n : -1;
      const certs = db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?)').get(IDS.volA, IDS.paperA).n;
      const logs = db.prepare('SELECT COUNT(*) n FROM certificate_logs WHERE team_id IN (SELECT id FROM teams WHERE public_id=?)').get(IDS.teamA).n;
      return { status: sid?.status, submittedAt: sid?.submitted_at, score: sid?.score, passed: sid?.passed, answered: ans, certs, logs };
    });
    check(`A${fault}a session still IN_PROGRESS (status=1, no score/passed/submitted)`, st.status === 1 && st.submittedAt == null && st.score == null && st.passed == null, JSON.stringify(st));
    check(`A${fault}b answers NOT finalized (user_answer null)`, st.answered === 0, `answered=${st.answered}`);
    check(`A${fault}c no cert / no log for this attempt after rollback (fixture volB log not counted)`,
      st.certs === 0 &&
        withDb((db) =>
          db.prepare('SELECT COUNT(*) n FROM certificate_logs cl JOIN certificates c ON c.id=cl.certificate_id WHERE c.user_id=(SELECT id FROM users WHERE public_id=?) AND c.exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?)').get(IDS.volA, IDS.paperA).n,
        ) === 0,
      JSON.stringify(st));
    // pool: 该 code 未被消费（id 对应回滚前 candidate 无法断言；至少 status=0 的 pool 不应减少）
    const pool0 = withDb((db) => db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_trn' AND status=0").get().n);
    check(`A${fault}d pool not consumed (still has free codes)`, pool0 >= 1, `pool0=${pool0}`);
  }

  if (fault === 3) {
    // A3：pool 候选枯竭 —— start 后把【全部】cert_trn free code 标记为 stale（模拟并发竞争耗竭）。
    // 注意：对运行中 wrangler miniflare D1 的外部 node:sqlite 写入可能不被其会话可见，
    // 故此处用 `wrangler d1 execute`（同一 D1 binding）执行 stale/refill，保证读写同会话。
    const staleViz = execSync(
      `npx wrangler d1 execute jhzy-v2-local --local --command "UPDATE id_pools SET status=1, assigned_to=NULL, assigned_at=NULL WHERE pool_type='cert_trn' AND status=0; SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_trn' AND status=0;"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const afterStale = Number((staleViz.match(/"n":\s*(\d+)/)?.[1] ?? '0'));
    await waitHealthy();
    log(`[A3] staled pool; free codes after = ${afterStale}`);

    if (afterStale !== 0) { skip('A3', 'pool not fully staled (external visibility issue)'); }
    else {
      const s = await startAndGetQuestions();
      if (!s) { fail++; log('  FAIL A3 start'); return; }
      const allRight = s.questions.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' }));
      const sub = await req('POST', `/api/v2/exams/sessions/${s.sessionPid}/submit`, { answers: allRight });
      check('A3 submit with exhausted pool returns 409 (pool conflict, no finalize)', sub.status === 409 && sub.data?.error?.details?.reason === 'exam_pool_exhausted', `status=${sub.status} ${JSON.stringify(sub.data)}`);
      const st = withDb((db) => db.prepare('SELECT status, submitted_at, score, passed FROM exam_sessions WHERE public_id=?').get(s.sessionPid));
      check('A3a session remains IN_PROGRESS (no finalize)', st.status === 1 && st.submitted_at == null && st.score == null && st.passed == null, JSON.stringify(st));
      const answersNull = withDb((db) => {
        const sid = db.prepare('SELECT id FROM exam_sessions WHERE public_id=?').get(s.sessionPid).id;
        return db.prepare('SELECT COUNT(*) n FROM exam_answers WHERE session_id=? AND user_answer IS NOT NULL').get(sid).n;
      });
      check('A3e answers not finalized (user_answer NULL)', answersNull === 0, `n=${answersNull}`);
      // 释放/补充一个【全新未用】code（模拟后台补池）→ 重试成功。
      // 注意：不能 re-free 已发过证的 code（会触发 cert_no UNIQUE —— 后端正确拒绝重复证号）。
      execSync(
        `npx wrangler d1 execute jhzy-v2-local --local --command "INSERT INTO id_pools (pool_type, code, status, created_at) SELECT 'cert_trn', printf('CTRN%06d', COALESCE(MAX(CAST(substr(code,5) AS INTEGER)),0)+1), 0, unixepoch() FROM (SELECT code FROM id_pools WHERE pool_type='cert_trn');"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      await waitHealthy();
      const retry = await req('POST', `/api/v2/exams/sessions/${s.sessionPid}/submit`, { answers: allRight });
      check('A3b retry succeeds (pool refilled)', retry.status === 200 && retry.data?.data?.result?.passed === true, `status=${retry.status} ${JSON.stringify(retry.data?.data?.result)}`);
      const st2 = withDb((db) => db.prepare('SELECT status, passed FROM exam_sessions WHERE public_id=?').get(s.sessionPid));
      check('A3c after retry session COMPLETED', st2.status === 3 && st2.passed === 1, JSON.stringify(st2));
      const certs = withDb((db) => db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=(SELECT id FROM users WHERE public_id=?) AND exam_paper_id=(SELECT id FROM exam_papers WHERE public_id=?)').get(IDS.volA, IDS.paperA).n);
      check('A3d exactly one cert after retry', certs === 1, `certs=${certs}`);
    }
  }

  log('');
  log(`P32-P2 fault probe: PASS=${pass} FAIL=${fail} SKIP=${skipped}`);
  if (fail > 0) process.exit(1);
}

await run();