#!/usr/bin/env node
/**
 * N0-A FINAL VERIFICATION —— MIGRATION UPGRADE FIXTURE CONFIRMATION（§3）。
 *
 * 目标：证明 0034 不只是 fresh/local-empty DB 可用，而是能正确「升级」一份
 * 含 legacy 行的旧 notifications 表（0001 旧 schema，含 user_id / team_id / notif_type /
 * title / content / target_type / target_id / is_read / read_at / channel）。
 *
 * 方法：在 workers/tmp/ 下建一份【独立】sqlite（不碰真实 local D1，更不碰 remote D1），
 * 还原 0001 旧 notifications schema + 2 条 legacy 行，然后直接执行 0034 真实 SQL，
 * 校验：内容保留 / recipient 迁移 / legacy read 状态保留 / 无 orphan / team_id 可 NULL / channel 有意丢弃。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.cwd(), 'tmp');
const FIX = join(TMP, '_n0a_legacy_fixture.sqlite');
if (existsSync(FIX)) unlinkSync(FIX);

const db = new DatabaseSync(FIX);
db.exec('PRAGMA foreign_keys = OFF;'); // 隔离测试数据迁移逻辑；FK 仅元数据，不强制

// ===== 还原 0001 legacy notifications schema（含 channel / is_read / read_at）+ users / teams =====
db.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE teams (id INTEGER PRIMARY KEY);
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  notif_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  target_type TEXT,
  target_id   INTEGER,
  is_read     INTEGER NOT NULL DEFAULT 0,
  read_at     INTEGER,
  channel     TEXT NOT NULL DEFAULT 'inapp',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO users (id) VALUES (10);
INSERT INTO teams (id) VALUES (7);
-- legacy row 1：已读（read_at 有值），channel=wechat_subscribe
INSERT INTO notifications (id, user_id, team_id, notif_type, title, content, target_type, target_id, is_read, read_at, channel, created_at)
  VALUES (1, 10, 7, 'signup', '旧报名通知', '旧报名正文内容', 'activity', 42, 1, 1700000000, 'wechat_subscribe', 1699999999);
-- legacy row 2：未读（read_at NULL），channel=inapp
INSERT INTO notifications (id, user_id, team_id, notif_type, title, content, target_type, target_id, is_read, read_at, channel, created_at)
  VALUES (2, 10, 7, 'system', '系统公告', '系统公告正文', NULL, NULL, 0, NULL, 'inapp', 1699999998);
`);

// ===== 执行真实 0034 迁移 SQL =====
const sql = readFileSync(join(process.cwd(), 'migrations', '0034_notification_core.sql'), 'utf8');
db.exec(sql);

// ===== 校验 =====
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

const nRows = db.prepare('SELECT * FROM notifications ORDER BY id').all();
const r1 = nRows.find((r) => r.id === 1);
const r2 = nRows.find((r) => r.id === 2);

check('legacy: 2 条通知被迁移', nRows.length === 2, `got ${nRows.length}`);
check('legacy row1 event_type = legacy.signup', r1?.event_type === 'legacy.signup', String(r1?.event_type));
check('legacy row1 title 保留', r1?.title === '旧报名通知');
check('legacy row1 body = content 保留', r1?.body === '旧报名正文内容');
check('legacy row1 team_id 保留 = 7', r1?.team_id === 7, `got ${r1?.team_id}`);
check('legacy row1 business_entity_type = activity 保留', r1?.business_entity_type === 'activity');
check('legacy row1 business_entity_id = 42 保留', r1?.business_entity_id === 42, `got ${r1?.business_entity_id}`);
check('legacy row2 event_type = legacy.system', r2?.event_type === 'legacy.system', String(r2?.event_type));
check('legacy row2 title 保留', r2?.title === '系统公告');

const recips = db.prepare('SELECT * FROM notification_recipients ORDER BY notification_id').all();
const rec1 = recips.find((x) => x.notification_id === 1);
const rec2 = recips.find((x) => x.notification_id === 2);
check('legacy: 2 条 recipient 被迁移', recips.length === 2, `got ${recips.length}`);
check('legacy recipient1 user_id = 10 正确迁移', rec1?.user_id === 10, `got ${rec1?.user_id}`);
check('legacy recipient1 read_at = 1700000000 保留（已读状态）', rec1?.read_at === 1700000000, `got ${rec1?.read_at}`);
check('legacy recipient2 read_at = NULL 保留（未读状态）', rec2?.read_at === null, `got ${rec2?.read_at}`);

const orphan = db
  .prepare('SELECT COUNT(*) AS n FROM notification_recipients WHERE notification_id NOT IN (SELECT id FROM notifications)')
  .get().n;
check('legacy: 无 orphan recipient', orphan === 0, `got ${orphan}`);

// team_id 后续允许 NULL
try {
  db.prepare('INSERT INTO notifications (public_id, event_type, category, title) VALUES (?,?,?,?)').run(
    '01NTF00000000000000000000000X',
    'legacy.nulltest',
    'system',
    'nullable test',
  );
  const n = db.prepare('SELECT team_id FROM notifications WHERE public_id = ?').get('01NTF00000000000000000000000X');
  check('team_id 后续允许 NULL', n?.team_id === null, `got ${n?.team_id}`);
} catch (e) {
  check('team_id 后续允许 NULL', false, String(e));
}

// channel 列：有意丢弃（统一通知域把 channel 收敛到 delivery 层，本轮仅 IN_APP；SMS/微信交付推迟 N0-D/N0-C）
const cols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
check('channel 列有意从 notifications 丢弃（统一通知域 v1）', !cols.includes('channel'), `cols=${cols.join(',')}`);

check('migration 成功（notifications + notification_recipients 均存在且 2 行）', cols.length > 0 && recips.length === 2);

db.close();
process.stderr.write(`\nLEGACY FIXTURE TOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
