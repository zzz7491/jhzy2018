/**
 * P36-C3-1 — 嘉禾 AI V1 Conversation Repository + Rate-Limit Foundation CONTRACT TEST
 *
 * 目的：在「完整当前迁移链」+「真实源码打包」+「真实 D1(sqlite shim)」上验证：
 *   1. conversation 持久化仓库（create / list / get / append）
 *   2. 所有权（public_id + user_id + team_id；跨用户/跨团队 = not found）
 *   3. 消息持久化契约（role/content/source_labels；无 system prompt / raw context / tool_calls）
 *   4. CAS 并发保护（EXPECTED_STORED_MESSAGES；非 updated_at 单锁）
 *   5. best-effort rate-limit foundation（只读 ai_usage_logs；仅 user 维度）
 *
 * 覆盖：任务 §18 A–AR。
 *
 * 纯契约测试：不驱动任何 route；不调用任何真实外部 AI；不修改源码 / 迁移 / 历史 WIP；
 * 不 git add / commit / push。
 *
 * 运行（在 workers/ 目录下）：node tests/p36_c3_1_conversation_rate_limit.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
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
    if (e && typeof e.reason === 'string') return `reason:${e.reason}`;
    if (e && typeof e.name === 'string') return `THROW:${e.name}`;
    return 'THROW';
  }
}
async function mustThrow(fn, label) {
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
const T = { MINE: 10, OTHER: 20 };
const U = { ME: 100, OTHER: 101, RL1: 201, RL2: 202, RL3: 203, RL4: 204 };
function ins(sql, params) {
  sqlite.prepare(sql).run(...params);
}
ins(`INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)`, [T.MINE, 'TEAMMINE0000000000000000001', '嘉禾测试队', U.ME]);
ins(`INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)`, [T.OTHER, 'TEAMOTHER000000000000000002', '别的团队', U.OTHER]);
for (const id of Object.values(U)) ins(`INSERT INTO users (id, public_id) VALUES (?,?)`, [id, `USER${String(id).padStart(22, '0')}`]);

// ---------------------------------------------------------------------------
// Bundle（真实源码）
// ---------------------------------------------------------------------------
const ENTRY = `
export { AIConversationRepository, ConversationContractError, validateStoredMessage, validateStoredMessages, parseStoredMessages, serializeMessages, CONVERSATION_SOURCE_LABELS, CONVERSATION_CAS, AI_CONVERSATION_CAPABILITY } from './src/repository/ai-conversation';
export { AIRateLimitService, AI_RATE_LIMIT_TYPE, AI_RATE_LIMIT_STRICT_CONCURRENCY, AI_RATE_LIMIT_DIMENSION, AI_RATE_LIMIT_MINUTE_WINDOW_SECONDS, AI_RATE_LIMIT_DAY_WINDOW_SECONDS, RATE_LIMIT_FAILED_USAGE_ACCOUNTING } from './src/services/ai/rate-limit';
export { AI_CONTEXT_SOURCE_LABELS } from './src/services/ai/data-block';
export { AI_USAGE_STATUS_EXISTING_SEMANTICS, FAILED_USAGE_LOGGING } from './src/services/ai/usage';
export { AIPrivacyError, FORBIDDEN_CONTEXT_KEYS, findForbiddenKeys, assertNoForbiddenKeys } from './src/utils/ai-privacy';
export { generateUlid } from './src/utils/crypto';
`;
const entryPath = join(WORKERS, '.p36_c3_1_bundle_entry.ts');
writeFileSync(entryPath, ENTRY);
const bundlePath = join(tmpdir(), `p36_c3_1_${Date.now()}.mjs`);
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
  auth: { authenticated: true, userId, role: 'volunteer', teamId, roles: [{ role: 'volunteer', scopeTeamId: teamId }] },
  tenant: { scope: 'TEAM_SCOPED', teamId, userId },
});
const mkRepo = (userId, teamId) => new M.AIConversationRepository({ db: DB, ctx: ctxFor(userId, teamId) });
const mkLimiter = (userId) => new M.AIRateLimitService({ db: DB, auth: { authenticated: true, userId, role: 'volunteer', teamId: T.MINE, roles: [] } });
const ulid = () => M.generateUlid();

const REPO_SRC = 'src/repository/ai-conversation.ts';
const RL_SRC = 'src/services/ai/rate-limit.ts';
const readSrc = (f) => readFileSync(join(WORKERS, f), 'utf8');
const REPO_TXT = readSrc(REPO_SRC);
const RL_TXT = readSrc(RL_SRC);
/** 去注释后只对可执行代码做源码级断言（避免文档说明文字误触发）。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]\/\/[^\n]*/g, '');
const REPO_CODE = stripComments(REPO_TXT);
const RL_CODE = stripComments(RL_TXT);

