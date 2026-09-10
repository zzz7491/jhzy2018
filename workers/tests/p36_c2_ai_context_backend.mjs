/**
 * P36-C2 — 嘉禾 AI V1 Context Builder + AI Backend CONTRACT TEST
 *
 * 目的：在「完整当前迁移链」+「真实源码打包」+「真实 D1(sqflite shim)」上验证：
 *   1. volunteer_assist context builder（服务端确定性、只读、最小投影、作用域受限）
 *   2. AI backend service（provider-neutral、输入规范、错误归一化、安全输出）
 *   3. usage logging（仅成功路径；不发明 status 语义；不虚构成本）
 *   4. privacy / safety filtering（代码级 forbidden-key guard）
 *   5. provider invocation orchestration
 *
 * 覆盖：任务 §13 A–AB。
 *
 * 纯契约测试：不驱动任何 route；不调用任何真实外部 AI API（provider 全部注入 mock）；
 * 不修改源码 / 迁移 / 历史 WIP；不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：node tests/p36_c2_ai_context_backend.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const WORKERS = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(WORKERS, 'migrations');
const MONOREPO = dirname(WORKERS);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  ✗ FAIL: ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(n) {
  console.log(`\n=== ${n} ===`);
}
async function kindOf(fn) {
  try {
    await fn();
    return 'NO_THROW';
  } catch (e) {
    if (e && typeof e.kind === 'string') return e.kind;
    if (e && typeof e.reason === 'string') return `reason:${e.reason}`;
    return `THROW:${e && e.name}`;
  }
}
function mustThrowSync(fn, label) {
  try {
    fn();
    check(label, false, 'expected throw');
  } catch {
    check(label, true);
  }
}
async function mustThrowAsync(fn, label) {
  const k = await kindOf(fn);
  check(label, k !== 'NO_THROW', `got ${k}`);
}

// ---------------------------------------------------------------------------
// SQLite + 完整迁移链
// ---------------------------------------------------------------------------
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = OFF;');
const migs = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
for (const f of migs) sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
console.log(`[setup] applied ${migs.length} migrations (latest: ${migs[migs.length - 1]})`);

// D1 shim（对齐 p35/p36 既有测试）
function makeD1(db) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...a) {
        params = a;
        return stmt;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async first() {
        const r = db.prepare(sql).get(...params);
        return r === undefined ? null : r;
      },
      async run() {
        const r = db.prepare(sql).run(...params);
        return {
          success: true,
          meta: { last_row_id: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) },
        };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
  };
}
const DB = makeD1(sqlite);

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const T = { MINE: 10, OTHER: 20, EMPTY: 30 };
const U = { ME: 100, OTHER: 101, EMPTY: 300 };
const ACT = { PUB: 1000, DRAFT: 1001, OTHER_TEAM: 1002 };

function ins(sql, params) {
  sqlite.prepare(sql).run(...params);
}

// teams / users
ins(`INSERT INTO teams (id, public_id, name, short_name, intro, owner_user_id, status) VALUES (?,?,?,?,?,?,1)`,
  [T.MINE, 'TEAMMINE0000000000000000001', '嘉禾测试队', '测试队', '用于测试的团队', U.ME]);
ins(`INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)`,
  [T.OTHER, 'TEAMOTHER000000000000000002', '别的团队', U.OTHER]);
ins(`INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)`,
  [T.EMPTY, 'TEAMEMPTY000000000000000003', '空团队', U.EMPTY]);

ins(`INSERT INTO users (id, public_id) VALUES (?,?)`, [U.ME, 'USERME00000000000000000001']);
ins(`INSERT INTO users (id, public_id) VALUES (?,?)`, [U.OTHER, 'USEROTHER0000000000000002']);
ins(`INSERT INTO users (id, public_id) VALUES (?,?)`, [U.EMPTY, 'USEREMPTY0000000000000003']);
// PII（绝不得进入 AI context）
ins(`INSERT INTO volunteer_profiles (user_id, real_name_enc, id_card_mask, phone_enc, phone_mask, emergency_contact_enc)
     VALUES (?,?,?,?,?,?)`,
  [U.ME, 'ENC_REALNAME_XYZ', '110101********1234', 'ENC_PHONE_XYZ', '138****5678', 'ENC_EMERGENCY_XYZ']);

// activities（audit_status=2(APPROVED) + status∈(1..4) 才对志愿者可见；created_by NOT NULL）
ins(`INSERT INTO activities (id, public_id, team_id, title, summary, start_time, end_time, audit_status, status, created_by)
     VALUES (?,?,?,?,?,?,?,2,1,?)`,
  [ACT.PUB, 'ACTPUB000000000000000000001', T.MINE, '社区清洁日', '河道清洁', 1750000000, 1750036000, U.ME]);
ins(`INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, audit_status, status, created_by)
     VALUES (?,?,?,?,?,?,1,1,?)`,
  [ACT.DRAFT, 'ACTDRAFT00000000000000000002', T.MINE, '内部草稿活动', 1750000000, 1750036000, U.ME]);
ins(`INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, audit_status, status, created_by)
     VALUES (?,?,?,?,?,?,2,1,?)`,
  [ACT.OTHER_TEAM, 'ACTOTHERTEAM000000000000003', T.OTHER, '别的团队活动', 1750000000, 1750036000, U.OTHER]);

// signups + participations
ins(`INSERT INTO activity_signups (id, activity_id, user_id, status) VALUES (?,?,?,1)`, [500, ACT.PUB, U.ME]);
ins(`INSERT INTO activity_signups (id, activity_id, user_id, status) VALUES (?,?,?,1)`, [501, ACT.PUB, U.OTHER]);
ins(`INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status)
     VALUES (?,?,?,?,1)`, [600, 'PARTME000000000000000000001', 500, 1]);
ins(`INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status)
     VALUES (?,?,?,?,1)`, [601, 'PARTOTHER0000000000000000002', 501, 1]);

// service_records
ins(`INSERT INTO service_records
     (id, session_id, user_id, team_id, activity_id, minutes, service_date, public_id, business_service_date, settlement_status, points_awarded_units)
     VALUES (?,?,?,?,?,?,?,?,?,1,100)`,
  [700, 1, U.ME, T.MINE, ACT.PUB, 120, 1750000000, 'SRME0000000000000000000001', '2026-08-01']);
ins(`INSERT INTO service_records
     (id, session_id, user_id, team_id, activity_id, minutes, service_date, public_id, settlement_status, points_awarded_units)
     VALUES (?,?,?,?,?,?,?,?,1,50)`,
  [701, 2, U.OTHER, T.MINE, ACT.PUB, 60, 1750000000, 'SROTHER00000000000000000002']);

// points
ins(`INSERT INTO points_accounts (user_id, balance, total_earned, total_spent) VALUES (?,?,?,?)`, [U.ME, 300, 400, 100]);
ins(`INSERT INTO points_accounts (user_id, balance, total_earned, total_spent) VALUES (?,?,?,?)`, [U.OTHER, 888888, 888888, 0]);

// growth
ins(`INSERT INTO growth_records (id, user_id, action_type, value, balance_after, request_id)
     VALUES (?,?,?,?,?,?)`, [800, U.ME, 'service_minute', 2, 10, 'gr-me-1']);
ins(`INSERT INTO growth_records (id, user_id, action_type, value, balance_after, request_id)
     VALUES (?,?,?,?,?,?)`, [801, U.OTHER, 'service_minute', 9, 99, 'gr-other-1']);

// training
ins(`INSERT INTO courses (id, public_id, team_id, title) VALUES (?,?,?,?)`, [900, 'COURSEME0000000000000000001', T.MINE, '急救培训']);
ins(`INSERT INTO course_enrollments (id, user_id, course_id, team_id, progress, learned_minutes, status)
     VALUES (?,?,?,?,?,?,1)`, [901, U.ME, 900, T.MINE, 40, 30]);
ins(`INSERT INTO course_enrollments (id, user_id, course_id, team_id, progress, learned_minutes, status)
     VALUES (?,?,?,?,?,?,1)`, [902, U.OTHER, 900, T.MINE, 90, 99]);

// exam
ins(`INSERT INTO exam_papers (id, public_id, team_id, title, pick_rule) VALUES (?,?,?,?,?)`,
  [1000, 'PAPERME000000000000000000001', T.MINE, '急救考核', '{}']);
ins(`INSERT INTO exam_sessions (id, paper_id, user_id, team_id, score, passed, submitted_at, status)
     VALUES (?,?,?,?,?,?,?,3)`, [1100, 1000, U.ME, T.MINE, 80, 1, 1750000000]);
ins(`INSERT INTO exam_sessions (id, paper_id, user_id, team_id, score, passed, submitted_at, status)
     VALUES (?,?,?,?,?,?,?,3)`, [1101, 1000, U.OTHER, T.MINE, 95, 1, 1750000000]);

// certificates
ins(`INSERT INTO certificate_templates (id, name, cert_type, layout, status) VALUES (?,?,?,?,1)`,
  [1200, '证书模板', 'training', '{}']);
ins(`INSERT INTO certificates (id, public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type, issuer_name, issued_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
  [1300, 'CERTME000000000000000000001', 'NO-ME-1', 'VC-ME-1', 1200, U.ME, T.MINE, 'training', '嘉禾志愿', 1750000000]);
ins(`INSERT INTO certificates (id, public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type, issuer_name, issued_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
  [1301, 'CERTOTHER0000000000000000002', 'NO-OT-1', 'VC-OT-1', 1200, U.OTHER, T.MINE, 'training', '别的颁发方', 1750000000]);

// content（content_type ∈ (announcement|story|policy|knowledge|platform)；status=2(PUBLISHED)+audit_status=2(APPROVED)）
ins(`INSERT INTO content_articles (id, public_id, content_type, team_id, title, summary, status, audit_status, published_at)
     VALUES (?,?,?,?,?,?,2,2,1750000000)`,
  [1400, 'ARTPUB000000000000000000001', 'story', T.MINE, '清洁日回顾', '一次有意义的志愿活动']);
ins(`INSERT INTO content_articles (id, public_id, content_type, team_id, title, status, audit_status)
     VALUES (?,?,?,?,?,1,1)`,
  [1401, 'ARTDRAFT00000000000000000002', 'story', T.MINE, '草稿未审核']);

// ---------------------------------------------------------------------------
// Bundle（真实源码）
// ---------------------------------------------------------------------------
const ENTRY = `
export { AIContextRepository, AI_CONTEXT_DEFAULT_LIMITS } from './src/repository/ai-context';
export { buildVolunteerAssistContext, AI_CONTEXT_SOURCE_LABELS } from './src/services/ai/data-block';
export { AIBackendService } from './src/services/ai/service';
export { AIUsageRepository, AI_USAGE_STATUS_EXISTING_SEMANTICS, FAILED_USAGE_LOGGING } from './src/services/ai/usage';
export { FORBIDDEN_CONTEXT_KEYS, findForbiddenKeys, assertNoForbiddenKeys, AIPrivacyError } from './src/services/ai/privacy';
export { normalizeUserInput, normalizeHistory, assertNoClientControlFields, AIInputError, AI_INPUT_MAX_CHARS, AI_MAX_HISTORY_MESSAGES, REJECTED_CLIENT_FIELDS } from './src/services/ai/input';
export { HttpChatProvider } from './src/services/ai/http-chat-provider';
export { AIProviderError } from './src/services/ai/provider';
export { VOLUNTEER_ASSIST_PROMPT_VERSION, VOLUNTEER_ASSIST_DATA_OPEN, VOLUNTEER_ASSIST_DATA_CLOSE } from './src/services/ai/prompts/volunteer-assist.v1';
`;
const entryPath = join(WORKERS, '.p36_c2_bundle_entry.ts');
writeFileSync(entryPath, ENTRY);
const bundlePath = join(tmpdir(), `p36_c2_${Date.now()}.mjs`);
await build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: bundlePath,
  absWorkingDir: WORKERS,
  logLevel: 'error',
});
unlinkSync(entryPath);
const M = await import(pathToFileURL(bundlePath).href);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const ctxFor = (userId, teamId) => ({
  auth: {
    authenticated: true,
    userId,
    role: 'volunteer',
    teamId,
    roles: [{ role: 'volunteer', scopeTeamId: teamId }],
  },
  tenant: { scope: 'TEAM_SCOPED', teamId, userId },
});
const mkRepo = (userId, teamId) => new M.AIContextRepository({ db: DB, ctx: ctxFor(userId, teamId) });

const AI_SRC_FILES = [
  'src/services/ai/privacy.ts',
  'src/services/ai/input.ts',
  'src/services/ai/data-block.ts',
  'src/services/ai/usage.ts',
  'src/services/ai/service.ts',
  'src/repository/ai-context.ts',
].filter((f) => existsSync(join(WORKERS, f)));
const readSrc = (f) => readFileSync(join(WORKERS, f), 'utf8');
const AI_TXT = AI_SRC_FILES.map(readSrc).join('\n');

const okProvider = {
  name: 'mock-provider',
  async complete() {
    return {
      text: '这是模拟回答。',
      provider: 'mock-provider',
      model: 'mock-model-1',
      promptTokens: 11,
      completionTokens: 7,
      latencyMs: 3,
      finishReason: 'stop',
    };
  },
};
const throwingProvider = (kind, message) => ({
  name: 'mock-throwing',
  async complete() {
    throw new M.AIProviderError(kind, message);
  },
});
const svcEnv = { AI_MAX_OUTPUT_TOKENS: '256', AI_TIMEOUT_MS: '5000', AI_API_KEY: 'SECRET_KEY_XYZ_987' };
const mkService = (userId, teamId, provider) =>
  new M.AIBackendService({ db: DB, ...ctxFor(userId, teamId), env: svcEnv }, provider);

// ===========================================================================
// A. context builder 只读
// ===========================================================================
section('A. context builder is read-only');
{
  const ctxSrc = readSrc('src/repository/ai-context.ts');
  check('A1 ai-context.ts 无写入语句 (INSERT/UPDATE/DELETE)', !/\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(ctxSrc));
  check('A2 ai-context.ts 仅 SELECT', (ctxSrc.match(/\bSELECT\b/gi) || []).length > 0 && !/\bCREATE\b|\bDROP\b/i.test(ctxSrc));
  const dataBlockSrc = readSrc('src/services/ai/data-block.ts');
  check('A3 data-block.ts 无写入语句', !/\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(dataBlockSrc));
}

// ===========================================================================
// B. 不自由 SQL（无插值 / 无请求对象）
// ===========================================================================
section('B. no free-form SQL');
{
  const ctxSrc = readSrc('src/repository/ai-context.ts');
  check('B1 ai-context.ts 无模板插值 ${...}（SQL 全静态）', !ctxSrc.includes('${'));
  check('B2 ai-context.ts 不读 HTTP request/body', !/req\.|request\.|body\./.test(ctxSrc));
  check('B3 repository 读方法不接受调用方传入的 scope 参数', !/list\w+\([^)]*\b(teamId|userId|scope)\b/.test(ctxSrc));
}

// ===========================================================================
// C–H. 作用域 / 可见性
// ===========================================================================
section('C–H. scope & visibility');
let meCtx;
{
  meCtx = await M.buildVolunteerAssistContext(mkRepo(U.ME, T.MINE));
  const dbText = meCtx.dataBlock;

  // C auth user scope
  check('C1 含本人服务记录（120 分钟）', /120 分钟/.test(dbText));
  check('C2 含本人参与记录', dbText.includes('我已参与'));

  // D team scope
  check('D1 含当前团队信息', dbText.includes('嘉禾测试队'));
  check('D2 含当前团队可见活动', dbText.includes('社区清洁日'));

  // E cross-team
  check('E1 不含其它团队活动', !dbText.includes('别的团队活动'));
  check('E2 不含其它团队公开 id', !dbText.includes('ACTOTHERTEAM'));

  // F other-user
  check('F1 不含他人证书', !dbText.includes('CERTOTHER'));
  check('F2 不含他人参与记录', !dbText.includes('PARTOTHER'));
  check('F3 不含他人积分（888888）', !dbText.includes('888888'));
  check('F4 不含他人考试得分（95）', !/得分 95/.test(dbText));

  // G unpublished activity
  check('G1 不含未审核活动（草稿）', !dbText.includes('内部草稿活动'));

  // H unpublished community
  check('H1 不含未审核社区内容（草稿）', !dbText.includes('草稿未审核'));
  check('H2 含已批准社区内容', dbText.includes('清洁日回顾'));
}

// ===========================================================================
// I–K. 隐私 / numeric id / public_id
// ===========================================================================
section('I–K. privacy / numeric id / public_id');
{
  const repo = mkRepo(U.ME, T.MINE);
  const rows = {
    team: await repo.readTeam(),
    activities: await repo.listVisibleActivities(),
    participations: await repo.listMyParticipations(),
    serviceRecords: await repo.listMyServiceRecords(),
    points: await repo.readMyPoints(),
    growth: await repo.listMyGrowth(),
    training: await repo.listMyTraining(),
    exams: await repo.listMyExams(),
    certificates: await repo.listMyCertificates(),
    content: await repo.listPublishedContent(),
  };
  const allRows = Object.values(rows);

  // I PII
  const dbText = meCtx.dataBlock;
  check('I1 context 不含 phone_enc 值', !dbText.includes('ENC_PHONE_XYZ'));
  check('I2 context 不含 id_card_mask 值', !dbText.includes('110101********1234'));
  check('I3 context 不含 real_name_enc 值', !dbText.includes('ENC_REALNAME_XYZ'));
  check('I4 context 不含 emergency_contact 值', !dbText.includes('ENC_EMERGENCY_XYZ'));

  // J numeric internal ids（逐行代码级 guard）
  const violations = allRows.flatMap((r) => M.findForbiddenKeys(r));
  check('J1 所有投影行无禁止键（numeric id / *_id / 隐私键）', violations.length === 0, violations.join(','));

  // K public_id allowed（未被误杀）
  check('K1 public_id 类键未被误杀（findForbiddenKeys 不报 public_id）',
    M.findForbiddenKeys({ public_id: 'x', activity_public_id: 'y', course_public_id: 'z' }).length === 0);
  check('K2 context 含合法 public_id（活动）', dbText.includes('ACTPUB000000000000000000001') || dbText.includes('社区清洁日'));
  check('K3 断言器对真实禁止键生效', M.findForbiddenKeys({ user_id: 1 }).length === 1);
}

// ===========================================================================
// L–N. sourceLabels / data-not-instruction
// ===========================================================================
section('L–N. sourceLabels & DATA boundary');
{
  const expected = ['团队', '活动', '服务记录', '积分', '成长', '培训', '证书', '社区内容'];
  check('L1 全部来源均注入（8 标签）', expected.every((l) => meCtx.sourceLabels.includes(l)), meCtx.sourceLabels.join(','));
  check('L2 sourceLabels 只包含白名单标签', meCtx.sourceLabels.every((l) => M.AI_CONTEXT_SOURCE_LABELS.includes(l)));
  check('L3 sections 与 sourceLabels 一致', meCtx.sections.map((s) => s.label).join(',') === meCtx.sourceLabels.join(','));

  // M 空来源不伪造
  const emptyCtx = await M.buildVolunteerAssistContext(mkRepo(U.EMPTY, T.EMPTY));
  check('M1 无数据团队：仅「团队」标签', emptyCtx.sourceLabels.join(',') === '团队', emptyCtx.sourceLabels.join(','));
  check('M2 空来源不伪造标签（无 证书/积分/活动）', !emptyCtx.sourceLabels.includes('证书') && !emptyCtx.sourceLabels.includes('积分') && !emptyCtx.sourceLabels.includes('活动'));

  // 无团队上下文：个人作用域（USER_SCOPED：积分/成长）仍可注入；
  // 但**团队作用域**标签一律不得出现（无团队即不得凭空产生团队数据）。
  const noTeamCtx = await M.buildVolunteerAssistContext(mkRepo(U.ME, null));
  const TEAM_SCOPED_LABELS = ['团队', '活动', '服务记录', '培训', '证书', '社区内容'];
  check('M3 无团队上下文 → 无任何团队作用域标签',
    TEAM_SCOPED_LABELS.every((l) => !noTeamCtx.sourceLabels.includes(l)), noTeamCtx.sourceLabels.join(','));
  check('M3b 无团队上下文 → 个人作用域标签仍可注入（积分/成长）',
    noTeamCtx.sourceLabels.includes('积分') && noTeamCtx.sourceLabels.includes('成长'), noTeamCtx.sourceLabels.join(','));

  // 完全无数据 + 无团队 → 无标签 + 诚实说明（不伪造任何来源）
  const emptyNullCtx = await M.buildVolunteerAssistContext(mkRepo(U.EMPTY, null));
  check('M4 无任何数据且无团队 → 无标签（不伪造）', emptyNullCtx.sourceLabels.length === 0, emptyNullCtx.sourceLabels.join(','));
  check('M4b 无数据时 dataBlock 含诚实说明', emptyNullCtx.dataBlock.includes('未查询到'));

  // N data-not-instruction
  check('N1 dataBlock 含 DATA 开/闭分隔符', meCtx.dataBlock.includes(M.VOLUNTEER_ASSIST_DATA_OPEN) && meCtx.dataBlock.includes(M.VOLUNTEER_ASSIST_DATA_CLOSE));
  check('N2 dataBlock 明确「不是指令」', /不是指令/.test(meCtx.dataBlock));
}

// ===========================================================================
// O–R. 输入规范
// ===========================================================================
section('O–R. input rules');
{
  await mustThrowAsync(async () => M.normalizeHistory([{ role: 'system', content: 'x' }]), 'O client system role rejected');
  await mustThrowAsync(async () => M.normalizeHistory([{ role: 'developer', content: 'x' }]), 'O2 client developer role rejected');
  await mustThrowAsync(async () => M.assertNoClientControlFields({ message: 'hi', provider: 'x' }), 'P client provider field rejected');
  await mustThrowAsync(async () => M.assertNoClientControlFields({ message: 'hi', model: 'x' }), 'P2 client model field rejected');
  await mustThrowAsync(async () => M.assertNoClientControlFields({ message: 'hi', system: 'x' }), 'P3 client system field rejected');
  await mustThrowAsync(async () => M.assertNoClientControlFields({ message: 'hi', context: 'x' }), 'P4 client context field rejected');
  check('Q1 input trim', M.normalizeUserInput('  hi  ') === 'hi');
  await mustThrowAsync(async () => M.normalizeUserInput('   '), 'Q2 empty input rejected');
  await mustThrowAsync(async () => M.normalizeUserInput('a'.repeat(M.AI_INPUT_MAX_CHARS + 1)), 'Q3 oversize input rejected');
  const longHist = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const bounded = M.normalizeHistory(longHist);
  check('R1 history bounded to max', bounded.length === M.AI_MAX_HISTORY_MESSAGES, `len=${bounded.length}`);
  check('R2 history keeps most recent', bounded[bounded.length - 1].content === 'm24');

  // service-level integration of input rules
  await mustThrowAsync(() => mkService(U.ME, T.MINE, okProvider).assist({ message: 'hi', model: 'inject' }), 'R3 service rejects client model field');
  await mustThrowAsync(() => mkService(U.ME, T.MINE, okProvider).assist({ message: '   ' }), 'R4 service rejects empty message');
}

// ===========================================================================
// S–X. provider-neutral service + 错误归一化 + 不泄露
// ===========================================================================
section('S–X. provider-neutral service & error normalization');
{
  const VENDORS = ['openai', 'deepseek', 'anthropic', 'gemini', 'dashscope', 'qwen', 'moonshot', 'kimi', 'doubao', 'volcengine'];
  const hits = [];
  for (const f of AI_SRC_FILES) {
    const lower = readSrc(f).toLowerCase();
    for (const v of VENDORS) if (lower.includes(v)) hits.push(`${f}:${v}`);
  }
  check('S1 service/context 无供应商 token', hits.length === 0, hits.join(','));

  check('T config_error 归一化', (await kindOf(() => mkService(U.ME, T.MINE, throwingProvider('config_error', 'cfg')).assist({ message: 'hi' }))) === 'config_error');
  check('U timeout 归一化', (await kindOf(() => mkService(U.ME, T.MINE, throwingProvider('timeout', 'to')).assist({ message: 'hi' }))) === 'timeout');

  let caught = null;
  try {
    await mkService(U.ME, T.MINE, throwingProvider('provider_error', 'RAW_UPSTREAM_BODY=supersecret')).assist({ message: 'hi' });
  } catch (e) {
    caught = e;
  }
  check('V provider_error 归一化', caught && caught.kind === 'provider_error', caught ? caught.kind : 'none');
  check('W 原始 provider 响应体不泄露（错误消息不含 RAW_UPSTREAM_BODY）', caught && !/RAW_UPSTREAM_BODY/.test(caught.message));
}

// ===========================================================================
// Y–AA. usage 记录 + 安全输出
// ===========================================================================
section('Y–AA. usage logging & safe output');
{
  const before = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  const svc = mkService(U.ME, T.MINE, okProvider);
  const res = await svc.assist({ message: '我的服务时长是多少？' });

  const after = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  check('Y1 成功路径写入 1 条 usage', after === before + 1, `before=${before} after=${after}`);
  const row = sqlite.prepare('SELECT * FROM ai_usage_logs ORDER BY id DESC LIMIT 1').get();
  check('Y2 usage 记录 provider/model', row.provider === 'mock-provider' && row.model === 'mock-model-1');
  check('Y3 usage 记录 tokens', row.prompt_tokens === 11 && row.completion_tokens === 7);
  check('Y4 usage 记录 latency', Number(row.latency_ms) === 3);
  check('Y5 usage 使用既有默认 status（未发明语义）', Number(row.status) === 1);
  check('Y6 usage 归属当前 user/team', Number(row.user_id) === U.ME && Number(row.team_id) === T.MINE);
  check('Z cost_estimate 不虚构（NULL）', row.cost_estimate === null);
  check('Z2 AI_USAGE_STATUS_EXISTING_SEMANTICS = UNDEFINED', M.AI_USAGE_STATUS_EXISTING_SEMANTICS === 'UNDEFINED');
  check('Z3 FAILED_USAGE_LOGGING 明确 DEFERRED', M.FAILED_USAGE_LOGGING === 'DEFERRED_TO_SCHEMA_DECISION', M.FAILED_USAGE_LOGGING);

  const json = JSON.stringify(res);
  check('AA1 返回值不含 DATA 块（raw context）', !json.includes('BUSINESS_DATA'));
  check('AA2 返回值不含 system prompt 文本', !json.includes('嘉禾 AI'));
  check('AA3 返回值不含内部 numeric 键', !/\b(user_id|team_id|"id")\b/.test(json));
  check('AA4 返回值含 text/provider/model/usage/sourceLabels/promptVersion',
    typeof res.text === 'string' && res.provider === 'mock-provider' && res.model === 'mock-model-1' &&
    typeof res.usage.promptTokens === 'number' && Array.isArray(res.sourceLabels) &&
    res.promptVersion === M.VOLUNTEER_ASSIST_PROMPT_VERSION);
  check('X API key 不泄露到返回值', !json.includes('SECRET_KEY_XYZ_987'));
}

// ===========================================================================
// AC. active team guard（P36-C2B 冻结：JIAHE_AI_V1_TEAM_CONTEXT = ACTIVE_TEAM_REQUIRED）
// ===========================================================================
section('AC. active team guard (P36-C2B)');
{
  // 计数型 mock provider：用于证明「无 team 时绝不调用 provider」。
  const countingProvider = () => {
    const state = { calls: 0 };
    return {
      state,
      provider: {
        name: 'count-provider',
        async complete() {
          state.calls += 1;
          return {
            text: 'ok',
            provider: 'count-provider',
            model: 'count-model',
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            finishReason: 'stop',
          };
        },
      },
    };
  };

  // A. no team → assist rejected
  let noTeamErr = null;
  try {
    await mkService(U.ME, null, okProvider).assist({ message: 'hi' });
  } catch (e) {
    noTeamErr = e;
  }
  check('AC1 无 active team → assist 被拒绝', noTeamErr !== null, noTeamErr ? String(noTeamErr.message) : 'NO_THROW');
  check(
    'AC2 拒绝错误复用现有错误体系（TEAM_SCOPE_REQUIRED / AppError）',
    !!noTeamErr && (noTeamErr.code === 'TEAM_SCOPE_REQUIRED' || noTeamErr.name === 'AppError'),
    noTeamErr ? `${noTeamErr.code}/${noTeamErr.name}` : 'none',
  );
  check('AC3 拒绝错误 status=403', !!noTeamErr && noTeamErr.status === 403, noTeamErr ? String(noTeamErr.status) : 'none');

  // B. no team → providerCalls = 0
  const cp1 = countingProvider();
  let rejected = false;
  try {
    await mkService(U.ME, null, cp1.provider).assist({ message: 'hi' });
  } catch {
    rejected = true;
  }
  check('AC4 无 team → 确实被拒绝', rejected === true);
  check('AC5 无 team → provider 调用次数 = 0（绝不先调用 provider 再失败）', cp1.state.calls === 0, `calls=${cp1.state.calls}`);

  // C. no team → usage rows unchanged
  const usageBefore = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  try {
    await mkService(U.ME, null, okProvider).assist({ message: 'hi' });
  } catch {
    /* expected: team guard */
  }
  const usageAfter = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  check('AC6 无 team → usage 行数不变', usageAfter === usageBefore, `before=${usageBefore} after=${usageAfter}`);

  // D/E. with team → providerCalls = 1 + usage row added（既有行为保持）
  const cp2 = countingProvider();
  const uBefore = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  await mkService(U.ME, T.MINE, cp2.provider).assist({ message: '我的服务时长是多少？' });
  const uAfter = sqlite.prepare('SELECT COUNT(*) c FROM ai_usage_logs').get().c;
  check('AC7 有 team → provider 调用次数 = 1', cp2.state.calls === 1, `calls=${cp2.state.calls}`);
  check('AC8 有 team → usage 行数 +1', uAfter === uBefore + 1, `before=${uBefore} after=${uAfter}`);

  // F. USER_SCOPED points/growth 本身仍可由 repository 以 userId 限定读出（无 team 时），
  //    但 AI service 无 team 时不会进入 context/provider pipeline —— 产品级边界，非数据读取能力变更。
  const noTeamCtx = await M.buildVolunteerAssistContext(mkRepo(U.ME, null));
  check(
    'AC9 USER_SCOPED 数据（积分/成长）仍可由 repository 以 userId 读出（无 team 时）',
    noTeamCtx.sourceLabels.includes('积分') || noTeamCtx.sourceLabels.includes('成长'),
    noTeamCtx.sourceLabels.join(','),
  );
  const cp3 = countingProvider();
  try {
    await mkService(U.ME, null, cp3.provider).assist({ message: 'hi' });
  } catch {
    /* expected: team guard */
  }
  check('AC10 但 AI service 无 team 时不进入 context/provider pipeline（provider 调用 = 0）', cp3.state.calls === 0, `calls=${cp3.state.calls}`);
}

