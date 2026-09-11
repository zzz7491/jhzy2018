#!/usr/bin/env node
/**
 * N0-A FINAL VERIFICATION —— SERVICE CREATE PATH TEST（非 direct SQL seed）。
 *
 * 真实调用 workers/src/routes/__test.ts 的 TEMPORARY /notification-create 端点，
 * 该端点内部 new NotificationService(...).create(body) —— 即真实 notification core 内部 create API。
 *
 * 前置：wrangler dev（--local）已在 BASE_URL 启动，且 __test.ts 已挂载临时 create 端点。
 * 依赖 D1 文件（read-only 计数）；用户通过 local mock wechat login 创建，避免直接猜 users schema。
 *
 * 覆盖（指令 §2）：
 *   CASE 1  new semantic create        → notifications +1, recipients +1
 *   CASE 2  same idempotency_key retry → recipient 幂等（不重复），notification 内容行 delta=0（无孤儿）
 *   CASE 3  different idempotency_key   → 允许再建一条通知
 *   CASE 4  team_id = NULL             → 创建成功
 *   CASE 5  team_id = valid value      → 创建成功
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8799';
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

function dbFile() {
  return join(
    D1_DIR,
    readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0],
  );
}
function withDb(fn) {
  const db = new DatabaseSync(dbFile());
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

// ===== setup：创建两个隔离测试用户 + 取一个真实 team id =====
const la = await login('N0A_OPENID_A', 'N0A_UNIONID_A');
const lb = await login('N0A_OPENID_B', 'N0A_UNIONID_B');
const uAid = q1('SELECT id FROM users WHERE public_id = ?', la?.data?.user?.public_id)?.id;
const uBid = q1('SELECT id FROM users WHERE public_id = ?', lb?.data?.user?.public_id)?.id;
const TOKEN = la?.data?.token ?? '';
const teamId = q1('SELECT id FROM teams LIMIT 1')?.id;

check('setup: 测试用户 A 已建且取得整数 id', typeof uAid === 'number' && uAid > 0, `uAid=${uAid}`);
check('setup: 测试用户 B 已建且取得整数 id', typeof uBid === 'number' && uBid > 0, `uBid=${uBid}`);
check('setup: 取得真实 team id（CASE 5 用）', typeof teamId === 'number' && teamId > 0, `teamId=${teamId}`);

// ===== CASE 1：new semantic create =====
process.stderr.write('CASE 1 new semantic create\n');
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'n0a.case1.signup',
      eventType: 'activity.signup.approved',
      category: 'activity',
      title: 'CASE1 报名通过',
      summary: '您报名的活动已通过',
      body: '详情见活动页',
      teamId: null,
      businessEntityType: 'activity',
      businessEntityId: 777,
      targetPage: '/pages/activity/detail',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('CASE1 HTTP 200', resp.status === 200, `http=${resp.status} ${JSON.stringify(resp.body).slice(0, 200)}`);
  check('CASE1 notifications +1', n1 === n0 + 1, `${n0}→${n1}`);
  check('CASE1 recipients +1', r1 === r0 + 1, `${r0}→${r1}`);
  check(
    'CASE1 返回 recipients[0].created = true',
    resp.body?.data?.recipients?.[0]?.created === true,
    JSON.stringify(resp.body?.data?.recipients),
  );
  check(
    'CASE1 返回 notification_id（ULID public_id）',
    typeof resp.body?.data?.notification_id === 'string' && resp.body.data.notification_id.length === 26,
    String(resp.body?.data?.notification_id),
  );
}

// ===== CASE 2：same idempotency_key retry =====
process.stderr.write('CASE 2 same idempotency_key retry\n');
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'n0a.case1.signup', // 与 CASE1 完全相同
      eventType: 'activity.signup.approved',
      category: 'activity',
      title: 'CASE2 重复（同 key）',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('CASE2 HTTP 200（无未处理 500）', resp.status === 200, `http=${resp.status} ${JSON.stringify(resp.body).slice(0, 200)}`);
  check(
    'CASE2 recipient 幂等：recipients 计数不变',
    r1 === r0,
    `${r0}→${r1}`,
  );
  check(
    'CASE2 返回 recipients[0].created = false（命中既有 recipient）',
    resp.body?.data?.recipients?.[0]?.created === false,
    JSON.stringify(resp.body?.data?.recipients),
  );
  check(
    'CASE2 幂等修正：notification 内容行 delta=0（无孤儿内容行）',
    n1 === n0,
    `${n0}→${n1}`,
  );
}

// ===== CASE 3：different idempotency_key =====
process.stderr.write('CASE 3 different idempotency_key\n');
{
  const n0 = nCount();
  const r0 = rCount();
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'n0a.case3.other',
      eventType: 'points.earned',
      category: 'points',
      title: 'CASE3 积分到账',
    },
    TOKEN,
  );
  const n1 = nCount();
  const r1 = rCount();
  check('CASE3 HTTP 200', resp.status === 200, `http=${resp.status}`);
  check('CASE3 允许再建一条通知（notifications +1）', n1 === n0 + 1, `${n0}→${n1}`);
  check('CASE3 新 recipient（recipients +1）', r1 === r0 + 1, `${r0}→${r1}`);
  check('CASE3 created = true', resp.body?.data?.recipients?.[0]?.created === true);
}

// ===== CASE 4：team_id = NULL =====
process.stderr.write('CASE 4 team_id = NULL\n');
{
  const resp = await create(
    {
      recipientUserIds: [uAid],
      idempotencyKey: 'n0a.case4.nullteam',
      eventType: 'system.announce',
      category: 'system',
      title: 'CASE4 系统通知（无团队）',
      teamId: null,
    },
    TOKEN,
  );
  check('CASE4 HTTP 200', resp.status === 200, `http=${resp.status}`);
  const pid = resp.body?.data?.notification_id;
  const row = q1(
    'SELECT team_id, event_type, category, title FROM notifications WHERE public_id = ?',
    pid,
  );
  check('CASE4 team_id 落库为 NULL', row?.team_id === null, `team_id=${row?.team_id}`);
  check('CASE4 内容保留', row?.title === 'CASE4 系统通知（无团队）' && row?.category === 'system');
}

// ===== CASE 5：team_id = valid value =====
process.stderr.write('CASE 5 team_id = valid value\n');
{
  const resp = await create(
    {
      recipientUserIds: [uBid],
      idempotencyKey: 'n0a.case5.team',
      eventType: 'team.invite',
      category: 'team',
      title: 'CASE5 团队邀请',
      teamId,
    },
    TOKEN,
  );
  check('CASE5 HTTP 200', resp.status === 200, `http=${resp.status}`);
  const pid = resp.body?.data?.notification_id;
  const row = q1(
    'SELECT team_id, event_type, category, title FROM notifications WHERE public_id = ?',
    pid,
  );
  check('CASE5 team_id 落库 = 传入有效值', row?.team_id === teamId, `team_id=${row?.team_id} expect=${teamId}`);
  check('CASE5 内容保留', row?.title === 'CASE5 团队邀请' && row?.category === 'team');
}

process.stderr.write(`\nSERVICE CREATE TOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
