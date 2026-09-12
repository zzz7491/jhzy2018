// =============================================================================
// N0-E5B — Team Public Contact（TEAM_PUBLIC_CONTACT）验证套件
//
// 真实 app + local D1（esbuild 打包 src/app.ts + 应用全部 migration，含 0037）。
//
// 冻结契约：
//   THING18_CONTRACT = TEAM_PUBLIC_CONTACT
//   teams.public_contact_name / teams.public_contact_phone
//     = 团队管理员主动填写、明确公开给活动报名者的业务联系人信息（PUBLIC BUSINESS DATA）。
//   写入授权 = team.settings.update（复用既有冻结权限；不新增权限、不改权限目录）。
//   目标团队必须等于 active team（跨团队 → 404），平台级上下文 → 403（禁平台级任意改动）。
//
// 覆盖（对应任务 §PHASE F A–Y）：
//   SCHEMA  A migration 成功 / B columns 存在 / C existing row 不受影响 / D null allowed
//   WRITE   E 授权管理员可改 / F 越权拒绝 / G 跨团队拒绝 / H name trim / I phone trim
//           J blank name → null / K blank phone → null / L invalid type / M over-limit
//           N partial update / O unknown 字段不可篡改其他数据
//   READ    P repository 读 public contact / Q activity→team lookup / R null 态准确
//   PRIVACY S 无 trusted phone / T 无 identity / U 无 emergency / V 无 owner/user profile 回退
//   REGRESS W team mine/detail/join / X signup+review / Y notification core
//
// 运行：node tests/n0e5b_team_public_contact.mjs（在 workers/ 目录）
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 与 TeamContactService 对齐（独立复核契约，不 import 内部常量，避免自证）。 */
const NAME_MAX = 100;
const PHONE_MAX = 32;

let __c = 0;
function pid(tag) {
  __c++;
  return (tag + __c.toString(36).toUpperCase() + '00000000000000000000000000').slice(0, 26);
}

