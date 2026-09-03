#!/usr/bin/env node
/**
 * S2-5 本地测试 fixture 管理（TEST-ONLY）。
 *
 * 用法：node tests/fixture.mjs setup|teardown
 *
 * 纪律：
 * - 仅操作本地 miniflare D1 sqlite 文件（与 S2-4 相同路径发现逻辑）。
 * - 所有测试行 public_id 以 '01TEST' 前缀标记，可识别、可清理。
 * - 禁止 INSERT INTO permissions / role_permissions（即使测试也不允许）。
 * - 在 wrangler dev 启动前 setup / 停止后 teardown，避免文件锁竞争。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 必须与 src/services/wechat-auth-service.ts 的 local 测试密钥一致（TEST-ONLY，非生产密钥）。
const LOCAL_IDENTITY_KEY = 'local-test-only-identity-key';
const identityHash = (identifier) => createHmac('sha256', LOCAL_IDENTITY_KEY).update(identifier).digest('hex');

/**
 * 全部测试用到的微信身份标识明文（S2-6c-3 新增）。
 *
 * 为什么需要：首登自动建档的用户 public_id 是运行时生成的合法 ULID（不可能是 '01TEST' 前缀），
 * 仅靠 `public_id LIKE '01TEST%'` 无法清理，teardown 会残留。
 * 因此清理时以【身份摘要反查 user_id】为锚点，把自动建档用户一并纳入删除集合。
 * 明文只存在于本测试文件（等价于一串测试 OpenID），不进任何业务日志。
 */
export const TEST_IDENTITIES = [
  // --- S2-6c-2 auth 模式既有 ---
  'OPENID_A', 'UNIONID_A',
  'OPENID_B',
  'OPENID_OWNER',
  'UNIONID_PLAT',
  'OPENID_SHARED', 'UNIONID_SHARED',
  'OPENID_DISABLED',
  'OPENID_REVOKED',
  'OPENID_INACTIVE',
  // --- S2-6c-2 测试中动态使用 ---
  'OPENID_UNKNOWN', 'OPENID_NEW', 'UNIONID_NEW',
  // --- S2-6c-3 首登 / 冲突 ---
  'FL_OPENID_1', 'FL_UNIONID_1',
  'FL_OPENID_ONLY',
  'FL_OPENID_REPEAT',
  'FL_OPENID_UA',
  'CONFLICT_OPENID', 'CONFLICT_UNIONID',
];
const TEST_HASHES = TEST_IDENTITIES.map(identityHash);

// D1 persistence dir 可被覆盖（S2-6i 等隔离 state 场景）：默认沿用 .wrangler/state。
const D1_DIR =
  process.env.JHZY_D1_DIR ??
  join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');

function findDbPath() {
  if (!existsSync(D1_DIR)) throw new Error(`D1 state dir not found: ${D1_DIR}`);
  const files = readdirSync(D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`expected exactly 1 sqlite file, got: ${files.join(',')}`);
  return join(D1_DIR, files[0]);
}

// ===== TEST ULID（26 位，Crockford 字符集，排除 I/L/O/U）=====
export const IDS = {
  teamA: '01TESTTEAMAAAAAAAAAAAAAAAA', // 10 + 16 A
  teamB: '01TESTTEAMBBBBBBBBBBBBBBBB',
  volA: '01TESTUSERAAAAAAAAAAAAAAAA', // 10 + 16 A
  volB: '01TESTUSERBBBBBBBBBBBBBBBB',
  ownerA: '01TESTUSERCDDDDDDDDDDDDDDD', // 11 + 15 D
  auditorA: '01TESTUSERCEEEEEEEEEEEEEE1', // 11 + 14 E + '1'
  plat: '01TESTUSERCPPPPPPPPPPPPPPP', // 11 + 15 P
  disabled: '01TESTUSERDDDDDDDDDDDDDDDD', // S2-6c-2：停用用户（status=3）
  teamAdminA: '01TESTUSERCFADMIN000000000A', // S2-6f：团队管理员（team_admin @ teamA）
  actA1: '01TESTACTAAAAAAAAAAAAAAAAA', // 9 + 17 A
  actA2: '01TESTACTBBBBBBBBBBBBBBBBB',
  actB1: '01TESTACTCCCCCCCCCCCCCCCCC',
  // S2-6g：报名垂直切片专用活动（'01TESTACTS' = 10 + 序号 1 + 15 填充 = 26）
  actS1: '01TESTACTS1AAAAAAAAAAAAAAA', // teamA / status=1 报名中 / allow_cancel=1 / need_audit=0
  actS2: '01TESTACTS2AAAAAAAAAAAAAAA', // teamA / status=1 报名中 / allow_cancel=0 / need_audit=1
  actS3: '01TESTACTS3AAAAAAAAAAAAAAA', // teamA / status=0 草稿  / allow_cancel=1 / need_audit=0
  actS4: '01TESTACTS4AAAAAAAAAAAAAAA', // teamB / status=1 报名中 / allow_cancel=1 / need_audit=0
  actS5: '01TESTACTS5AAAAAAAAAAAAAAA', // teamA / status=1 / allow_cancel=1 / need_audit=0（他人报名不可取消）
  actS6: '01TESTACTS6AAAAAAAAAAAAAAA', // teamA / status=1 / allow_cancel=1 / need_audit=0（角色撤销/恢复）
  // 6 + 9 + 10 + 1 = 26
  platSuper: '01TESTUSERSUPER0000000000A', // S2-6g：platform_super_admin（scope NULL）
  // S2-6h：签到垂直切片专用活动（'01TESTATT' = 10 + 序号 + 15 填充 = 26）
  actAtt1: '01TESTATT1AAAAAAAAAAAAAAAA', // teamA / status=1 报名中 / volA 已报名（B/C 主路径）
  actAtt2: '01TESTATT2AAAAAAAAAAAAAAAA', // teamA / status=1 / volA 已报名（重复签到 / 签退路径）
  actAtt3: '01TESTATT3AAAAAAAAAAAAAAAA', // teamA / status=1 / volA 未报名（无报名 → 409）
  actAtt4: '01TESTATT4AAAAAAAAAAAAAAAA', // teamA / status=1 / volA 已报名（D 组权限矩阵）
  actAtt5: '01TESTATT5AAAAAAAAAAAAAAAA', // teamA / status=1 / volA 已报名（E 组实时授权）
  actAttB: '01TESTATTBAAAAAAAAAAAAAAAA', // teamB / status=1 / volB 已报名（跨团队 → 404）
  // ===== S2-6i（Review + Force Checkout）专用 fixture =====
  adminA: '01TESTUSERadminA', // team_admin @ teamA
  ownerB: '01TESTUSERownerB', // team_owner @ teamB
  mpUserA: '01TESTUSERmpUserA', // volunteer @ teamA（多参加模型：同一 signup → 多 session）
  actMgmtA: '01TESTACTmgmtA', // teamA / status=1
  actMgmtB: '01TESTACTmgmtB', // teamB / status=1
  // 合法 ULID 但库中不存在（用于 404 与"不泄露存在性"对照）。
  sessMissing: '01TESTSESSZZZZZZZZZZZZZZZZ',
  // 畸形 sessionId（非正整数 → 400）。
  sessMalformed: 'abc-not-int',
};