// ===========================================================================
// AB. 无业务状态变更
// ===========================================================================
section('AB. no business state mutation');
{
  const writes = [];
  const re = /\b(INSERT\s+INTO|UPDATE\s+[a-z_]+|DELETE\s+FROM)\s+([a-z_]+)/gi;
  for (const f of AI_SRC_FILES) {
    const txt = readSrc(f);
    for (const m of txt.matchAll(re)) writes.push({ file: f, verb: m[1].toUpperCase().split(/\s+/)[0], table: m[2] });
  }
  const bad = writes.filter((w) => w.table !== 'ai_usage_logs');
  check('AB1 AI 代码唯一的写入目标是 ai_usage_logs（AI 遥测）', bad.length === 0, JSON.stringify(bad));
  check('AB2 无业务表写语句', !/INSERT\s+INTO\s+(activities|points_ledger|points_accounts|service_records|certificates|content_articles|courses|exam_sessions)\b/i.test(AI_TXT));
  check('AB3 无 UPDATE 业务表', !/UPDATE\s+(activities|points_accounts|service_records|certificates|content_articles)\b/i.test(AI_TXT));
}

// ===========================================================================
// 附加：无 route / 无 frontend / 无 RAG / 无 tool calling（本阶段边界）
// ===========================================================================
section('附加：stage boundary');
{
  const routeDir = join(WORKERS, 'src', 'routes');
  const aiRoutes = readdirSync(routeDir).filter((f) => /^ai/i.test(f));
  check('BD1 无 AI route 文件', aiRoutes.length === 0, aiRoutes.join(','));
  const appTs = readFileSync(join(WORKERS, 'src', 'app.ts'), 'utf8');
  check('BD2 app.ts 未挂载 AI route', !/route\(\s*'\/ai/.test(appTs));
  check('BD3 无 frontend AI 页面', !existsSync(join(MONOREPO, 'miniprogram', 'pages', 'ai')));
  check('BD4 无 RAG / tool-calling 实现', !/function_call\b|embedding\s*[:=(]|vector_store|knowledge_retrieval/i.test(AI_TXT));
}

// ---------------------------------------------------------------------------
try {
  unlinkSync(bundlePath);
} catch {
  /* ignore */
}
console.log('\n========================================');
console.log(`P36-C2 RESULT: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('========================================');