// ---------- D1 适配器（node:sqlite 后端）----------
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
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
        const r = sqlite.prepare(sql).run(...p);
        return { meta: { changes: r.changes ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      const out = [];
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
  };
}

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // 1) 打包真实 app.ts
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const built = await build({
    entryPoints: [appPath],
    bundle: true, format: 'esm', platform: 'node', target: 'node18',
    write: false, logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `n0e5b_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // 1b) 单独打包 TeamRepository（用于 Q：activity.team_id → team public contact 直连查询）
  const repoBuilt = await build({
    entryPoints: [fileURLToPath(new URL('../src/repository/teams.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', target: 'node18',
    write: false, logLevel: 'error',
  });
  const repoPath = join(tmpdir(), `n0e5b_repo_${Date.now()}.mjs`);
  writeFileSync(repoPath, repoBuilt.outputFiles[0].text);
  const { TeamRepository } = await import(pathToFileURL(repoPath).href);

  // 2) 本地 sqlite + 应用全部 migration（含新增 0037）
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const migDir = join(WORKERS_DIR, 'migrations');
  const migFiles = readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort();
  for (const f of migFiles) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const d1 = makeD1(sqlite);

  const seed = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // ======================= SCHEMA =======================
  check('A migration 全量应用成功（含 0037）', migFiles.some((f) => f.startsWith('0037_')), `last=${migFiles[migFiles.length - 1]}`);

  const teamCols = qa('PRAGMA table_info(teams)').map((c) => c.name);
  check('B teams.public_contact_name 列存在', teamCols.includes('public_contact_name'));
  check('B teams.public_contact_phone 列存在', teamCols.includes('public_contact_phone'));

  // 3) 用户与团队
  const U = { alice: pid('U'), carol: pid('U'), vol: pid('U'), bob: pid('U'), dave: pid('U') };
  for (const n of Object.keys(U)) seed('INSERT INTO users (public_id, nickname) VALUES (?,?)', U[n], n);
  const uid = {};
  for (const n of Object.keys(U)) uid[n] = q('SELECT id FROM users WHERE public_id=?', U[n]).id;

  const T = { A: pid('T'), B: pid('T') };
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.A, 'teamA', uid.alice);
  seed('INSERT INTO teams (public_id, name, owner_user_id) VALUES (?,?,?)', T.B, 'teamB', uid.bob);
  const tA = q('SELECT id FROM teams WHERE public_id=?', T.A).id;
  const tB = q('SELECT id FROM teams WHERE public_id=?', T.B).id;

  // 真实 user_roles 绑定（/teams/mine 依赖 DB user_roles，非 mock x-test-role）：
  // alice = team_owner @ teamA，carol = team_admin @ teamA（供 W 回归 / 授权对照）。
  const roleOwner = q("SELECT id FROM roles WHERE code='team_owner'").id;
  const roleAdmin = q("SELECT id FROM roles WHERE code='team_admin'").id;
  seed('INSERT INTO user_roles (user_id, role_id, scope_team_id, granted_at) VALUES (?,?,?,?)', uid.alice, roleOwner, tA, 1700000000);
  seed('INSERT INTO user_roles (user_id, role_id, scope_team_id, granted_at) VALUES (?,?,?,?)', uid.carol, roleAdmin, tA, 1700000000);

  // C：历史团队行不受影响（新列默认 NULL，其他列不变）
  const rowA = q('SELECT name, owner_user_id, cert_status, status, public_contact_name, public_contact_phone FROM teams WHERE id=?', tA);
  check('C existing team row 结构不受影响（name/owner/status 不变）',
    rowA.name === 'teamA' && rowA.owner_user_id === uid.alice && rowA.cert_status === 0 && rowA.status === 1,
    JSON.stringify(rowA));
  check('D 新列默认 NULL（null allowed）',
    rowA.public_contact_name === null && rowA.public_contact_phone === null);

  // 私密数据种子（用于 PRIVACY / V 无回退）
  const OWNER_PRIVATE_PHONE = '13900001111';
  seed(
    `INSERT INTO phone_verifications (public_id,user_id,provider,phone_enc,phone_hash,phone_mask,status,created_at)
     VALUES (?,?,'WECHAT','enc-blob','hash-abc','139****1111','BOUND',?)`,
    pid('P'), uid.alice, 1700000000,
  );

  // 4) 请求驱动
  const ENV = { DB: d1, ENVIRONMENT: 'local' };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, ENV);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  const getContact = (teamId, role, user, team) =>
    call('GET', `/api/v2/teams/${teamId}/public-contact`, { role, user, team });
  const patchContact = (teamId, role, user, team, body) =>
    call('PATCH', `/api/v2/teams/${teamId}/public-contact`, { role, user, team, body });

  const dbContact = (teamId) =>
    q('SELECT public_contact_name, public_contact_phone FROM teams WHERE id=?', teamId);

  // 志愿资格 seed（P0-C 派生事实：identity VERIFIED + phone BOUND + INITIAL 培训考试通过）。
  // 报名端点在服务内 assertVolunteerQualified；与 teams 改动无关，仅用于证明 signup/review 路径完整。
  function grantQualification(userId) {
    seed(
      `INSERT INTO identity_verifications (public_id,user_id,provider,status,identity_fingerprint,attempt_key,created_at,verified_at)
       VALUES (?,?,'FAKE','VERIFIED',?,?,?,?)`,
      pid('I'), userId, 'fp' + userId, 'ak' + userId, 1700000000, 1700000000,
    );
    seed(
      `INSERT INTO phone_verifications (public_id,user_id,provider,phone_enc,phone_hash,phone_mask,status,created_at)
       VALUES (?,?,'WECHAT','enc','h','138****0000','BOUND',?)`,
      pid('P'), userId, 1700000000,
    );
    const cpid = pid('C');
    seed(
      `INSERT INTO courses (public_id, team_id, title, required, status, created_by, deleted_at, purpose)
       VALUES (?,?, 'Init Training', 0, 1, ?, NULL, 'INITIAL_VOLUNTEER')`,
      cpid, tA, userId,
    );
    const courseId = q('SELECT id FROM courses WHERE public_id=?', cpid).id;
    const ppid = pid('K');
    seed(
      `INSERT INTO exam_papers (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, deleted_at, purpose)
       VALUES (?,?, 'Init Exam', ?, '{"count":20}', 100, 90, 60, 3, 1, NULL, 'INITIAL_VOLUNTEER')`,
      ppid, tA, courseId,
    );
    const paperId = q('SELECT id FROM exam_papers WHERE public_id=?', ppid).id;
    seed(
      `INSERT INTO course_enrollments (user_id, course_id, team_id, progress, status, completed_at)
       VALUES (?,?,?,100,3,?)`,
      userId, courseId, tA, 1700000000,
    );
    const spid = pid('S');
    seed(
      `INSERT INTO exam_sessions (public_id, paper_id, user_id, team_id, attempt_no, started_at, submitted_at, score, passed, status)
       VALUES (?,?,?,?,1,?,?,95,1,3)`,
      spid, paperId, userId, tA, 1700000000, 1700000000,
    );
    const sessionId = q('SELECT id FROM exam_sessions WHERE public_id=?', spid).id;
    for (let i = 0; i < 20; i++) {
      const qpid = pid('Q');
      seed(
        `INSERT INTO exam_questions (public_id, question_type, stem, options, answer, difficulty, status, created_by, created_at, updated_at)
         VALUES (?, 'single', ?, '[{"key":"A","text":"a"}]', 'A', 2, 1, ?, ?, ?)`,
        qpid, 'Q' + i, userId, 1700000000, 1700000000,
      );
      const questionId = q('SELECT id FROM exam_questions WHERE public_id=?', qpid).id;
      seed(
        `INSERT INTO exam_answers (team_id, session_id, question_id, user_answer, is_correct, score, answered_at)
         VALUES (?,?,?,'A',1,1,?)`,
        tA, sessionId, questionId, 1700000000,
      );
    }
  }

  // ======================= WRITE: E 授权管理员可改 =======================
  const rE1 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '张老师', public_contact_phone: '0571-88888888' });
  check('E team_owner 可更新公开联系人 → 200', rE1.status === 200, `status=${rE1.status}`);
  let c = dbContact(tA);
  check('E team_owner 写入落库', c.public_contact_name === '张老师' && c.public_contact_phone === '0571-88888888', JSON.stringify(c));

  const rE2 = await patchContact(T.A, 'team_admin', uid.carol, tA, { public_contact_phone: '13800002222' });
  check('E team_admin 可更新公开联系电话 → 200', rE2.status === 200, `status=${rE2.status}`);
  c = dbContact(tA);
  check('E team_admin 写入落库且未改 name', c.public_contact_phone === '13800002222' && c.public_contact_name === '张老师', JSON.stringify(c));

  // ======================= WRITE: F 越权拒绝 =======================
  const rFVol = await patchContact(T.A, 'volunteer', uid.vol, tA, { public_contact_name: '黑客' });
  check('F volunteer 无 team.settings.update → 403', rFVol.status === 403, `status=${rFVol.status}`);
  const rFAud = await patchContact(T.A, 'team_auditor', uid.dave, tA, { public_contact_name: '黑客' });
  check('F team_auditor 无权限 → 403', rFAud.status === 403, `status=${rFAud.status}`);
  const rFAnon = await patchContact(T.A, undefined, undefined, undefined, { public_contact_name: '黑客' });
  check('F 未认证 → 401', rFAnon.status === 401, `status=${rFAnon.status}`);
  const rFPlat = await patchContact(T.A, 'platform_super_admin', uid.dave, tA, { public_contact_name: '黑客' });
  check('F 平台上下文（tenant.teamId=null）→ 403（禁平台级任意改动）', rFPlat.status === 403, `status=${rFPlat.status}`);
  c = dbContact(tA);
  check('F 越权尝试后数据未被篡改', c.public_contact_name === '张老师', JSON.stringify(c));

  // ======================= WRITE: G 跨团队拒绝 =======================
  const rG1 = await patchContact(T.A, 'team_owner', uid.bob, tB, { public_contact_name: '跨团队' });
  check('G teamB owner 改 teamA → 404', rG1.status === 404, `status=${rG1.status}`);
  const rG2 = await patchContact(T.B, 'team_owner', uid.alice, tA, { public_contact_name: '跨团队' });
  check('G teamA owner 改 teamB → 404', rG2.status === 404, `status=${rG2.status}`);
  const rG3 = await patchContact(T.A, 'team_owner', uid.alice, undefined, { public_contact_name: '无团队' });
  check('G 无 active team（不注入 X-Team-Id）→ 403 TEAM_SCOPE_REQUIRED', rG3.status === 403, `status=${rG3.status}`);
  c = dbContact(tA);
  check('G 跨团队尝试后 teamA 数据未被篡改', c.public_contact_name === '张老师', JSON.stringify(c));

  // ======================= WRITE: H/I trim =======================
  await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '  李老师  ', public_contact_phone: '  010-12345678  ' });
  c = dbContact(tA);
  check('H name trim 后持久化', c.public_contact_name === '李老师', JSON.stringify(c));
  check('I phone trim 后持久化', c.public_contact_phone === '010-12345678', JSON.stringify(c));

  // ======================= WRITE: J/K blank → null =======================
  await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '   ' });
  c = dbContact(tA);
  check('J 纯空白 name → NULL', c.public_contact_name === null, JSON.stringify(c));
  await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: '' });
  c = dbContact(tA);
  check('K 空串 phone → NULL', c.public_contact_phone === null, JSON.stringify(c));

  // ======================= WRITE: L invalid type =======================
  const rL1 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: 123 });
  const rL2 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: { x: 1 } });
  const rL3 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: ['1'] });
  check('L 非 string（number/object/array）→ 400', rL1.status === 400 && rL2.status === 400 && rL3.status === 400,
    `statuses=${[rL1.status, rL2.status, rL3.status].join(',')}`);
  const rL4 = await call('PATCH', `/api/v2/teams/${T.A}/public-contact`, { role: 'team_owner', user: uid.alice, team: tA, body: undefined });
  check('L 空 body / 非对象 → 400', rL4.status === 400, `status=${rL4.status}`);
  const rL5 = await patchContact(T.A, 'team_owner', uid.alice, tA, {});
  check('L 两字段均缺省 → 400（至少一个字段）', rL5.status === 400, `status=${rL5.status}`);

  // ======================= WRITE: M over-limit =======================
  const rM1 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: 'x'.repeat(NAME_MAX + 1) });
  check(`M name ${NAME_MAX + 1} 字符 → 400`, rM1.status === 400, `status=${rM1.status}`);
  const rM2 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: 'y'.repeat(NAME_MAX) });
  check(`M name 恰 ${NAME_MAX} 字符 → 200`, rM2.status === 200, `status=${rM2.status}`);
  const rM3 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: '1'.repeat(PHONE_MAX + 1) });
  check(`M phone ${PHONE_MAX + 1} 字符 → 400`, rM3.status === 400, `status=${rM3.status}`);
  const rM4 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: 'abc123' });
  check('M phone 含字母 → 400（保守字符集）', rM4.status === 400, `status=${rM4.status}`);
  const rM5 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: '----' });
  check('M phone 无数字 → 400', rM5.status === 400, `status=${rM5.status}`);
  const rM6 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: '+86 138 0000 0000' });
  check('M phone 带区号/空格合法 → 200（不假定大陆手机号）', rM6.status === 200, `status=${rM6.status}`);

  // ======================= WRITE: N partial update =======================
  await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '王老师', public_contact_phone: '021-99998888' });
  const rN1 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '赵老师' });
  c = dbContact(tA);
  check('N 只更新 name → phone 不变', rN1.status === 200 && c.public_contact_name === '赵老师' && c.public_contact_phone === '021-99998888', JSON.stringify(c));
  const rN2 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_phone: '0755-66667777' });
  c = dbContact(tA);
  check('N 只更新 phone → name 不变', rN2.status === 200 && c.public_contact_phone === '0755-66667777' && c.public_contact_name === '赵老师', JSON.stringify(c));

  // ======================= WRITE: O unknown 字段不可篡改其他数据 =======================
  const beforeO = q('SELECT name, status, cert_status, intro FROM teams WHERE id=?', tA);
  const rO1 = await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '合法', name: 'HACKED', status: 3 });
  check('O 含未知字段（name/status）→ 400', rO1.status === 400, `status=${rO1.status}`);
  const rO2 = await patchContact(T.A, 'team_owner', uid.alice, tA, { id: tB });
  check('O 含 id 字段 → 400', rO2.status === 400, `status=${rO2.status}`);
  const afterO = q('SELECT name, status, cert_status, intro FROM teams WHERE id=?', tA);
  check('O 未知字段请求未篡改无关列',
    JSON.stringify(beforeO) === JSON.stringify(afterO), `before=${JSON.stringify(beforeO)} after=${JSON.stringify(afterO)}`);
  check('O 未知字段请求未顺带写入 name', dbContact(tA).public_contact_name !== '合法', JSON.stringify(dbContact(tA)));

  // ======================= READ: P repository 读 =======================
  await patchContact(T.A, 'team_owner', uid.alice, tA, { public_contact_name: '钱老师', public_contact_phone: '028-11112222' });
  const rP = await getContact(T.A, 'team_admin', uid.carol, tA);
  const pContact = rP.json?.data?.public_contact;
  check('P GET public-contact → 200', rP.status === 200, `status=${rP.status}`);
  check('P GET 返回正确公开联系人',
    pContact && pContact.public_contact_name === '钱老师' && pContact.public_contact_phone === '028-11112222',
    JSON.stringify(pContact));

  // ======================= READ: Q activity → team lookup =======================
  const t0 = 1_700_000_000;
  const rAct = await call('POST', '/api/v2/activities', {
    role: 'team_admin', user: uid.alice, team: tA,
    body: { title: 'Q 活动', start_time: t0, end_time: t0 + 7200, quota: 10, address: 'Q 路 1 号' },
  });
  const actPub = rAct.json?.data?.activity?.public_id;
  check('Q 前置：创建活动 → 201', rAct.status === 201, `status=${rAct.status}`);
  const actRow = q('SELECT id, team_id FROM activities WHERE public_id=?', actPub);
  check('Q 活动 team_id 指向 teamA', actRow && actRow.team_id === tA, JSON.stringify(actRow));

  const repo = new TeamRepository({ db: d1, ctx: { auth: { authenticated: true, userId: uid.alice, role: 'team_admin', teamId: tA, roles: [] }, tenant: { scope: 'TEAM_SCOPED', teamId: tA, userId: uid.alice } } });
  const qContact = await repo.findPublicContactByTeamId(actRow.team_id);
  check('Q activity.team_id → findPublicContactByTeamId 返回 teamA 联系人',
    qContact && qContact.public_contact_name === '钱老师' && qContact.public_contact_phone === '028-11112222',
    JSON.stringify(qContact));

  // ======================= READ: R null 态 =======================
  const rR = await getContact(T.B, 'team_owner', uid.bob, tB);
  const rContact = rR.json?.data?.public_contact;
  check('R 未配置团队 → 200 且两字段为 null',
    rR.status === 200 && rContact && rContact.public_contact_name === null && rContact.public_contact_phone === null,
    JSON.stringify(rContact));

  // ======================= PRIVACY: S/T/U =======================
  const keys = Object.keys(pContact || {}).sort();
  check('S/T/U 响应 DTO 仅含两个公开字段（无 trusted/identity/emergency）',
    JSON.stringify(keys) === JSON.stringify(['public_contact_name', 'public_contact_phone']), JSON.stringify(keys));
  const rawBody = JSON.stringify(rP.json);
  check('S 响应不含 owner trusted phone 明文', !rawBody.includes(OWNER_PRIVATE_PHONE));
  check('S 响应不含 phone_mask/phone_enc/phone_hash 字段',
    !rawBody.includes('phone_mask') && !rawBody.includes('phone_enc') && !rawBody.includes('phone_hash'));
  check('T 响应不含身份字段（openid/identity/unionid/nid）',
    !/openid|unionid|identity|nid|id_card/i.test(rawBody));
  check('U 响应不含 emergency/联系人隐私字段', !/emergency/i.test(rawBody));

  // ======================= PRIVACY: V 无 owner/user profile 回退 =======================
  // teamB 未配置公开联系人，且已为 teamB owner(bob) 写入 trusted phone → 仍应为 null（不回退）。
  seed(
    `INSERT INTO phone_verifications (public_id,user_id,provider,phone_enc,phone_hash,phone_mask,status,created_at)
     VALUES (?,?,'WECHAT','enc2','hash2','137****2222','BOUND',?)`,
    pid('P'), uid.bob, 1700000000,
  );
  const rV = await getContact(T.B, 'team_owner', uid.bob, tB);
  const vContact = rV.json?.data?.public_contact;
  check('V 未配置时不从 owner/user profile 回退',
    vContact && vContact.public_contact_name === null && vContact.public_contact_phone === null, JSON.stringify(vContact));
  check('V 不回退 owner trusted phone', vContact && vContact.public_contact_phone !== '137****2222' && vContact.public_contact_name !== 'bob');

  // ======================= REGRESSION: W team mine/detail/join =======================
  const rWm = await call('GET', '/api/v2/teams/mine', { role: 'team_owner', user: uid.alice });
  check('W GET /teams/mine 仍 200 且含 teamA', rWm.status === 200 && (rWm.json?.data?.teams ?? []).some((t) => t.public_id === T.A),
    `status=${rWm.status}`);
  const rWd = await call('GET', `/api/v2/teams/${T.A}`, { role: 'volunteer', user: uid.vol, team: tA });
  check('W GET /teams/:id 仍 200', rWd.status === 200 && rWd.json?.data?.team?.public_id === T.A, `status=${rWd.status}`);
  const rWj = await call('POST', `/api/v2/teams/${T.B}/join`, { role: 'volunteer', user: uid.dave });
  check('W POST /teams/:id/join 仍 200', rWj.status === 200, `status=${rWj.status}`);
  const memberRow = q('SELECT COUNT(*) n FROM team_members WHERE team_id=? AND user_id=?', tB, uid.dave);
  check('W join 仍写入 team_members', memberRow.n === 1, `n=${memberRow.n}`);

  // ======================= REGRESSION: X signup + review =======================
  grantQualification(uid.vol);
  const actX = rAct.json?.data?.activity?.public_id;
  await call('POST', `/api/v2/activities/${actX}/submit`, { role: 'team_admin', user: uid.alice, team: tA });
  const rXapp = await call('POST', `/api/v2/activities/${actX}/approve`, { role: 'team_auditor', user: uid.carol, team: tA });
  check('X 前置：活动审核通过 → 200', rXapp.status === 200, `status=${rXapp.status}`);
  // 报名审核路径需 activity.need_audit=1（create API 不开放该字段；测试内直接置位以覆盖 review 分支）。
  seed('UPDATE activities SET need_audit=1 WHERE id=?', actRow.id);
  const rXsign = await call('POST', `/api/v2/activities/${actX}/signups`, { role: 'volunteer', user: uid.vol, team: tA, body: {} });
  check('X 报名仍成功 → 201', rXsign.status === 201, `status=${rXsign.status}`);
  const signupId = rXsign.json?.data?.signup?.id;
  const preRev = q('SELECT review_status FROM activity_signups WHERE id=?', signupId);
  check('X need_audit=1 → 报名落库为待审（review_status=0）', preRev && preRev.review_status === 0, JSON.stringify(preRev));
  const rXrev = await call('POST', `/api/v2/activities/${actX}/signups/${signupId}/review`, {
    role: 'team_admin', user: uid.carol, team: tA, body: { decision: 'approve' },
  });
  check('X 报名审核仍成功 → 200', rXrev.status === 200, `status=${rXrev.status}`);
  const revRow = q('SELECT review_status FROM activity_signups WHERE id=?', signupId);
  check('X 报名审核落库（review_status=1）', revRow && revRow.review_status === 1, JSON.stringify(revRow));

  // ======================= REGRESSION: Y notification core =======================
  const rYn = await call('GET', '/api/v2/notifications/unread-count', { role: 'volunteer', user: uid.vol, team: tA });
  check('Y GET /notifications/unread-count 仍 200（SELF，不受 teams 改动影响）', rYn.status === 200, `status=${rYn.status}`);
  const rYna = await call('GET', '/api/v2/notifications/unread-count', {});
  check('Y 未认证 notifications → 401（契约不变）', rYna.status === 401, `status=${rYna.status}`);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`N0-E5B RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== N0-E5B = BLOCKED ===' : '=== N0-E5B = PASS ===');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
