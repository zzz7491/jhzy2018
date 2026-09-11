#!/usr/bin/env node
/**
 * N0-A Notification Core（统一通知域 v1 · IN_APP 闭环）集成测试。
 *
 * 前置：
 *   - 本地 D1 已应用 0034（notifications 重建 + notification_recipients 新建）。
 *   - `wrangler dev --local --port 8787` 已启动（读取同一本地 D1 文件）。
 *
 * 认证：依赖 local test 中间件——`x-test-user`（整数 userId）/ `x-test-role`。
 * 播种：直接打开本地 D1 sqlite，插入两个隔离测试用户 + 通知/投递态（幂等，可重复运行）。
 *
 * 覆盖（N0-A 验收 §27 repo/service、§28 route 跨用户、§29 migration）：
 *   A  认证拒绝（401）/ 非法 ULID（400）
 *   B  列表（newest-first / 分页 / read 标记 / 仅本人）
 *   C  未读数
 *   D  标记已读（幂等 / 保留 read_at / 详情含 body 不含内部字段）
 *   E  全部已读
 *   F  跨用户隔离（他人通知 → 404；列表仅本人；合法但不存在 ULID → 404）
 *   G  migration 完整性（UNIQUE(idempotency_key)；team_id 可空）
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// 强制 localhost 绕过任何代理（避免 node fetch 把 127.0.0.1 误走代理）。
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const D1_DIR = join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const DBFILE = join(D1_DIR, readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')[0]);

/** Crockford ULID 字符集（与 src/utils/crypto.generateUlid 完全一致，且匹配 validation.requireUlidParam 正则）。 */
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** 由固定 seed 确定性生成 26 位合法 ULID（保证重复运行幂等，同一 seed → 同一 id）。 */
function fixedUlid(seed) {
  let s = '';
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < 26; i++) {
    s += ENC[(x + i * 7) % 32];
    x = (x * 1103515245 + 12345) >>> 0;
  }
  return s;
}

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

const authH = (userId, role = 'volunteer') => ({ 'x-test-user': String(userId), 'x-test-role': role });
async function call(method, path, { headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, body: json };
}

// ===================== 播种（直接 D1 写，幂等）=====================
const db = new DatabaseSync(DBFILE);
function ensureUser(seed) {
  const pid = fixedUlid(seed);
  db.prepare(`INSERT OR IGNORE INTO users (public_id) VALUES (?)`).run(pid);
  return db.prepare(`SELECT id FROM users WHERE public_id = ?`).get(pid).id;
}
const userA = ensureUser(101);
const userB = ensureUser(202);

// 清理本轮残留（不碰其它数据），保证可重复运行。
db.prepare(`DELETE FROM notification_recipients WHERE user_id IN (?, ?)`).run(userA, userB);
db.prepare(`DELETE FROM notifications WHERE created_by IS NULL AND title LIKE 'N0A-%'`).run();