const T0 = 1756500000; // 固定时间戳，保证幂等

function idByPublicId(db, publicId) {
  return db.prepare('SELECT id FROM users WHERE public_id = ?').get(publicId)?.id ?? null;
}

/**
 * 需要清理的 user id 集合：'01TEST' 前缀用户 ∪ 绑定了测试身份摘要的用户（含首登自动建档）。
 */
function testUserIds(db) {
  const ids = new Set();
  for (const r of db.prepare(`SELECT id FROM users WHERE public_id LIKE '01TEST%'`).all()) ids.add(r.id);
  const stmt = db.prepare(`SELECT user_id FROM user_identities WHERE identity_hash = ?`);
  for (const h of TEST_HASHES) for (const r of stmt.all(h)) ids.add(r.user_id);
  return [...ids];
}

/**
 * 动态 FK 感知级联删除：遍历所有引用 users / teams 的表，删除测试 id 命中的子行。
 * 背景：早期 clean() 仅手写删除少量子表，当 DB 中存在其它 users 子表残留
 * （如 S2-4 校验器写入的 activity_signups、或上一 fixture 的 user_roles）时，
 * `DELETE FROM users` 会因外键约束失败。动态发现全部外键子表可保证 teardown 真正零残留，
 * 且对 Schema 演进（新增 users 子表）零维护成本。TEST-ONLY 使用。
 */
function cascadeDeleteTestRefs(db, ids, teamIds, activityIds = []) {
  const userIn = ids.length > 0 ? ids.join(',') : '-1';
  const teamIn = teamIds.length > 0 ? teamIds.join(',') : '-1';
  // S2-6g：activity_signups / attendance_sessions 等表外键指向 activities。
  // clean() 期间 PRAGMA foreign_keys = OFF，DELETE FROM activities 不会级联，
  // 若不清子行会留下孤儿 activity_signups（teardown 零残留断言失败）。
  const actIn = activityIds.length > 0 ? activityIds.join(',') : '-1';
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all();
  for (const { name } of tables) {
    let fks;
    try {
      fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all();
    } catch {
      continue;
    }
    for (const fk of fks) {
      if (fk.table === 'users') {
        try {
          db.prepare(`DELETE FROM "${name}" WHERE "${fk.from}" IN (${userIn})`).run();
        } catch {
          /* 列类型不匹配等忽略 */
        }
      } else if (fk.table === 'teams') {
        try {
          db.prepare(`DELETE FROM "${name}" WHERE "${fk.from}" IN (${teamIn})`).run();
        } catch {
          /* 忽略 */
        }
      } else if (fk.table === 'activities') {
        try {
          db.prepare(`DELETE FROM "${name}" WHERE "${fk.from}" IN (${actIn})`).run();
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}

function clean(db) {
  // 临时关闭 FK 约束，按"子表先于父表"任意顺序安全删除（TEST-ONLY，不影响 production）。
  // 动态级联已删除全部测试引用行，重新开启后状态一致、零残留。
  db.exec('PRAGMA foreign_keys = OFF;');
  // 测试用户 id 集合：'01TEST' 前缀 ∪ 绑定了测试身份摘要的用户 ∪ S2-4 校验器 'TEST%' 用户。
  const ids = testUserIds(db); // 返回 number[]
  for (const r of db.prepare(`SELECT id FROM users WHERE public_id LIKE 'TEST%'`).all()) ids.push(r.id);
  const teamIds = db
    .prepare(`SELECT id FROM teams WHERE public_id LIKE '01TEST%' OR public_id LIKE 'TEST%'`)
    .all()
    .map((r) => r.id);
  const activityIds = db
    .prepare(`SELECT id FROM activities WHERE public_id LIKE '01TEST%' OR public_id LIKE 'TEST%'`)
    .all()
    .map((r) => r.id);
  cascadeDeleteTestRefs(db, ids, teamIds, activityIds);
  // 兜底：按 public_id 显式清理活动（activities.team_id / created_by 已被级联覆盖）。
  db.prepare(`DELETE FROM activities WHERE public_id LIKE '01TEST%' OR public_id LIKE 'TEST%'`).run();
  db.prepare(`DELETE FROM teams WHERE public_id LIKE '01TEST%' OR public_id LIKE 'TEST%'`).run();
  db.prepare(`DELETE FROM users WHERE id ${ids.length > 0 ? `IN (${ids.join(',')})` : 'IN (-1)'}`).run();
  db.exec('PRAGMA foreign_keys = ON;');
}

function setup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, 1)`);
  insUser.run(IDS.volA, 'TEST-VolA');
  insUser.run(IDS.volB, 'TEST-VolB');
  insUser.run(IDS.ownerA, 'TEST-OwnerA');
  insUser.run(IDS.auditorA, 'TEST-AuditorA');
  insUser.run(IDS.plat, 'TEST-Platform');

  const volAId = idByPublicId(db, IDS.volA);
  const volBId = idByPublicId(db, IDS.volB);
  const ownerAId = idByPublicId(db, IDS.ownerA);
  const auditorAId = idByPublicId(db, IDS.auditorA);
  const platId = idByPublicId(db, IDS.plat);

  db.prepare(`INSERT INTO user_profiles (user_id, gender, bio) VALUES (?, 1, 'TEST profile A')`).run(volAId);

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insMember = db.prepare(
    `INSERT INTO team_members (team_id, user_id, team_role_code, join_status) VALUES (?, ?, ?, 1)`,
  );
  insMember.run(teamAId, ownerAId, 'owner');
  insMember.run(teamAId, volAId, 'member');
  insMember.run(teamAId, auditorAId, 'auditor');
  insMember.run(teamBId, volBId, 'owner');

  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, created_by)
     VALUES (?, ?, ?, ?, ?, 30, 2, ?)`,
  );
  insAct.run(IDS.actA1, teamAId, 'TEST Activity A1', T0 + 86400, T0 + 90000, ownerAId);
  insAct.run(IDS.actA2, teamAId, 'TEST Activity A2', T0 + 172800, T0 + 176400, ownerAId);
  insAct.run(IDS.actB1, teamBId, 'TEST Activity B1', T0 + 86400, T0 + 90000, volBId);

  // 安全断言（S2-6e）：fixture 后权限目录必须保持在 seed 基线 83/238（测试不得改动权限目录）。
  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) {
    throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238，目录基线漂移`);
  }

  console.log(`[fixture] setup OK: users=5 teams=2 members=4 activities=3 (permissions=${p}, role_permissions=${rp})`);
  db.close();
}

function teardown() {
  const db = new DatabaseSync(findDbPath());
  clean(db);
  // S2-6e：teardown 仅断言【测试 fixture 表】零残留；权限目录(83/238)为 seed 基线，合法非 0。
  // （permissions / role_permissions 不在以下"必须=0"集合内——S2-6e 起已 seed。）
  const cnt = (sql) => db.prepare(sql).get().n;
  const p = cnt('SELECT COUNT(*) AS n FROM permissions');
  const rp = cnt('SELECT COUNT(*) AS n FROM role_permissions');
  if (p !== 83 || rp !== 238) {
    throw new Error(`FATAL: permission catalog 基线漂移 permissions=${p} role_permissions=${rp}（期望 83/238）`);
  }
  const u = cnt('SELECT COUNT(*) AS n FROM users');
  const ui = cnt('SELECT COUNT(*) AS n FROM user_identities');
  const s = cnt('SELECT COUNT(*) AS n FROM sessions');
  const ur = cnt('SELECT COUNT(*) AS n FROM user_roles');
  const tm = cnt('SELECT COUNT(*) AS n FROM team_members');
  const t = cnt('SELECT COUNT(*) AS n FROM teams');
  const se = cnt('SELECT COUNT(*) AS n FROM security_events');
  // S2-6g：活动与报名同属测试残留集合，必须回 0。
  const ac = cnt('SELECT COUNT(*) AS n FROM activities');
  const as = cnt('SELECT COUNT(*) AS n FROM activity_signups');
  // S2-6h：考勤会话与证据行同样必须回 0（本切片写入的两张表）。
  const sess = cnt('SELECT COUNT(*) AS n FROM attendance_sessions');
  const ev = cnt('SELECT COUNT(*) AS n FROM attendance_events');
  const anom = cnt('SELECT COUNT(*) AS n FROM attendance_anomalies');
  const bad = Object.entries({ users: u, user_identities: ui,
    sessions: s, user_roles: ur, team_members: tm, teams: t, security_events: se,
    activities: ac, activity_signups: as, attendance_sessions: sess, attendance_events: ev, attendance_anomalies: anom })
    .filter(([, v]) => v !== 0);
  if (bad.length > 0) {
    throw new Error(`teardown check failed: ${bad.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  console.log(
    `[fixture] teardown OK: users/user_identities/sessions/user_roles/team_members/teams/security_events/activities/activity_signups/attendance_sessions/attendance_events/attendance_anomalies = 0, permission catalog seeded (83/238)`,
  );
  db.close();
}

/**
 * session 模式（S2-6c-1）：基础 fixture + user_roles 角色行 + 停用用户。
 * sessions 行由 tests/session_integration.mjs 自行插入（token/hash 在测试侧生成）。
 * 注意：本模式会写入 user_roles（S2-5 J 组测试要求其为 0），因此【不得】与 S2-5 回归同时运行。
 */
function sessionSetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`);
  insUser.run(IDS.volA, 'TEST-VolA', 1);
  insUser.run(IDS.volB, 'TEST-VolB', 1);
  insUser.run(IDS.ownerA, 'TEST-OwnerA', 1);
  insUser.run(IDS.auditorA, 'TEST-AuditorA', 1);
  insUser.run(IDS.plat, 'TEST-Platform', 1);
  insUser.run(IDS.disabled, 'TEST-Disabled', 3); // 停用用户（status=3）

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const auditorAId = uid(IDS.auditorA);
  const platId = uid(IDS.plat);
  const disabledId = uid(IDS.disabled);

  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(ownerAId, rid('volunteer'), teamAId); // 同团队多角色
  insUR.run(ownerAId, rid('volunteer'), teamBId); // 多团队角色行
  insUR.run(auditorAId, rid('team_auditor'), teamAId);
  insUR.run(platId, rid('platform_operator'), null); // 平台角色（scope NULL）
  insUR.run(disabledId, rid('volunteer'), teamAId); // 停用用户仍有角色行（session 必须拒绝）

  // 活动行（TEAM_SCOPED 隔离验证依赖；与 base setup 相同的三条）
  const T0 = 1756500000;
  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, created_by)
     VALUES (?, ?, ?, ?, ?, 30, 2, ?)`,
  );
  insAct.run(IDS.actA1, teamAId, 'TEST Activity A1', T0 + 86400, T0 + 90000, ownerAId);
  insAct.run(IDS.actA2, teamAId, 'TEST Activity A2', T0 + 172800, T0 + 176400, ownerAId);
  insAct.run(IDS.actB1, teamBId, 'TEST Activity B1', T0 + 86400, T0 + 90000, volBId);

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);
  console.log(`[fixture] session setup OK: users=6(含1停用) user_roles=8 teams=2 (permissions=${p}, role_permissions=${rp})`);
  db.close();
}