const NOW = Math.floor(Date.now() / 1000);

// ===========================================================================
// A. create
// ===========================================================================
section('A. create conversation');
const createdPublicId = ulid();
{
  const repo = mkRepo(U.ME, T.MINE);
  const p1 = ulid();
  const res = await repo.createConversation({
    publicId: p1,
    title: '如何报名活动',
    provider: 'mock-provider',
    model: 'mock-model-1',
    userMessage: '怎么报名活动？',
    assistantMessage: '请在活动页点击报名。',
    sourceLabels: ['活动'],
    usage: { promptTokens: 11, completionTokens: 7, latencyMs: 3 },
  });
  check('A1 create 返回输入 public_id', res.public_id === p1);
  const row = sqlite.prepare(`SELECT * FROM ai_conversations WHERE public_id = ?`).get(p1);
  check('A2 create 落库 1 行', row != null);
  check('B1 capability 固定 volunteer_assist', row && row.capability === 'volunteer_assist');
  check('C1 归属 user_id', row && row.user_id === U.ME);
  check('C2 归属 team_id', row && row.team_id === T.MINE);
  check('M1 tool_calls 为 NULL（V1 不启用）', row && row.tool_calls == null);
  check('status 使用 schema DEFAULT(1)（未写 2/3）', row && row.status === 1);
  check('S1 public_id 合法可寻址', (await repo.getConversation(p1)) != null);

  // 消息契约
  const msgs = JSON.parse(row.messages);
  check('K1 messages 仅 role/content/[source_labels]（无 system prompt）', msgs.every((m) => {
    const keys = Object.keys(m).sort().join(',');
    return keys === 'content,role' || keys === 'content,role,source_labels';
  }));
  check('K2 messages 不含 system 角色', msgs.every((m) => m.role === 'user' || m.role === 'assistant'));
  const allText = JSON.stringify(msgs);
  check('L1 未持久化 raw business_data', !allText.includes('business_data') && !allText.includes('<business_data'));
  check('N1 source_labels 仅出现在 assistant', msgs[0].source_labels === undefined && Array.isArray(msgs[1].source_labels));
  check('N2 assistant source_labels 内容正确', msgs[1].source_labels.length === 1 && msgs[1].source_labels[0] === '活动');

  const res2 = await repo.createConversation({
    publicId: createdPublicId,
    title: 't2',
    provider: 'mock-provider',
    model: 'mock-model-1',
    userMessage: 'u2',
    assistantMessage: 'a2',
    sourceLabels: [],
    usage: { promptTokens: 1, completionTokens: 1, latencyMs: 1 },
  });
  check('A3 create 第二次仍返回 public_id', res2.public_id === createdPublicId);
}

// ===========================================================================
// D–F. ownership
// ===========================================================================
section('D–F. ownership');
{
  check('D1 他人 get → not found', (await mkRepo(U.OTHER, T.MINE).getConversation(createdPublicId)) === null);
  check('E1 跨团队 get → not found', (await mkRepo(U.ME, T.OTHER).getConversation(createdPublicId)) === null);
  check('F1 numeric id 不能作为 public 地址', (await mkRepo(U.ME, T.MINE).getConversation('1')) === null);
  const numericRow = sqlite.prepare(`SELECT id FROM ai_conversations WHERE public_id = ?`).get(createdPublicId);
  check('F2 numeric id 不可寻址（用真实 numeric id 亦 null）', (await mkRepo(U.ME, T.MINE).getConversation(String(numericRow.id))) === null);
  await mustThrow(async () => {
    await mkRepo(U.ME, T.MINE).createConversation({
      publicId: '1', title: null, provider: 'p', model: 'm',
      userMessage: 'u', assistantMessage: 'a', sourceLabels: [],
      usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    });
  }, 'F3 create 非 ULID publicId → 拒绝');
}

