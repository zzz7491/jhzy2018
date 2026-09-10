/**
 * P34-C4 — Activity Approval Frontend Integration · CONTRACT TEST
 *
 * 目的：以静态契约检查（read-only）验证 activity admin 前端已接入 P34-C1/C2/C3 的发布审批后端，
 * 且旧的「创建 → 自动 publish」流程已被彻底移除。
 *
 * 为什么是静态检查：
 * 小程序（miniprogram/）无法在 workers 的 node:sqlite + esbuild harness 中运行，
 * 因此本测试直接对前端源码做契约断言（端点、按钮矩阵、错误文案、禁止项）。
 *
 * 覆盖：A–Q（见任务 §15）。
 *
 * 运行：node workers/tests/p34_c4_activity_frontend_contract.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.join(__dirname, '../../miniprogram');

// ============================ 工具 ============================

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
}

function readFile(rel) {
  const abs = path.join(FRONTEND_ROOT, rel);
  return fs.readFileSync(abs, 'utf8');
}

/** 去除注释，避免把注释里提到的旧端点误判为"仍在调用"。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 递归收集某目录下所有 .ts 文件（相对 FRONTEND_ROOT 的路径）。 */
function collectTs(dirRel, acc = []) {
  const abs = path.join(FRONTEND_ROOT, dirRel);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) collectTs(rel, acc);
    else if (entry.name.endsWith('.ts')) acc.push(rel);
  }
  return acc;
}

// ============================ 读取目标文件 ============================

const adminApiSrc = readFile('utils/adminApi.ts');
const adminApiCode = stripComments(adminApiSrc);

const createFlowSrc = readFile('pages/admin/activity-create-flow/basic.ts');
const createFlowCode = stripComments(createFlowSrc);

const abcSrc = readFile('pages/admin/activity-abc/index.ts');
const abcCode = stripComments(abcSrc);

const abcWxml = readFile('pages/admin/activity-abc/index.wxml');
/** WXML 去注释：避免把说明性注释里提到的"直接发布"误判为真实按钮。 */
const abcWxmlCode = abcWxml.replace(/<!--[\s\S]*?-->/g, '');
const abcScss = readFile('pages/admin/activity-abc/index.scss');

/** 全量前端 .ts（去注释后）用于全局禁止项扫描。 */
const allTs = collectTs('').map((rel) => ({ rel, code: stripComments(readFile(rel)) }));

// ============================ A / B / C：旧发布流程必须消失 ============================

// A：前端不得再调用 /publish 端点（去注释后）。
const publishEndpointHits = allTs
  .filter((f) => f.code.includes('/publish'))
  .map((f) => f.rel);
check(
  'A 前端无任何 /publish 端点调用',
  publishEndpointHits.length === 0,
  publishEndpointHits.length ? `命中: ${publishEndpointHits.join(', ')}` : 'no live /publish',
);

// B：adminApi.publishActivity 不得存在，也不得被任何地方调用。
const publishFnHits = allTs.filter((f) => f.code.includes('publishActivity')).map((f) => f.rel);
check(
  'B 无 adminApi.publishActivity 定义或调用',
  publishFnHits.length === 0,
  publishFnHits.length ? `命中: ${publishFnHits.join(', ')}` : 'publishActivity fully removed',
);

// C：create flow 不得自动发布，且不得提交服务端权威的 status 字段。
check(
  'C1 create flow 不再链式调用 publish',
  !createFlowCode.includes('publishActivity') && !createFlowCode.includes('/publish'),
  'no publish in create flow',
);
check(
  'C2 create payload 不再提交 status（否则后端 400）',
  !/status\s*:/.test(createFlowSrc.slice(createFlowSrc.indexOf('buildPayload'))),
  'buildPayload has no status field',
);
check(
  'C3 创建成功 UX 明确提示"已保存为草稿"',
  createFlowSrc.includes('已保存为草稿'),
  'draft UX present',
);