/**
 * auth 模式（S2-6c-2）：session 模式 + user_identities 身份行（微信登录/身份解析依赖）。
 *
 * 身份行全部使用 HMAC-SHA256 摘要（与 src/services/wechat-auth-service.ts local 测试密钥一致），
 * fixture 与测试侧均不出现 openid/unionid 明文的存储（明文仅出现在 mock code 载荷中）。
 *
 * 注意：本模式写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥，
 * 【不得】与 S2-5 回归同时运行。
 */
function authSetup() {
  runAuthSetup(false);
}

/**
 * firstlogin 模式（S2-6c-3）：auth 模式 + 身份冲突矩阵。
 *   volA ← wechat_unionid(CONFLICT_UNIONID)
 *   volB ← wechat_openid(CONFLICT_OPENID)
 * 用 code = MOCK_WECHAT_CODE.CONFLICT_OPENID.CONFLICT_UNIONID 登录时，
 * unionid 命中 volA、openid 命中 volB → 必须触发 OPEN-7 冲突拒绝。
 */
function firstloginSetup() {
  runAuthSetup(true);
}

function runAuthSetup(addConflictRows) {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`);
  insUser.run(IDS.volA, 'TEST-VolA', 1);
  insUser.run(IDS.volB, 'TEST-VolB', 1);
  insUser.run(IDS.ownerA, 'TEST-OwnerA', 1);
  insUser.run(IDS.plat, 'TEST-Platform', 1);
  insUser.run(IDS.disabled, 'TEST-Disabled', 3); // 停用用户：身份存在但登录必须 401

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const platId = uid(IDS.plat);
  const disabledId = uid(IDS.disabled);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(platId, rid('platform_operator'), null);
  insUR.run(disabledId, rid('volunteer'), teamAId); // 停用用户仍有角色行（登录必须被拒）

  // ===== user_identities（身份解析矩阵）=====
  const insId = db.prepare(
    `INSERT INTO user_identities (user_id, identity_type, identity_hash, active_marker, status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const O = (v) => identityHash(v);
  // 正常绑定
  insId.run(volAId, 'wechat_openid', O('OPENID_A'), 1, 1);
  insId.run(volAId, 'wechat_unionid', O('UNIONID_A'), 1, 1);
  insId.run(volBId, 'wechat_openid', O('OPENID_B'), 1, 1);
  insId.run(ownerAId, 'wechat_openid', O('OPENID_OWNER'), 1, 1);
  // unionid-only 绑定（openid 未绑定 → 必须靠 unionid 命中）
  insId.run(platId, 'wechat_unionid', O('UNIONID_PLAT'), 1, 1);
  // unionid 优先级矩阵：OPENID_SHARED 绑 ownerA，UNIONID_SHARED 绑 volB → 同现时必须命中 volB
  insId.run(ownerAId, 'wechat_openid', O('OPENID_SHARED'), 1, 1);
  insId.run(volBId, 'wechat_unionid', O('UNIONID_SHARED'), 1, 1);
  // 停用用户身份（user.status=3 → 登录必须 401）
  insId.run(disabledId, 'wechat_openid', O('OPENID_DISABLED'), 1, 1);
  // 已撤销身份行（active_marker=NULL 哨兵）→ 不得命中
  insId.run(volAId, 'wechat_openid', O('OPENID_REVOKED'), null, 1);
  // 停用身份行（status=2）→ 不得命中
  insId.run(volAId, 'wechat_openid', O('OPENID_INACTIVE'), 1, 2);

  // S2-6c-3 OPEN-7：冲突矩阵（unionid→volA、openid→volB，两个不同主体）。
  if (addConflictRows) {
    insId.run(volAId, 'wechat_unionid', O('CONFLICT_UNIONID'), 1, 1);
    insId.run(volBId, 'wechat_openid', O('CONFLICT_OPENID'), 1, 1);
  }

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);
  const ids = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_identities ui JOIN users u ON u.id = ui.user_id WHERE u.public_id LIKE '01TEST%'`,
    )
    .get().n;
  console.log(
    `[fixture] ${addConflictRows ? 'firstlogin' : 'auth'} setup OK: users=5(含1停用) user_roles=5 teams=2 user_identities=${ids}` +
      `${addConflictRows ? ' +conflictMatrix(2)' : ''} (permissions=${p}, role_permissions=${rp})`,
  );
  db.close();
}

/**
 * sec 模式（S2-6c-4）：auth 模式全量 + 一枚用【上一把 HMAC 密钥】哈希的身份（验证双密钥过渡 OPEN-6）。
 * 该用户 public_id 以 01TEST 前缀 → teardown 经 01TEST% 清理，无残留。
 */
function secSetup() {
  runAuthSetup(false); // 复用 5 用户 + 身份 + 角色（不含冲突矩阵）
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  const now = Math.floor(Date.now() / 1000);
  const PREV_KEY = 'test-previous-hmac-key-2026'; // 与 wrangler.jsonc vars.IDENTITY_HMAC_KEY_PREVIOUS 一致（local TEST-ONLY）
  db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`).run(
    '01TESTUSERCPREVKEY00001',
    'TEST-PrevKey',
    1,
  );
  const prevUserId = db.prepare('SELECT id FROM users WHERE public_id = ?').get('01TESTUSERCPREVKEY00001')?.id;
  const openidHash = createHmac('sha256', PREV_KEY).update('OPENID_PREVKEY').digest('hex');
  db.prepare(
    `INSERT INTO user_identities (user_id, identity_type, identity_hash, active_marker, status, bound_at)
     VALUES (?, 'wechat_openid', ?, 1, 1, ?)`,
  ).run(prevUserId, openidHash, now);
  db.close();
  console.log('[fixture] sec setup OK: +prev-key user 01TESTUSERCPREVKEY00001 (OPENID_PREVKEY hashed with previous key)');
}