// ===========================================================================
// G–H. list
// ===========================================================================
section('G–H. list');
{
  const repoME = mkRepo(U.ME, T.MINE);
  const otherTeamUlid = ulid();
  await mkRepo(U.ME, T.OTHER).createConversation({
    publicId: otherTeamUlid, title: 'other-team', provider: 'p', model: 'm',
    userMessage: 'u', assistantMessage: 'a', sourceLabels: [],
    usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  });
  const otherUserUlid = ulid();
  await mkRepo(U.OTHER, T.MINE).createConversation({
    publicId: otherUserUlid, title: 'other-user', provider: 'p', model: 'm',
    userMessage: 'u', assistantMessage: 'a', sourceLabels: [],
    usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  });

  const page = await repoME.listConversations(1, 20, 0);
  const ids = page.items.map((i) => i.public_id);
  check('G1 list 仅含本人+本团队会话', ids.includes(createdPublicId) && !ids.includes(otherTeamUlid) && !ids.includes(otherUserUlid));
  check('G2 pagination 结构正确', page.pagination.page === 1 && page.pagination.page_size === 20 && page.pagination.total >= 2);

  const keys = Object.keys(page.items[0]).sort().join(',');
  check('H1 list 投影仅 public_id/title/updated_at/created_at', keys === 'created_at,public_id,title,updated_at');
  const itemTxt = JSON.stringify(page.items);
  check('H2 list 不含 provider/model/messages/tokens/id', !/provider|model|messages|token|\bid\b/.test(itemTxt));

  const empty = await mkRepo(U.RL1, T.MINE).listConversations(1, 20, 0);
  check('G3 无会话用户 list 为空', empty.items.length === 0);
}

// ===========================================================================
// I. get projection
// ===========================================================================
section('I. get projection');
{
  const detail = await mkRepo(U.ME, T.MINE).getConversation(createdPublicId);
  const keys = Object.keys(detail).sort().join(',');
  check('I1 get 投影仅 public_id/title/messages/created_at/updated_at', keys === 'created_at,messages,public_id,title,updated_at');
  const txt = JSON.stringify(detail);
  check('J1 get 不暴露 provider/model/numeric id/tool_calls/tokens', !/provider|model|tool_calls|prompt_tokens|completion_tokens|\"id\"/.test(txt));
}

// ===========================================================================
// O–R + S2. message validation
// ===========================================================================
section('O–R. message validation');
{
  await mustThrow(() => M.validateStoredMessage({ role: 'system', content: 'x' }), 'O1 malformed role (system) → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'tool', content: 'x' }), 'O2 malformed role (tool) → 拒绝');
  await mustThrow(() => M.validateStoredMessage(null), 'P1 null message → 拒绝');
  await mustThrow(() => M.validateStoredMessage('str'), 'P2 string message → 拒绝');
  await mustThrow(() => M.validateStoredMessage(['x']), 'P3 array message → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user' }), 'P4 缺 content → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', extra: 1 }), 'P5 未知字段 → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', id: 999 }), 'Q1 numeric internal id → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', user_id: 1 }), 'Q2 user_id → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', team_id: 1 }), 'Q3 team_id → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', phone_enc: 'ENC' }), 'R1 PII phone_enc → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', id_card_mask: '1101' }), 'R2 PII id_card_mask → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'assistant', content: 'x', source_labels: ['不存在来源'] }), 'S2 source_labels 非白名单 → 拒绝');
  await mustThrow(() => M.validateStoredMessage({ role: 'user', content: 'x', source_labels: ['活动'] }), 'S3 user 不得携带 source_labels → 拒绝');
  const okMsg = M.validateStoredMessage({ role: 'assistant', content: 'ok', source_labels: ['积分'] });
  check('S4 合法 assistant 消息通过', okMsg.role === 'assistant' && okMsg.source_labels[0] === '积分');
  await mustThrow(() => M.parseStoredMessages('{not json'), 'I2 损坏 JSON → 安全失败（不静默信任）');

  const parity = JSON.stringify(M.CONVERSATION_SOURCE_LABELS) === JSON.stringify(M.AI_CONTEXT_SOURCE_LABELS);
  check('S5 source_labels 白名单与 P36-C2 一致（parity）', parity);
}