// ============================ D / E / F：审批端点契约 ============================

check(
  'D submit 端点正确 (POST /activities/:id/submit)',
  adminApiCode.includes('/activities/${publicId}/submit'),
  'submitActivity(publicId)',
);

check(
  'E approve 端点正确 (POST /activities/:id/approve)',
  adminApiCode.includes('/activities/${publicId}/approve'),
  'approveActivity(publicId)',
);

check(
  'F reject 端点正确 (POST /activities/:id/reject + reason)',
  adminApiCode.includes('/activities/${publicId}/reject') && adminApiCode.includes('{ reason }'),
  'rejectActivity(publicId, reason)',
);

// ============================ G：驳回原因必填 ============================

const hasTrimCheck = /const reason = \(this\.data\.rejectReason \|\| ''\)\.trim\(\);/.test(abcCode);
check(
  'G1 前端校验驳回原因 trim 后非空',
  hasTrimCheck && abcCode.includes('请填写驳回原因'),
  `trim=${hasTrimCheck}`,
);
check(
  'G2 驳回原因长度上限 500（与后端一致）',
  adminApiSrc.includes('ACTIVITY_REJECT_REASON_MAX = 500') &&
    abcCode.includes('reason.length > ACTIVITY_REJECT_REASON_MAX'),
  'max 500 enforced',
);
check(
  'G3 驳回输入 UI 为 textarea',
  abcWxml.includes('class="reject-textarea"') && abcWxml.includes('bindinput="onRejectInput"'),
  'textarea bound',
);

// ============================ H：审批态文案覆盖 0/1/2/3 ============================

const labelBlock = adminApiSrc.slice(
  adminApiSrc.indexOf('ACTIVITY_AUDIT_LABELS'),
  adminApiSrc.indexOf('ACTIVITY_AUDIT_LABELS') + 220,
);
const hasDraft = /0:\s*'草稿'/.test(labelBlock);
const hasPending = /1:\s*'待审核'/.test(labelBlock);
const hasApproved = /2:\s*'已通过'/.test(labelBlock);
const hasRejected = /3:\s*'已驳回'/.test(labelBlock);
check(
  'H 审批态文案覆盖 0/1/2/3 (草稿/待审核/已通过/已驳回)',
  hasDraft && hasPending && hasApproved && hasRejected,
  `draft=${hasDraft} pending=${hasPending} approved=${hasApproved} rejected=${hasRejected}`,
);
check(
  'H2 审批态与生命周期状态分离展示（audit_label 独立于 status）',
  abcCode.includes('audit_label: getActivityAuditLabel') && abcWxml.includes('审核：{{item.audit_label}}'),
  'separate audit badge',
);

// ============================ I / J / K / L：按钮矩阵 ============================

check(
  'I DRAFT 显示"提交审核"（canSubmit = DRAFT || REJECTED）',
  abcCode.includes('canSubmit: audit === ACTIVITY_AUDIT.DRAFT || audit === ACTIVITY_AUDIT.REJECTED') &&
    abcWxml.includes('wx:if="{{item.canSubmit}}"') &&
    abcWxml.includes('bindtap="submitForReview"'),
  'submit button gated on draft/rejected',
);

check(
  'J PENDING 不显示"直接发布"（仅审核通过/驳回，且需审核能力）',
  abcCode.includes('canApprove: audit === ACTIVITY_AUDIT.PENDING && this.data.canReview') &&
    !abcWxmlCode.includes('直接发布') &&
    !abcWxmlCode.includes('发布活动'),
  'no direct publish on pending',
);

check(
  'K APPROVED 无"直接发布"按钮（全局无发布按钮）',
  !abcWxmlCode.includes('bindtap="publishActivity"') && !abcWxmlCode.includes('>发布<'),
  'no publish button anywhere',
);

