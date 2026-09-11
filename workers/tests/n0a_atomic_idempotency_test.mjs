#!/usr/bin/env node
/**
 * N0-A ATOMIC IDEMPOTENCY FINAL FIX —— 真实调用 NotificationService.create()。
 *
 * 前置：wrangler dev（--local）已在 BASE_URL 启动，且 __test.ts 挂载临时 /notification-create 端点。
 * 真实服务路径：__test 端点 → new NotificationService(...).create(body) → repo.createIdempotent()
 * （D1 batch 原子写入，无 ON CONFLICT DO NOTHING；冲突整批回滚）。
 *
 * 覆盖：
 *   A   first create        → 1 notification / 1 recipient
 *   B   same key once       → delta 0/0, same id, created=false
 *   C   same key ×5         → 最终 1 notification / 1 recipient
 *   D   different key       → 第二组正常创建
 *   E   team_id NULL        → PASS
 *   F   valid team_id       → PASS
 *   G   direct UNIQUE       → 直接重复插入被拒（schema 级）
 *   H   global orphan query → 0
 *   8   ATOMIC FAILURE PROOF → 冲突 batch 回滚，尝试的 notification 未落库（NOTIFICATION_INSERT_ROLLED_BACK=YES）
 *   9   NON-IDEMPOTENCY PROOF → FK 错误原样抛出，不误判为 created=false（NON_IDEMPOTENCY_ERRORS_NOT_SWALLOWED=YES）
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8803';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

function d1File() {
  return join(
    D1_DIR,
    readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0],
  );
}
function withDb(fn) {
  const db = new DatabaseSync(d1File());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const q1 = (sql, ...b) => withDb((db) => db.prepare(sql).get(...b));

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

const nCount = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n);
const rCount = () =>
  withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM notification_recipients').get().n);
const nByTitle = (t) =>
  withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE title = ?').get(t).n);
const orphanCount = () =>
  withDb(
    (db) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications n
            WHERE n.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM notification_recipients nr
                WHERE nr.notification_id = n.id AND nr.deleted_at IS NULL
              )`,
        )
        .get().n,
  );

async function login(openid, unionid) {
  const res = await fetch(`${BASE}/api/v2/auth/wechat/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: `MOCK_WECHAT_CODE.${openid}.${unionid}` }),
  });
  return res.json();
}

async function create(body, token) {
  const res = await fetch(`${BASE}/api/v2/__test/notification-create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

// ===== setup =====
const la = await login('N0A_ATOMIC_A', 'N0A_ATOMIC_UA');
const lb = await login('N0A_ATOMIC_B', 'N0A_ATOMIC_UB');
const uAid = q1('SELECT id FROM users WHERE public_id = ?', la?.data?.user?.public_id)?.id;
const uBid = q1('SELECT id FROM users WHERE public_id = ?', lb?.data?.user?.public_id)?.id;
const TOKEN = la?.data?.token ?? '';
const teamId = q1('SELECT id FROM teams LIMIT 1')?.id;

check('setup: 用户 A 取得整数 id', typeof uAid === 'number' && uAid > 0, `uAid=${uAid}`);
check('setup: 用户 B 取得整数 id', typeof uBid === 'number' && uBid > 0, `uBid=${uBid}`);
check('setup: 取得真实 team id（F 用）', typeof teamId === 'number' && teamId > 0, `teamId=${teamId}`);

// ===== A. first create =====
process.stderr.write('A first create\n');
let firstId = null;
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.first',
      eventType: 'activity.signup.approved',
      category: 'activity',
      title: 'A 报名通过',
      summary: 'a',
      body: 'b',
      teamId: null,
      businessEntityType: 'activity',
      businessEntityId: 777,
      targetPage: '/pages/activity/detail',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('A HTTP 200', resp.status === 200, `http=${resp.status} ${JSON.stringify(resp.body).slice(0, 160)}`);
  check('A notifications +1', n1 === n0 + 1, `${n0}→${n1}`);
  check('A recipients +1', r1 === r0 + 1, `${r0}→${r1}`);
  check('A created = true', resp.body?.data?.recipients?.[0]?.created === true);
  check('A 返回 ULID public_id', typeof resp.body?.data?.notification_id === 'string' && resp.body.data.notification_id.length === 26);
  firstId = resp.body?.data?.notification_id;
}

// ===== B. same key once =====
process.stderr.write('B same key once\n');
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.first',
      eventType: 'activity.signup.approved',
      category: 'activity',
      title: 'B 重复（同 key）',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('B HTTP 200（无未处理 500）', resp.status === 200, `http=${resp.status}`);
  check('B 返回 created = false', resp.body?.data?.created === false, JSON.stringify(resp.body?.data));
  check('B recipient delta = 0', r1 === r0, `${r0}→${r1}`);
  check('B notification delta = 0', n1 === n0, `${n0}→${n1}`);
  check('B 返回原始 notification id', resp.body?.data?.notification_id === firstId, `${resp.body?.data?.notification_id} vs ${firstId}`);
}

// ===== C. same key ×5 =====
process.stderr.write('C same key ×5\n');
{
  const nBefore = nCount();
  const rBefore = rCount();
  let lastReturnedId = null;
  for (let i = 0; i < 5; i++) {
    const resp = await create(
      {
        recipientUserIds: [uAid],
        idempotencyKey: 'atomic.first',
        eventType: 'activity.signup.approved',
        category: 'activity',
        title: `C 重复 ${i}`,
      },
      TOKEN,
    );
    lastReturnedId = resp.body?.data?.notification_id;
    check(`C[${i}] HTTP 200`, resp.status === 200, `http=${resp.status}`);
    check(`C[${i}] created = false`, resp.body?.data?.created === false);
  }
  const nAfter = nCount();
  const rAfter = rCount();
  const byKey = withDb(
    (db) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications n
             JOIN notification_recipients nr ON nr.notification_id = n.id
            WHERE nr.idempotency_key = ?`,
        )
        .get('atomic.first:u' + uAid).n,
  );
  const recByKey = withDb(
    (db) =>
      db.prepare('SELECT COUNT(*) AS n FROM notification_recipients WHERE idempotency_key = ?').get('atomic.first:u' + uAid).n,
  );
  check('C notification 净增 = 0', nAfter === nBefore, `${nBefore}→${nAfter}`);
  check('C recipient 净增 = 0', rAfter === rBefore, `${rBefore}→${rAfter}`);
  check('C 该 key 仅 1 条 notification', byKey === 1, `byKey=${byKey}`);
  check('C 该 key 仅 1 条 recipient', recByKey === 1, `recByKey=${recByKey}`);
  check('C 每次返回原始 id', lastReturnedId === firstId, `${lastReturnedId} vs ${firstId}`);
}

// ===== D. different key =====
process.stderr.write('D different key\n');
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.second',
      eventType: 'points.earned',
      category: 'points',
      title: 'D 积分到账',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('D HTTP 200', resp.status === 200, `http=${resp.status}`);
  check('D notifications +1', n1 === n0 + 1, `${n0}→${n1}`);
  check('D recipients +1', r1 === r0 + 1, `${r0}→${r1}`);
  check('D created = true', resp.body?.data?.recipients?.[0]?.created === true);
}

// ===== E. team_id NULL =====
process.stderr.write('E team_id NULL\n');
{
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.nullteam',
      eventType: 'system.announce',
      category: 'system',
      title: 'E 系统通知（无团队）',
      teamId: null,
    },
    TOKEN,
  );
  check('E HTTP 200', resp.status === 200, `http=${resp.status}`);
  const pid = resp.body?.data?.notification_id;
  const row = q1('SELECT team_id, title FROM notifications WHERE public_id = ?', pid);
  check('E team_id 落库 NULL', row?.team_id === null, `team_id=${row?.team_id}`);
}

// ===== F. valid team_id =====
process.stderr.write('F valid team_id\n');
{
  const resp = await create(
    {
      recipientUserIds: [uBid],
      idempotencyKey: 'atomic.team',
      eventType: 'team.invite',
      category: 'team',
      title: 'F 团队邀请',
      teamId,
    },
    TOKEN,
  );
  check('F HTTP 200', resp.status === 200, `http=${resp.status}`);
  const pid = resp.body?.data?.notification_id;
  const row = q1('SELECT team_id, title FROM notifications WHERE public_id = ?', pid);
  check('F team_id 落库 = 传入有效值', row?.team_id === teamId, `team_id=${row?.team_id} expect=${teamId}`);
}

// ===== G. direct UNIQUE（schema 级，隔离 copy） =====
process.stderr.write('G direct UNIQUE\n');
{
  const src = d1File();
  const tmp = join(process.cwd(), 'tmp', '_atomic_unique_probe.sqlite');
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  copyFileSync(src, tmp);
  const db = new DatabaseSync(tmp);
  let rejected = false;
  try {
    db.exec(
      `INSERT INTO notifications (public_id, event_type, category, title, created_at) VALUES ('UQ_G_A','e','system','t',1)`,
    );
    db.exec(
      `INSERT INTO notification_recipients (public_id, notification_id, user_id, read_at, created_at, idempotency_key) VALUES ('R_G_A',(SELECT id FROM notifications WHERE public_id='UQ_G_A'),1,NULL,1,'gkey')`,
    );
    db.exec(
      `INSERT INTO notification_recipients (public_id, notification_id, user_id, read_at, created_at, idempotency_key) VALUES ('R_G_B',(SELECT id FROM notifications WHERE public_id='UQ_G_A'),1,NULL,1,'gkey')`,
    );
  } catch (e) {
    rejected = /UNIQUE constraint failed/.test(String(e?.message ?? e));
  }
  db.close();
  check('G 直接重复 idempotency_key 被 UNIQUE 拒绝', rejected);
  // live 索引确认
  const idx = withDb(
    (db) =>
      db
        .prepare(`SELECT name, "unique" FROM pragma_index_list('notification_recipients')`)
        .all()
        .find((r) => r.name === 'idx_nrec_idempotency'),
  );
  check('G live UNIQUE 索引存在', !!idx && idx.unique === 1, JSON.stringify(idx));
}

// ===== 8. ATOMIC FAILURE PROOF =====
process.stderr.write('8 atomic rollback proof\n');
{
  // 8.1 通过服务 pre-seed 一条冲突 key 的既有通知（提交成功）
  const seedResp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.probe.key',
      eventType: 'system.announce',
      category: 'system',
      title: 'ATOMIC_PROBE_SEED_TITLE',
    },
    TOKEN,
  );
  check('8.1 pre-seed HTTP 200', seedResp.status === 200, `http=${seedResp.status}`);
  const seedId = seedResp.body?.data?.notification_id;

  // 8.2 同 key 重试，但携带可识别 marker title（若被错误提交即可被查到）
  const nBefore = nCount();
  const attemptResp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.probe.key', // 与 pre-seed 相同 → 冲突
      eventType: 'system.announce',
      category: 'system',
      title: 'ATOMIC_ROLLBACK_MARKER_XYZ', // 本次尝试的 notification 携带此 marker
    },
    TOKEN,
  );
  const nAfter = nCount();

  check('8.2 重试 HTTP 200（无未处理 500）', attemptResp.status === 200, `http=${attemptResp.status}`);
  check('8.2 重试 created = false', attemptResp.body?.data?.created === false);
  check('8.2 重试返回原始 notification id', attemptResp.body?.data?.notification_id === seedId, `${attemptResp.body?.data?.notification_id} vs ${seedId}`);
  check('8.2 冲突 batch 回滚：notification 净增 = 0', nAfter === nBefore, `${nBefore}→${nAfter}`);
  // 关键证据：本次尝试生成的 notification（marker title）必须不存在
  const markerRows = nByTitle('ATOMIC_ROLLBACK_MARKER_XYZ');
  check('8.3 NOTIFICATION_INSERT_ROLLED_BACK = YES（marker 通知未落库）', markerRows === 0, `markerRows=${markerRows}`);
  const seedRows = nByTitle('ATOMIC_PROBE_SEED_TITLE');
  check('8.4 既有 seed 通知仍保留（=1）', seedRows === 1, `seedRows=${seedRows}`);
}

// ===== 9. NON-IDEMPOTENCY ERROR PROOF（FK） =====
process.stderr.write('9 non-idempotency error not swallowed\n');
{
  const nBefore = nCount();
  // 合法可控 FK failure：team_id 指向不存在的 team
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'atomic.fk.newerror',
      eventType: 'system.announce',
      category: 'system',
      title: 'ATOMIC_FK_MARKER',
      teamId: 999999,
    },
    TOKEN,
  );
  const nAfter = nCount();
  check('9.1 FK 错误被抛出（HTTP != 200）', resp.status !== 200, `http=${resp.status} body=${JSON.stringify(resp.body).slice(0, 160)}`);
  check('9.2 未被误判为 created = false', resp.body?.data?.created !== false, JSON.stringify(resp.body?.data));
  check('9.3 错误尝试的 notification 未落库（不吞错误且回滚）', nByTitle('ATOMIC_FK_MARKER') === 0, `markerRows=${nByTitle('ATOMIC_FK_MARKER')}`);
  check('9.4 notification 总数未因错误尝试增加', nAfter === nBefore, `${nBefore}→${nAfter}`);
  check('9.5 NON_IDEMPOTENCY_ERRORS_NOT_SWALLOWED = YES', resp.status !== 200 && resp.body?.data?.created !== false && nByTitle('ATOMIC_FK_MARKER') === 0);
}

// ===== H. global orphan query =====
process.stderr.write('H global orphan query\n');
{
  const oc = orphanCount();
  check('H orphan count = 0', oc === 0, `orphan=${oc}`);
}

process.stderr.write(`\nATOMIC IDEMPOTENCY TOTAL: ${pass} pass, ${fail} fail\n`);
process.stdout.write(`TOTAL ${pass} ${fail}\n`);
process.exitCode = fail === 0 ? 0 : 1;