function seedNotification(pid, { teamId = null, eventType, category, title, summary = null, body = null, targetPage = null }) {
  db.prepare(
    `INSERT INTO notifications (public_id, team_id, event_type, category, title, summary, body, target_page, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(pid, teamId, eventType, category, title, summary, body, targetPage);
  return db.prepare(`SELECT id FROM notifications WHERE public_id = ?`).get(pid).id;
}
function seedRecipient(notifId, userId, idemKey, readAt = null) {
  db.prepare(
    `INSERT OR IGNORE INTO notification_recipients (public_id, notification_id, user_id, read_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(fixedUlid(notifId * 31 + userId), notifId, userId, readAt, idemKey);
}

// userA：3 条（nA1 团队级 team_id=1 验证 OPTIONAL scope；nA2 用户级；nA3 已读）
const idA1 = fixedUlid(1001);
const idA2 = fixedUlid(1002);
const idA3 = fixedUlid(1003);
const nA1 = seedNotification(idA1, { teamId: 1, eventType: 'activity.signup.approved', category: 'activity', title: 'N0A-活动报名通过', summary: '您报名的活动已通过', body: '详情正文', targetPage: 'pages/activity/detail' });
seedRecipient(nA1, userA, `n0a:${idA1}:u${userA}`);
const nA2 = seedNotification(idA2, { teamId: null, eventType: 'system.maintenance', category: 'system', title: 'N0A-系统维护通知' });
seedRecipient(nA2, userA, `n0a:${idA2}:u${userA}`);
const nA3 = seedNotification(idA3, { teamId: null, eventType: 'points.earned', category: 'points', title: 'N0A-积分到账', body: '获得10积分' });
seedRecipient(nA3, userA, `n0a:${idA3}:u${userA}`, Math.floor(Date.now() / 1000)); // 已读

// userB：1 条（验证跨用户隔离）
const idB1 = fixedUlid(2001);
const nB1 = seedNotification(idB1, { teamId: null, eventType: 'team.invite', category: 'team', title: 'N0A-B队邀请' });
seedRecipient(nB1, userB, `n0a:${idB1}:u${userB}`);
db.close();

// ===================== A. 认证 / 参数 =====================
process.stderr.write('A. 认证 / 参数校验\n');
{
  const r = await call('GET', '/api/v2/notifications');
  check('A1 未认证 401 AUTH_REQUIRED', r.res.status === 401 && r.body?.error?.code === 'AUTH_REQUIRED', `got ${r.res.status}`);
  const bad = await call('GET', '/api/v2/notifications/ZZZZ', { headers: authH(userA) });
  check('A2 非法 ULID 400 INVALID_PARAM', bad.res.status === 400 && bad.body?.error?.code === 'INVALID_PARAM', `got ${bad.res.status}`);
}

// ===================== B. 列表 =====================
process.stderr.write('B. 列表（newest-first / 仅本人 / read 标记）\n');
let listItems = [];
{
  const r = await call('GET', '/api/v2/notifications', { headers: authH(userA) });
  check('B1 list 200', r.res.status === 200 && r.body?.success === true, `got ${r.res.status}`);
  listItems = r.body?.data?.items ?? [];
  check('B2 仅本人 3 条', listItems.length === 3, `len=${listItems.length}`);
  let ordered = true;
  for (let i = 1; i < listItems.length; i++) if (listItems[i].created_at > listItems[i - 1].created_at) ordered = false;
  check('B3 newest-first（created_at 降序）', ordered, JSON.stringify(listItems.map((i) => i.created_at)));
  const byId = Object.fromEntries(listItems.map((i) => [i.id, i]));
  check('B4 nA3 已读=true', byId[idA3]?.read === true, JSON.stringify(byId[idA3]));
  check('B5 nA1 未读=false', byId[idA1]?.read === false, JSON.stringify(byId[idA1]));
  check('B6 nA2 未读=false', byId[idA2]?.read === false, JSON.stringify(byId[idA2]));
  check('B7 返回的 id 均为合法 ULID', listItems.every((i) => ULID_RE.test(i.id)), '');
  check('B8 含分页对象', r.body?.data?.pagination && typeof r.body.data.pagination.total === 'number', '');
  check('B9 团队级通知对本人可见（team_id 非读权限）', byId[idA1]?.title === 'N0A-活动报名通过', JSON.stringify(byId[idA1]));
}

// ===================== C. 未读数 =====================
process.stderr.write('C. 未读数\n');
{
  const r = await call('GET', '/api/v2/notifications/unread-count', { headers: authH(userA) });
  check('C1 unread-count 200', r.res.status === 200, `got ${r.res.status}`);
  check('C2 未读=2（nA1/nA2 未读，nA3 已读）', r.body?.data?.unread === 2, `unread=${r.body?.data?.unread}`);
}

// ===================== D. 标记已读（幂等）=====================
process.stderr.write('D. 标记已读（幂等 / 详情）\n');
{
  const r = await call('POST', `/api/v2/notifications/${idA1}/read`, { headers: authH(userA) });
  check('D1 mark-read 200 read=true', r.res.status === 200 && r.body?.data?.read === true, `got ${r.res.status} ${JSON.stringify(r.body)}`);
  const u = await call('GET', '/api/v2/notifications/unread-count', { headers: authH(userA) });
  check('D2 标记后未读=1', u.body?.data?.unread === 1, `unread=${u.body?.data?.unread}`);

  const again = await call('POST', `/api/v2/notifications/${idA1}/read`, { headers: authH(userA) });
  check('D3 重复标记仍 200（幂等）', again.res.status === 200 && again.body?.data?.read === true, `got ${again.res.status}`);
  const detail = await call('GET', `/api/v2/notifications/${idA1}`, { headers: authH(userA) });
  check('D4 详情保留 read=true', detail.body?.data?.read === true, JSON.stringify(detail.body?.data));
  check('D5 详情含 body 正文', detail.body?.data?.body === '详情正文', `body=${detail.body?.data?.body}`);
  check('D6 详情不含内部字段（idempotency_key/payload_json/deleted_at）', !JSON.stringify(detail.body).includes('idempotency_key') && !JSON.stringify(detail.body).includes('payload_json') && !JSON.stringify(detail.body).includes('deleted_at'), '');
}

// ===================== E. 全部已读 =====================
process.stderr.write('E. 全部已读\n');
{
  const r = await call('POST', '/api/v2/notifications/read-all', { headers: authH(userA) });
  check('E1 read-all 200', r.res.status === 200, `got ${r.res.status}`);
  check('E2 updated ≥ 1', (r.body?.data?.updated ?? 0) >= 1, `updated=${r.body?.data?.updated}`);
  const u = await call('GET', '/api/v2/notifications/unread-count', { headers: authH(userA) });
  check('E3 全部已读后未读=0', u.body?.data?.unread === 0, `unread=${u.body?.data?.unread}`);
}

// ===================== F. 跨用户隔离 =====================
process.stderr.write('F. 跨用户隔离\n');
{
  const cross = await call('GET', `/api/v2/notifications/${idA1}`, { headers: authH(userB) });
  check('F1 他人通知 → 404 NOT_FOUND（不泄露存在）', cross.res.status === 404 && cross.body?.error?.code === 'NOT_FOUND', `got ${cross.res.status} ${JSON.stringify(cross.body)}`);
  const crossList = await call('GET', '/api/v2/notifications', { headers: authH(userB) });
  const items = crossList.body?.data?.items ?? [];
  check('F2 他人列表仅含本人 1 条', items.length === 1 && items[0]?.id === idB1, `len=${items.length}`);
  const missing = await call('GET', `/api/v2/notifications/${fixedUlid(7777)}`, { headers: authH(userA) });
  check('F3 合法但不存在的 ULID → 404', missing.res.status === 404 && missing.body?.error?.code === 'NOT_FOUND', `got ${missing.res.status}`);
}

// ===================== G. migration 完整性 =====================
process.stderr.write('G. migration 完整性（§29）\n');
{
  // team_id 可空：nA2/nA3 已成功以 team_id=NULL 写入（播种未抛错即证明）。
  const dbg = new DatabaseSync(DBFILE, { readOnly: true });
  const nullTeam = dbg.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE public_id IN (?, ?) AND team_id IS NULL`).get(idA2, idA3).n;
  check('G1 team_id 可空（nA2/nA3 为 NULL）', nullTeam === 2, `nullTeam=${nullTeam}`);
  const cols = dbg.prepare(`PRAGMA table_info(notification_recipients)`).all().map((c) => `${c.name}:${c.notnull ? 'NOTNULL' : ''}`);
  check('G2 notification_recipients 含 user_id NOTNULL + idempotency_key NOTNULL', cols.includes('user_id:NOTNULL') && cols.includes('idempotency_key:NOTNULL'), JSON.stringify(cols));
  dbg.close();

  // UNIQUE(idempotency_key)：重复插入同键必须被拒绝。
  let dupRejected = false;
  try {
    const w = new DatabaseSync(DBFILE);
    w.prepare(`INSERT INTO notification_recipients (public_id, notification_id, user_id, idempotency_key) VALUES (?, ?, ?, ?)`).run(fixedUlid(99991), nA1, userA, `n0a:${idA1}:u${userA}`);
    w.close();
  } catch (e) {
    dupRejected = /UNIQUE/.test(String(e));
  }
  check('G3 重复 idempotency_key 被 UNIQUE 拒绝', dupRejected, 'duplicate not rejected');
}

process.stderr.write(`\nTOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
