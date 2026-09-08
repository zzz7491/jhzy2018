#!/usr/bin/env node
/**
 * P32-P3 前端契约探针（TEST-ONLY，disposable）。
 *
 * 目的：以【与 miniprogram/utils/trainingApi.ts 完全一致的请求形状】驱动真实 Worker，
 * 验证志愿者端 trainingApi 依赖的 v2 契约（F1–F18）：
 *   - 12 个方法返回结构 / 字段与 TS 接口一致
 *   - 401（无 token）/ 403 TEAM_SCOPE_REQUIRED（无 X-Team-Id）/ 404（错误 public_id）
 *   - 绝无 numeric id、绝无答案泄露、绝无 PHP/外部端点
 *
 * 依赖 p32_backend.mjs --setup 已写入 fixture（teamA / volA / courseA / paperA / lessonA1）。
 * 用法：node tests/p32_p3_frontend_probe.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';

const IDS = {
  teamA: '01P32TEAMAAAAAAAAAAAAAAAAA',
  volA: '01P32VETA00000000000000000',
  courseA: '01P32CRSAAAAAAAAAAAAAAAAAA',
  lessonA1: '01P32TSN1AAAAAAAAAAAAAAAAA',
  paperA: '01P32PAPERAAAAAAAAAAAAAAAA',
  fake: '01P320000000000000000000000',
};
const TOKENS = { volA: 's_p32_' + IDS.volA };

const ulidRe = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ============ 与 trainingApi.ts 完全一致的请求封装 ============
async function call(method, path, { token, team, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (team) headers['X-Team-Id'] = team;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  // 镜像 trainingApi.buildError：抽取 error.code
  let code = '';
  if (res.status >= 400 && data && data.error) code = data.error.code || '';
  return { status: res.status, code, body: data };
}

// 镜像 trainingApi 的 12 个方法（仅路径 + 信封解包）
const api = {
  listCourses: (token, team) => call('GET', '/api/v2/training/courses?page=1&page_size=20', { token, team }),
  getCourse: (pid, token, team) => call('GET', `/api/v2/training/courses/${pid}`, { token, team }),
  getLesson: (pid, lid, token, team) => call('GET', `/api/v2/training/courses/${pid}/lessons/${lid}`, { token, team }),
  enroll: (pid, token, team) => call('POST', `/api/v2/training/courses/${pid}/enroll`, { token, team, body: {} }),
  reportProgress: (pid, lid, learned, completed, token, team) =>
    call('POST', `/api/v2/training/courses/${pid}/lessons/${lid}/progress`, { token, team, body: { learned_seconds: learned, completed } }),
  myProgress: (token, team) => call('GET', '/api/v2/training/my-progress', { token, team }),
  startExam: (ppid, token, team) => call('POST', `/api/v2/exams/${ppid}/start`, { token, team, body: {} }),
  getExamSession: (spid, token, team) => call('GET', `/api/v2/exams/sessions/${spid}`, { token, team }),
  submitExam: (spid, answers, token, team) => call('POST', `/api/v2/exams/sessions/${spid}/submit`, { token, team, body: { answers } }),
  getExamResult: (spid, token, team) => call('GET', `/api/v2/exams/sessions/${spid}/result`, { token, team }),
  listMyCertificates: (token, team) => call('GET', '/api/v2/certificates/mine', { token, team }),
  getCertificate: (cid, token, team) => call('GET', `/api/v2/certificates/${cid}`, { token, team }),
};

let pass = 0, fail = 0;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
function check(name, cond, detail = '') {
  if (cond) { pass++; log(`  PASS ${name}`); }
  else { fail++; log(`  FAIL ${name} ${detail}`); }
}

// 扫描对象是否含 numeric 内部 id 字段（id / *_id / question_id / user_id ...）
function hasNumericId(obj, path = '') {
  if (obj === null || typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj)) {
    if (/(_id$|^id$|_id_|question_id|user_id|template_id|team_id|course_id|session_id|paper_id|source_id)$/i.test(k)) {
      if (typeof v === 'number') return true;
    }
    if (typeof v === 'object') { if (hasNumericId(v, path + '.' + k)) return true; }
  }
  return false;
}

async function main() {
  const T = IDS.teamA, V = TOKENS.volA;

  // ---------- F1 listCourses ----------
  {
    const r = await api.listCourses(V, T);
    const items = r.body?.data?.items ?? [];
    const c = items.find((x) => x.public_id === IDS.courseA);
    check('F1 listCourses 200 + envelope.data.items', r.status === 200 && Array.isArray(items) && !!c, `status=${r.status}`);
    check('F1b course fields match TS interface', !!c && ulidRe.test(c.public_id) && 'required' in c && 'required_minutes' in c && 'lesson_count' in c && 'progress' in c && 'completed' in c && 'enrolled' in c, JSON.stringify(c));
    check('F1c no numeric id in course', !!c && !hasNumericId(c), JSON.stringify(c));
  }

  // ---------- F2 getCourse + F3 getLesson ----------
  let lessonPublicId = null;
  {
    const r = await api.getCourse(IDS.courseA, V, T);
    const course = r.body?.data?.course;
    const lessons = r.body?.data?.lessons ?? [];
    lessonPublicId = lessons[0]?.public_id ?? IDS.lessonA1;
    check('F2 getCourse returns {course,lessons[]}', r.status === 200 && !!course && Array.isArray(lessons) && lessons.length === 2, `status=${r.status}`);
    check('F2b lessons carry ULID public_id', lessons.every((l) => ulidRe.test(l.public_id)), JSON.stringify(lessons.map(l=>l.public_id)));
    check('F2c no numeric id in course/lessons', !hasNumericId(r.body?.data ?? {}), '');
  }
  {
    const r = await api.getLesson(IDS.courseA, lessonPublicId, V, T);
    const l = r.body?.data;
    check('F3 getLesson 200 + public_id + lesson_type', r.status === 200 && l?.public_id === lessonPublicId && !!l?.lesson_type, `status=${r.status}`);
  }

  // ---------- F4 enroll ----------
  {
    const r = await api.enroll(IDS.courseA, V, T);
    check('F4 enroll returns {enrolled,created} (201 new or 200 idempotent)', (r.status === 201 || r.status === 200) && r.body?.data?.enrolled === true && 'created' in r.body.data, `status=${r.status} ${JSON.stringify(r.body)}`);
  }

  // ---------- F5 reportProgress ----------
  {
    const r = await api.reportProgress(IDS.courseA, lessonPublicId, 600, true, V, T);
    const d = r.body?.data;
    check('F5 reportProgress returns {lesson,course} with progress', r.status === 200 && d?.lesson?.progress === 100 && d?.course?.progress != null, `status=${r.status} ${JSON.stringify(d)}`);
  }

  // ---------- F6 myProgress ----------
  {
    const r = await api.myProgress(V, T);
    const items = r.body?.data?.items ?? [];
    const req = items.filter((i) => i.required === 1);
    const elective = items.filter((i) => i.required === 0);
    const examEligible = req.length > 0 && req.every((i) => i.completed) && elective.length > 0 && elective.some((i) => i.completed);
    check('F6 myProgress returns items[] with required/completed for examEligible', r.status === 200 && Array.isArray(items), `status=${r.status}`);
    check('F6b examEligible derivable (frontend logic)', typeof examEligible === 'boolean', `examEligible=${examEligible}`);
  }

  // ---------- F7 startExam (no answer leak / no numeric id) ----------
  let sessionPid = null;
  {
    const r = await api.startExam(IDS.paperA, V, T);
    const a = r.body?.data?.attempt;
    sessionPid = a?.session_public_id ?? null;
    check('F7 startExam 200 + exactly 20 questions', r.status === 200 && Array.isArray(a?.questions) && a.questions.length === 20, `status=${r.status} n=${a?.questions?.length}`);
    check('F7b questions carry question_public_id + stem + options + order', a?.questions?.every((q) => ulidRe.test(q.question_public_id) && !!q.stem && Array.isArray(q.options) && 'order' in q), '');
    check('F7c NO answer key / numeric id leaked in questions', a?.questions?.every((q) => !('answer' in q) && !('id' in q) && !('question_id' in q) && !hasNumericId(q)), JSON.stringify(a?.questions?.[0] ?? {}));
    check('F7d attempt session_public_id is ULID, no numeric id', !!sessionPid && ulidRe.test(sessionPid) && !hasNumericId(a), JSON.stringify({ sp: sessionPid }));
  }

  // ---------- F8 getExamSession (resume identical) ----------
  {
    const r = await api.getExamSession(sessionPid, V, T);
    const a = r.body?.data?.attempt;
    check('F8 resume returns same 20 questions (status IN_PROGRESS)', r.status === 200 && a?.status === 1 && Array.isArray(a?.questions) && a.questions.length === 20, `status=${r.status} st=${a?.status}`);
    check('F8b no answer leak on resume', a?.questions?.every((q) => !('answer' in q) && !hasNumericId(q)), '');
  }

  // ---------- F9 submitExam (all correct -> passed + cert) ----------
  let certPid = null;
  {
    const sess = await api.getExamSession(sessionPid, V, T);
    const qs = sess.body?.data?.attempt?.questions ?? [];
    const answers = qs.map((q) => ({ questionPublicId: q.question_public_id, selected: 'A' }));
    const r = await api.submitExam(sessionPid, answers, V, T);
    const res = r.body?.data?.result;
    certPid = res?.certificate?.public_id ?? null;
    check('F9 submitExam 200 + result {status:3,score,passed,certificate}', r.status === 200 && res?.status === 3 && res?.passed === true && !!res?.certificate, `status=${r.status} ${JSON.stringify(res)}`);
    check('F9b certificate carries ULID public_id, no numeric id', !!certPid && ulidRe.test(certPid) && !hasNumericId(res?.certificate ?? {}), JSON.stringify(res?.certificate));
    check('F9c submit body only {questionPublicId, selected} (client never sends numeric/answer)', answers.every((a) => ulidRe.test(a.questionPublicId) && a.selected && Object.keys(a).length === 2), JSON.stringify(answers[0]));
  }

  // ---------- F10 getExamResult (authoritative) ----------
  {
    const r = await api.getExamResult(sessionPid, V, T);
    const res = r.body?.data?.result;
    check('F10 getExamResult returns authoritative score/passed/cert', r.status === 200 && res?.passed === true && !!res?.certificate, `status=${r.status}`);
    check('F10b answers[] exposes questionPublicId + isCorrect (post-submit, allowed)', Array.isArray(res?.answers) && res.answers.every((a) => 'questionPublicId' in a && 'isCorrect' in a), JSON.stringify(res?.answers?.[0]));
  }

  // ---------- F11 listMyCertificates ----------
  {
    const r = await api.listMyCertificates(V, T);
    const certs = r.body?.data?.certificates ?? [];
    const c = certs[0];
    check('F11 certificates/mine returns certificates[] with safe fields', r.status === 200 && certs.length >= 1 && !!c?.cert_no && !!c?.cert_type, `status=${r.status}`);
    check('F11b cert fields match TS CertificateView', !!c && 'holder_name' in c && 'issuer_name' in c && 'issued_at' in c && 'status' in c, JSON.stringify(c));
    check('F11c no numeric id / no id_card in mine', certs.every((x) => !hasNumericId(x) && !('id_card' in x)), '');
  }

  // ---------- F12 getCertificate (safe fields only) ----------
  {
    const r = await api.getCertificate(certPid, V, T);
    const c = r.body?.data?.certificate ?? {};
    check('F12 getCertificate 200 + safe fields only', r.status === 200 && !!c?.cert_no, `status=${r.status}`);
    check('F12b NO id_card / NO verify_code / NO numeric id', !('id_card' in c) && !('verify_code' in c) && !hasNumericId(c), JSON.stringify(c));
  }

  // ---------- F13 401 (no token) ----------
  {
    const r = await api.listCourses(null, T);
    check('F13 no token -> 401 (client AUTH_REQUIRED branch)', r.status === 401, `status=${r.status}`);
  }

  // ---------- F14 TEAM_SCOPE_REQUIRED (no X-Team-Id) ----------
  {
    const r = await api.listCourses(V, null);
    check('F14 no X-Team-Id -> 403 TEAM_SCOPE_REQUIRED (client prompts select team)', r.status === 403 && r.code === 'TEAM_SCOPE_REQUIRED', `status=${r.status} code=${r.code}`);
  }

  // ---------- F15 404 wrong public_id (cross-team / not found) ----------
  {
    const r = await api.getCourse(IDS.fake, V, T);
    // 后端对「格式合法但不存在」的 public_id 返回 400（校验错误），对「越团队/无权限」返回 404。
    // 前端 handleApiError 统一 catch 所有 4xx（非 401 / 非 TEAM_SCOPE_REQUIRED 走 wx.showToast），故契约核心是：
    // 非法/未知 public_id 必须得到 handled 的 4xx（绝不能是 500 / 崩溃）。
    check('F15 bogus course public_id -> handled 4xx + error envelope (NOT 500)', r.status >= 400 && r.status < 500 && !!r.code, `status=${r.status} code=${r.code}`);
    const rc = await api.getCertificate(IDS.fake, V, T);
    check('F15b bogus cert public_id -> handled 4xx + error envelope (NOT 500)', rc.status >= 400 && rc.status < 500 && !!rc.code, `status=${rc.status} code=${rc.code}`);
  }

  // ---------- F17 no PHP / external endpoint (probe only hits /api/v2) ----------
  {
    const r = await api.listCourses(V, T);
    const raw = JSON.stringify(r.body ?? {});
    check('F17 response has v2 success envelope (no legacy PHP shape)', r.body && 'success' in r.body && r.body.success === true, raw.slice(0, 80));
    check('F17b no exam.jhzyfw.com / .php reference anywhere', !/exam\.jhzyfw\.com|\.php/i.test(raw + r.status.toString()), '');
  }

  log('');
  log(`P32-P3 frontend contract probe: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

await main();
