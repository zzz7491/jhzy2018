#!/usr/bin/env node
/**
 * G2 —— GET /api/v2/activities (+ /:id) 匿名 public-read 确定性合同测试。
 *
 * 冻结语义（G2）：
 * - 允许匿名（guest / 无 Authorization）读取真正公开、可展示的活动；不新增 /public/activities。
 * - publication predicate（真实 schema 字段，非 magic number）：
 *     deleted_at IS NULL AND audit_status = 2 (APPROVED) AND status IN (1,2,3,4)（displayable lifecycle）。
 * - 跨团队：guest 无 X-Team-Id / auth.teamId，public 读不依赖 TEAM_SCOPED（仅本 read path 例外，非通用 bypass）。
 * - 详情：非 public（draft/pending/rejected/unpublished/deleted/未知）→ 404（不泄露存在性，NON-ENUMERATION）。
 * - 响应 allowlist（PublicActivityRow）：排除内部 numeric id / team_id / audit_status /
 *   submitted_at / reviewed_at / reject_reason。lifecycle status（招募态）可公开。
 * - 认证用户契约不变：manager→listByMyTeam/findByPublicId，volunteer→listVolunteerVisible/findVolunteerVisibleByPublicId。
 * - 所有 mutation（POST/PUT/DELETE/submit/approve/reject/signup/checkin/checkout）仍 requirePermission。
 *
 * 两部分：
 *   A 组（静态合同）：路由 / 仓储源码断言（guest 分支、publication predicate、public projection、
 *                     无 team filter、无 ensureTableRead、认证契约保留、mutation 不变、无新权限）。
 *   B 组（SQL 行为）：node:sqlite 建真实 activities 表 + fixture，执行仓储里【实际发布的那条 SQL】，
 *                     验证 predicate / cross-team / projection / NON-ENUMERATION / pagination-only。
 *
 * 运行：node workers/tests/g2_public_activity_read.mjs   （无需 wrangler / D1 / node_modules）
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const routeSrc = readFileSync(join(ROOT, 'src/routes/activities.ts'), 'utf8');
const repoSrc = readFileSync(join(ROOT, 'src/repository/activities.ts'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

// ── 鲁棒方法切片（CRLF 安全：按 2 空格缩进的 `async name(` 边界切分）──────────
function methodBody(src, name) {
  const re = new RegExp('\\r?\\n  async ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(');
  const m = re.exec(src);
  if (!m) return '';
  // Advance past the signature line so the method's OWN opening is excluded
  // from the "next method" search (otherwise it self-matches at position 0 → empty slice).
  const nl = src.indexOf('\n', m.index + 1);
  const rest = nl < 0 ? src.slice(m.index) : src.slice(nl + 1);
  const next = rest.search(/\r?\n  async [A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next);
}
function firstSelect(block) {
  const s = block.indexOf('`SELECT');
  if (s < 0) return '';
  const e = block.indexOf('`', s + 1);
  return block.slice(s + 1, e);
}
function projectionOf(sql) {
  const i = sql.toUpperCase().indexOf('FROM');
  if (i < 0) return sql;
  return sql.slice(0, i).replace(/^\s*SELECT/i, '').trim();
}

const listHandlerStart = routeSrc.indexOf("activities.get('/',");
const listHandlerEnd = routeSrc.indexOf("activities.get('/:id'", listHandlerStart);
const listHandler = routeSrc.slice(listHandlerStart, listHandlerEnd);

const detailHandlerStart = routeSrc.indexOf("activities.get('/:id'");
const detailHandlerEnd = routeSrc.indexOf("activities.post('/:activityId/signups'", detailHandlerStart);
const detailHandler = routeSrc.slice(detailHandlerStart, detailHandlerEnd);

const listBody = methodBody(repoSrc, 'listPublicVisible');
const detailBody = methodBody(repoSrc, 'findPublicVisibleByPublicId');

const whereMatch = /const where = `([^`]*)`/.exec(listBody);
const where = whereMatch ? whereMatch[1] : '';
const LIST_SQL = firstSelect(listBody).replace('${where}', where);
const DETAIL_SQL = firstSelect(detailBody);

console.log('=== A 组：静态合同（路由 / 仓储） ===');

// 1) 两个 GET handler 不再无条件 throw authRequired；guest 分支走 public 方法。
check(listHandlerStart >= 0 && listHandlerEnd > listHandlerStart, 'route defines GET /');
check(detailHandlerStart >= 0 && detailHandlerEnd > detailHandlerStart, 'route defines GET /:id');
check(!/if \(!auth\.authenticated\) throw authRequired\(\)/.test(listHandler), 'GET / no longer unconditionally 401 (guest allowed)');
check(!/if \(!auth\.authenticated\) throw authRequired\(\)/.test(detailHandler), 'GET /:id no longer unconditionally 401 (guest allowed)');
check(listHandler.includes('repo.listPublicVisible('), 'GET / guest branch calls listPublicVisible');
check(detailHandler.includes('repo.findPublicVisibleByPublicId('), 'GET /:id guest branch calls findPublicVisibleByPublicId');
check(listHandler.includes("if (!auth.authenticated)"), 'GET / branches on auth.authenticated');
check(detailHandler.includes("if (!auth.authenticated)"), 'GET /:id branches on auth.authenticated');

// 2) guest 分支不调用 can() / requirePermission（不要求权限即可 public read）。
const listGuestBranch = listHandler.slice(listHandler.indexOf('if (!auth.authenticated)'), listHandler.indexOf('return ok(c, result)'));
const detailGuestBranch = detailHandler.slice(detailHandler.indexOf('if (!auth.authenticated)'), detailHandler.indexOf('return ok(c, { activity })'));
check(!/can\(|requirePermission\(/.test(listGuestBranch), 'GET / guest branch performs no permission check');
check(!/can\(|requirePermission\(/.test(detailGuestBranch), 'GET /:id guest branch performs no permission check');

// 3) publication predicate（真实字段，非 magic number）。
const PREDICATE = /deleted_at IS NULL AND audit_status = 2 AND status IN \(1,2,3,4\)/;
check(PREDICATE.test(listBody), 'listPublicVisible uses publication predicate (audit_status=2 AND status IN (1,2,3,4) AND deleted_at IS NULL)');
check(PREDICATE.test(detailBody), 'findPublicVisibleByPublicId uses publication predicate');
check(listBody.includes('audit_status = 2'), 'listPublicVisible references APPROVED via audit_status = 2 (no magic number)');

// 4) 无 team filter（guest 无 team context，不得依赖 TEAM_SCOPED）。
check(!/team_id\s*=\s*\?/.test(LIST_SQL), 'listPublicVisible SQL has NO team_id = ? filter (cross-team public read)');
check(!/team_id\s*=\s*\?/.test(DETAIL_SQL), 'findPublicVisibleByPublicId SQL has NO team_id = ? filter');
check(!/this\.ctx\.tenant\.teamId|requireTeamId\(\)/.test(listBody), 'listPublicVisible does NOT require team context');
check(!/this\.ctx\.tenant\.teamId|requireTeamId\(\)/.test(detailBody), 'findPublicVisibleByPublicId does NOT require team context');

// 5) 不调用 ensureTableRead（其要求 auth/team，与匿名 public-read 冲突）。
check(!/ensureTableRead\(/.test(listBody), 'listPublicVisible does NOT call ensureTableRead (anonymous public-read path)');
check(!/ensureTableRead\(/.test(detailBody), 'findPublicVisibleByPublicId does NOT call ensureTableRead');

// 6) public projection 排除内部字段（仅检查 SELECT 投影列）。
const listProj = projectionOf(LIST_SQL);
const detProj = projectionOf(DETAIL_SQL);
check(!/team_id|audit_status|submitted_at|reviewed_at|reject_reason/.test(listProj), 'listPublicVisible SELECT projection excludes internal fields (team_id/audit_*)');
check(!/team_id|audit_status|submitted_at|reviewed_at|reject_reason/.test(detProj), 'findPublicVisibleByPublicId SELECT projection excludes internal fields (team_id/audit_*)');

// 7) 认证契约保留（authenticated 仍走既有 TEAM_SCOPED 路径）。
check(listHandler.includes('listByMyTeam(') && listHandler.includes('listVolunteerVisible('), 'GET / authenticated keeps listByMyTeam / listVolunteerVisible');
check(detailHandler.includes('findByPublicId(') && detailHandler.includes('findVolunteerVisibleByPublicId('), 'GET /:id authenticated keeps findByPublicId / findVolunteerVisibleByPublicId');
check(listHandler.includes("can(c.env, auth, c.get('tenant'), 'activity.activity.review')"), 'GET / authenticated still resolves manager via can()');
check(detailHandler.includes("can(c.env, auth, c.get('tenant'), 'activity.activity.review')"), 'GET /:id authenticated still resolves manager via can()');

// 8) mutation 权限不变（route 全文仍对写端点 requirePermission）。
for (const code of [
  "requirePermission('activity.activity.create')",
  "requirePermission('activity.activity.update')",
  "requirePermission('activity.activity.submit')",
  "requirePermission('activity.activity.review')",
  "requirePermission('signup.signup.create')",
  "requirePermission('signup.signup.cancel')",
  "requirePermission('attendance.record.checkin')",
  "requirePermission('attendance.record.checkout')",
]) {
  check(routeSrc.includes(code), `mutation endpoint still guarded: ${code}`);
}

// 9) 未新增任何 permission code（guest public-read 复用既有端点，无新权限）。
check(!/requirePermission\('[a-z]+\.[a-z]+\.(public|guest|anonymous)/.test(routeSrc), 'no new public/guest/anonymous permission introduced for G2');

// 10) guest 列表仅用分页参数，不接受 status/team 等绕过 predicate 的 query。
check((LIST_SQL.match(/\?/g) || []).length === 2, 'listPublicVisible SQL has exactly 2 bind params (pageSize, offset) — no status/team param');
check((DETAIL_SQL.match(/\?/g) || []).length === 1, 'findPublicVisibleByPublicId SQL has exactly 1 bind param (public_id)');
check(listHandler.includes('parsePagination(c.req.query())'), 'GET / guest reads only pagination from query (no status/team filter)');
check(!/\$\{/.test(LIST_SQL) && !/\$\{/.test(DETAIL_SQL), 'both shipped SQLs are fully parameterized (no template interpolation)');

console.log('=== B 组：SQL 行为（node:sqlite 真实 schema + fixture） ===');

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  team_id INTEGER NOT NULL,
  title TEXT,
  summary TEXT,
  address TEXT,
  start_time INTEGER,
  end_time INTEGER,
  signup_deadline INTEGER,
  quota INTEGER,
  signed_count INTEGER,
  status INTEGER NOT NULL DEFAULT 0,
  max_session_minutes INTEGER,
  audit_status INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  reviewed_at INTEGER,
  reject_reason TEXT,
  deleted_at INTEGER
);
`);

// 26-char Crockford-safe ULID-like fixtures（'01G2P' 前缀 + 21 位 body）。
const PUB_A   = '01G2P' + 'A'.repeat(21);
const PUB_B   = '01G2P' + 'B'.repeat(21);
const DRAFT   = '01G2P' + 'D'.repeat(21);
const PEND    = '01G2P' + 'P'.repeat(21);
const REJ     = '01G2P' + 'R'.repeat(21);
const UNPUB   = '01G2P' + 'Y'.repeat(21);
const DEL     = '01G2P' + 'X'.repeat(21);
const CANCEL  = '01G2P' + 'C'.repeat(21);
const UNKNOWN = '01G2P' + 'Z'.repeat(21);

const ins = db.prepare(`INSERT INTO activities
  (id, public_id, team_id, title, summary, address, start_time, end_time, signup_deadline,
   quota, signed_count, status, max_session_minutes, audit_status, submitted_at, reviewed_at, reject_reason, deleted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

// team A / B approved+displayable → public
ins.run(1, PUB_A, 201, 'A公开活动', 's', 'addrA', 1757000000, 1757003600, null, 10, 3, 1, 120, 2, null, null, null, null);
ins.run(2, PUB_B, 202, 'B公开活动', 's', 'addrB', 1757001000, 1757004600, null, 20, 5, 2, 90, 2, null, null, null, null);
// draft (audit 0) → not public
ins.run(3, DRAFT, 201, '草稿', 's', null, 1757000000, 1757003600, null, 10, 0, 1, 60, 0, null, null, null, null);
// pending (audit 1) → not public
ins.run(4, PEND, 201, '待审', 's', null, 1757000000, 1757003600, null, 10, 0, 1, 60, 1, 1757000000, null, null, null);
// rejected (audit 3) → not public
ins.run(5, REJ, 201, '驳回', 's', null, 1757000000, 1757003600, null, 10, 0, 1, 60, 3, 1757000000, 1757000001, 'bad', null);
// unpublished (status 5, audit 2) → not public (status not in displayable set)
ins.run(6, UNPUB, 201, '下架', 's', null, 1757000000, 1757003600, null, 10, 0, 5, 60, 2, null, null, null, null);
// deleted (audit 2, status 1) → not public (deleted_at set)
ins.run(7, DEL, 201, '已删', 's', null, 1757000000, 1757003600, null, 10, 0, 1, 60, 2, null, null, null, 1757000000);
// cancelled (status 4, audit 2) → public per frozen volunteer-visible predicate (status IN (1,2,3,4))
ins.run(8, CANCEL, 203, '已取消公开', 's', null, 1757000000, 1757003600, null, 10, 0, 4, 60, 2, null, null, null, null);

const listRows = db.prepare(LIST_SQL).all(20, 0); // pageSize, offset（每次执行重新 prepare，避免 statement finalized）
const listPubs = new Set(listRows.map((r) => r.public_id));

// B1. 仅 public（approved+displayable+not deleted）出现；draft/pending/rejected/unpublished/deleted 被排除。
check(listPubs.has(PUB_A), 'guest list includes approved team-A activity');
check(listPubs.has(PUB_B), 'guest list includes approved team-B activity (CROSS-TEAM, no team filter)');
check(listPubs.has(CANCEL), 'guest list includes CANCELLED(4)+approved (mirrors frozen volunteer-visible predicate status IN (1,2,3,4))');
check(!listPubs.has(DRAFT), 'guest list EXCLUDES draft (audit_status=0)');
check(!listPubs.has(PEND), 'guest list EXCLUDES pending (audit_status=1)');
check(!listPubs.has(REJ), 'guest list EXCLUDES rejected (audit_status=3)');
check(!listPubs.has(UNPUB), 'guest list EXCLUDES unpublished (status=5)');
check(!listPubs.has(DEL), 'guest list EXCLUDES deleted (deleted_at set)');
check(listRows.length === 3, `guest list returns exactly 3 public activities (got ${listRows.length})`);

// B2. public projection 不含内部字段（无 id/team_id/audit_status/audit metadata）。
const PUBLIC_KEYS = ['public_id', 'title', 'summary', 'address', 'start_time', 'end_time', 'signup_deadline', 'quota', 'signed_count', 'status', 'max_session_minutes'];
const leakKeys = new Set();
for (const r of listRows) {
  for (const k of Object.keys(r)) {
    if (!PUBLIC_KEYS.includes(k)) leakKeys.add(k);
  }
}
check(leakKeys.size === 0, `guest list projection has NO internal field (leaked: ${[...leakKeys].join(',') || 'none'})`);
check(listRows.every((r) => r.team_id === undefined && r.audit_status === undefined && r.reject_reason === undefined), 'guest list rows expose no team_id / audit_status / reject_reason');

// B3. 不使用 team_id 过滤（cross-team 由 predicate 而非 team 决定）。
check(!/team_id/.test(LIST_SQL), 'shipped list SQL has no team_id filter (cross-team public read)');

// B4. detail：public → 200；non-public → 404（NON-ENUMERATION）。
const detPub = (pub) => db.prepare(DETAIL_SQL).get(pub); // 每次执行重新 prepare

check(detPub(PUB_A) != null, 'guest detail: approved activity → found (200)');
check(detPub(PUB_A).team_id === undefined && detPub(PUB_A).audit_status === undefined, 'guest detail row exposes no team_id / audit_status');
check(detPub(DRAFT) == null, 'guest detail: draft → null (404, no enumeration)');
check(detPub(PEND) == null, 'guest detail: pending → null (404)');
check(detPub(REJ) == null, 'guest detail: rejected → null (404)');
check(detPub(UNPUB) == null, 'guest detail: unpublished → null (404)');
check(detPub(DEL) == null, 'guest detail: deleted → null (404)');
check(detPub(UNKNOWN) == null, 'guest detail: unknown valid ULID → null (404)');

// B5. detail SQL 参数化 + 仅 public_id 一个绑定（无 team 绑定）。
check((DETAIL_SQL.match(/\?/g) || []).length === 1, 'detail SQL has exactly 1 bind param (public_id)');
check(DETAIL_SQL.includes('public_id = ?'), 'detail SQL filters by public_id');
check(!/team_id/.test(DETAIL_SQL), 'detail SQL has no team_id filter');

// B6. 纯读：执行后数据未变。
const before = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;
db.prepare(LIST_SQL).all(20, 0);
db.prepare(DETAIL_SQL).get(PUB_A);
db.prepare(DETAIL_SQL).get(UNKNOWN);
const after = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;
check(before === after && before === 8, 'GET queries perform no mutation (row count unchanged)');

// B7. pagination-only：page_size 上限由 parsePagination 在路由层 clamp，SQL 仅接受 pageSize/offset。
check(/LIMIT \? OFFSET \?/.test(LIST_SQL), 'list SQL uses LIMIT ? OFFSET ? (pagination only)');

db.close();

console.log('----------------------------------------');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