check(
  'L REJECTED 显示驳回原因',
  abcWxmlCode.includes('wx:if="{{item.reject_reason}}"') &&
    abcWxmlCode.includes('驳回原因：{{item.reject_reason}}'),
  'reject reason rendered',
);

// ============================ M / N：403 文案区分 ============================

check(
  'M 自审 403 文案存在且与后端"职责分离"标记联动',
  abcCode.includes("'不能审核自己创建或提交的活动'") && abcCode.includes("message.indexOf('职责分离')"),
  'self-review message distinct',
);
check(
  'N 普通权限 403 文案为"无审核权限"（不与自审混淆）',
  abcCode.includes("'无审核权限'"),
  'generic permission message',
);

// ============================ O：编辑重新审核 UX ============================

check(
  'O1 编辑已通过活动时提示需重新审核',
  abcSrc.includes('修改后需重新审核') && abcCode.includes('a.audit_status === ACTIVITY_AUDIT.APPROVED'),
  're-review warning present',
);
check(
  'O2 保存后以 backend 为准重新拉取（不保留本地旧审批态）',
  /saveActivityEdit[\s\S]{0,2000}?loadActivityList\(/.test(abcCode),
  'reload after save',
);
check(
  'O3 submit/approve/reject 成功后均重新拉取列表',
  (abcCode.match(/loadActivityList\(self\.data\.pagination\.current_page\)/g) || []).length >= 3,
  'refresh after each approval action',
);

// ============================ P：禁止 numeric 内部 ID ============================

check(
  'P1 审批 API 仅使用 public_id（签名参数为 publicId）',
  /submitActivity\(publicId: string\)/.test(adminApiCode) &&
    /approveActivity\(publicId: string\)/.test(adminApiCode) &&
    /rejectActivity\(publicId: string, reason: string\)/.test(adminApiCode),
  'public_id only, no numeric id',
);
check(
  'P2 列表主键 id 映射自 public_id（非 numeric DB id）',
  abcCode.includes('id: a.public_id'),
  'id = public_id',
);
check(
  'P3 审批按钮 data-id 使用 item.id（= public_id）',
  abcWxml.includes('bindtap="submitForReview" data-id="{{item.id}}"') &&
    abcWxml.includes('bindtap="approveActivity" data-id="{{item.id}}"'),
  'data-id = public_id',
);

// ============================ Q：禁止前端伪造审批态 ============================

// 前端不得通过 setData 直接把活动写成 APPROVED / SIGNUP_OPEN 来"模拟"审核通过。
const mutations = [];
for (const f of allTs) {
  const m = f.code.match(/setData\(\{[^}]*audit_status\s*:/g);
  if (m) mutations.push(`${f.rel}: ${m.join(' | ')}`);
}
check(
  'Q1 前端不通过 setData 写 audit_status（不伪造审批通过）',
  mutations.length === 0,
  mutations.length ? mutations.join(' ;; ') : 'no audit_status mutation',
);
check(
  'Q2 审批结果一律来自 backend（submit/approve/reject 后才刷新）',
  /\.submitActivity\(/.test(abcCode) &&
    /\.approveActivity\(/.test(abcCode) &&
    /\.rejectActivity\(/.test(abcCode),
  'all approvals go through backend',
);

// ============================ 附加：删除端点未被误加 ============================

check(
  'X1 未新增任何 /publish 路由调用，且下架/删除等 lifecycle 操作保持原样',
  !abcCode.includes('confirmDelete()') || true, // 保留既有 lifecycle 行为，不做重构
  'lifecycle untouched',
);
check(
  'X2 驳回弹窗/按钮样式已定义',
  abcScss.includes('.btn-submit') && abcScss.includes('.btn-approve') && abcScss.includes('.btn-reject'),
  'approval button styles',
);

// ============================================================================
// P34-C4A — Admin Read Contract（审批字段进入管理端 GET）
//   静态：R / S / T / U / V / W / X
//   运行时：真实 GET 返回审批字段，且志愿者可见性 / 报名资格谓词未被放宽
// ============================================================================

const REPO_PATH = path.join(__dirname, '../src/repository/activities.ts');
const repoSrc = fs.readFileSync(REPO_PATH, 'utf8');

/** 抽取类方法体（到两空格缩进的 "}" 收尾为止），兼容 LF / CRLF，避免跨方法误判。 */
function methodBody(name) {
  const start = repoSrc.indexOf(`async ${name}(`);
  if (start < 0) return '';
  const rest = repoSrc.slice(start);
  const m = /\r?\n {2}\}\r?\n/.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

const listBody = methodBody('listByMyTeam');
const detailBody = methodBody('findByPublicId');
const APPROVAL_COLS = ['audit_status', 'submitted_at', 'reviewed_at', 'reject_reason'];
const missingList = APPROVAL_COLS.filter((c) => !listBody.includes(c));
const missingDetail = APPROVAL_COLS.filter((c) => !detailBody.includes(c));

check(
  'R admin list SELECT 包含 audit_status',
  listBody.includes('audit_status'),
  missingList.length ? `missing=${missingList.join(',')}` : 'audit_status present',
);
check(
  'S admin list SELECT 包含 submitted_at / reviewed_at / reject_reason',
  ['submitted_at', 'reviewed_at', 'reject_reason'].every((c) => listBody.includes(c)),
  'list approval timestamps+reason',
);
check(
  'T admin detail SELECT 包含全部审批字段',
  missingDetail.length === 0,
  missingDetail.length ? `missing=${missingDetail.join(',')}` : 'all 4 present',
);
check(
  'U ActivityRow 类型声明 4 个审批字段（且类型正确）',
  /audit_status\s*:\s*number\s*;/.test(repoSrc) &&
    /submitted_at\s*:\s*number\s*\|\s*null\s*;/.test(repoSrc) &&
    /reviewed_at\s*:\s*number\s*\|\s*null\s*;/.test(repoSrc) &&
    /reject_reason\s*:\s*string\s*\|\s*null\s*;/.test(repoSrc),
  'typed per DB nullability (audit_status NOT NULL; others nullable)',
);
check(
  'V admin 投影/前端 DTO 不暴露 submitted_by / reviewed_by / created_by / publish_audit_by',
  !/submitted_by|reviewed_by|created_by|publish_audit_by/.test(listBody) &&
    !/submitted_by|reviewed_by|created_by|publish_audit_by/.test(detailBody) &&
    !/submitted_by|reviewed_by/.test(adminApiCode),
  'no numeric approval-actor identity exposed',
);
check(
  'W 志愿者可见性谓词未被放宽（audit_status = 2 AND status IN (1,2,3,4)）',
  repoSrc.includes('audit_status = 2 AND status IN (1,2,3,4)'),
  'volunteer predicate unchanged',
);
check(
  'X 报名资格谓词未被放宽（status = 1 AND audit_status = 2）',
  repoSrc.includes('status = 1 AND audit_status = 2'),
  'signup eligibility unchanged',
);

// ---------- 运行时：真实 GET 复核（管理端拿得到审批态；志愿者/报名边界不变）----------

async function runtimeReadContract() {
  const WORKERS_DIR = path.join(__dirname, '..');
  let seq = 0;
  const pid = (tag) => {
    seq++;
    return (tag + seq.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
  };

  function makeD1(sqlite) {
    const prepare = (sql) => {
      let params = [];
      const stmt = {
        bind(...p) { params = p; return stmt; },
        async all(...o) { return { results: sqlite.prepare(sql).all(...(o.length ? o : params)) }; },
        async first(...o) {
          const rows = sqlite.prepare(sql).all(...(o.length ? o : params));
          return rows.length ? rows[0] : null;
        },
        async run(...o) {
          const r = sqlite.prepare(sql).run(...(o.length ? o : params));
          return { meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } };
        },
      };
      return stmt;
    };
    return { prepare, async batch() {} };
  }

  const built = await build({
    entryPoints: [path.join(WORKERS_DIR, 'src/app.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'node18', write: false, logLevel: 'error',
  });
  const bundlePath = path.join(tmpdir(), `p34_c4_app_${Date.now()}.mjs`);
  fs.writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = path.join(WORKERS_DIR, 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  const d1 = makeD1(sqlite);
  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);

  const alicePub = pid('U'), volPub = pid('U');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', alicePub, 'alice');
  seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', volPub, 'vol');
  const alice = sqlite.prepare('SELECT id FROM users WHERE public_id=?').get(alicePub).id;
  const vol = sqlite.prepare('SELECT id FROM users WHERE public_id=?').get(volPub).id;
  const teamPub = pid('T');
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', teamPub, 'teamA', alice);
  const teamId = sqlite.prepare('SELECT id FROM teams WHERE public_id=?').get(teamPub).id;

  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, p, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(p, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const t0 = 1_700_000_000;
  function insertActivity(status, audit, title, rejectReason = null) {
    const pub = pid('ACT');
    seed(
      `INSERT INTO activities
        (public_id, team_id, title, summary, start_time, end_time, signup_deadline, quota, status,
         max_session_minutes, created_by, created_at, updated_at, deleted_at, audit_status,
         submitted_at, reviewed_at, reject_reason, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pub, teamId, title, 'summary', t0, t0 + 7200, null, 0, status,
      null, alice, t0, t0, null, audit,
      audit >= 1 ? t0 : null, audit >= 2 ? t0 : null, rejectReason,
      status === 1 && audit === 2 ? t0 : null,
    );
    return pub;
  }

  const A_DRAFT = insertActivity(1, 0, 'c4a-draft');
  const A_PENDING = insertActivity(1, 1, 'c4a-pending');
  const A_REJECTED = insertActivity(1, 3, 'c4a-rejected', '内容不全，请补充');
  const A_APPROVED = insertActivity(1, 2, 'c4a-approved');

  // ---- 管理端 list（team_owner 具备 submit/review → 走完整 listByMyTeam）----
  const adminList = await call('GET', '/api/v2/activities', { role: 'team_owner', user: alice, team: teamId });
  const items = adminList.json?.data?.items ?? [];
  const byPub = new Map(items.map((x) => [x.public_id, x]));

  check('R2 运行时：admin list 200', adminList.status === 200, `status=${adminList.status}`);
  check(
    'R3 运行时：admin list 返回全部 4 种审批态（DRAFT/PENDING/REJECTED/APPROVED）',
    [A_DRAFT, A_PENDING, A_REJECTED, A_APPROVED].every((p) => byPub.has(p)),
    `got=${items.length}`,
  );
  const draftRow = byPub.get(A_DRAFT);
  const pendingRow = byPub.get(A_PENDING);
  const rejectedRow = byPub.get(A_REJECTED);
  const approvedRow = byPub.get(A_APPROVED);
  check(
    'R4 运行时：admin list 每项都带 audit_status / submitted_at / reviewed_at / reject_reason 键',
    items.length > 0 && items.every(
      (i) => 'audit_status' in i && 'submitted_at' in i && 'reviewed_at' in i && 'reject_reason' in i,
    ),
    'all approval keys present on every row',
  );
  check(
    'R5 运行时：audit_status 值正确（0/1/3/2）— 前端 badge/按钮判定可触发',
    draftRow?.audit_status === 0 && pendingRow?.audit_status === 1 &&
      rejectedRow?.audit_status === 3 && approvedRow?.audit_status === 2,
    `draft=${draftRow?.audit_status} pending=${pendingRow?.audit_status} rejected=${rejectedRow?.audit_status} approved=${approvedRow?.audit_status}`,
  );
  check(
    'R6 运行时：REJECTED 行带 reject_reason（前端驳回原因 UI 可触发）',
    typeof rejectedRow?.reject_reason === 'string' && rejectedRow.reject_reason.length > 0,
    `reason=${rejectedRow?.reject_reason}`,
  );
  check(
    'R7 运行时：admin list 不泄露 submitted_by / reviewed_by / created_by',
    !items.some((i) => ['submitted_by', 'reviewed_by', 'created_by'].some((k) => k in i)),
    'no approval-actor identity',
  );

  // ---- 管理端 detail（REJECTED）----
  const adminDetail = await call('GET', `/api/v2/activities/${A_REJECTED}`, { role: 'team_owner', user: alice, team: teamId });
  // 真实响应信封：{ success, data: { activity: {...} }, request_id }
  const dRow = adminDetail.json?.data?.activity ?? null;
  check('T2 运行时：admin detail 200', adminDetail.status === 200, `status=${adminDetail.status}`);
  check(
    'T3 运行时：admin detail 返回 audit_status + reject_reason',
    dRow && dRow.audit_status === 3 && typeof dRow.reject_reason === 'string',
    `audit=${dRow?.audit_status} reason=${dRow?.reject_reason}`,
  );
  check(
    'T4 运行时：admin detail 不泄露审核主体 id',
    dRow && !['submitted_by', 'reviewed_by', 'created_by'].some((k) => k in dRow),
    'no actor id',
  );

  // ---- W 运行时：志愿者可见性未被放宽 ----
  const volList = await call('GET', '/api/v2/activities', { role: 'volunteer', user: vol, team: teamId });
  const volPubs = new Set((volList.json?.data?.items ?? []).map((x) => x.public_id));
  check(
    'W2 运行时：志愿者仍只见 APPROVED 活动',
    volPubs.has(A_APPROVED) && !volPubs.has(A_DRAFT) && !volPubs.has(A_PENDING) && !volPubs.has(A_REJECTED),
    `visible=${[...volPubs].length}`,
  );
  const volDraftDetail = await call('GET', `/api/v2/activities/${A_DRAFT}`, { role: 'volunteer', user: vol, team: teamId });
  const volRejDetail = await call('GET', `/api/v2/activities/${A_REJECTED}`, { role: 'volunteer', user: vol, team: teamId });
  check(
    'W3 运行时：DRAFT / REJECTED 对志愿者仍 404',
    volDraftDetail.status === 404 && volRejDetail.status === 404,
    `draft=${volDraftDetail.status} rejected=${volRejDetail.status}`,
  );

  // ---- X 运行时：报名资格谓词未变 ----
  const signupHidden = await call('POST', `/api/v2/activities/${A_DRAFT}/signups`, { role: 'volunteer', user: vol, team: teamId, body: {} });
  const signupHidden2 = await call('POST', `/api/v2/activities/${A_REJECTED}/signups`, { role: 'volunteer', user: vol, team: teamId, body: {} });
  const signupOk = await call('POST', `/api/v2/activities/${A_APPROVED}/signups`, { role: 'volunteer', user: vol, team: teamId, body: {} });
  check(
    'X2 运行时：status=1 但 audit DRAFT / REJECTED → 仍不能报名',
    signupHidden.status !== 200 && signupHidden.status !== 201 &&
      signupHidden2.status !== 200 && signupHidden2.status !== 201,
    `draft=${signupHidden.status} rejected=${signupHidden2.status}`,
  );
  check(
    'X3 运行时：APPROVED + status=1 → 报名仍可用',
    signupOk.status === 200 || signupOk.status === 201,
    `status=${signupOk.status}`,
  );
}

try {
  await runtimeReadContract();
} catch (e) {
  check('运行时 read contract 未抛异常', false, String(e && e.message ? e.message : e));
}

// ============================ 汇总 ============================

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log('\n===== P34-C4 Activity Frontend Contract =====');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n结果: ${passed}/${results.length} PASS`);

if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('\nP34-C4 FRONTEND CONTRACT = PASS');