// ===========================================================================
// T–Y. append + CAS
// ===========================================================================
section('T–Y. append & CAS');
{
  const repo = mkRepo(U.ME, T.MINE);
  const id = ulid();
  await repo.createConversation({
    publicId: id, title: 'cas', provider: 'p0', model: 'm0',
    userMessage: 'u0', assistantMessage: 'a0', sourceLabels: [],
    usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  });

  // 模拟 service：provider 前读取原文快照
  const snap = await repo.readMessagesForAppend(id);
  check('T0 快照读取成功且原文非空', snap != null && snap.messages.length === 2);

  const r1 = await repo.appendExchange({
    publicId: id, expectedMessagesRaw: snap.messagesRaw,
    userMessage: 'u1', assistantMessage: 'a1', sourceLabels: ['积分'],
    provider: 'p1', model: 'm1', usage: { promptTokens: 5, completionTokens: 3, latencyMs: 2 },
  });
  check('U1 CAS 首次 append changes=1（ok）', r1.ok === true);

  const rowAfter = sqlite.prepare(`SELECT messages, provider, model, latency_ms, status FROM ai_conversations WHERE public_id = ?`).get(id);
  const afterMsgs = JSON.parse(rowAfter.messages);
  check('T1 append 同时追加 user+assistant', afterMsgs.length === 4 && afterMsgs[2].role === 'user' && afterMsgs[3].role === 'assistant');
  check('T2 append 更新 provider/model/latency', rowAfter.provider === 'p1' && rowAfter.model === 'm1' && rowAfter.latency_ms === 2);
  check('T3 append 不改 status（保持既有值）', rowAfter.status === 1);

  // 陈旧期望值 → stale
  const r2 = await repo.appendExchange({
    publicId: id, expectedMessagesRaw: snap.messagesRaw,
    userMessage: 'u2', assistantMessage: 'a2', sourceLabels: [],
    provider: 'p2', model: 'm2', usage: { promptTokens: 1, completionTokens: 1, latencyMs: 1 },
  });
  check('V1 陈旧 expectedMessagesRaw → stale（changes=0）', r2.ok === false && r2.reason === 'stale');

  // 同秒并发：两次都基于同一旧原文，第二次必 stale（与 updated_at 精度无关）
  const snap2 = await repo.readMessagesForAppend(id);
  const [c1, c2] = await Promise.all([
    repo.appendExchange({ publicId: id, expectedMessagesRaw: snap2.messagesRaw, userMessage: 'A', assistantMessage: 'A', sourceLabels: [], provider: 'p', model: 'm', usage: { promptTokens: 1, completionTokens: 1, latencyMs: 1 } }),
    repo.appendExchange({ publicId: id, expectedMessagesRaw: snap2.messagesRaw, userMessage: 'B', assistantMessage: 'B', sourceLabels: [], provider: 'p', model: 'm', usage: { promptTokens: 1, completionTokens: 1, latencyMs: 1 } }),
  ]);
  check('W1 同秒并发仅一次成功', [c1.ok, c2.ok].filter(Boolean).length === 1);

  // 跨用户 append → not_found（不泄露存在性）
  const rOther = await mkRepo(U.OTHER, T.MINE).appendExchange({
    publicId: id, expectedMessagesRaw: snap.messagesRaw,
    userMessage: 'x', assistantMessage: 'y', sourceLabels: [],
    provider: 'p', model: 'm', usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  });
  check('X0 他人 append → not_found', rOther.ok === false && rOther.reason === 'not_found');

  // 源码级 CAS 断言
  const updStart = REPO_CODE.indexOf('UPDATE ai_conversations');
  const updBlock = REPO_CODE.slice(updStart, REPO_CODE.indexOf('`', updStart));
  check('X1 append 谓词含 public_id+user_id+team_id+messages', /WHERE public_id = \? AND user_id = \? AND team_id = \? AND messages IS \?/.test(updBlock));
  check('Y1 CAS 策略 = EXPECTED_STORED_MESSAGES', M.CONVERSATION_CAS === 'EXPECTED_STORED_MESSAGES');
  check('Y2 未使用 updated_at 作为唯一锁', !/AND updated_at = \?/.test(REPO_CODE));
}

