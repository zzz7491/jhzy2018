/**
 * P36-C1 — 嘉禾 AI V1 Foundation CONTRACT TEST
 *
 * 目的：验证 P36-C1 的六项交付在「完整当前迁移链」与「真实源码打包」上成立：
 *   1. 0029 AI schema foundation（ai_conversations 收口重建 + ai_usage_logs 索引）
 *   2. Workers AI config/env contract（provider-neutral，secret 隔离，安全默认 + 钳制）
 *   3. provider-neutral interface（不依赖任何供应商 SDK / 类型）
 *   4. 一个最小 provider adapter（标准 HTTP chat-completions 契约，可 mock fetch）
 *   5. versioned volunteer_assist system prompt
 *   6. 基础层不含 context builder / routes / frontend / RAG / Agent / tool calling
 *
 * 覆盖：任务 §11 A–T。
 *
 * 纯契约测试：不驱动任何 route / service workflow；不调用任何真实外部 AI API；
 * 不修改源码 / 迁移 / 历史 WIP；不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：
 *   node tests/p36_c1_ai_foundation.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const WORKERS = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(WORKERS, 'migrations');
const AI_MIGRATION = '0029_p36_ai_foundation.sql';
const MONOREPO = dirname(WORKERS); // E:\D盘备份\miniprogram

// ---------------------------------------------------------------------------
// 断言基础设施
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    failures.push(msg);
    console.log('  ✗ FAIL: ' + msg);
  }
}
function section(name) {
  console.log('\n=== ' + name + ' ===');
}
function mustThrow(fn, label) {
  try {
    fn();
    fail++;
    failures.push(label + ' (expected throw, but succeeded)');
    console.log('  ✗ FAIL: ' + label + ' (expected throw, but succeeded)');
  } catch {
    pass++;
    console.log('  ✓ ' + label);
  }
}
function mustSucceed(fn, label) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + label);
  } catch (e) {
    fail++;
    failures.push(label + ' -> ' + e.message);
    console.log('  ✗ FAIL: ' + label + ' -> ' + e.message);
  }
}

function freshSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;'); // 与项目既有离线测试一致
  return sqlite;
}
function applyAllMigrations(sqlite) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  return files;
}

// ---------------------------------------------------------------------------
// 主流程 —— 第 1 部分：SCHEMA
// ---------------------------------------------------------------------------
const sqlite = freshSqlite();
const applied = applyAllMigrations(sqlite);
console.log(`[setup] applied ${applied.length} migrations (latest: ${applied[applied.length - 1]})`);

let __u = 0;
function insConv(over = {}) {
  const r = {
    public_id: 'PUBX' + ++__u,
    user_id: 1,
    team_id: 1,
    capability: 'volunteer_assist',
    status: 1,
    ...over,
  };
  sqlite
    .prepare(
      `INSERT INTO ai_conversations
        (user_id, team_id, public_id, capability, provider, model, messages, tool_calls, title,
         prompt_tokens, completion_tokens, latency_ms, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(r.user_id, r.team_id, r.public_id, r.capability, null, null, null, null, null, 0, 0, 0, r.status, 1000, 1000);
  return r;
}

// A. 0029 migration 存在 + 落在完整链上
section('A. 0029 migration exists & applies');
assert(existsSync(join(MIGRATIONS_DIR, AI_MIGRATION)), 'A 0029_p36_ai_foundation.sql exists');
assert(applied.includes(AI_MIGRATION), 'A 0029 is part of the applied migration chain');
{
  const f0030 = '0030_analytics_index.sql';
  const has0030 = applied.includes(f0030);
  let ok0030 = has0030 && applied[applied.length - 1] === f0030;
  if (has0030) {
    const sql0030 = readFileSync(join(MIGRATIONS_DIR, f0030), 'utf8');
    ok0030 =
      ok0030 &&
      !/CREATE TABLE|ALTER TABLE|ADD COLUMN/i.test(sql0030) &&
      /idx_tm_team\s+ON\s+team_members\s*\(\s*team_id\s*,\s*join_status\s*\)/i.test(sql0030) &&
      !/ai_conversations|ai_usage_logs/i.test(sql0030);
  }
  assert(
    ok0030,
    'A 0030_analytics_index.sql is the latest migration and is strictly an analytics index (no table/column/alter, no P36 AI schema touch)',
  );
}
{
  let reapplied = true;
  try {
    applyAllMigrations(freshSqlite());
  } catch (e) {
    reapplied = false;
    failures.push('A reapply: ' + e.message);
  }
  assert(reapplied, 'A migration chain (incl. 0029) re-applies cleanly on a fresh DB');
}

// B. conversation public_id contract（存在 + NOT NULL）
section('B. ai_conversations.public_id NOT NULL contract');
{
  const cols = sqlite.prepare("PRAGMA table_info('ai_conversations')").all();
  const pid = cols.find((c) => c.name === 'public_id');
  assert(!!pid, 'B public_id column exists');
  assert(pid && pid.notnull === 1, 'B public_id is NOT NULL (notnull=1)');
  assert(cols.some((c) => c.name === 'id' && c.pk === 1), 'B numeric id remains internal PRIMARY KEY');
  mustSucceed(() => insConv(), 'B insert with public_id succeeds');
}

// C. public_id UNIQUE
section('C. public_id UNIQUE');
{
  const a = insConv({ public_id: 'DUP_PUBLIC_ID_1' });
  mustThrow(
    () => insConv({ public_id: 'DUP_PUBLIC_ID_1' }),
    'C duplicate public_id rejected (UNIQUE)',
  );
  const uniq = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_aic_public_id'")
    .get();
  assert(!!uniq, 'C unique index idx_aic_public_id exists');
  assert(a.public_id === 'DUP_PUBLIC_ID_1', 'C first insert persisted');
}

// D. updated_at / title 存在
section('D. updated_at + title columns exist');
{
  const cols = sqlite.prepare("PRAGMA table_info('ai_conversations')").all().map((c) => c.name);
  assert(cols.includes('updated_at'), 'D updated_at exists');
  assert(cols.includes('title'), 'D title exists');
  // updated_at / title 可空（既有行迁移时以 NULL 落位）
  const info = sqlite.prepare("PRAGMA table_info('ai_conversations')").all();
  assert(info.find((c) => c.name === 'updated_at').notnull === 0, 'D updated_at is nullable');
  assert(info.find((c) => c.name === 'title').notnull === 0, 'D title is nullable');
}

// E. conversation history index (user_id, updated_at)
section('E. conversation history index');
{
  const idx = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_aic_user_updated'")
    .get();
  assert(!!idx, 'E idx_aic_user_updated exists');
  const info = sqlite.prepare("PRAGMA index_info('idx_aic_user_updated')").all().map((c) => c.name);
  assert(
    info.length === 2 && info[0] === 'user_id' && info[1] === 'updated_at',
    `E index columns = (user_id, updated_at) (got ${info.join(',')})`,
  );
}

// F. usage user/time index
section('F. ai_usage_logs (user_id, created_at) index');
{
  const idx = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_aul_user_created'")
    .get();
  assert(!!idx, 'F idx_aul_user_created exists');
  const info = sqlite.prepare("PRAGMA index_info('idx_aul_user_created')").all().map((c) => c.name);
  assert(
    info.length === 2 && info[0] === 'user_id' && info[1] === 'created_at',
    `F index columns = (user_id, created_at) (got ${info.join(',')})`,
  );
}

// G. capability CHECK 未被破坏（6 枚举）
section('G. capability CHECK preserved (6 values)');
{
  const SIX = ['volunteer_assist', 'growth', 'learning', 'policy', 'activity_copy', 'analytics'];
  for (const cap of SIX) mustSucceed(() => insConv({ capability: cap }), `G capability '${cap}' accepted`);
  mustThrow(() => insConv({ capability: 'bogus' }), 'G invalid capability rejected');
}

// H. status CHECK 未被无证据修改（仍为 1,2,3）
section('H. status CHECK preserved (1,2,3)');
{
  mustThrow(() => insConv({ status: 4 }), 'H status=4 rejected');
  mustThrow(() => insConv({ status: 0 }), 'H status=0 rejected');
  for (const s of [1, 2, 3]) mustSucceed(() => insConv({ status: s }), `H status=${s} accepted`);
  // default = 1
  const row = {
    user_id: 1,
    team_id: 1,
    public_id: 'PUBDEF' + ++__u,
    capability: 'volunteer_assist',
  };
  sqlite
    .prepare(
      `INSERT INTO ai_conversations (user_id, team_id, public_id, capability, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(row.user_id, row.team_id, row.public_id, row.capability, 1000);
  const got = sqlite.prepare('SELECT status FROM ai_conversations WHERE public_id=?').get(row.public_id);
  assert(got && got.status === 1, 'H default status = 1');
}

// I. generateUlid 复用（不新增第二套 ID generator）
section('I. generateUlid reuse');
{
  const crypto = readFileSync(join(WORKERS, 'src', 'utils', 'crypto.ts'), 'utf8');
  assert(/export function generateUlid\s*\(/.test(crypto), 'I generateUlid defined in src/utils/crypto.ts');
  const aiFiles = listAiSourceFiles();
  const extraGen = aiFiles.filter((f) => /export function (generate|new).*[Ii]d\s*\(/.test(readFileSync(join(WORKERS, f), 'utf8')));
  assert(extraGen.length === 0, `I no new ID generator in AI foundation (found: ${extraGen.join(',') || 'none'})`);
}

// 迁移静态检查（不新增无关表 / 不改 RBAC / 不动其它表 DDL）
section('I/J. migration static checks');
{
  const sql = readFileSync(join(MIGRATIONS_DIR, AI_MIGRATION), 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)].map((m) => m[1]);
  const expected = ['ai_conversations_new'];
  assert(
    tables.length === expected.length && expected.every((t) => tables.includes(t)),
    `I 0029 creates exactly one table (ai_conversations_new) → got [${tables.join(',')}]`,
  );
  for (const forbidden of ['provider', 'model', 'prompt', 'message', 'knowledge', 'vector', 'quota']) {
    assert(
      !new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${forbidden}[a-z_]*`, 'i').test(sql),
      `I no new '${forbidden}*' table`,
    );
  }
  assert(!/INSERT\s+INTO\s+permissions/i.test(sql), 'J no INSERT INTO permissions');
  assert(!/INSERT\s+INTO\s+role_permissions/i.test(sql), 'J no INSERT INTO role_permissions');
  assert(/capability IN \('volunteer_assist','growth','learning','policy','activity_copy','analytics'\)/.test(sql),
    'J capability CHECK with 6 values preserved in 0029');
  assert(/status\s+INTEGER NOT NULL DEFAULT 1 CHECK \(status IN \(1,2,3\)\)/.test(sql),
    'J status CHECK (1,2,3) preserved in 0029');
  assert(!/CREATE TABLE IF NOT EXISTS\s+ai_usage_logs_new/i.test(sql), 'J ai_usage_logs is NOT rebuilt (index-only)');
}

// ---------------------------------------------------------------------------
// 第 2 部分：RUNTIME（真实源码打包）
// ---------------------------------------------------------------------------
function listAiSourceFiles() {
  const out = [];
  for (const rel of [
    'src/config/ai.ts',
    'src/services/ai/index.ts',
    'src/services/ai/provider.ts',
    'src/services/ai/http-chat-provider.ts',
    'src/services/ai/factory.ts',
    'src/services/ai/prompts/volunteer-assist.v1.ts',
  ]) {
    if (existsSync(join(WORKERS, rel))) out.push(rel);
  }
  return out;
}

const ENTRY = `
export { resolveAIConfig, AI_DEFAULTS, AI_RATE_LIMIT_SEMANTICS } from './src/config/ai';
export { HttpChatProvider } from './src/services/ai/http-chat-provider';
export { AIProviderError } from './src/services/ai/provider';
export { createAIProvider } from './src/services/ai/factory';
export {
  VOLUNTEER_ASSIST_PROMPT_VERSION,
  VOLUNTEER_ASSIST_SYSTEM_PROMPT,
  VOLUNTEER_ASSIST_DATA_OPEN,
  VOLUNTEER_ASSIST_DATA_CLOSE,
} from './src/services/ai/prompts/volunteer-assist.v1';
export { generateUlid } from './src/utils/crypto';
`;

const entryPath = join(WORKERS, '.p36_c1_bundle_entry.ts');
writeFileSync(entryPath, ENTRY);
const bundlePath = join(tmpdir(), `p36_c1_${Date.now()}.mjs`);
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

// helpers for runtime
function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    },
  };
}
async function kindOf(fn) {
  try {
    await fn();
    return 'NO_THROW';
  } catch (e) {
    if (e && typeof e.kind === 'string') return e.kind;
    return 'THROW:' + (e && e.name);
  }
}
const REQ = { system: 'SYS', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 64, timeoutMs: 1000 };

// J. AIProvider 不依赖具体供应商 SDK
section('J. provider-neutral interface (no vendor SDK)');
{
  const VENDORS = [
    'openai', 'deepseek', 'anthropic', 'gemini', 'dashscope', 'qwen',
    'moonshot', 'kimi', 'doubao', 'volcengine', 'azure', 'mistral', 'cohere', 'groq',
  ];
  const files = listAiSourceFiles();
  const hits = [];
  for (const f of files) {
    const txt = readFileSync(join(WORKERS, f), 'utf8');
    const lower = txt.toLowerCase();
    for (const v of VENDORS) if (lower.includes(v)) hits.push(`${f}:${v}`);
    // imports must be relative only (no vendor SDK package)
    const specs = [...txt.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) if (!s.startsWith('.')) hits.push(`${f}:import(${s})`);
  }
  assert(hits.length === 0, `J no vendor token / non-relative import in AI foundation (hits: ${hits.join(', ') || 'none'})`);
  assert(/export interface AIProvider\b/.test(readFileSync(join(WORKERS, 'src/services/ai/provider.ts'), 'utf8')),
    'J provider.ts exports AIProvider interface');
}

// K. adapter endpoint/key/model 来自 config（非硬编码）
section('K. adapter endpoint/model/credential come from config');
{
  const envCfg = {
    AI_PROVIDER: 'cfg-provider',
    AI_MODEL: 'cfg-model-9',
    AI_BASE_URL: 'https://cfg.example.invalid/v1/',
    AI_API_KEY: 'CFG-KEY-NOT-REAL',
  };
  let cap = null;
  const mockOk = async (url, init) => {
    cap = { url, init };
    return jsonResponse(200, {
      choices: [{ message: { content: 'ok-text' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
  };
  const provider = M.createAIProvider(envCfg, mockOk);
  const out = await provider.complete(REQ); // M: mockable + parse
  const body = JSON.parse(cap.init.body);
  assert(cap.url === 'https://cfg.example.invalid/v1/chat/completions', `K endpoint from config (got ${cap.url})`);
  assert(cap.init.headers.authorization === 'Bearer CFG-KEY-NOT-REAL', 'K credential from config (Authorization header)');
  assert(body.model === 'cfg-model-9', `K model from config (got ${body.model})`);
  assert(out.provider === 'cfg-provider' && out.model === 'cfg-model-9', 'K result carries provider/model execution record');
  // M: response parsing / normalization
  assert(out.text === 'ok-text', 'M parsed text');
  assert(out.promptTokens === 3 && out.completionTokens === 5, 'M parsed token usage');
  assert(out.finishReason === 'stop', 'M normalized finish_reason=stop');
  assert(typeof out.latencyMs === 'number' && out.latencyMs >= 0, 'M latencyMs present');
  assert(body.stream === false, 'M non-streaming request (V1 frozen non-streaming)');
  assert(/system/i.test(body.messages[0].role) || body.messages[0].role === 'system', 'M system prompt carried as first message');
}

// L. 无真实 secret / 安全默认
section('L. no real secret + safe defaults');
{
  const files = listAiSourceFiles();
  const leak = files.filter((f) => /sk-[A-Za-z0-9]{8,}/.test(readFileSync(join(WORKERS, f), 'utf8')));
  assert(leak.length === 0, `L no key-like literal (sk-...) in AI foundation (found: ${leak.join(',') || 'none'})`);
  const empty = M.resolveAIConfig({});
  assert(empty.apiKey === '' && empty.model === '' && empty.baseUrl === '', 'L empty env → no seeded credential/model/endpoint');
  assert(empty.configured === false, 'L empty env → configured=false');
  assert(M.AI_DEFAULTS.model === '' && M.AI_DEFAULTS.baseUrl === '', 'L defaults carry NO vendor model/endpoint');
  const partial = M.resolveAIConfig({ AI_API_KEY: 'K', AI_MODEL: 'm' });
  assert(partial.configured === false, 'L missing baseUrl → configured=false (no false "ready")');
  // 配置未就绪时 adapter 拒绝（config_error），绝不发出请求
  const cfgKind = await kindOf(async () => M.createAIProvider({}, async () => { throw new Error('should-not-call'); }));
  assert(cfgKind === 'config_error', `L unconfigured provider → config_error (got ${cfgKind})`);
}

// N. provider error 归一化
section('N. provider error normalized');
{
  const mk = (impl) =>
    new M.HttpChatProvider({ name: 'n', baseUrl: 'https://x.invalid/v1', apiKey: 'k', model: 'm' }, impl);
  const httpErr = mk(async () => jsonResponse(429, { error: 'rate limited upstream' }));
  assert((await kindOf(() => httpErr.complete(REQ))) === 'provider_error', 'N non-2xx → provider_error kind');
  let caught = null;
  try {
    await httpErr.complete(REQ);
  } catch (e) {
    caught = e;
  }
  assert(caught && caught.status === 429, 'N upstream status preserved (429) for logging');
  assert(caught && !/rate limited upstream/.test(caught.message), 'N upstream body NOT leaked in error message');
  const malformed = mk(async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('bad json');
    },
  }));
  assert((await kindOf(() => malformed.complete(REQ))) === 'provider_error', 'N malformed JSON → provider_error');
  const noContent = mk(async () => jsonResponse(200, { choices: [{ message: {}, finish_reason: 'stop' }] }));
  assert((await kindOf(() => noContent.complete(REQ))) === 'provider_error', 'N missing content → provider_error');
}

// O. timeout 归一化
section('O. timeout normalized');
{
  const pending = new M.HttpChatProvider(
    { name: 'n', baseUrl: 'https://x.invalid/v1', apiKey: 'k', model: 'm' },
    (url, init) =>
      new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      }),
  );
  const kind = await kindOf(() => pending.complete({ ...REQ, timeoutMs: 5 }));
  assert(kind === 'timeout', `O abort on timeout → timeout kind (got ${kind})`);
  const directAbort = new M.HttpChatProvider(
    { name: 'n', baseUrl: 'https://x.invalid/v1', apiKey: 'k', model: 'm' },
    async () => {
      const e = new Error('abort');
      e.name = 'AbortError';
      throw e;
    },
  );
  assert((await kindOf(() => directAbort.complete(REQ))) === 'timeout', 'O AbortError rejection → timeout kind');
}

// P/Q/R. versioned prompt
section('P/Q/R. versioned volunteer_assist prompt');
{
  assert(M.VOLUNTEER_ASSIST_PROMPT_VERSION === 'volunteer_assist.v1',
    `P prompt version fixed (got ${M.VOLUNTEER_ASSIST_PROMPT_VERSION})`);
  const p = M.VOLUNTEER_ASSIST_SYSTEM_PROMPT;
  const Q = ['嘉禾 AI', '业务智能助手', '只能依据服务端', '无法确认', '不得猜测', '不得编造', '服务时长', '积分', '证书', '活动状态', '只读', '严禁声称', '内部数字', '未经授权', '中文优先'];
  const qMissing = Q.filter((s) => !p.includes(s));
  assert(qMissing.length === 0, `Q prompt carries read-only + truthfulness boundary (missing: ${qMissing.join('|') || 'none'})`);
  assert(p.includes(M.VOLUNTEER_ASSIST_DATA_OPEN) && p.includes(M.VOLUNTEER_ASSIST_DATA_CLOSE),
    'R prompt defines DATA block delimiters');
  assert(p.includes('数据（DATA）') && p.includes('不是给你的指令'),
    'R prompt states DATA block is data, NOT instruction (injection boundary)');
}

// S. 无 provider/model 用户选择逻辑
section('S. no user-facing provider/model selection');
{
  const routeDir = join(WORKERS, 'src', 'routes');
  const routeFiles = readdirSync(routeDir).filter((f) => f.endsWith('.ts'));
  // P36-C3-2 起：授权存在的 AI route **有且仅有** routes/ai.ts（4 个端点）。
  // 本断言保留初衷（禁止任何超出冻结清单的 AI 端点），只对已授权文件放行。
  const aiRoutes = routeFiles.filter((f) => /^ai/i.test(f) || /ai[-_]?(assistant|chat)/i.test(f));
  assert(
    aiRoutes.length === 1 && aiRoutes[0] === 'ai.ts',
    `S only authorized AI route file (found: ${aiRoutes.join(',') || 'none'})`,
  );
  const appTs = readFileSync(join(WORKERS, 'src', 'app.ts'), 'utf8');
  const aiMounts = [...appTs.matchAll(/route\(\s*'(\/ai[\w-]*)'/g)].map((m) => m[1]);
  assert(
    aiMounts.length === 1 && aiMounts[0] === '/ai',
    `S app.ts mounts exactly one AI route (/ai) (found: ${aiMounts.join(',') || 'none'})`,
  );
  const cfg = readFileSync(join(WORKERS, 'src', 'config', 'ai.ts'), 'utf8');
  assert(/export function resolveAIConfig\(env:\s*Env\)/.test(cfg), 'S config resolved from Env only (no request/model input)');
  const aiTxt = listAiSourceFiles().map((f) => readFileSync(join(WORKERS, f), 'utf8')).join('\n');
  assert(!/req\.body|request\.body|body\.model|body\.provider|body\.temperature/.test(aiTxt),
    'S no client-supplied model/provider/temperature handling');
}

// T. 无 context builder / routes / frontend / RAG / Agent / tool calling
section('T. no context builder / routes / frontend / RAG / agent / tools');
{
  const aiDir = join(WORKERS, 'src', 'services', 'ai');
  const walk = (d) => {
    const out = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  // P36-C3-2 起：`conversation-service` 为授权的 AI 会话编排服务（不含 context builder /
  // retriever / embedding / vector / rag / agent / tool calling）。对授权文件名放行，其余仍禁。
  const aiAll = walk(aiDir).map((f) => f.replace(/\\/g, '/'));
  const forbiddenNames = aiAll
    .filter((f) => !/conversation-service\.ts$/.test(f))
    .filter((f) => /context|builder|retriev|embed|vector|rag|agent|tool|conversation/i.test(f));
  assert(forbiddenNames.length === 0, `T no context builder / RAG / agent / tool files (found: ${forbiddenNames.join(',') || 'none'})`);
  // P36-C4 已合法实现并冻结 AI 前端；C1 不再否定该后续合法阶段，
  // 改为验证「前端存在」这一冻结条件（不复制 C4 测试，保持断言数不变）。
  assert(existsSync(join(MONOREPO, 'miniprogram', 'pages', 'ai', 'index.ts')) && existsSync(join(MONOREPO, 'miniprogram', 'pages', 'ai', 'chat.ts')), 'T AI frontend pages (index/chat) exist (P36-C4 frozen)');
  const appJson = readFileSync(join(MONOREPO, 'miniprogram', 'app.json'), 'utf8');
  assert(/pages\/ai\/index/.test(appJson) && /pages\/ai\/chat/.test(appJson), 'T app.json registers both AI pages (pages/ai/index, pages/ai/chat)');
  // 源码中不得出现 tool-calling / function-calling 实现
  const aiTxt = listAiSourceFiles().map((f) => readFileSync(join(WORKERS, f), 'utf8')).join('\n');
  assert(!/tool_calls\s*:|function_call|tool_choice/.test(aiTxt), 'T no tool/function calling in foundation');
}

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------
try {
  unlinkSync(bundlePath);
} catch {
  /* ignore */
}

console.log('\n========================================');
console.log(`P36-C1 RESULT: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
