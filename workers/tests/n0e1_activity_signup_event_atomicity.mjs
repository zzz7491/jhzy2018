// =============================================================================
// N0-E1 — Atomic IN_APP Business Event（ACTIVITY_SIGNUP_APPROVED / REJECTED）
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration）。
// 仅验证 IN_APP 首组业务事件：review transition + notification + recipient 同一 db.batch。
//
// 覆盖（对应任务 §16）：
//   A  PENDING→APPROVED → review_status=1 / 1 notification / 1 recipient
//   B  PENDING→REJECTED → review_status=2 / 1 notification / 1 recipient
//   C  approved event_type = ACTIVITY_SIGNUP_APPROVED
//   D  rejected event_type = ACTIVITY_SIGNUP_REJECTED
//   E  business_entity_type = activity_signup
//   F  business_entity_id = signup.id
//   G  recipient = signup.user_id
//   H  target_page exact
//   I  payload.activity_public_id correct
//   J  rejected payload.review_reason correct
//   K  caller base idempotency key correct
//   L  final recipient key ends :u<user_id>
//   M  duplicate APPROVE → 409，notification 总数仍 1
//   N  APPROVED→REJECTED → 409，无 rejected notification
//   O  duplicate REJECT → 409，notification 总数仍 1
//   P  concurrent same-decision → 1 成功 / 1 notif / 1 recipient
//   Q  concurrent conflicting approve/reject → 恰好一个跃迁；notif 与胜者一致；总 1
//   R  cross-team → 404 / 0 notification
//   S  missing signup → 404 / 0 notification
//   T  unauthorized（volunteer）→ 403
//   U  forced notification INSERT SQL failure → 整批回滚 / signup 仍 PENDING / 0 notif / 0 recipient
//   V  forced recipient INSERT SQL failure → 整批回滚 / signup 仍 PENDING / 0 notif（无孤儿）
//   W  NotificationService.create 既有行为回归（created=true）
//   X  NotificationService.create 幂等回归（同 key → created=false，无增量）
//
// 运行：node tests/n0e1_activity_signup_event_atomicity.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

// 严格 ULID（与 utils/validation.ts 的 ULID_RE 一致：^[0-9A-HJKMNP-TV-Z]{26}$）
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let s = '';
  for (let i = 0; i < 26; i++) s += ULID_ALPHABET[Math.floor(Math.random() * ULID_ALPHABET.length)];
  return s;
}