// ===========================================================================
// AA–AF. rate limit
// ===========================================================================
section('AA–AF. rate limit');
const LIM = { rateLimitPerMin: 10, rateLimitPerDay: 200 };
{
  const d1 = await mkLimiter(U.RL1).evaluate(LIM);
  check('AA1 minute 低于阈值 → allowed', d1.allowed === true);

  for (let i = 0; i < 10; i++) {
    ins(`INSERT INTO ai_usage_logs (user_id, team_id, provider, model, latency_ms, created_at) VALUES (?,?,?,?,?,?)`, [U.RL2, T.MINE, 'p', 'm', 1, NOW - 30]);
  }
  const d2 = await mkLimiter(U.RL2).evaluate(LIM);
  check('AB1 minute 达阈值 → limited:minute', d2.allowed === false && d2.limited === 'minute');

  for (let i = 0; i < 200; i++) {
    ins(`INSERT INTO ai_usage_logs (user_id, team_id, provider, model, latency_ms, created_at) VALUES (?,?,?,?,?,?)`, [U.RL3, T.MINE, 'p', 'm', 1, NOW - 3600]);
  }
  const d3 = await mkLimiter(U.RL3).evaluate(LIM);
  check('AC1 day 达阈值 → limited:day', d3.allowed === false && d3.limited === 'day');

  check('AE1 minute retryAfterSeconds 合理 (1..60)', d2.allowed === false && d2.retryAfterSeconds >= 1 && d2.retryAfterSeconds <= 60);
  check('AE2 day retryAfterSeconds 合理 (1..86400)', d3.allowed === false && d3.retryAfterSeconds >= 1 && d3.retryAfterSeconds <= 86400);

  const dOther = await mkLimiter(U.RL4).evaluate(LIM);
  check('AF1 limiter 按 user 隔离（他人不受影响）', dOther.allowed === true);
}