/**
 * authz 模式（S2-6f）：Runtime Authorization Core 集成测试 fixture。
 *
 * 与 sessionSetup 相同的基础 + user_roles 多角色/多团队布局，并额外加入 team_admin 用户，
 * 以覆盖 §十六 探针（PLATFORM 高权限 / TEAM 管理 / Volunteer 自有 / Auditor 读）与
 * §十三 角色变化即时生效（真实 D1 user_roles 修改后下一请求立即反映）。
 *
 * 写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥，【不得】与 S2-5 回归同时运行。
 */
function authzSetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`);
  insUser.run(IDS.volA, 'TEST-VolA', 1);
  insUser.run(IDS.volB, 'TEST-VolB', 1);
  insUser.run(IDS.ownerA, 'TEST-OwnerA', 1);
  insUser.run(IDS.auditorA, 'TEST-AuditorA', 1);
  insUser.run(IDS.teamAdminA, 'TEST-TeamAdminA', 1);
  insUser.run(IDS.plat, 'TEST-Platform', 1);
  insUser.run(IDS.disabled, 'TEST-Disabled', 3); // 停用用户（status=3）

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const auditorAId = uid(IDS.auditorA);
  const teamAdminAId = uid(IDS.teamAdminA);
  const platId = uid(IDS.plat);
  const disabledId = uid(IDS.disabled);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(ownerAId, rid('volunteer'), teamAId); // 同团队多角色
  insUR.run(ownerAId, rid('volunteer'), teamBId); // 多团队角色行
  insUR.run(auditorAId, rid('team_auditor'), teamAId);
  insUR.run(teamAdminAId, rid('team_admin'), teamAId); // 团队管理员（§十六 TEAM 管理探针）
  insUR.run(platId, rid('platform_operator'), null); // 平台角色（scope NULL）
  insUR.run(disabledId, rid('volunteer'), teamAId); // 停用用户仍有角色行（session 必须拒绝）

  const T0 = 1756500000;
  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, created_by)
     VALUES (?, ?, ?, ?, ?, 30, 2, ?)`,
  );
  insAct.run(IDS.actA1, teamAId, 'TEST Activity A1', T0 + 86400, T0 + 90000, ownerAId);
  insAct.run(IDS.actA2, teamAId, 'TEST Activity A2', T0 + 172800, T0 + 176400, ownerAId);
  insAct.run(IDS.actB1, teamBId, 'TEST Activity B1', T0 + 86400, T0 + 90000, volBId);

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);
  console.log(
    `[fixture] authz setup OK: users=7(含1停用) user_roles=9 teams=2 activities=3 (permissions=${p}, role_permissions=${rp})`,
  );
  db.close();
}

/**
 * signup 模式（S2-6g）：活动报名垂直切片最小 fixture。
 *
 * 只包含本切片必需的数据（用户 §十六，不制造整套业务假数据）：
 * - 2 teams（teamA / teamB）
 * - 5 users：volA(volunteer@A) / volB(volunteer@B) / ownerA(team_owner@A + volunteer@A)
 *            / teamAdminA(team_admin@A) / plat(platform_operator, scope NULL)
 * - 4 activities：
 *     actS1 teamA status=1 allow_cancel=1 need_audit=0 —— 主路径（免审）
 *     actS2 teamA status=1 allow_cancel=0 need_audit=1 —— 禁止取消 + 需审
 *     actS3 teamA status=0 allow_cancel=1 need_audit=0 —— 草稿（不开放报名）
 *     actS4 teamB status=1 allow_cancel=1 need_audit=0 —— 跨团队目标
 * - activity_signups：0 行（测试自行创建/断言；teardown 必须回 0）
 *
 * 写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥。
 */
function signupSetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`);
  insUser.run(IDS.volA, 'TEST-VolA', 1);
  insUser.run(IDS.volB, 'TEST-VolB', 1);
  insUser.run(IDS.ownerA, 'TEST-OwnerA', 1);
  insUser.run(IDS.teamAdminA, 'TEST-TeamAdminA', 1);
  insUser.run(IDS.plat, 'TEST-Platform', 1);
  insUser.run(IDS.platSuper, 'TEST-SuperAdmin', 1);

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const teamAdminAId = uid(IDS.teamAdminA);
  const platId = uid(IDS.plat);
  const platSuperId = uid(IDS.platSuper);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  // 团队角色绑定（PermissionProvider 的唯一运行时事实源）。
  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(ownerAId, rid('volunteer'), teamAId); // 同团队多角色（team_owner + volunteer）
  insUR.run(ownerAId, rid('volunteer'), teamBId); // 多团队角色行（切换 active team 验证）
  insUR.run(teamAdminAId, rid('team_admin'), teamAId);
  insUR.run(platId, rid('platform_operator'), null); // 平台角色（scope NULL）
  insUR.run(platSuperId, rid('platform_super_admin'), null); // 平台超管（scope NULL，持全部 83）

  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status,
                             allow_cancel, need_audit, created_by)
     VALUES (?, ?, ?, ?, ?, 30, ?, ?, ?, ?)`,
  );
  insAct.run(IDS.actS1, teamAId, 'TEST Signup A1', T0 + 86400, T0 + 90000, 1, 1, 0, ownerAId);
  insAct.run(IDS.actS2, teamAId, 'TEST Signup A2', T0 + 172800, T0 + 176400, 1, 0, 1, ownerAId);
  insAct.run(IDS.actS3, teamAId, 'TEST Signup A3-draft', T0 + 259200, T0 + 262800, 0, 1, 0, ownerAId);
  insAct.run(IDS.actS4, teamBId, 'TEST Signup B1', T0 + 86400, T0 + 90000, 1, 1, 0, volBId);
  insAct.run(IDS.actS5, teamAId, 'TEST Signup A5', T0 + 345600, T0 + 349200, 1, 1, 0, ownerAId);
  insAct.run(IDS.actS6, teamAId, 'TEST Signup A6', T0 + 432000, T0 + 435600, 1, 1, 0, ownerAId);

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);
  const su = db.prepare('SELECT COUNT(*) AS n FROM activity_signups').get().n;
  console.log(
    `[fixture] signup setup OK: users=6 user_roles=8 teams=2 activities=6 activity_signups=${su} (permissions=${p}, role_permissions=${rp})`,
  );
  db.close();
}

/**
 * attendance 模式（S2-6h）：活动签到垂直切片最小 fixture。
 *
 * 只包含本切片必需的数据（用户 §十六）：
 * - 2 teams（teamA / teamB）
 * - 6 users：volA(volunteer@A) / volB(volunteer@B) / ownerA(team_owner@A + volunteer@A)
 *            / teamAdminA(team_admin@A) / plat(platform_operator, scope NULL) / platSuper(platform_super_admin)
 * - 6 activities：actAtt1/2/3/4/5(teamA, status=1) / actAttB(teamB, status=1)
 * - activity_signups：volA 报名 actAtt1 + actAtt2（status=1）；volB 报名 actAttB；
 *   volA 未报名 actAtt3（用于"无报名 → 409"）
 * - attendance_sessions / attendance_events：0 行（测试自行创建/断言；teardown 必须回 0）
 *
 * 写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥。
 */
function attendanceSetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, ?)`);
  insUser.run(IDS.volA, 'TEST-VolA', 1);
  insUser.run(IDS.volB, 'TEST-VolB', 1);
  insUser.run(IDS.ownerA, 'TEST-OwnerA', 1);
  insUser.run(IDS.teamAdminA, 'TEST-TeamAdminA', 1);
  insUser.run(IDS.plat, 'TEST-Platform', 1);
  insUser.run(IDS.platSuper, 'TEST-SuperAdmin', 1);

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const teamAdminAId = uid(IDS.teamAdminA);
  const platId = uid(IDS.plat);
  const platSuperId = uid(IDS.platSuper);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', volBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  // 团队角色绑定（PermissionProvider 的唯一运行时事实源）。
  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(ownerAId, rid('volunteer'), teamAId); // 同团队多角色（team_owner + volunteer）
  insUR.run(ownerAId, rid('volunteer'), teamBId); // 多团队角色行（切换 active team 验证）
  insUR.run(teamAdminAId, rid('team_admin'), teamAId);
  insUR.run(platId, rid('platform_operator'), null); // 平台角色（scope NULL）
  insUR.run(platSuperId, rid('platform_super_admin'), null); // 平台超管（scope NULL，持全部 83）

  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status,
                             allow_cancel, need_audit, created_by)
     VALUES (?, ?, ?, ?, ?, 30, ?, ?, ?, ?)`,
  );
  insAct.run(IDS.actAtt1, teamAId, 'TEST Attend A1', T0 + 86400, T0 + 90000, 1, 1, 0, ownerAId);
  insAct.run(IDS.actAtt2, teamAId, 'TEST Attend A2', T0 + 172800, T0 + 176400, 1, 1, 0, ownerAId);
  insAct.run(IDS.actAtt3, teamAId, 'TEST Attend A3-nosignup', T0 + 259200, T0 + 262800, 1, 1, 0, ownerAId);
  insAct.run(IDS.actAtt4, teamAId, 'TEST Attend A4', T0 + 345600, T0 + 349200, 1, 1, 0, ownerAId);
  insAct.run(IDS.actAtt5, teamAId, 'TEST Attend A5', T0 + 432000, T0 + 435600, 1, 1, 0, ownerAId);
  insAct.run(IDS.actAttB, teamBId, 'TEST Attend B1', T0 + 86400, T0 + 90000, 1, 1, 0, volBId);

  // 预置报名（status=1 有效）：volA → actAtt1/2/4/5；volB → actAttB。
  // actAtt3 故意不报名（验证"无报名 → 409 NOT_SIGNED_UP"）。
  const insSignup = db.prepare(
    `INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at)
     VALUES (?, ?, 1, 1, ?)`,
  );
  const actId = (pub) => db.prepare('SELECT id FROM activities WHERE public_id = ?').get(pub)?.id;
  insSignup.run(actId(IDS.actAtt1), volAId, T0);
  insSignup.run(actId(IDS.actAtt2), volAId, T0);
  insSignup.run(actId(IDS.actAtt4), volAId, T0);
  insSignup.run(actId(IDS.actAtt5), volAId, T0);
  insSignup.run(actId(IDS.actAtt5), ownerAId, T0); // ownerA 本人已报名（用于 D6 team_owner 持 checkin 签到）
  insSignup.run(actId(IDS.actAttB), volBId, T0);

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);
  const su = db.prepare('SELECT COUNT(*) AS n FROM activity_signups').get().n;
  const ss = db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n;
  console.log(
    `[fixture] attendance setup OK: users=6 user_roles=8 teams=2 activities=6 activity_signups=${su} attendance_sessions=${ss} (permissions=${p}, role_permissions=${rp})`,
  );
  db.close();
}

