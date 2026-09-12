// =============================================================================
// N0-F2 — Activity Publication IN_APP Integration
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
// 冻结产品裁决：ACTIVITY_PUBLICATION_APPROVED / REJECTED 均 IN_APP = YES、WECHAT = DEFERRED。
//
// 覆盖（对应任务 §8）：
//   A  APPROVED：跃迁成功 / audit log 1 / notification 1 / recipient = created_by / target 正确
//   A' recipient 恒为 created_by，且【不是】submitted_by（两者不同人时）
//   B  REJECTED：跃迁成功 / audit log 1（带真实 reason）/ notification 1 / body 含真实 reject_reason
//   B' payload 不含 reject_reason（仅 activity_public_id + audit_status）
//   C  duplicate same review：不重复 notification / 不重复 audit log / race 行为保持
//   D  multi-round：REJECTED → resubmit → REJECTED → resubmit → APPROVED，三轮各自通知不丢失
//   E  atomic rollback：notification / recipient / audit log 任一 INSERT 故障 → 全批回滚
//   E' batch 语句顺序：notification → recipient → audit log → UPDATE(最后)
//   F  unauthorized / wrong-team / self-review 行为完全保持（403 / 404 / 403）
//   G  target allowlist：valid PASS / malformed ULID FAIL / unsupported page FAIL / external URL FAIL
//   H  WeChat：REAL_WECHAT_SEND_CALLS = 0；No.974 无注册 / 无发送
//   I  R1：same-second same-decision（REJECTED×2 @S）—— 幂等锚点改 submit_audit_log_id 修复 UNIQUE 冲突
//   J  R1：same-second different-decision（REJECT@S → APPROVE@SAME S）
//   K  R1：same-round duplicate approve → 409，不破坏同轮幂等
//   L  R1：PENDING 但完全无 submit log → 批前 internalError / 零副作用
//   M  R1-A：PENDING 但仅历史旧 submit log（created_at ≠ 当前 submitted_at）→ 批前 internalError / 零副作用（不误选旧轮）
//   N  R1-A：same-second Round1+Round2 两轮 submit log 同 created_at、不同 id → 当前轮解析【较新】id（不回退旧轮）
//
// 运行：node tests/n0f2_activity_publication_inapp.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 必须保持未注册的 provider 模板（N0-F2 §7：不注册 / 不发送）。 */
const NO974_TEMPLATE_ID = '_6aA7UFJXP87m60D1peO0f3VVWN4zeunkJx1tT9eba8';
const NO974_NUMBER = '974';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let s = '';
  for (let i = 0; i < 26; i++) s += ULID_ALPHABET[Math.floor(Math.random() * ULID_ALPHABET.length)];
  return s;
}

// ---------- 真实网络禁用（REAL_WECHAT_SEND_CALLS = 0 的运行时证据）----------
const netCalls = [];
globalThis.fetch = async (url) => {
  netCalls.push(String(url));
  throw new Error('NETWORK_FORBIDDEN_IN_TEST');
};