// ===========================================================================
// AD, AG–AM. rate limit source contract
// ===========================================================================
section('AD, AG–AM. rate-limit source contract');
{
  check('AD1 rate-limit 无 provider 依赖（不触发 provider）', !/provider|complete\(|fetch\(/.test(RL_CODE));
  const fromTables = [...RL_CODE.matchAll(/\bFROM\s+([a-z_]+)/gi)].map((m) => m[1]);
  check('AG1 limiter 只读 ai_usage_logs', fromTables.length > 0 && fromTables.every((t) => t === 'ai_usage_logs'));
  check('AH1 未加 team 维度', !/team_id/.test(RL_CODE) && M.AI_RATE_LIMIT_DIMENSION === 'user');
  check('AI1 best-effort 语义显式', M.AI_RATE_LIMIT_TYPE === 'BEST_EFFORT_COST_GUARD' && /BEST_EFFORT_COST_GUARD/.test(RL_TXT));
  check('AJ1 未声称 strict concurrency', M.AI_RATE_LIMIT_STRICT_CONCURRENCY === false);
  check('AK1 failed usage accounting = DEFERRED', M.RATE_LIMIT_FAILED_USAGE_ACCOUNTING === 'DEFERRED');
  check('AL1 未发明 ai_usage_logs.status 语义', !/\bstatus\b/.test(RL_CODE) && M.AI_USAGE_STATUS_EXISTING_SEMANTICS === 'UNDEFINED');
  check('AM1 无 KV / DO / Redis / quota table', !/KV|DurableObject|Durable Object|redis|Redis|quota|CREATE TABLE/i.test(RL_CODE));
  const rlWrites = [...RL_CODE.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)].map((m) => m[1]);
  check('AO1 rate limiter 不写任何表', rlWrites.length === 0);
}

// ===========================================================================
// AN, Z, AP–AR. repository / stage contract
// ===========================================================================
section('AN, Z, AP–AR. repository / stage contract');
{
  const repoWrites = [...REPO_CODE.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)].map((m) => m[1]);
  check('AN1 conversation 仓库只写 ai_conversations', repoWrites.length > 0 && repoWrites.every((t) => t === 'ai_conversations'));
  check('AN2 无 CREATE/ALTER/DROP（无 schema 变更）', !/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)\b/i.test(REPO_CODE));
  check('Z1 迁移链最新仍为 0029（无 0030）', migs[migs.length - 1] === '0029_p36_ai_foundation.sql' && !migs.some((f) => f.startsWith('0030')));

  const insertStart = REPO_CODE.indexOf('INSERT INTO ai_conversations');
  const insertBlock = REPO_CODE.slice(insertStart, REPO_CODE.indexOf('VALUES', insertStart));
  check('Z2 create 不主动写 status（用 DEFAULT）', !/\bstatus\b/.test(insertBlock));

  // P36-C3-2 起：HTTP route 由独立 slice 交付；C3-1 仍【不】自带 route（仅确认尚未被本 slice 引入之外的东西）。
  const aiRoutes = readdirSync(join(WORKERS, 'src/routes')).filter((f) => /^ai/i.test(f));
  check('AP1 AI route 文件仅限授权的 ai.ts', aiRoutes.every((f) => f === 'ai.ts') && aiRoutes.length <= 1, aiRoutes.join(','));
  const appMounts = [...readSrc('src/app.ts').matchAll(/route\(\s*'(\/ai[\w-]*)'/g)].map((m) => m[1]);
  check('AP2 app.ts 的 AI 挂载仅限 /ai（本 slice 不挂载）', appMounts.every((p) => p === '/ai'));
  check('AP3 仓库/限流不引 hono/route', !/hono|\.\.\/routes/.test(REPO_CODE) && !/hono|\.\.\/routes/.test(RL_CODE));
  check('AQ1 无 AI 前端页面', !existsSync(join(MONOREPO, 'miniprogram/pages/ai')));
  check('AR1 无真实外部 AI 调用', !/fetch\(|https?:\/\//.test(REPO_CODE) && !/fetch\(|https?:\/\//.test(RL_CODE));
  check('AR2 仓库不依赖 provider/adapter', !/services\/ai\/(provider|http-chat-provider|factory|service)/.test(REPO_CODE));
}

// ===========================================================================
// P36-C3-1A. 分层架构 —— repository 不得依赖 services / privacy guard 单一权威
// ===========================================================================
section('P36-C3-1A. 分层架构 / privacy guard 单一权威定义');
{
  // A / B —— repository/** → services/** imports = 0（程序化扫描全部仓库文件）
  const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
  const REPO_DIR = 'src/repository';
  const repoFiles = readdirSync(join(WORKERS, REPO_DIR)).filter((f) => f.endsWith('.ts'));
  const svcImports = [];
  for (const f of repoFiles) {
    const code = stripComments(readSrc(`${REPO_DIR}/${f}`));
    for (const m of code.matchAll(IMPORT_RE)) {
      if (/(^|\/)(\.\.\/)+services(\/|$)/.test(m[1])) svcImports.push(`${f} -> ${m[1]}`);
    }
  }
  check('A1 repository/ai-conversation.ts 不 import services/**',
    !svcImports.some((d) => d.startsWith('ai-conversation.ts')), svcImports.join(' | '));
  check('B1 repository/** 全部文件无 repository→services 依赖',
    svcImports.length === 0, svcImports.join(' | '));
  check('B2 P36 AI 仓库文件（ai-context / ai-conversation）无 services 依赖',
    !svcImports.some((d) => d.startsWith('ai-context.ts') || d.startsWith('ai-conversation.ts')),
    svcImports.join(' | '));

  // C —— 禁止键清单只有一个权威定义
  const walkTs = (dir) =>
    readdirSync(join(WORKERS, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkTs(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [],
    );
  const allTs = walkTs('src');
  const codeOf = (f) => stripComments(readSrc(f));
  const denyDefs = allTs.filter((f) => /export const FORBIDDEN_CONTEXT_KEYS\b/.test(codeOf(f)));
  check('C1 禁止键清单只有一处 export 定义',
    denyDefs.length === 1 && denyDefs[0] === 'src/utils/ai-privacy.ts', denyDefs.join(' | '));
  const setDefs = allTs.filter((f) => /const FORBIDDEN_SET\b/.test(codeOf(f)));
  check('C2 FORBIDDEN_SET 只有一处定义',
    setDefs.length === 1 && setDefs[0] === 'src/utils/ai-privacy.ts', setDefs.join(' | '));
  check('C3 旧 services/ai/privacy.ts 已删除（无 shim / 副本）',
    !existsSync(join(WORKERS, 'src/services/ai/privacy.ts')));
  const privacyFiles = allTs.filter((f) => /ai-privacy\.ts$/.test(f));
  check('C4 src 下只有一个 ai-privacy 文件',
    privacyFiles.length === 1 && privacyFiles[0] === 'src/utils/ai-privacy.ts', privacyFiles.join(' | '));
  check('C5 AI barrel 不再导出 privacy（无第二导出路径 / 兼容 shim）',
    !/from '\.\/privacy'|utils\/ai-privacy/.test(codeOf('src/services/ai/index.ts')));

  // D —— data-block 与 conversation repository 使用同一 shared guard
  const DB_CODE = codeOf('src/services/ai/data-block.ts');
  check('D1 data-block 从 utils/ai-privacy 导入 guard', /from '\.\.\/\.\.\/utils\/ai-privacy'/.test(DB_CODE));
  check('D2 conversation repository 从 utils/ai-privacy 导入 guard', /from '\.\.\/utils\/ai-privacy'/.test(REPO_CODE));
  check('D3 两者解析到同一共享模块（src 唯一 ai-privacy 文件）',
    privacyFiles.length === 1 && /utils\/ai-privacy/.test(DB_CODE) && /utils\/ai-privacy/.test(REPO_CODE));
  check('D4 bundle 中 guard 为单一实例且可直接调用', typeof M.assertNoForbiddenKeys === 'function');
  check('D5 shared guard 命中禁止键时抛 AIPrivacyError', (() => {
    try {
      M.assertNoForbiddenKeys({ user_id: 1 });
      return false;
    } catch (e) {
      return e instanceof M.AIPrivacyError;
    }
  })());

  // E —— 行为未变：PII / numeric ID / public_id 规则与持久化边界拒绝语义
  check('E1 public_id 类键未被误杀',
    M.findForbiddenKeys({ public_id: 'x', activity_public_id: 'y', course_public_id: 'z' }).length === 0);
  check('E2 internal numeric ID 键仍被拒绝',
    M.findForbiddenKeys({ id: 1, user_id: 2, team_id: 3 }).length === 3);
  check('E3 PII 键仍被拒绝',
    ['real_name_enc', 'id_card_hash', 'id_card_mask', 'phone_enc', 'phone_mask', 'emergency_contact_enc', 'identity_hash']
      .every((k) => M.findForbiddenKeys({ [k]: 'v' }).length === 1));
  check('E4 凭证类键仍被拒绝',
    ['token', 'secret', 'password', 'api_key', 'apikey', 'authorization']
      .every((k) => M.findForbiddenKeys({ [k]: 'v' }).length === 1));
  check('E5 禁止键清单内容未变（36 项）', M.FORBIDDEN_CONTEXT_KEYS.length === 36,
    `got ${M.FORBIDDEN_CONTEXT_KEYS.length}`);
  check('E6 conversation 消息校验仍拒绝 PII 键（复用 shared guard）', (() => {
    try {
      M.validateStoredMessage({ role: 'user', content: 'x', real_name_enc: 'v' });
      return false;
    } catch (e) {
      return e instanceof M.AIPrivacyError;
    }
  })());
  check('E7 conversation 消息校验仍拒绝 internal numeric ID 键', (() => {
    try {
      M.validateStoredMessage({ role: 'user', content: 'x', user_id: 7 });
      return false;
    } catch (e) {
      return e instanceof M.AIPrivacyError;
    }
  })());
  check('E8 合法消息仍通过（含 public_id 不受影响）',
    M.validateStoredMessage({ role: 'user', content: 'x' }).role === 'user');
}

// ===========================================================================
// 汇总
// ===========================================================================
console.log('\n========================================');
console.log(`P36-C3-1 RESULT: PASS=${pass}  FAIL=${fail}`);
console.log('========================================');
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