const cmd = process.argv[2];
if (cmd === 'setup') setup();
else if (cmd === 'session') sessionSetup();
else if (cmd === 'auth') authSetup();
else if (cmd === 'firstlogin') firstloginSetup();
else if (cmd === 'sec') secSetup();
else if (cmd === 'authz') authzSetup();
else if (cmd === 'signup') signupSetup();
else if (cmd === 'attendance') attendanceSetup();
else if (cmd === 'attendance-management') attendanceManagementSetup();
else if (cmd === 'anomaly') attendanceAnomalySetup();
else if (cmd === 'teardown') teardown();
else {
  console.error('usage: node tests/fixture.mjs setup|session|auth|firstlogin|sec|authz|signup|attendance|attendance-management|anomaly|teardown');
  process.exit(2);
}

/**
 * attendance-management 模式（S2-6i）：Review + Force Checkout 垂直切片最小 fixture。
 *
 * 只包含本切片必需的数据（用户 §十六）：
 * - Team A：ownerA(team_owner) / adminA(team_admin) / auditorA(team_auditor) / volA(volunteer) / mpUserA(volunteer)
 * - Team B：ownerB(team_owner) / volB(volunteer)
 * - Platform：plat(platform_operator) / platSuper(platform_super_admin, scope null)
 * - activities：actMgmtA(teamA) / actMgmtB(teamB)
 * - signups：volA→actMgmtA / mpUserA→actMgmtA（多参加载体）/ volB→actMgmtB
 * - attendance_sessions：R1-R5（review_status 0/0/1/2/0，status=2 避免占用单一活跃槽）、
 *   F1-F5（status 1/0/2/3/4，仅 F1 活跃）、B_R/B_F（teamB 跨团队对照）、
 *   MP_F_OLD/NEW 与 MP_R_OLD/NEW（mpUserA 同一 signup → 多 session，验证只操作指定 sessionId）
 *
 * 约束：任意用户同时仅一条活跃会话（uq_active_attendance），故 volA 仅 F1 活跃、mpUserA 仅 MP_F_NEW 活跃、
 * volB 仅 B_F 活跃，互不冲突。
 * 写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥。
 * 不写 permissions / role_permissions / migrations。session id 写入 manifest 供测试读取。
 */
function attendanceManagementSetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, 1)`);
  insUser.run(IDS.volA, 'TEST-VolA');
  insUser.run(IDS.volB, 'TEST-VolB');
  insUser.run(IDS.ownerA, 'TEST-OwnerA');
  insUser.run(IDS.auditorA, 'TEST-AuditorA');
  insUser.run(IDS.teamAdminA, 'TEST-TeamAdminA');
  insUser.run(IDS.adminA, 'TEST-AdminA');
  insUser.run(IDS.ownerB, 'TEST-OwnerB');
  insUser.run(IDS.mpUserA, 'TEST-MpUserA');
  insUser.run(IDS.plat, 'TEST-Platform');
  insUser.run(IDS.platSuper, 'TEST-SuperAdmin');

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const auditorAId = uid(IDS.auditorA);
  const teamAdminAId = uid(IDS.teamAdminA);
  const adminAId = uid(IDS.adminA);
  const ownerBId = uid(IDS.ownerB);
  const mpUserAId = uid(IDS.mpUserA);
  const platId = uid(IDS.plat);
  const platSuperId = uid(IDS.platSuper);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', ownerBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(auditorAId, rid('team_auditor'), teamAId);
  insUR.run(teamAdminAId, rid('team_admin'), teamAId);
  insUR.run(adminAId, rid('team_admin'), teamAId); // team_admin@A（与 teamAdminA 区分，纯管理角色）
  insUR.run(mpUserAId, rid('volunteer'), teamAId);
  insUR.run(ownerBId, rid('team_owner'), teamBId);
  insUR.run(platId, rid('platform_operator'), null);
  insUR.run(platSuperId, rid('platform_super_admin'), null);

  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, allow_cancel, need_audit, created_by)
     VALUES (?, ?, ?, ?, ?, 30, ?, 1, 0, ?)`,
  );
  insAct.run(IDS.actMgmtA, teamAId, 'TEST Mgmt A', T0 + 86400, T0 + 90000, 1, ownerAId);
  insAct.run(IDS.actMgmtB, teamBId, 'TEST Mgmt B', T0 + 86400, T0 + 90000, 1, ownerBId);
  const actAId = db.prepare('SELECT id FROM activities WHERE public_id = ?').get(IDS.actMgmtA)?.id;
  const actBId = db.prepare('SELECT id FROM activities WHERE public_id = ?').get(IDS.actMgmtB)?.id;

  const insSignup = db.prepare(
    `INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at) VALUES (?, ?, 1, 1, ?)`,
  );
  insSignup.run(actAId, volAId, T0);
  insSignup.run(actAId, mpUserAId, T0); // 同一活动，mpUserA 一条报名 → 多 session（多参加模型载体）
  insSignup.run(actAId, ownerAId, T0); // ownerA 本人报名（F6 活跃会话载体，供 team_admin 强制签退正向用例）
  insSignup.run(actBId, volBId, T0);
  const volASignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actAId, volAId)?.id;
  const mpSignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actAId, mpUserAId)?.id;
  const ownerASignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actAId, ownerAId)?.id;
  const volBSignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actBId, volBId)?.id;
  if (!Number.isInteger(volASignupId)) throw new Error('volASignupId missing');
  if (!Number.isInteger(mpSignupId)) throw new Error('mpSignupId missing');
  if (!Number.isInteger(ownerASignupId)) throw new Error('ownerASignupId missing');
  if (!Number.isInteger(volBSignupId)) throw new Error('volBSignupId missing');

  const insSess = db.prepare(
    `INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, status, review_status, checkin_at, checkout_at, service_date, slot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  );
  const insertSess = (label, signupId, userId, teamId, activityId, status, reviewStatus, checkinAt, checkoutAt) => {
    try {
      return Number(
        insSess.run(signupId, activityId, userId, teamId, status, reviewStatus, checkinAt, checkoutAt, T0, T0, T0).lastInsertRowid,
      );
    } catch (e) {
      throw new Error(
        `insertSess ${label} failed: signupId=${signupId} userId=${userId} teamId=${teamId} activityId=${activityId} status=${status} reviewStatus=${reviewStatus} checkinAt=${checkinAt} checkoutAt=${checkoutAt} :: ${e.message}`,
      );
    }
  };

  // Team A review 目标（volA 名下；status=2 避免占用单一活跃槽，review 只看 review_status）
  const R1 = insertSess('R1', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // approve 目标
  const R2 = insertSess('R2', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // reject 目标
  const R3 = insertSess('R3', volASignupId, volAId, teamAId, actAId, 2, 1, T0, T0 + 100); // 已审核 approved → 409
  const R4 = insertSess('R4', volASignupId, volAId, teamAId, actAId, 2, 2, T0, T0 + 100); // 已审核 rejected → 409
  const R5 = insertSess('R5', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 多参加隔离 / 额外待审目标（保留给 B12/B28 非法请求，不得被成功审核）
  const R6 = insertSess('R6', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 待审：team_auditor 正向审核目标
  const R7 = insertSess('R7', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 待审：team_admin 正向审核目标
  // Team A force 目标（仅 F1 活跃）
  const F1 = insertSess('F1', volASignupId, volAId, teamAId, actAId, 1, 0, T0, null); // 活跃，可 force
  const F2 = insertSess('F2', volASignupId, volAId, teamAId, actAId, 0, 0, null, null); // 未签到
  const F3 = insertSess('F3', volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 已签退
  const F4 = insertSess('F4', volASignupId, volAId, teamAId, actAId, 3, 0, T0, null); // 异常
  const F5 = insertSess('F5', volASignupId, volAId, teamAId, actAId, 4, 0, T0, null); // 取消
  const F6 = insertSess('F6', ownerASignupId, ownerAId, teamAId, actAId, 1, 0, T0, null); // ownerA 活跃：team_admin 强制签退正向目标
  // Team B 跨团队对照（volB 名下）
  const B_R = insertSess('B_R', volBSignupId, volBId, teamBId, actBId, 2, 0, T0, T0 + 100); // 跨团队 review 目标
  const B_F = insertSess('B_F', volBSignupId, volBId, teamBId, actBId, 1, 0, T0, null); // 跨团队 force 目标（活跃）
  // 多参加模型（mpUserA 同一 signup → 多 session）
  const MP_F_OLD = insertSess('MP_F_OLD', mpSignupId, mpUserAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 历史已签退
  const MP_F_NEW = insertSess('MP_F_NEW', mpSignupId, mpUserAId, teamAId, actAId, 1, 0, T0, null); // 当前活跃
  const MP_R_OLD = insertSess('MP_R_OLD', mpSignupId, mpUserAId, teamAId, actAId, 2, 1, T0, T0 + 100); // 历史：已审核(review_status=1) → D4 必须 409
  const MP_R_NEW = insertSess('MP_R_NEW', mpSignupId, mpUserAId, teamAId, actAId, 2, 0, T0, T0 + 100); // 当前（待 review）

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);

  const manifest = {
    users: {
      volA: volAId,
      volB: volBId,
      ownerA: ownerAId,
      adminA: adminAId,
      auditorA: auditorAId,
      ownerB: ownerBId,
      mpUserA: mpUserAId,
      plat: platId,
      teamAdminA: teamAdminAId,
      platSuper: platSuperId,
    },
    teams: { teamA: teamAId, teamB: teamBId },
    activities: { actMgmtA: actAId, actMgmtB: actBId },
    sessions: { R1, R2, R3, R4, R5, R6, R7, F1, F2, F3, F4, F5, F6, B_R, B_F, MP_F_OLD, MP_F_NEW, MP_R_OLD, MP_R_NEW },
  };
  writeManifest(manifest);

  console.log(
    `[fixture] attendance-management setup OK: users=10 teams=2 activities=2 sessions=19 (permissions=${p}, role_permissions=${rp}); manifest -> ${process.env.JHZY_MANIFEST ?? '.tmp/s2-6i-sessions.json'}`,
  );
  db.close();
}

/** 将 session / user / team / activity id manifest 写入文件，供集成测试读取（避免跨进程硬编码 id）。 */
function writeManifest(obj) {
  const p = process.env.JHZY_MANIFEST ?? join(process.cwd(), '.tmp', 's2-6i-sessions.json');
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

/**
 * anomaly 模式（S2-6j V1）：Attendance Anomaly Handling 垂直切片最小 fixture。
 *
 * 只包含本切片必需的数据（用户 §十六 / §3）：
 * - Team A：ownerA(team_owner) / adminA(team_admin) / auditorA(team_auditor) / volA(volunteer)
 * - Team B：ownerB(team_owner) / volB(volunteer)
 * - Platform：plat(platform_operator) / platSuper(platform_super_admin, scope null)
 * - activities：actMgmtA(teamA) / actMgmtB(teamB)
 * - signups：volA→actMgmtA / ownerA→actMgmtA / volB→actMgmtB
 * - attendance_sessions：A_S1/A_S2(teamA) / B_S1(teamB)（status=2 避免占用单一活跃槽）
 * - attendance_anomalies：AA1..AA6(teamA，含 status 1/2/3 与多 type，created_at 递增供分页) /
 *   AB1/AB2(teamB，跨团队对照)
 *
 * 约束：不写 permissions / role_permissions / migrations。anomaly id 写入 manifest 供测试读取。
 * 写入 user_roles，与 S2-5 J 组（要求 user_roles=0）互斥，【不得】与 S2-5 回归同时运行。
 */
function attendanceAnomalySetup() {
  const db = new DatabaseSync(findDbPath());
  db.exec('PRAGMA foreign_keys = ON;');
  clean(db);

  const insUser = db.prepare(`INSERT INTO users (public_id, nickname, status) VALUES (?, ?, 1)`);
  insUser.run(IDS.volA, 'TEST-VolA');
  insUser.run(IDS.volB, 'TEST-VolB');
  insUser.run(IDS.ownerA, 'TEST-OwnerA');
  insUser.run(IDS.auditorA, 'TEST-AuditorA');
  insUser.run(IDS.teamAdminA, 'TEST-TeamAdminA');
  insUser.run(IDS.adminA, 'TEST-AdminA');
  insUser.run(IDS.ownerB, 'TEST-OwnerB');
  insUser.run(IDS.plat, 'TEST-Platform');
  insUser.run(IDS.platSuper, 'TEST-SuperAdmin');

  const uid = (pid) => db.prepare('SELECT id FROM users WHERE public_id = ?').get(pid)?.id;
  const volAId = uid(IDS.volA);
  const volBId = uid(IDS.volB);
  const ownerAId = uid(IDS.ownerA);
  const auditorAId = uid(IDS.auditorA);
  const teamAdminAId = uid(IDS.teamAdminA);
  const adminAId = uid(IDS.adminA);
  const ownerBId = uid(IDS.ownerB);
  const platId = uid(IDS.plat);
  const platSuperId = uid(IDS.platSuper);
  const rid = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

  const insTeam = db.prepare(`INSERT INTO teams (public_id, name, owner_user_id, status) VALUES (?, ?, ?, 1)`);
  insTeam.run(IDS.teamA, 'TEST Team A', ownerAId);
  insTeam.run(IDS.teamB, 'TEST Team B', ownerBId);
  const teamAId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamA)?.id;
  const teamBId = db.prepare('SELECT id FROM teams WHERE public_id = ?').get(IDS.teamB)?.id;

  const insUR = db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_team_id) VALUES (?, ?, ?)`);
  insUR.run(volAId, rid('volunteer'), teamAId);
  insUR.run(volBId, rid('volunteer'), teamBId);
  insUR.run(ownerAId, rid('team_owner'), teamAId);
  insUR.run(auditorAId, rid('team_auditor'), teamAId);
  insUR.run(teamAdminAId, rid('team_admin'), teamAId);
  insUR.run(adminAId, rid('team_admin'), teamAId); // team_admin@A（纯管理角色，持 handle）
  insUR.run(ownerBId, rid('team_owner'), teamBId);
  insUR.run(platId, rid('platform_operator'), null);
  insUR.run(platSuperId, rid('platform_super_admin'), null);

  const insAct = db.prepare(
    `INSERT INTO activities (public_id, team_id, title, start_time, end_time, quota, status, allow_cancel, need_audit, created_by)
     VALUES (?, ?, ?, ?, ?, 30, ?, 1, 0, ?)`,
  );
  insAct.run(IDS.actMgmtA, teamAId, 'TEST Mgmt A', T0 + 86400, T0 + 90000, 1, ownerAId);
  insAct.run(IDS.actMgmtB, teamBId, 'TEST Mgmt B', T0 + 86400, T0 + 90000, 1, ownerBId);
  const actAId = db.prepare('SELECT id FROM activities WHERE public_id = ?').get(IDS.actMgmtA)?.id;
  const actBId = db.prepare('SELECT id FROM activities WHERE public_id = ?').get(IDS.actMgmtB)?.id;

  const insSignup = db.prepare(
    `INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at) VALUES (?, ?, 1, 1, ?)`,
  );
  insSignup.run(actAId, volAId, T0);
  insSignup.run(actAId, ownerAId, T0);
  insSignup.run(actBId, volBId, T0);
  const volASignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actAId, volAId)?.id;
  const ownerASignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actAId, ownerAId)?.id;
  const volBSignupId = db.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(actBId, volBId)?.id;
  if (!Number.isInteger(volASignupId)) throw new Error('volASignupId missing');
  if (!Number.isInteger(ownerASignupId)) throw new Error('ownerASignupId missing');
  if (!Number.isInteger(volBSignupId)) throw new Error('volBSignupId missing');

  const insSess = db.prepare(
    `INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, status, review_status, checkin_at, checkout_at, service_date, slot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  );
  const insertSess = (signupId, userId, teamId, activityId, status, reviewStatus, checkinAt, checkoutAt) =>
    Number(
      insSess.run(signupId, activityId, userId, teamId, status, reviewStatus, checkinAt, checkoutAt, T0, T0, T0).lastInsertRowid,
    );
  const A_S1 = insertSess(volASignupId, volAId, teamAId, actAId, 2, 0, T0, T0 + 100); // AA1..AA4 宿主
  const A_S2 = insertSess(ownerASignupId, ownerAId, teamAId, actAId, 2, 0, T0, T0 + 100); // AA5/AA6 宿主
  const B_S1 = insertSess(volBSignupId, volBId, teamBId, actBId, 2, 0, T0, T0 + 100); // AB1/AB2 宿主

  // attendance_anomalies（team_id 与 session 一致；status 1=OPEN / 2=CONFIRMED / 3=DISMISSED）
  const insAnom = db.prepare(
    `INSERT INTO attendance_anomalies (session_id, team_id, anomaly_type, detail, handled_by, handled_at, resolution, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAnom = (label, sessionId, teamId, type, detail, status, handledBy, handledAt, resolution, createdAt) => {
    try {
      return Number(
        insAnom.run(sessionId, teamId, type, detail, handledBy, handledAt, resolution, status, createdAt).lastInsertRowid,
      );
    } catch (e) {
      throw new Error(`insertAnom ${label} failed: ${e.message}`);
    }
  };
  const AA1 = insertAnom('AA1', A_S1, teamAId, 'out_of_range', '{"note":"AA1 out_of_range"}', 1, null, null, null, T0 + 1);
  const AA2 = insertAnom('AA2', A_S1, teamAId, 'device_switch', '{"note":"AA2 device_switch"}', 1, null, null, null, T0 + 2);
  const AA3 = insertAnom('AA3', A_S1, teamAId, 'multi_account', '{"note":"AA3"}', 2, ownerAId, T0 + 50, 'confirmed-legacy', T0 + 3);
  const AA4 = insertAnom('AA4', A_S1, teamAId, 'replay', '{"note":"AA4"}', 3, ownerAId, T0 + 60, 'dismissed-legacy', T0 + 4);
  const AA5 = insertAnom('AA5', A_S2, teamAId, 'cross_day', '{"note":"AA5 cross_day"}', 1, null, null, null, T0 + 5);
  const AA6 = insertAnom('AA6', A_S2, teamAId, 'overlong', '{"note":"AA6 overlong"}', 1, null, null, null, T0 + 6);
  const AB1 = insertAnom('AB1', B_S1, teamBId, 'out_of_range', '{"note":"AB1 cross-team"}', 1, null, null, null, T0 + 1);
  const AB2 = insertAnom('AB2', B_S1, teamBId, 'reverse_time', '{"note":"AB2 cross-team"}', 1, null, null, null, T0 + 2);

  const p = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n;
  const rp = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  if (p !== 83 || rp !== 238) throw new Error(`FATAL: permissions=${p} role_permissions=${rp} — 期望 S2-6e seed 基线 83/238`);

  const manifest = {
    users: { volA: volAId, volB: volBId, ownerA: ownerAId, adminA: adminAId, auditorA: auditorAId, ownerB: ownerBId, plat: platId, platSuper: platSuperId },
    teams: { teamA: teamAId, teamB: teamBId },
    activities: { actMgmtA: actAId, actMgmtB: actBId },
    sessions: { A_S1, A_S2, B_S1 },
    anomalies: { AA1, AA2, AA3, AA4, AA5, AA6, AB1, AB2 },
  };
  writeManifest(manifest);

  console.log(
    `[fixture] anomaly setup OK: users=9 teams=2 activities=2 sessions=3 anomalies=8 (permissions=${p}, role_permissions=${rp}); manifest -> ${process.env.JHZY_MANIFEST ?? '.tmp/s2-6i-sessions.json'}`,
  );
  db.close();
}