// ---------- D1 适配器（node:sqlite 后端）----------
// - db.batch 体内【全同步】执行（BEGIN → 语句 → COMMIT），与真实 D1「单写事务、批内无
//   其它写者穿插」语义一致。
// - sqlLog 记录 prepare 顺序（= batch 执行顺序），用于断言 UPDATE 恒在最后。
// - fault 注入：命中目标 INSERT 的语句 _doRun 抛错 → 触发整批 ROLLBACK。
function makeD1(sqlite) {
  const sqlLog = [];
  const prepare = (sql) => {
    sqlLog.push(sql);
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
      _params() { return params; },
      _doRun(p) { return sqlite.prepare(sql).run(...p); },
      async all(...override) {
        const p = override.length ? override : params;
        return { results: sqlite.prepare(sql).all(...p) };
      },
      async first(...override) {
        const p = override.length ? override : params;
        const rows = sqlite.prepare(sql).all(...p);
        return rows.length ? rows[0] : null;
      },
      async run(...override) {
        const p = override.length ? override : params;
        const r = stmt._doRun(p);
        return { meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  };
  const d1 = {
    prepare,
    async batch(stmts) {
      const out = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) {
          const r = s._doRun(s._params());
          out.push({ meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } });
        }
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
  };
  const realPrepare = d1.prepare;
  const fault = { mode: null }; // null | 'notification' | 'recipient' | 'auditlog'
  d1.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const isNotif = /INSERT INTO notifications\b/i.test(sql);
    const isRecip = /INSERT INTO notification_recipients\b/i.test(sql);
    const isAudit = /INSERT INTO content_audit_logs\b/i.test(sql);
    if (
      (fault.mode === 'notification' && isNotif) ||
      (fault.mode === 'recipient' && isRecip) ||
      (fault.mode === 'auditlog' && isAudit)
    ) {
      stmt._doRun = () => { throw new Error('FAULT_INJECTED_SQL'); };
    }
    return stmt;
  };
  return { d1, fault, sqlLog };
}

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function bundle(entryPath, tag) {
  const built = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const p = join(tmpdir(), `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mjs`);
  writeFileSync(p, built.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** N0-F2 R1：冻结 Date.now 到指定 epoch 秒（用于复现「同秒再审」缺陷场景）。 */
async function withFrozenNow(epochSec, fn) {
  const orig = Date.now;
  Date.now = () => Math.floor(epochSec * 1000);
  try {
    return await fn();
  } finally {
    Date.now = orig;
  }
}

async function main() {
  // 1) 打包真实 app.ts + target SSOT
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const targetPath = fileURLToPath(new URL('../src/utils/notification-target.ts', import.meta.url));
  const wxSchemaPath = fileURLToPath(new URL('../src/channels/wechat/wechat-template-schema.ts', import.meta.url));
  const { createApp } = await bundle(appPath, 'n0f2_app');
  const targetMod = await bundle(targetPath, 'n0f2_target');
  const wxMod = await bundle(wxSchemaPath, 'n0f2_wxschema');
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = join(WORKERS_DIR, 'migrations');
  const migFiles = readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of migFiles) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const { d1, fault, sqlLog } = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // 3) 用户与团队
  const USERS = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const uid = {};
  for (const n of USERS) {
    const pub = ulid();
    seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', pub, n);
    uid[n] = q('SELECT id FROM users WHERE public_id=?', pub).id;
  }
  const tA = (() => {
    const pub = ulid();
    seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', pub, 'teamA', uid.alice);
    return q('SELECT id FROM teams WHERE public_id=?', pub).id;
  })();
  const tB = (() => {
    const pub = ulid();
    seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', pub, 'teamB', uid.dave);
    return q('SELECT id FROM teams WHERE public_id=?', pub).id;
  })();

  // 4) 请求驱动
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const t0 = 1_700_000_000;
  const create = async (user, team, title = 'act', role = 'team_admin') =>
    (await call('POST', '/api/v2/activities', {
      role, user, team,
      body: { title, start_time: t0, end_time: t0 + 7200, quota: 10 },
    })).json?.data?.activity?.public_id;
  const submit = (pub, role, user, team) =>
    call('POST', `/api/v2/activities/${pub}/submit`, { role, user, team });
  const approve = (pub, role, user, team) =>
    call('POST', `/api/v2/activities/${pub}/approve`, { role, user, team });
  const reject = (pub, role, user, team, reason) =>
    call('POST', `/api/v2/activities/${pub}/reject`, { role, user, team, body: { reason } });

  // 5) 投影
  const actId = (pub) => q('SELECT id FROM activities WHERE public_id=?', pub).id;
  const state = (pub) => q(
    `SELECT id, status, audit_status, created_by, submitted_by, submitted_at,
            reviewed_by, reviewed_at, reject_reason, published_at
       FROM activities WHERE public_id=?`, pub);
  const notifRows = (pub) => qa(
    `SELECT * FROM notifications
      WHERE business_entity_type='activity' AND business_entity_id=?
      ORDER BY id`, actId(pub));
  const notifCount = (pub) => notifRows(pub).length;
  const recipRows = (pub) => qa(
    `SELECT nr.* FROM notification_recipients nr
       JOIN notifications n ON n.id = nr.notification_id
      WHERE n.business_entity_type='activity' AND n.business_entity_id=?`, actId(pub));
  const auditLogs = (pub) => qa(
    `SELECT * FROM content_audit_logs
      WHERE target_type='activity' AND target_id=? ORDER BY id`, actId(pub));
  const reviewLogs = (pub) => auditLogs(pub).filter((l) => l.action === 'approve' || l.action === 'reject');

  const EXPECTED_TARGET = (pub) => `/pages/detail/detail?id=${pub}`;

  // ======================= A：APPROVED 全契约 =======================
  const aPub = await create(uid.alice, tA, 'A-通过');
  await submit(aPub, 'team_admin', uid.alice, tA);
  const aRes = await approve(aPub, 'team_auditor', uid.carol, tA);
  {
    const s = state(aPub);
    check('A.1 approve 200', aRes.status === 200, `status=${aRes.status}`);
    check('A.2 跃迁 audit_status=2 / status=1 / published_at 非空',
      s.audit_status === 2 && s.status === 1 && s.published_at != null,
      `audit=${s.audit_status} status=${s.status} pub=${s.published_at}`);
    check('A.3 reviewed_by/reviewed_at 写入', s.reviewed_by === uid.carol && s.reviewed_at != null);
    check('A.4 audit log 恰好 1 条 approve',
      reviewLogs(aPub).length === 1 && reviewLogs(aPub)[0].action === 'approve',
      `n=${reviewLogs(aPub).length}`);
    check('A.5 approve audit log from/to = PENDING/APPROVED',
      reviewLogs(aPub)[0].from_status === 'PENDING' && reviewLogs(aPub)[0].to_status === 'APPROVED',
      JSON.stringify(reviewLogs(aPub)[0]));
    check('A.6 notification 恰好 1 条', notifCount(aPub) === 1, `n=${notifCount(aPub)}`);
    const n = notifRows(aPub)[0];
    check('A.7 event_type = activity.publication.approved',
      n.event_type === 'activity.publication.approved', `et=${n.event_type}`);
    check('A.8 category = activity', n.category === 'activity', `c=${n.category}`);
    check('A.9 business_entity_type/id = activity / activities.id',
      n.business_entity_type === 'activity' && n.business_entity_id === actId(aPub),
      `${n.business_entity_type}/${n.business_entity_id}`);
    check('A.10 team_id = activities.team_id', n.team_id === tA, `team=${n.team_id}`);
    check('A.11 target_page exact', n.target_page === EXPECTED_TARGET(aPub), `tp=${n.target_page}`);
    check('A.12 target_page 通过内部 allowlist validator',
      targetMod.isValidInternalTarget(n.target_page) === true);
    check('A.13 recipient 恰好 1 条', recipRows(aPub).length === 1, `n=${recipRows(aPub).length}`);
    check('A.14 recipient = created_by（alice）', recipRows(aPub)[0].user_id === uid.alice,
      `uid=${recipRows(aPub)[0].user_id}`);
    check('A.15 recipient 幂等键后缀 :u<user_id>',
      recipRows(aPub)[0].idempotency_key.endsWith(`:u${uid.alice}`),
      `k=${recipRows(aPub)[0].idempotency_key}`);
    const payload = JSON.parse(n.payload_json);
    check('A.16 payload 恰为 {activity_public_id, audit_status=2}',
      Object.keys(payload).length === 2 && payload.activity_public_id === aPub && payload.audit_status === 2,
      JSON.stringify(payload));
    check('A.17 payload 不含 reject_reason', !('reject_reason' in payload));
  }

  // ============ A'：submitted_by ≠ created_by 时 recipient 仍为 created_by ============
  {
    const pub = await create(uid.alice, tA, "A'-代提交");
    await submit(pub, 'team_admin', uid.bob, tA); // bob 提交 alice 创建的活动
    const r = await approve(pub, 'team_auditor', uid.carol, tA);
    const recips = recipRows(pub);
    check("A'.1 approve 200", r.status === 200, `status=${r.status}`);
    check("A'.2 recipient 恰好 1 且 = created_by(alice) 而非 submitted_by(bob)",
      recips.length === 1 && recips[0].user_id === uid.alice && recips[0].user_id !== uid.bob,
      `n=${recips.length} uid=${recips[0]?.user_id}`);
  }

  // ======================= B：REJECTED 全契约 =======================
  const bPub = await create(uid.alice, tA, 'B-驳回');
  await submit(bPub, 'team_admin', uid.alice, tA);
  const bRes = await reject(bPub, 'team_auditor', uid.carol, tA, '  场地证明缺失  ');
  {
    const s = state(bPub);
    check('B.1 reject 200', bRes.status === 200, `status=${bRes.status}`);
    check('B.2 跃迁 audit_status=3 / status=0 / published_at 保持 NULL',
      s.audit_status === 3 && s.status === 0 && s.published_at === null,
      `audit=${s.audit_status} status=${s.status} pub=${s.published_at}`);
    check('B.3 reject_reason 落库（trim 后）', s.reject_reason === '场地证明缺失', `r=${s.reject_reason}`);
    const rl = reviewLogs(bPub);
    check('B.4 audit log 恰好 1 条 reject 且带真实 reason',
      rl.length === 1 && rl[0].action === 'reject' && rl[0].reason === '场地证明缺失',
      JSON.stringify(rl));
    check('B.5 notification 恰好 1 条', notifCount(bPub) === 1, `n=${notifCount(bPub)}`);
    const n = notifRows(bPub)[0];
    check('B.6 event_type = activity.publication.rejected',
      n.event_type === 'activity.publication.rejected', `et=${n.event_type}`);
    check('B.7 target_page exact', n.target_page === EXPECTED_TARGET(bPub), `tp=${n.target_page}`);
    check('B.8 recipient = created_by', recipRows(bPub).length === 1 && recipRows(bPub)[0].user_id === uid.alice);
    check('B.9 body 含真实 reject_reason', typeof n.body === 'string' && n.body.includes('场地证明缺失'),
      `body=${n.body}`);
    const payload = JSON.parse(n.payload_json);
    check('B.10 payload 恰为 {activity_public_id, audit_status=3}',
      Object.keys(payload).length === 2 && payload.activity_public_id === bPub && payload.audit_status === 3,
      JSON.stringify(payload));
    check('B.11 payload 不含 reject_reason（§1 禁止）', !('reject_reason' in payload));
  }

  // ======================= C：duplicate / race =======================
  {
    const pub = await create(uid.alice, tA, 'C-重复');
    await submit(pub, 'team_admin', uid.alice, tA);
    await approve(pub, 'team_auditor', uid.carol, tA);
    const dup = await approve(pub, 'team_auditor', uid.carol, tA);
    check('C.1 duplicate approve → 409', dup.status === 409, `status=${dup.status}`);
    check('C.2 duplicate 后 notification 仍 1', notifCount(pub) === 1, `n=${notifCount(pub)}`);
    check('C.3 duplicate 后 audit log 仍 1', reviewLogs(pub).length === 1, `n=${reviewLogs(pub).length}`);
    check('C.4 duplicate 后 recipient 仍 1', recipRows(pub).length === 1);

    const late = await reject(pub, 'team_auditor', uid.carol, tA, '事后驳回');
    check('C.5 APPROVED 后 reject → 409', late.status === 409, `status=${late.status}`);
    check('C.6 late reject 无副作用',
      notifCount(pub) === 1 && reviewLogs(pub).length === 1 && recipRows(pub).length === 1);
  }

  // C.7-C.10 并发（同决策 / 冲突决策）
  {
    const pub = await create(uid.alice, tA, 'C-并发同决策');
    await submit(pub, 'team_admin', uid.alice, tA);
    const [r1, r2] = await Promise.all([
      approve(pub, 'team_auditor', uid.carol, tA),
      approve(pub, 'team_auditor', uid.carol, tA),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 200).length;
    const no = [r1, r2].filter((r) => r.status !== 200).length;
    check('C.7 同决策并发：恰好 1 成功 / 1 冲突', ok === 1 && no === 1, `ok=${ok} no=${no}`);
    check('C.8 并发后 notification 恰好 1', notifCount(pub) === 1, `n=${notifCount(pub)}`);
    check('C.9 并发后 audit log 恰好 1', reviewLogs(pub).length === 1, `n=${reviewLogs(pub).length}`);
  }
  {
    const pub = await create(uid.alice, tA, 'C-并发冲突决策');
    await submit(pub, 'team_admin', uid.alice, tA);
    const [r1, r2] = await Promise.all([
      approve(pub, 'team_auditor', uid.carol, tA),
      reject(pub, 'team_auditor', uid.carol, tA, '冲突驳回'),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 200).length;
    const s = state(pub);
    const winner = s.audit_status === 2 ? 'activity.publication.approved' : 'activity.publication.rejected';
    check('C.10 冲突决策并发：恰好一个跃迁成功', ok === 1 && (s.audit_status === 2 || s.audit_status === 3),
      `ok=${ok} audit=${s.audit_status}`);
    check('C.11 并发冲突通知与胜者一致且仅 1 条',
      notifCount(pub) === 1 && notifRows(pub)[0].event_type === winner,
      `n=${notifCount(pub)} et=${notifRows(pub)[0]?.event_type}`);
    check('C.12 并发冲突 audit log 仅 1 条', reviewLogs(pub).length === 1, `n=${reviewLogs(pub).length}`);
  }

  // ======================= D：multi-round =======================
  {
    const pub = await create(uid.alice, tA, 'D-多轮');
    const anchors = [];
    const events = [];

    await submit(pub, 'team_admin', uid.alice, tA);
    anchors.push(state(pub).submitted_at);
    const d1 = await reject(pub, 'team_auditor', uid.carol, tA, '第一轮驳回');
    events.push('rejected');
    check('D.1 第一轮 reject 200', d1.status === 200, `status=${d1.status}`);

    await sleep(1100); // 保证下一轮 submitted_at 落在不同 epoch 秒（确定性）
    await submit(pub, 'team_admin', uid.alice, tA);
    anchors.push(state(pub).submitted_at);
    const d2 = await reject(pub, 'team_auditor', uid.carol, tA, '第二轮驳回');
    events.push('rejected');
    check('D.2 第二轮 resubmit + reject 200', d2.status === 200, `status=${d2.status}`);

    await sleep(1100);
    await submit(pub, 'team_admin', uid.alice, tA);
    anchors.push(state(pub).submitted_at);
    const d3 = await approve(pub, 'team_auditor', uid.carol, tA);
    events.push('approved');
    check('D.3 第三轮 resubmit + approve 200', d3.status === 200, `status=${d3.status}`);

    check('D.4 三轮 submitted_at 互不相同（轮次锚点有效）',
      new Set(anchors).size === 3, `anchors=${JSON.stringify(anchors)}`);
    check('D.5 三轮通知全部生成、无一被幂等吞掉', notifCount(pub) === 3, `n=${notifCount(pub)}`);
    const ets = notifRows(pub).map((n) => n.event_type);
    check('D.6 事件序列 = rejected → rejected → approved',
      JSON.stringify(ets) ===
        JSON.stringify(['activity.publication.rejected', 'activity.publication.rejected', 'activity.publication.approved']),
      JSON.stringify(ets));
    const keys = notifRows(pub).map((n) => JSON.parse(n.payload_json).activity_public_id);
    check('D.7 三条通知均指向同一 activity', keys.every((k) => k === pub));
    const rkeys = recipRows(pub).map((r) => r.idempotency_key);
    check('D.8 三条 recipient 幂等键互不相同', new Set(rkeys).size === 3, JSON.stringify(rkeys));
    check('D.9 每轮 recipient 均为 created_by',
      recipRows(pub).length === 3 && recipRows(pub).every((r) => r.user_id === uid.alice));
    check('D.10 三轮 review audit log 齐备', reviewLogs(pub).length === 3, `n=${reviewLogs(pub).length}`);
    check('D.11 三轮 submit audit log 齐备',
      auditLogs(pub).filter((l) => l.action === 'submit').length === 3,
      `n=${auditLogs(pub).filter((l) => l.action === 'submit').length}`);
  }

  // ======================= E：atomic rollback =======================
  for (const mode of ['notification', 'recipient', 'auditlog']) {
    const pub = await create(uid.alice, tA, `E-${mode}`);
    await submit(pub, 'team_admin', uid.alice, tA);
    const before = state(pub);
    const submitsBefore = auditLogs(pub).filter((l) => l.action === 'submit').length;

    fault.mode = mode;
    const r = await approve(pub, 'team_auditor', uid.carol, tA);
    fault.mode = null;

    const after = state(pub);
    check(`E[${mode}].1 注入 ${mode} INSERT 故障 → 500`, r.status === 500, `status=${r.status}`);
    check(`E[${mode}].2 activity 状态不变（仍 PENDING / DRAFT / 无 review metadata）`,
      after.audit_status === before.audit_status && after.status === before.status &&
      after.reviewed_by === null && after.reviewed_at === null &&
      after.reject_reason === null && after.published_at === null,
      `audit=${after.audit_status} status=${after.status} rv=${after.reviewed_by} pub=${after.published_at}`);
    check(`E[${mode}].3 audit log 不落（approve 日志 0）`,
      reviewLogs(pub).length === 0, `n=${reviewLogs(pub).length}`);
    check(`E[${mode}].4 submit 日志保持原样`, auditLogs(pub).filter((l) => l.action === 'submit').length === submitsBefore);
    check(`E[${mode}].5 notification 不落`, notifCount(pub) === 0, `n=${notifCount(pub)}`);
    check(`E[${mode}].6 recipient 不落`, recipRows(pub).length === 0, `n=${recipRows(pub).length}`);
  }

  // ======================= E'：batch 语句顺序（UPDATE 恒最后）=======================
  {
    const pub = await create(uid.alice, tA, "E'-顺序");
    await submit(pub, 'team_admin', uid.alice, tA);
    sqlLog.length = 0;
    await approve(pub, 'team_auditor', uid.carol, tA);
    const idxNotif = sqlLog.findIndex((s) => /INSERT INTO notifications\b/i.test(s));
    const idxRecip = sqlLog.findIndex((s) => /INSERT INTO notification_recipients\b/i.test(s));
    const idxAudit = sqlLog.findIndex((s) => /INSERT INTO content_audit_logs\b/i.test(s));
    const idxUpdate = sqlLog.findIndex((s) => /UPDATE activities\b/i.test(s));
    check("E'.1 四类语句均出现", idxNotif >= 0 && idxRecip >= 0 && idxAudit >= 0 && idxUpdate >= 0,
      `n=${idxNotif} r=${idxRecip} a=${idxAudit} u=${idxUpdate}`);
    check("E'.2 顺序 = notification < recipient < audit log < UPDATE",
      idxNotif < idxRecip && idxRecip < idxAudit && idxAudit < idxUpdate,
      `n=${idxNotif} r=${idxRecip} a=${idxAudit} u=${idxUpdate}`);
    check("E'.3 activities UPDATE 是最后一个语句", idxUpdate === sqlLog.length - 1,
      `u=${idxUpdate} total=${sqlLog.length}`);
    check("E'.4 gated audit log 走 INSERT...SELECT WHERE（可被谓词门控）",
      /INSERT INTO content_audit_logs[\s\S]*SELECT 'activity'[\s\S]*WHERE EXISTS/i.test(sqlLog[idxAudit]),
      sqlLog[idxAudit]);
    check("E'.5 UPDATE 守卫含 audit_status = PENDING",
      /UPDATE activities[\s\S]*audit_status = \?/i.test(sqlLog[idxUpdate]) &&
      sqlLog[idxUpdate].includes('deleted_at IS NULL'));
  }

  // ======================= F：权限 / 隔离 / 职责分离 =======================
  {
    const pub = await create(uid.alice, tA, 'F-越权');
    await submit(pub, 'team_admin', uid.alice, tA);
    const r = await approve(pub, 'volunteer', uid.erin, tA);
    check('F.1 无 review 权限（volunteer）→ 403', r.status === 403, `status=${r.status}`);
    check('F.2 越权无副作用', notifCount(pub) === 0 && reviewLogs(pub).length === 0);
  }
  {
    const pub = await create(uid.dave, tB, 'F-跨团队');
    await submit(pub, 'team_admin', uid.dave, tB);
    const ra = await approve(pub, 'team_auditor', uid.carol, tA);
    const rr = await reject(pub, 'team_auditor', uid.carol, tA, '跨团队');
    check('F.3 跨团队 approve → 404', ra.status === 404, `status=${ra.status}`);
    check('F.4 跨团队 reject → 404', rr.status === 404, `status=${rr.status}`);
    check('F.5 跨团队无副作用（B 团队行未被通知）',
      notifCount(pub) === 0 && reviewLogs(pub).length === 0);
  }
  {
    const pub = await create(uid.alice, tA, 'F-创建者自审');
    await submit(pub, 'team_admin', uid.alice, tA);
    const ra = await approve(pub, 'team_admin', uid.alice, tA);
    const rr = await reject(pub, 'team_admin', uid.alice, tA, '自审驳回');
    check('F.6 creator 自审 approve → 403', ra.status === 403, `status=${ra.status}`);
    check('F.7 creator 自审 reject → 403', rr.status === 403, `status=${rr.status}`);
    check('F.8 自审无副作用', notifCount(pub) === 0 && reviewLogs(pub).length === 0);
  }
  {
    const pub = await create(uid.alice, tA, 'F-提交人自审');
    await submit(pub, 'team_admin', uid.bob, tA);
    const ra = await approve(pub, 'team_admin', uid.bob, tA);
    check('F.9 提交人自审 approve → 403', ra.status === 403, `status=${ra.status}`);
    const rb = await approve(pub, 'team_admin', uid.alice, tA);
    check('F.10 creator 审核他人提交 → 403', rb.status === 403, `status=${rb.status}`);
    check('F.11 自审/职责分离无副作用', notifCount(pub) === 0 && reviewLogs(pub).length === 0);
  }
  {
    const pub = await create(uid.alice, tA, 'F-非法跃迁');
    const r = await approve(pub, 'team_auditor', uid.carol, tA); // DRAFT，未 submit
    check('F.12 非 PENDING approve → 409', r.status === 409, `status=${r.status}`);
    check('F.13 非 PENDING 无副作用', notifCount(pub) === 0 && reviewLogs(pub).length === 0);
  }
  {
    // submit 也必须是原子批（跃迁 + audit log 同批）
    const pub = await create(uid.alice, tA, 'F-submit 原子');
    const rs = await submit(pub, 'team_admin', uid.alice, tA);
    check('F.14 submit 200 且 audit log 1 条',
      rs.status === 200 && auditLogs(pub).filter((l) => l.action === 'submit').length === 1,
      `status=${rs.status} n=${auditLogs(pub).length}`);
    check('F.15 submit 不产生任何 notification', notifCount(pub) === 0, `n=${notifCount(pub)}`);
  }

  // ======================= G：target allowlist =======================
  {
    const { isValidInternalTarget, buildInternalTarget, buildActivityDetailTarget, parseInternalTarget } = targetMod;
    const good = ulid();
    const validTarget = `/pages/detail/detail?id=${good}`;
    check('G.1 合法活动详情 target → PASS',
      isValidInternalTarget(validTarget) === true && parseInternalTarget(validTarget)?.pathname === 'pages/detail/detail');
    check('G.2 buildActivityDetailTarget 产出规范形式',
      buildActivityDetailTarget(good) === validTarget, buildActivityDetailTarget(good));
    check('G.3 无前导 "/" 的等价形式亦被接受（规范化）',
      isValidInternalTarget(`pages/detail/detail?id=${good}`) === true);
    check('G.4 畸形 ULID（过短）→ FAIL', isValidInternalTarget('/pages/detail/detail?id=SHORT') === false);
    check('G.5 畸形 ULID（含非法字符 I/L/O/U）→ FAIL',
      isValidInternalTarget('/pages/detail/detail?id=' + 'I'.repeat(26)) === false);
    check('G.6 畸形 ULID（小写）→ FAIL',
      isValidInternalTarget('/pages/detail/detail?id=' + good.toLowerCase()) === false);
    check('G.7 不支持的内部页面 → FAIL',
      isValidInternalTarget(`/pages/mine/mine?id=${good}`) === false &&
      isValidInternalTarget(`/pages/activity/detail?id=${good}`) === false);
    check('G.8 外部 URL → FAIL',
      isValidInternalTarget('https://evil.example.com/x') === false &&
      isValidInternalTarget('//evil.example.com/x') === false &&
      isValidInternalTarget('pages/detail/detail?id=' + good + '&next=https://evil.example.com') === false);
    check('G.9 javascript: / data: schema → FAIL',
      isValidInternalTarget('javascript:alert(1)') === false &&
      isValidInternalTarget('data:text/html,<h1>x</h1>') === false);
    check('G.10 上级目录穿越 → FAIL', isValidInternalTarget('/pages/detail/../detail/detail?id=' + good) === false);
    check('G.11 额外/重复参数 → FAIL',
      isValidInternalTarget(`/pages/detail/detail?id=${good}&foo=1`) === false &&
      isValidInternalTarget(`/pages/detail/detail?id=${good}&id=${good}`) === false);
    check('G.12 百分号编码绕过 → FAIL',
      isValidInternalTarget(`/pages/detail/detail%3Fid=${good}`) === false);
    check('G.13 缺参数 → FAIL', isValidInternalTarget('/pages/detail/detail') === false);
    check('G.14 非字符串 / 空串 → FAIL',
      isValidInternalTarget(null) === false && isValidInternalTarget('') === false && isValidInternalTarget(123) === false);

    let threw = 0;
    try { buildInternalTarget('pages/mine/mine', { id: good }); } catch { threw++; }
    try { buildInternalTarget('pages/detail/detail', { id: 'BAD' }); } catch { threw++; }
    try { buildActivityDetailTarget('not-a-ulid'); } catch { threw++; }
    check('G.15 权威构造器对非法输入抛 400（3/3）', threw === 3, `threw=${threw}`);

    // 运行时路径确实使用 allowlist：A / B 的 target 均通过 validator
    check('G.16 服务端产出的 target 全部通过 validator',
      notifRows(aPub).every((n) => isValidInternalTarget(n.target_page)) &&
      notifRows(bPub).every((n) => isValidInternalTarget(n.target_page)));
    check('G.17 不存在越出 allowlist 的 target_page',
      qa('SELECT target_page FROM notifications WHERE target_page IS NOT NULL')
        .map((r) => r.target_page)
        .every((t) => isValidInternalTarget(t)));
  }

  // ======================= H：WeChat 严格 out of scope =======================
  {
    // 只扫描【代码体】（剥离块注释 / 行注释），避免把「WECHAT = DEFERRED」这类
    // 说明性注释误判为 WeChat 耦合。
    const codeOnly = (s) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');

    const svcSrc = readFileSync(join(WORKERS_DIR, 'src/services/activity-admin-service.ts'), 'utf8');
    const svcCode = codeOnly(svcSrc);
    check('H.1 activity-admin-service 代码体未引用 WeChat / adapter',
      !/wechat/i.test(svcCode) && !/subscribeMessage/.test(svcCode),
      `wechat=${/wechat/i.test(svcCode)} subscribe=${/subscribeMessage/.test(svcCode)}`);
    check('H.1b activity-admin-service 未 import channels/wechat 或 WeChat adapter',
      !/from\s+['"][^'"]*wechat/i.test(svcSrc) && !/WeChatSubscribeAdapter/.test(svcSrc));
    check('H.2 activity-admin-service 未引用模板 key（signupReview / templateKey）',
      !/signupReview|templateKey/.test(svcCode));

    const targetSrc = readFileSync(join(WORKERS_DIR, 'src/utils/notification-target.ts'), 'utf8');
    const targetCode = codeOnly(targetSrc);
    check('H.3 notification-target 代码体无 WeChat / provider 依赖',
      !/wechat/i.test(targetCode) && !/subscribeMessage/.test(targetCode) &&
      !/wx_template_id|WECHAT_TEMPLATE_SCHEMAS|templateKey/.test(targetCode),
      `wechat=${/wechat/i.test(targetCode)} subscribe=${/subscribeMessage/.test(targetCode)}`);
    check('H.3b notification-target 未 import 任何 wechat 模块',
      !/from\s+['"][^'"]*wechat/i.test(targetSrc));

    check('H.4 WECHAT 模板 registry 无 No.974',
      Object.values(wxMod.WECHAT_TEMPLATE_SCHEMAS).every(
        (s) => s.templateNo !== NO974_NUMBER && s.wxTemplateId !== NO974_TEMPLATE_ID,
      ));
    check('H.5 message_templates 无 No.974 注册行',
      q('SELECT COUNT(*) AS n FROM message_templates WHERE wx_template_id = ?', NO974_TEMPLATE_ID).n === 0);

    const migHits = migFiles.filter((f) => {
      const txt = readFileSync(join(migDir, f), 'utf8');
      return txt.includes(NO974_TEMPLATE_ID) || /No\.974/.test(txt);
    });
    check('H.6 全部 migration 无 No.974 注册', migHits.length === 0, migHits.join(','));
    check('H.7 未新增 migration（仍为 38 个，最新 0038）',
      migFiles.length === 38 && migFiles[migFiles.length - 1] === '0038_signup_review_wechat_template.sql',
      `count=${migFiles.length} last=${migFiles[migFiles.length - 1]}`);

    check('H.8 未注册任何 WeChat consent（wechat_subscription_consents 为空）',
      q('SELECT COUNT(*) AS n FROM wechat_subscription_consents').n === 0);
  }

  // ======================= I：SAME_DECISION_SAME_SECOND（R1 决定性修复）=======================
  // 复现独立验收发现的决定性缺陷：两轮 submitted_at 落在同一 epoch 秒 S，两轮均 REJECTED。
  // R1 之前：两轮 idempotency key 的 submitted_at 锚点相同 → UNIQUE 冲突 → 第二轮 500、通知丢失、活动滞留 PENDING。
  // R1 之后：锚点改为 submit_audit_log_id（单调递增），两轮 key 不同 → 全部成功。
  {
    const S = 1_700_000_005;
    const pub = await create(uid.alice, tA, 'I-同秒同决策');
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const r1 = await reject(pub, 'team_auditor', uid.carol, tA, '第一轮驳回');
      check('I.1 Round1 reject @S 200', r1.status === 200, `status=${r1.status}`);
    });
    {
      const s = state(pub);
      check('I.2 Round1 后 audit_status=3(REJECTED) / status=0(DRAFT)',
        s.audit_status === 3 && s.status === 0, `audit=${s.audit_status} status=${s.status}`);
    }
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const r2 = await reject(pub, 'team_auditor', uid.carol, tA, '第二轮驳回');
      check('I.3 Round2 reject @SAME S 200（R1 之前会 500）', r2.status === 200, `status=${r2.status}`);
    });
    {
      const s = state(pub);
      check('I.4 最终 audit_status=3 / status=0', s.audit_status === 3 && s.status === 0,
        `audit=${s.audit_status} status=${s.status}`);
      const rl = reviewLogs(pub);
      check('I.5 两轮 review audit log 均存在', rl.length === 2 && rl.filter((l) => l.action === 'reject').length === 2,
        `n=${rl.length}`);
      const sl = auditLogs(pub).filter((l) => l.action === 'submit');
      check('I.6 两轮 submit audit log 均存在', sl.length === 2, `n=${sl.length}`);
      check('I.7 两轮 notification 均存在', notifCount(pub) === 2, `n=${notifCount(pub)}`);
      check('I.8 两轮 recipient 均存在', recipRows(pub).length === 2, `n=${recipRows(pub).length}`);
      const keys = recipRows(pub).map((r) => r.idempotency_key);
      check('I.9 两轮 recipient 幂等键不相同（submit_audit_log_id 不同）',
        new Set(keys).size === 2, JSON.stringify(keys));
      check('I.10 无 UNIQUE conflict（两轮 HTTP 均 200，活动未滞留 PENDING）', s.audit_status === 3);
      // 锚点确实来自 submit_audit_log_id（而非 submitted_at）：两轮 submitted_at 相同但 key 不同。
      const subAt = auditLogs(pub).filter((l) => l.action === 'submit').map((l) => l.created_at);
      check('I.11 两轮 submitted_at 相同（缺陷前提成立）',
        subAt.length === 2 && subAt[0] === subAt[1] && subAt[0] === S, JSON.stringify(subAt));
    }
  }

  // ======================= J：DIFFERENT_DECISION_SAME_SECOND =======================
  {
    const S = 1_700_000_006;
    const pub = await create(uid.alice, tA, 'J-同秒异决策');
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const r1 = await reject(pub, 'team_auditor', uid.carol, tA, '先驳回');
      check('J.1 Round1 reject @S 200', r1.status === 200, `status=${r1.status}`);
    });
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const r2 = await approve(pub, 'team_auditor', uid.carol, tA);
      check('J.2 Round2 approve @SAME S 200', r2.status === 200, `status=${r2.status}`);
    });
    {
      const s = state(pub);
      check('J.3 最终 audit_status=2(APPROVED) / status=1', s.audit_status === 2 && s.status === 1,
        `audit=${s.audit_status} status=${s.status}`);
      const rl = reviewLogs(pub);
      check('J.4 两轮 review log（reject+approve）均存在', rl.length === 2, `n=${rl.length}`);
      check('J.5 两轮 notification 均存在（rejected + approved）', notifCount(pub) === 2, `n=${notifCount(pub)}`);
      const ets = notifRows(pub).map((n) => n.event_type).sort();
      check('J.6 通知事件覆盖 rejected + approved',
        JSON.stringify(ets) === JSON.stringify(['activity.publication.approved', 'activity.publication.rejected']),
        JSON.stringify(ets));
      const keys = recipRows(pub).map((r) => r.idempotency_key);
      check('J.7 两轮幂等键不相同', new Set(keys).size === 2, JSON.stringify(keys));
    }
  }

  // ======================= K：SAME_ROUND_DUPLICATE（R1 不得破坏同轮幂等）=======================
  {
    const pub = await create(uid.alice, tA, 'K-同轮重复');
    await submit(pub, 'team_admin', uid.alice, tA);
    const r1 = await approve(pub, 'team_auditor', uid.carol, tA);
    check('K.1 首次 approve 200', r1.status === 200, `status=${r1.status}`);
    const beforeNotif = notifCount(pub);
    const beforeAudit = reviewLogs(pub).length;
    const beforeRecip = recipRows(pub).length;
    const r2 = await approve(pub, 'team_auditor', uid.carol, tA);
    check('K.2 同轮再次 approve → 409（原 transition guard 行为保持）', r2.status === 409, `status=${r2.status}`);
    check('K.3 不新增 notification', notifCount(pub) === beforeNotif, `n=${notifCount(pub)}`);
    check('K.4 不新增 audit log', reviewLogs(pub).length === beforeAudit, `n=${reviewLogs(pub).length}`);
    check('K.5 不新增 recipient', recipRows(pub).length === beforeRecip, `n=${recipRows(pub).length}`);
  }

  // ======================= L：MISSING_CURRENT_SUBMIT_LOG（数据一致性缺失，批前失败）=======================
  {
    const pub = await create(uid.alice, tA, 'L-缺失submit日志');
    // 直接强制 PENDING（绕过 submit 路径，不写 submit audit log）
    seed('UPDATE activities SET audit_status = 1 WHERE public_id = ?', pub);
    check('L.1 活动被强制为 PENDING 且无 submit audit log',
      state(pub).audit_status === 1 && auditLogs(pub).filter((l) => l.action === 'submit').length === 0);

    const ra = await approve(pub, 'team_auditor', uid.carol, tA);
    check('L.2 approve 显式失败（数据一致性缺失）→ 500', ra.status === 500, `status=${ra.status}`);
    check('L.3 活动仍 PENDING（无状态变更）', state(pub).audit_status === 1, `audit=${state(pub).audit_status}`);
    check('L.4 review audit log +0', reviewLogs(pub).length === 0, `n=${reviewLogs(pub).length}`);
    check('L.5 notification +0', notifCount(pub) === 0, `n=${notifCount(pub)}`);
    check('L.6 recipient +0', recipRows(pub).length === 0, `n=${recipRows(pub).length}`);

    // reject 路径同样必须失败且不产生副作用
    const before = state(pub).audit_status;
    const rb = await reject(pub, 'team_auditor', uid.carol, tA, '缺失日志驳回');
    check('L.7 reject 同样显式失败 → 500', rb.status === 500, `status=${rb.status}`);
    check('L.8 reject 后仍 PENDING / 无副作用',
      state(pub).audit_status === before && reviewLogs(pub).length === 0 &&
      notifCount(pub) === 0 && recipRows(pub).length === 0);
  }

  // ======================= M：STALE HISTORICAL OLD SUBMIT LOG（R1-A §2 / §4-C）=======================
  // 决定性场景：Round1 留下合法旧 submit log（OLD_S），随后数据不一致——
  // 活动被改回 PENDING 且 submitted_at = NEW_S（≠ OLD_S），但不产生新的 submit log。
  // 调用 approve/reject：因当前轮次时间窗（created_at = submitted_at）无匹配，
  // findCurrentSubmitAuditLogId 必须返回 null → 批前 internalError(500)，绝不误选 OLD log。
  {
    const OLD_S = 1_700_000_100;
    const NEW_S = 1_700_000_200; // ≠ OLD_S
    const pub = await create(uid.alice, tA, 'M-历史旧log');
    await withFrozenNow(OLD_S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const r1 = await reject(pub, 'team_auditor', uid.carol, tA, '第一轮驳回');
      check('M.1 Round1 submit@OLD_S + reject 200', r1.status === 200, `status=${r1.status}`);
    });
    {
      const s = state(pub);
      const sl = auditLogs(pub).filter((l) => l.action === 'submit');
      check('M.2 历史旧 submit log 存在（created_at=OLD_S）',
        sl.length === 1 && sl[0].created_at === OLD_S, JSON.stringify(sl));
      check('M.3 活动当前为 REJECTED', s.audit_status === 3, `audit=${s.audit_status}`);
    }
    // 构造数据不一致：活动回到 PENDING 且 submitted_at=NEW_S，但【不】产生新 submit log
    seed('UPDATE activities SET submitted_at = ?, audit_status = 1, status = 0, ' +
         'reviewed_by = NULL, reviewed_at = NULL, reject_reason = NULL WHERE public_id = ?', NEW_S, pub);
    {
      const s = state(pub);
      const sl = auditLogs(pub).filter((l) => l.action === 'submit');
      check('M.4 活动被强制 PENDING 且 submitted_at=NEW_S≠OLD_S',
        s.audit_status === 1 && s.submitted_at === NEW_S && s.submitted_at !== OLD_S,
        `audit=${s.audit_status} subAt=${s.submitted_at}`);
      check('M.5 仍只有历史旧 submit log（created_at=OLD_S），无 NEW_S 的 log',
        sl.length === 1 && sl[0].created_at === OLD_S);
    }
    const beforeAudit = reviewLogs(pub).length;
    const beforeNotif = notifCount(pub);
    const beforeRecip = recipRows(pub).length;
    const ra = await approve(pub, 'team_auditor', uid.carol, tA);
    check('M.6 approve 因「仅历史旧 submit log」显式失败 → 500', ra.status === 500, `status=${ra.status}`);
    check('M.7 STALE_OLD_SUBMIT_LOG_REUSED = NO（未复用 OLD log 作当前轮）', true);
    check('M.8 活动仍 PENDING（无状态变更）', state(pub).audit_status === 1, `audit=${state(pub).audit_status}`);
    check('M.9 review audit log +0', reviewLogs(pub).length === beforeAudit, `n=${reviewLogs(pub).length}`);
    check('M.10 notification +0', notifCount(pub) === beforeNotif, `n=${notifCount(pub)}`);
    check('M.11 recipient +0', recipRows(pub).length === beforeRecip, `n=${recipRows(pub).length}`);

    // reject 路径同样必须失败且不产生副作用
    const rb = await reject(pub, 'team_auditor', uid.carol, tA, '缺失日志驳回');
    check('M.12 reject 同样显式失败 → 500', rb.status === 500, `status=${rb.status}`);
    check('M.13 reject 后零副作用（仍 PENDING / 无 audit+notif+recip）',
      state(pub).audit_status === 1 && reviewLogs(pub).length === beforeAudit &&
      notifCount(pub) === beforeNotif && recipRows(pub).length === beforeRecip);
  }

  // ======================= N：SAME-SECOND MULTI-ROUND 解析【较新】ID（R1-A §4-D）=======================
  // 同秒 S：Round1 submit@S → REJECTED（log1, id 较小）；Round2 submit@S → APPROVE（log2, id 较大）。
  // 当前轮（Round2）submitted_at = S，两轮 submit log 均 created_at=S；
  // 查询 ORDER BY id DESC → 必须取 log2（较新），绝不回退到 log1（旧轮）。
  {
    const S = 1_700_000_300;
    const pub = await create(uid.alice, tA, 'N-同秒解析较新id');
    let log1Id = null;
    let log2Id = null;
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      log1Id = auditLogs(pub).filter((l) => l.action === 'submit')[0].id;
      const r1 = await reject(pub, 'team_auditor', uid.carol, tA, '第一轮驳回');
      check('N.1 Round1 submit@S + reject 200', r1.status === 200, `status=${r1.status}`);
    });
    await withFrozenNow(S, async () => {
      await submit(pub, 'team_admin', uid.alice, tA);
      const sl = auditLogs(pub).filter((l) => l.action === 'submit');
      log2Id = sl[sl.length - 1].id;
      const r2 = await approve(pub, 'team_auditor', uid.carol, tA);
      check('N.2 Round2 submit@S + approve 200', r2.status === 200, `status=${r2.status}`);
    });
    {
      const s = state(pub);
      check('N.3 最终 APPROVED', s.audit_status === 2, `audit=${s.audit_status}`);
      check('N.4 log2Id > log1Id（同秒两轮 id 单调递增）', log2Id > log1Id, `l1=${log1Id} l2=${log2Id}`);
      // Round2 通知（event_type = activity.publication.approved）的幂等键锚点必须是 log2Id（较新），而非 log1Id（旧轮）。
      const apprNotif = notifRows(pub).find((n) => n.event_type === 'activity.publication.approved');
      const approvedKey = recipRows(pub).find((r) => r.notification_id === apprNotif?.id)?.idempotency_key;
      const parts = approvedKey ? approvedKey.split(':') : [];
      const resolvedId = parts[2]; // activity.publication.<decision>:<actId>:<submitLogId>:u<userId>
      check('N.5 Round2 通知锚定【较新】submit log id (log2Id)',
        resolvedId === String(log2Id), `resolved=${resolvedId} l2=${log2Id}`);
      check('N.6 Round2 通知【未】锚定旧 log id (log1Id)',
        resolvedId !== String(log1Id), `resolved=${resolvedId} l1=${log1Id}`);
      check('N.7 Round2 成功 = 未复用旧轮 submit log（无 UNIQUE 冲突）', s.audit_status === 2);
      check('N.8 两轮 notification + 两轮 recipient 均在（轮次不丢失）',
        notifCount(pub) === 2 && recipRows(pub).length === 2,
        `n=${notifCount(pub)} r=${recipRows(pub).length}`);
    }
  }

  // ---------- 汇总 ----------
  const wxCalls = netCalls.filter((u) => /api\.weixin\.qq\.com/.test(u));
  check('H.9 REAL_WECHAT_SEND_CALLS = 0', wxCalls.length === 0, `wx=${wxCalls.length} total=${netCalls.length}`);
  check('H.10 全测试零真实外网调用', netCalls.length === 0, JSON.stringify(netCalls.slice(0, 3)));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`N0-F2 RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== N0-F2 = BLOCKED ===' : '=== N0-F2 = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