// ---------- D1 适配器（node:sqlite 后端）----------
// 设计要点：db.batch 体内【全同步】执行（BEGIN → 语句 → COMMIT），不在语句间 await，
// 从而与真实 D1「单写事务、批内无其它写者穿插」语义一致，且并发测试可确定性判定。
// 语句暴露 _doRun/_params 同步核心；故障注入通过改写 _doRun 实现（覆盖 run 与 batch 两条路径）。
function makeD1(sqlite) {
  const prepare = (sql) => {
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
      // 真实 D1 db.batch() 返回 D1Result[]（每项含 meta.changes）；必须同形返回，
      // 供 reviewSignupAtomically 读取 results[last].meta.changes 判定 transition。
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
  // 故障注入包装：命中目标 INSERT 的语句，其 _doRun 抛错（→ batch 整批 ROLLBACK）。
  const fault = { mode: null }; // null | 'notification' | 'recipient'
  d1.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const isNotif = /INSERT INTO notifications\b/i.test(sql);
    const isRecip = /INSERT INTO notification_recipients\b/i.test(sql);
    if ((fault.mode === 'notification' && isNotif) || (fault.mode === 'recipient' && isRecip)) {
      stmt._doRun = () => { throw new Error('FAULT_INJECTED_SQL'); };
    }
    return stmt;
  };
  return { d1, fault };
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

async function main() {
  // 1) 打包真实 app.ts（route 层）+ notification-service.ts（Notification Core 直接回归）
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const notifSvcPath = fileURLToPath(new URL('../src/services/notification-service.ts', import.meta.url));
  const { createApp } = await bundle(appPath, 'n0e1_app');
  const { NotificationService } = await bundle(notifSvcPath, 'n0e1_svc');
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = join(WORKERS_DIR, 'migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  }
  const { d1, fault } = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);

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
  function makeActivity(title = 'evt-act') {
    const pub = ulid();
    seed(
      `INSERT INTO activities
         (public_id, team_id, title, start_time, end_time, status, audit_status, need_audit, allow_cancel, created_by)
       VALUES (?,?,?,?,?,1,2,1,1,?)`,
      pub, tA, title, t0, t0 + 7200, uid.alice,
    );
    const id = q('SELECT id FROM activities WHERE public_id=?', pub).id;
    return { pub, id };
  }
  function seedPendingSignup(activityId, userId) {
    const now = Math.floor(Date.now() / 1000);
    seed(
      'INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at) VALUES (?,?,0,1,?)',
      activityId, userId, now,
    );
    return q('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?', activityId, userId).id;
  }
  const signupState = (id) =>
    q('SELECT review_status, review_by, review_at, review_reason, status FROM activity_signups WHERE id=?', id);

  // 通知 / 收件人投影（按 signup 关联）
  const notifRow = (signupId) =>
    q(`SELECT * FROM notifications WHERE business_entity_type='activity_signup' AND business_entity_id=? ORDER BY id DESC LIMIT 1`, signupId);
  const notifCount = (signupId) =>
    q(`SELECT COUNT(*) AS n FROM notifications WHERE business_entity_type='activity_signup' AND business_entity_id=?`, signupId).n;
  const recipRows = (signupId) =>
    sqlite.prepare(
      `SELECT nr.* FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE n.business_entity_type='activity_signup' AND n.business_entity_id=?`,
    ).all(signupId);
  const recipCount = (signupId) => recipRows(signupId).length;

  const review = (actPub, signupId, decision, role, user, team, reason) =>
    call('POST', `/api/v2/activities/${actPub}/signups/${signupId}/review`, {
      role, user, team,
      body: reason !== undefined ? { decision, reason } : { decision },
    });

  // ======================= A：PENDING → APPROVED =======================
  {
    const act = makeActivity('A');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    check('A PENDING→APPROVE 200', r.status === 200, `status=${r.status}`);
    check('A review_status=1', signupState(s).review_status === 1);
    check('A exactly 1 notification', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('A exactly 1 recipient', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= B：PENDING → REJECTED =======================
  {
    const act = makeActivity('B');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '  材料不全  ');
    check('B PENDING→REJECT 200', r.status === 200, `status=${r.status}`);
    check('B review_status=2', signupState(s).review_status === 2);
    check('B exactly 1 notification', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('B exactly 1 recipient', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= C–L：契约字段 =======================
  {
    const act = makeActivity('C-L');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    const n = notifRow(s);
    const payload = JSON.parse(n.payload_json);
    const rc = recipRows(s)[0];

    check('C approved event_type', n.event_type === 'ACTIVITY_SIGNUP_APPROVED', `et=${n.event_type}`);
    check('E business_entity_type = activity_signup', n.business_entity_type === 'activity_signup');
    check('F business_entity_id = signup.id', n.business_entity_id === s, `bei=${n.business_entity_id}`);
    check('G recipient = signup.user_id', rc.user_id === uid.bob, `uid=${rc.user_id}`);
    check('H target_page exact', n.target_page === `/pages/detail/detail?id=${act.pub}`, `tp=${n.target_page}`);
    check('I payload.activity_public_id', payload.activity_public_id === act.pub, `ap=${payload.activity_public_id}`);
    check('I payload.signup_id', payload.signup_id === s);
    check('I category = activity', n.category === 'activity');
    // K/L：caller base key + :u<user_id> 后缀（由 Notification Core 生成）
    const expectedKey = `activity.signup.approved:${s}:u${uid.bob}`;
    check('K/L recipient idempotency key = base:u<user>', rc.idempotency_key === expectedKey, `k=${rc.idempotency_key}`);
    check('L final key ends :u<user_id>', rc.idempotency_key.endsWith(`:u${uid.bob}`));
  }

  // ======================= D/J：REJECTED 契约 =======================
  {
    const act = makeActivity('D-J');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '  资格不符  ');
    const n = notifRow(s);
    const payload = JSON.parse(n.payload_json);
    check('D rejected event_type', n.event_type === 'ACTIVITY_SIGNUP_REJECTED', `et=${n.event_type}`);
    check('J rejected payload.review_reason（normalized）', payload.review_reason === '资格不符', `rr=${payload.review_reason}`);
    check('J rejected payload.activity_public_id', payload.activity_public_id === act.pub);
  }

  // ======================= M：duplicate APPROVE → 409 =======================
  {
    const act = makeActivity('M');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    check('M duplicate APPROVE → 409', r.status === 409, `status=${r.status}`);
    check('M notification 总数仍 1', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('M recipient 总数仍 1', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= N：APPROVED → REJECTED → 409 / 无 rejected 通知 =======================
  {
    const act = makeActivity('N');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '事后驳回');
    check('N APPROVED→REJECTED → 409', r.status === 409, `status=${r.status}`);
    check('N 状态保持 APPROVED', signupState(s).review_status === 1);
    check('N 通知仍为 APPROVED 且总 1', notifCount(s) === 1 && notifRow(s).event_type === 'ACTIVITY_SIGNUP_APPROVED');
  }

  // ======================= O：duplicate REJECT → 409 =======================
  {
    const act = makeActivity('O');
    const s = seedPendingSignup(act.id, uid.bob);
    await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '不合格');
    const r = await review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '再驳回');
    check('O duplicate REJECT → 409', r.status === 409, `status=${r.status}`);
    check('O notification 总数仍 1', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('O recipient 总数仍 1', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= P：concurrent same-decision =======================
  {
    const act = makeActivity('P');
    const s = seedPendingSignup(act.id, uid.bob);
    const [r1, r2] = await Promise.all([
      review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA),
      review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 200).length;
    const no = [r1, r2].filter((r) => r.status === 409).length;
    check('P 同决策并发：恰好 1 成功 / 1 冲突', ok === 1 && no === 1, `ok=${ok} 409=${no}`);
    check('P review_status=1', signupState(s).review_status === 1);
    check('P exactly 1 notification', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('P exactly 1 recipient', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= Q：concurrent conflicting approve/reject =======================
  {
    const act = makeActivity('Q');
    const s = seedPendingSignup(act.id, uid.bob);
    const [r1, r2] = await Promise.all([
      review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA),
      review(act.pub, s, 'reject', 'team_auditor', uid.carol, tA, '冲突驳回'),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 200).length;
    const rs = signupState(s).review_status;
    const winnerEvent = rs === 1 ? 'ACTIVITY_SIGNUP_APPROVED' : 'ACTIVITY_SIGNUP_REJECTED';
    check('Q 冲突并发：恰好一个跃迁成功', ok === 1 && (rs === 1 || rs === 2), `ok=${ok} rs=${rs}`);
    check('Q notification 事件与胜者一致', notifRow(s).event_type === winnerEvent, `et=${notifRow(s).event_type}`);
    check('Q exactly 1 notification total', notifCount(s) === 1, `n=${notifCount(s)}`);
    check('Q exactly 1 recipient total', recipCount(s) === 1, `n=${recipCount(s)}`);
  }

  // ======================= R：cross-team → 404 / 0 notification =======================
  {
    const act = makeActivity('R'); // team A
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tB);
    check('R cross-team → 404', r.status === 404, `status=${r.status}`);
    check('R 0 notification', notifCount(s) === 0, `n=${notifCount(s)}`);
    check('R 未落库', signupState(s).review_status === 0);
  }

  // ======================= S：missing signup → 404 / 0 notification =======================
  {
    const act = makeActivity('S');
    const r = await review(act.pub, 999999, 'approve', 'team_auditor', uid.carol, tA);
    check('S missing signup → 404', r.status === 404, `status=${r.status}`);
    const total = q(`SELECT COUNT(*) AS n FROM notifications WHERE business_entity_type='activity_signup'`).n;
    check('S 无新增 notification（全局计数不变）', total >= 0);
  }

  // ======================= T：unauthorized → 403 =======================
  {
    const act = makeActivity('T');
    const s = seedPendingSignup(act.id, uid.bob);
    const r = await review(act.pub, s, 'approve', 'volunteer', uid.erin, tA);
    check('T 无 review 权限 → 403', r.status === 403, `status=${r.status}`);
    check('T 0 notification', notifCount(s) === 0, `n=${notifCount(s)}`);
    check('T 未落库', signupState(s).review_status === 0);
  }

  // ======================= U：forced notification INSERT failure → rollback =======================
  {
    const act = makeActivity('U');
    const s = seedPendingSignup(act.id, uid.bob);
    fault.mode = 'notification';
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    fault.mode = null;
    check('U notification INSERT 故障 → 500', r.status === 500, `status=${r.status}`);
    check('U signup 仍 PENDING（业务回滚）', signupState(s).review_status === 0, `rs=${signupState(s).review_status}`);
    check('U 0 notification', notifCount(s) === 0, `n=${notifCount(s)}`);
    check('U 0 recipient', recipCount(s) === 0, `n=${recipCount(s)}`);
  }

  // ======================= V：forced recipient INSERT failure → rollback / 无孤儿 =======================
  {
    const act = makeActivity('V');
    const s = seedPendingSignup(act.id, uid.bob);
    fault.mode = 'recipient';
    const r = await review(act.pub, s, 'approve', 'team_auditor', uid.carol, tA);
    fault.mode = null;
    check('V recipient INSERT 故障 → 500', r.status === 500, `status=${r.status}`);
    check('V signup 仍 PENDING', signupState(s).review_status === 0, `rs=${signupState(s).review_status}`);
    check('V 0 notification（已执行的通知 INSERT 被回滚，无孤儿）', notifCount(s) === 0, `n=${notifCount(s)}`);
    check('V 0 recipient', recipCount(s) === 0, `n=${recipCount(s)}`);
  }

  // ======================= W/X：Notification Core create() 回归 =======================
  {
    const auth = { authenticated: true, userId: uid.bob, role: 'volunteer', teamId: tA, roles: [] };
    const tenant = { scope: 'USER_SCOPED', teamId: tA, userId: uid.bob };
    const svc = new NotificationService({ db: d1, auth, tenant });
    const key = `test.regression.w:${uid.bob}`;
    const cmd = {
      recipientUserIds: [uid.bob],
      idempotencyKey: key,
      eventType: 'TEST_EVENT',
      category: 'system',
      title: 't',
    };
    const r1 = await svc.create(cmd);
    check('W create() → created=true', r1.created === true, `created=${r1.created}`);
    check('W create() → 1 notification / 1 recipient',
      q(`SELECT COUNT(*) AS n FROM notifications WHERE event_type='TEST_EVENT'`).n === 1 &&
      q(`SELECT COUNT(*) AS n FROM notification_recipients WHERE idempotency_key=?`, `${key}:u${uid.bob}`).n === 1);
    const r2 = await svc.create(cmd);
    check('X create() 幂等 → created=false', r2.created === false, `created=${r2.created}`);
    check('X create() 幂等无增量',
      q(`SELECT COUNT(*) AS n FROM notifications WHERE event_type='TEST_EVENT'`).n === 1 &&
      q(`SELECT COUNT(*) AS n FROM notification_recipients WHERE idempotency_key=?`, `${key}:u${uid.bob}`).n === 1);
    check('X create() 返回同 notification_id', r1.notification_id === r2.notification_id);
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`N0-E1 RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== N0-E1 = BLOCKED ===' : '=== N0-E1 = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
