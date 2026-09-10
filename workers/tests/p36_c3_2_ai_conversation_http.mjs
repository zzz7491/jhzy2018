/**
 * P36-C3-2 — 嘉禾 AI V1 Conversation HTTP API CONTRACT TEST
 *
 * 在「真实 src/app.ts（esbuild 打包）」+「完整迁移链」+「node:sqlite D1 适配器」+
 * 「真实中间件链（authContext → tenantContext → csrf → AI gate → route）」上验证：
 *   1. 4 个 AI endpoint 的存在性与冻结契约
 *   2. authentication / ACTIVE_TEAM_REQUIRED / ai.assist.use / ownership
 *   3. strict body allowlist（客户端 history / provider / model / tool* / action … 一律 400）
 *   4. server-side history（bounded）+ 每请求重建 context
 *   5. rate-limit 集成（provider 之前；429；providerCalls = 0）
 *   6. CAS（EXPECTED_STORED_MESSAGES；stale → 409 且不重试 provider）
 *   7. 安全投影（无 provider/model/numeric id/PII/raw context/system prompt/上游细节）
 *   8. AI_CAN_MUTATE_BUSINESS_STATE = NO
 *
 * 纯契约测试：provider 由**本地 stub**替换 globalThis.fetch（不发起任何真实外部请求）；
 * 不修改源码 / 迁移 / frontend / 历史 WIP；不 git add / commit / push。
 *
 * 运行（workers/ 目录）：node tests/p36_c3_2_ai_conversation_http.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const WORKERS = fileURLToPath(new URL('..', import.meta.url));

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
function section(title) {
  console.log(`\n=== ${title} ===`);
}

const API_KEY = 'TEST-KEY-DO-NOT-LEAK';
const UPSTREAM_SECRET = 'SECRET-UPSTREAM-BODY';
const BASE_URL = 'http://ai.internal.test/v1';
const MODEL_NAME = 'unit-test-model';
const SYSTEM_PROMPT_MARK = '你是「嘉禾 AI」';
const DATA_OPEN_MARK = '<<<BUSINESS_DATA';

// ---------------------------------------------------------------------------
// D1 适配器（可注入「ai_conversations 写入失败」以验证不重试 provider）
// ---------------------------------------------------------------------------
let failConversationInsert = false;
function makeD1(sqlite) {
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) {
        params = p;
        return stmt;
      },
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
        if (failConversationInsert && /INSERT INTO ai_conversations/.test(sql)) {
          throw new Error('simulated persistence failure');
        }
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
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) await s.run();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// provider stub（统计调用次数 / 捕获请求体 / 可故障）
// ---------------------------------------------------------------------------
const provider = {
  calls: 0,
  bodies: [],
  mode: 'ok', // ok | error
  mutateDuringCall: null,
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  provider.calls++;
  let body = null;
  try {
    body = JSON.parse(init.body);
  } catch {}
  provider.bodies.push({ url: String(url), body, headers: init.headers });
  if (provider.mutateDuringCall) {
    const fn = provider.mutateDuringCall;
    provider.mutateDuringCall = null;
    fn();
  }
  if (provider.mode === 'error') {
    return new Response(JSON.stringify({ error: { message: UPSTREAM_SECRET, code: 'upstream_x' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'AI 回复内容', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

// ---------------------------------------------------------------------------
// 禁止出现在任何 HTTP 响应中的键 / 子串
// ---------------------------------------------------------------------------
const BANNED_KEYS = new Set([
  'id', 'user_id', 'team_id', 'provider', 'model', 'capability',
  'prompt_tokens', 'completion_tokens', 'latency_ms', 'tool_calls',
  'api_key', 'authorization',
]);
const BANNED_SUBSTRINGS = [API_KEY, UPSTREAM_SECRET, BASE_URL, SYSTEM_PROMPT_MARK, DATA_OPEN_MARK];
const scanned = [];

/** 生成合法 26 位 ULID 形态标识（纯数字，避开 Crockford 禁用的 I/L/O/U；供 fixture 直插）。 */
const mkId = (n) => String(n).padStart(26, '0');

function scanForBanned(obj, path = '') {
  if (typeof obj === 'string') {
    for (const s of BANNED_SUBSTRINGS) if (obj.includes(s)) return `forbidden substring at ${path}`;
    return null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanForBanned(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (BANNED_KEYS.has(k)) return `forbidden key '${k}' at ${path}`;
      if (BANNED_SUBSTRINGS.some((s) => k.includes(s))) return `forbidden substring in key at ${path}`;
      const r = scanForBanned(obj[k], path ? `${path}.${k}` : k);
      if (r) return r;
    }
  }
  return null;
}

function scanSecrets(obj, path = '') {
  if (typeof obj === 'string') {
    for (const s of BANNED_SUBSTRINGS) if (obj.includes(s)) return `forbidden substring at ${path}`;
    return null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = scanSecrets(obj[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = scanSecrets(obj[k], path ? `${path}.${k}` : k);
      if (r) return r;
    }
  }
  return null;
}

/** 业务表（用于 AI_CAN_MUTATE_BUSINESS_STATE = NO 快照对比）。 */
const BUSINESS_TABLES = [
  'activities', 'activity_signups', 'activity_participations', 'attendance_sessions',
  'attendance_events', 'service_records', 'points_accounts', 'points_ledger',
  'growth_records', 'courses', 'course_enrollments', 'exam_sessions', 'certificates',
  'content_articles', 'content_comments', 'users', 'teams', 'volunteer_profiles',
  'user_profiles', 'files', 'notifications',
];

async function main() {
  // -------------------------------------------------------------------------
  // 1) 打包真实 app.ts
  // -------------------------------------------------------------------------
  const appPath = join(WORKERS, 'src/app.ts');
  const built = await build({
    entryPoints: [appPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const bundlePath = join(tmpdir(), `p36_c3_2_app_${Date.now()}.mjs`);
  writeFileSync(bundlePath, built.outputFiles[0].text);
  const { createApp } = await import(pathToFileURL(bundlePath).href);
  const app = createApp();

  // -------------------------------------------------------------------------
  // 2) sqlite + 完整迁移链
  // -------------------------------------------------------------------------
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  const migDir = join(WORKERS, 'migrations');
  const migs = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migs) sqlite.exec(readFileSync(join(migDir, f), 'utf8'));
  const d1 = makeD1(sqlite);
  const migrationsLatest = migs[migs.length - 1];

  const ins = (sql, ...p) => sqlite.prepare(sql).run(...p);
  const q = (sql, ...p) => sqlite.prepare(sql).get(...p);
  const qa = (sql, ...p) => sqlite.prepare(sql).all(...p);

  // -------------------------------------------------------------------------
  // 3) 种子（users / teams；角色与权限来自既有迁移 seed，不改 RBAC）
  // -------------------------------------------------------------------------
  const U = { alice: 101, bob: 102 };
  const T = { A: 201, B: 202 };
  ins('INSERT INTO users (id, public_id, nickname) VALUES (?,?,?)', U.alice, 'USERALICE0000000000000000001', 'alice');
  ins('INSERT INTO users (id, public_id, nickname) VALUES (?,?,?)', U.bob, 'USERBOB000000000000000000002', 'bob');
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.A, 'TEAMAAAA00000000000000000001', '团队A', U.alice);
  ins('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)', T.B, 'TEAMBBBB00000000000000000002', '团队B', U.bob);

  const usageCount = (userId) => q('SELECT COUNT(*) AS c FROM ai_usage_logs WHERE user_id = ?', userId)?.c ?? 0;
  const convCount = () => q('SELECT COUNT(*) AS c FROM ai_conversations')?.c ?? 0;
  const convRow = (pub) => q('SELECT * FROM ai_conversations WHERE public_id = ?', pub);
  const tableCounts = () =>
    Object.fromEntries(BUSINESS_TABLES.map((t) => [t, q(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0]));

  // -------------------------------------------------------------------------
  // 4) 请求驱动
  // -------------------------------------------------------------------------
  const ENV = {
    DB: d1,
    ENVIRONMENT: 'local',
    AI_PROVIDER: 'http-chat',
    AI_BASE_URL: BASE_URL,
    AI_MODEL: MODEL_NAME,
    AI_API_KEY: API_KEY,
    AI_RL_PER_MIN: '50',
    AI_RL_PER_DAY: '500',
  };
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(
      path,
      {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      { ...ENV, ...(opts.env ?? {}) },
    );
    let json = null;
    try {
      json = await res.json();
    } catch {}
    scanned.push({ method, path, status: res.status, json });
    return { status: res.status, json };
  }
  const delta = async (fn) => {
    const before = provider.calls;
    const out = await fn();
    return { ...out, calls: provider.calls - before };
  };
  const lastBody = () => provider.bodies[provider.bodies.length - 1]?.body ?? null;

  const ALICE = { role: 'volunteer', user: U.alice, team: T.A };
  const BOB = { role: 'volunteer', user: U.bob, team: T.A };

  const S_BASE = tableCounts();

  // =========================================================================
  section('AUTH. 认证 / ACTIVE_TEAM_REQUIRED / permission');
  // =========================================================================
  {
    const r = await delta(() => call('POST', '/api/v2/ai/conversations', { body: { message: 'hi' } }));
    check('A1 unauthenticated → 401', r.status === 401, `status=${r.status}`);
    check('A2 unauthenticated code = AUTH_REQUIRED', r.json?.error?.code === 'AUTH_REQUIRED');
    check('A3 unauthenticated providerCalls = 0', r.calls === 0);

    const r2 = await delta(() => call('POST', '/api/v2/ai/conversations', { role: 'volunteer', user: U.alice, body: { message: 'hi' } }));
    check('A4 no active team → 403', r2.status === 403, `status=${r2.status}`);
    check('A5 no team code = TEAM_SCOPE_REQUIRED', r2.json?.error?.code === 'TEAM_SCOPE_REQUIRED');
    check('A6 no team providerCalls = 0', r2.calls === 0);

    const r3 = await delta(() => call('POST', '/api/v2/ai/conversations', { role: 'platform_super_admin', user: U.alice, body: { message: 'hi' } }));
    check('A7 platform role 无 team 仍 403', r3.status === 403, `status=${r3.status}`);
    check('A8 platform role 无 team code = TEAM_SCOPE_REQUIRED', r3.json?.error?.code === 'TEAM_SCOPE_REQUIRED');
    check('A9 platform role 无 team providerCalls = 0', r3.calls === 0);

    const r4 = await delta(() => call('GET', '/api/v2/ai/conversations', { role: 'volunteer', user: U.alice }));
    check('A10 list 无 team → 403', r4.status === 403 && r4.json?.error?.code === 'TEAM_SCOPE_REQUIRED');

    // permission denied：临时摘除 volunteer → ai.assist.use 绑定（只改本次内存 DB，不改 RBAC seed）
    ins(
      `DELETE FROM role_permissions
        WHERE role_id = (SELECT id FROM roles WHERE code = ?)
          AND permission_id = (SELECT id FROM permissions WHERE code = ?)`,
      'volunteer',
      'ai.assist.use',
    );
    const r5 = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: 'hi' } }));
    check('A11 permission denied → 403', r5.status === 403, `status=${r5.status}`);
    check('A12 permission denied code = FORBIDDEN', r5.json?.error?.code === 'FORBIDDEN');
    check('A13 permission denied providerCalls = 0', r5.calls === 0);
    ins(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
        WHERE r.code = ? AND p.code = ?`,
      'volunteer',
      'ai.assist.use',
    );
    check('A14 RBAC 绑定已还原', qa(
      `SELECT 1 FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = 'volunteer' AND p.code = 'ai.assist.use'`,
    ).length === 1);
  }

  // =========================================================================
  section('CREATE. POST /conversations');
  // =========================================================================
  const created = {};
  {
    const u0 = usageCount(U.alice);
    const c0 = convCount();
    const r = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: '  怎么报名活动？  ' } }));
    created.res = r;
    check('B1 valid → 201', r.status === 201, `status=${r.status}`);
    created.publicId = r.json?.data?.public_id;
    check('B2 返回 public_id（26 位 ULID）', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(created.publicId ?? ''));
    check('B3 response 不含 provider/model', scanForBanned(r.json?.data) == null, scanForBanned(r.json?.data) ?? '');
    check('B4 providerCalls = 1（title 不额外调用）', r.calls === 1, `calls=${r.calls}`);
    check('B5 usage +1', usageCount(U.alice) === u0 + 1);
    check('B6 conversation +1', convCount() === c0 + 1);

    const row = convRow(created.publicId);
    check('B7 capability 固定 volunteer_assist', row?.capability === 'volunteer_assist');
    check('B8 provider 来自 server config', row?.provider === 'http-chat');
    check('B9 model 来自 server config', row?.model === MODEL_NAME);
    check('B10 tool_calls 为 NULL', row?.tool_calls == null);
    check('B11 status 使用 schema DEFAULT(1)', row?.status === 1);
    check('B12 归属 user_id', row?.user_id === U.alice);
    check('B13 归属 team_id', row?.team_id === T.A);
    check('B14 title 由首条消息本地生成', r.json?.data?.title === '怎么报名活动？', `title=${r.json?.data?.title}`);
    check('B15 title 已 trim/折叠空白', !/\s{2,}/.test(r.json?.data?.title ?? ''));

    const msgs = JSON.parse(row.messages);
    check('B16 messages = [user, assistant]', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant');
    check('B17 user message 已 trim', msgs[0].content === '怎么报名活动？');
    check('B18 user message 字段仅 role/content', Object.keys(msgs[0]).sort().join(',') === 'content,role');
    check('B19 assistant 字段仅 role/content/source_labels', Object.keys(msgs[1]).sort().join(',') === 'content,role,source_labels');
    check('B20 source_labels 仅出现在 assistant', msgs[0].source_labels === undefined && Array.isArray(msgs[1].source_labels));
    const rawTxt = row.messages;
    check('B21 未持久化 raw business context', !rawTxt.includes(DATA_OPEN_MARK));
    check('B22 未持久化 system prompt', !rawTxt.includes(SYSTEM_PROMPT_MARK));
    check('B23 未持久化 numeric id / PII 键', !/(user_id|team_id|real_name_enc|phone_enc|id_card)/.test(rawTxt));
    check('B24 未持久化 provider raw response', !rawTxt.includes('finish_reason') && !rawTxt.includes('choices'));
    check('B25 create 响应投影仅 public_id/title/messages/created_at/updated_at',
      Object.keys(r.json?.data ?? {}).sort().join(',') === 'created_at,messages,public_id,title,updated_at',
      Object.keys(r.json?.data ?? {}).sort().join(','));
  }

  // =========================================================================
  section('STRICT INPUT. 客户端 body 白名单');
  // =========================================================================
  {
    const forbiddenFields = [
      'history', 'provider', 'model', 'capability', 'temperature', 'top_p', 'system',
      'system_prompt', 'context', 'business_data', 'tool', 'tools', 'tool_calls',
      'tool_choice', 'action', 'command', 'operation', 'max_tokens', 'timeout',
      'unknown_field',
    ];
    let allRejected = true;
    let noProviderCall = true;
    const rejected = [];
    for (const f of forbiddenFields) {
      const r = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: 'x', [f]: 'y' } }));
      if (r.status !== 400) {
        allRejected = false;
        rejected.push(`${f}:${r.status}`);
      }
      if (r.calls !== 0) noProviderCall = false;
    }
    check('C1 全部控制面/未知字段 → 400', allRejected, rejected.join(' | '));
    check('C2 全部拒绝请求 providerCalls = 0', noProviderCall);

    const rEmpty = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: '   ' } }));
    check('C3 空 message → 400', rEmpty.status === 400, `status=${rEmpty.status}`);
    const rLong = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: 'x'.repeat(2001) } }));
    check('C4 超长 message → 400', rLong.status === 400, `status=${rLong.status}`);
    const rNo = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: {} }));
    check('C5 缺少 message → 400', rNo.status === 400, `status=${rNo.status}`);
    const rMsg = await delta(() => call('POST', `/api/v2/ai/conversations/${created.publicId}/messages`, { ...ALICE, body: { message: 'x', history: [] } }));
    check('C6 messages 端点同样拒绝客户端 history', rMsg.status === 400, `status=${rMsg.status}`);
    check('C7 messages 端点拒绝时 providerCalls = 0', rMsg.calls === 0);
  }

  // =========================================================================
  section('LIST. GET /conversations');
  // =========================================================================
  {
    // 他人同队 + 本人跨队各建一条
    const bobRes = await call('POST', '/api/v2/ai/conversations', { ...BOB, body: { message: 'bob 的提问' } });
    const crossTeamRes = await call('POST', '/api/v2/ai/conversations', { role: 'volunteer', user: U.alice, team: T.B, body: { message: '团队B 提问' } });
    created.bobId = bobRes.json?.data?.public_id;
    created.crossTeamId = crossTeamRes.json?.data?.public_id;

    const r = await delta(() => call('GET', '/api/v2/ai/conversations', ALICE));
    check('D1 own list → 200', r.status === 200, `status=${r.status}`);
    check('D2 GET providerCalls = 0', r.calls === 0);
    const items = r.json?.data?.items ?? [];
    const ids = items.map((i) => i.public_id);
    check('D3 list 仅含本人+本团队会话', ids.includes(created.publicId) && !ids.includes(created.bobId) && !ids.includes(created.crossTeamId));
    check('D4 list 投影仅 public_id/title/updated_at/created_at',
      items.every((i) => Object.keys(i).sort().join(',') === 'created_at,public_id,title,updated_at'),
      items.map((i) => Object.keys(i).sort().join(',')).join(' | '));
    check('D5 list 无 provider/model/messages/tokens', scanForBanned(r.json?.data) == null, scanForBanned(r.json?.data) ?? '');
    check('D6 pagination metadata 完整',
      ['page', 'page_size', 'total', 'total_pages'].every((k) => k in (r.json?.data?.pagination ?? {})),
      JSON.stringify(r.json?.data?.pagination));
    const page2 = await call('GET', '/api/v2/ai/conversations?page=2&page_size=1', ALICE);
    check('D7 pagination 生效', page2.status === 200 && (page2.json?.data?.pagination?.page_size ?? 0) === 1);
  }

  // =========================================================================
  section('DETAIL. GET /conversations/:publicId');
  // =========================================================================
  {
    const r = await delta(() => call('GET', `/api/v2/ai/conversations/${created.publicId}`, ALICE));
    check('E1 own detail → 200', r.status === 200, `status=${r.status}`);
    check('E2 GET providerCalls = 0', r.calls === 0);
    check('E3 detail 投影仅 public_id/title/messages/created_at/updated_at',
      Object.keys(r.json?.data ?? {}).sort().join(',') === 'created_at,messages,public_id,title,updated_at',
      Object.keys(r.json?.data ?? {}).sort().join(','));
    check('E4 detail 无 provider/model/tool_calls/tokens', scanForBanned(r.json?.data) == null, scanForBanned(r.json?.data) ?? '');

    const bad = await call('GET', '/api/v2/ai/conversations/not-a-ulid', ALICE);
    check('E5 非法 ULID → 400', bad.status === 400 && bad.json?.error?.code === 'INVALID_PARAM', `status=${bad.status}`);
    const otherUser = await call('GET', `/api/v2/ai/conversations/${created.publicId}`, BOB);
    check('E6 跨用户 → 404', otherUser.status === 404, `status=${otherUser.status}`);
    const otherTeam = await call('GET', `/api/v2/ai/conversations/${created.publicId}`, { role: 'volunteer', user: U.alice, team: T.B });
    check('E7 跨团队 → 404', otherTeam.status === 404, `status=${otherTeam.status}`);
    const missing = await call('GET', `/api/v2/ai/conversations/${mkId(4)}`, ALICE);
    check('E8 不存在 ULID → 404', missing.status === 404, `status=${missing.status}`);
  }

  // =========================================================================
  section('NEXT MESSAGE. POST /conversations/:publicId/messages');
  // =========================================================================
  {
    const u0 = usageCount(U.alice);
    const r = await delta(() => call('POST', `/api/v2/ai/conversations/${created.publicId}/messages`, { ...ALICE, body: { message: '那我怎么取消？' } }));
    check('F1 valid → 200', r.status === 200, `status=${r.status}`);
    check('F2 providerCalls = 1', r.calls === 1, `calls=${r.calls}`);
    check('F3 usage +1', usageCount(U.alice) === u0 + 1);
    const msgs = JSON.parse(convRow(created.publicId).messages);
    check('F4 精确追加 user+assistant', msgs.length === 4 && msgs[2].role === 'user' && msgs[3].role === 'assistant');
    check('F5 source_labels 仍仅 assistant', msgs[2].source_labels === undefined && Array.isArray(msgs[3].source_labels));
    check('F6 response 投影安全', scanForBanned(r.json?.data) == null, scanForBanned(r.json?.data) ?? '');

    const body = lastBody();
    const providerMsgs = body?.messages ?? [];
    check('F7 provider 收到服务端历史（含首轮 user）',
      providerMsgs.some((m) => m.content === '怎么报名活动？'));
    check('F8 provider 收到服务端历史（含首轮 assistant）',
      providerMsgs.some((m) => m.role === 'assistant' && m.content === 'AI 回复内容'));
    const systemMsgs = providerMsgs.filter((m) => m.role === 'system');
    check('F9 system 仅服务端注入且只有 1 条（客户端不可提交 system）',
      systemMsgs.length === 1 && systemMsgs[0].content.includes(SYSTEM_PROMPT_MARK));
    check('F10 model 由服务端配置下发', body?.model === MODEL_NAME);
    check('F11 本轮问题随重建后的 context 一起下发',
      typeof providerMsgs[providerMsgs.length - 1]?.content === 'string' &&
      providerMsgs[providerMsgs.length - 1].content.includes('那我怎么取消？'));
    const crossOwner = await delta(() => call('POST', `/api/v2/ai/conversations/${created.publicId}/messages`, { ...BOB, body: { message: '我能改吗？' } }));
    check('F12 跨用户 append → 404', crossOwner.status === 404, `status=${crossOwner.status}`);
    check('F13 跨用户 append providerCalls = 0', crossOwner.calls === 0);
  }

  // =========================================================================
  section('CONTEXT REFRESH. 每请求重建（新业务数据即时可见）');
  // =========================================================================
  {
    // 延迟注入一条「已审核 + 开放」的活动（fixture 写入，非 AI 写入）
    ins(
      `INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, audit_status, status, created_by)
       VALUES (?,?,?,?,?,?,2,1,?)`,
      9001, 'ACTPUB000000000000000000901', T.A, '延迟注入river清洁活动ZZQ', 1750000000, 1750036000, U.alice,
    );
    const before = provider.bodies.length;
    await call('POST', `/api/v2/ai/conversations/${created.publicId}/messages`, { ...ALICE, body: { message: '现在有什么活动？' } });
    const body = provider.bodies[provider.bodies.length - 1]?.body;
    const all = body?.messages ?? [];
    const last = all[all.length - 1];
    check('G1 新一轮请求携带最新活动数据（context 每次重建）',
      typeof last?.content === 'string' && last.content.includes('延迟注入river清洁活动ZZQ'));
    check('G2 业务数据包裹在 DATA 块内', typeof last?.content === 'string' && last.content.includes(DATA_OPEN_MARK));
    // 仅校验业务侧消息（system 提示词本身含有"不要输出 user_id/team_id"的告诫，属正常文案）
    const nonSystem = all.filter((m) => m.role !== 'system');
    check('G3 provider 业务消息不含 numeric internal id 字段',
      !/user_id|team_id|real_name_enc|id_card|phone_enc/.test(JSON.stringify(nonSystem)));
    check('G4 本区块仅一次 provider 调用', provider.bodies.length === before + 1);
  }

  // =========================================================================
  section('PROVIDER HISTORY BOUND. 20 条窗口 + 存储不裁剪');
  // =========================================================================
  {
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push(
        i % 2 === 1
          ? { role: 'assistant', content: `历史消息-${i}`, source_labels: [] }
          : { role: 'user', content: `历史消息-${i}` },
      );
    }
    const pub = mkId(1);
    ins(
      `INSERT INTO ai_conversations (id, user_id, team_id, public_id, capability, provider, model, messages, title, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      9100, U.alice, T.A, pub, 'volunteer_assist', 'http-chat', MODEL_NAME, JSON.stringify(many), '长会话', 1750000000, 1750000000,
    );
    const before = provider.bodies.length;
    await call('POST', `/api/v2/ai/conversations/${pub}/messages`, { ...ALICE, body: { message: '继续' } });
    const body = provider.bodies[provider.bodies.length - 1]?.body;
    // adapter 会把服务端 system 作为 messages[0] 下发；窗口计数只统计非 system 消息
    const historyMsgs = (body?.messages ?? []).filter((m) => m.role !== 'system');
    const n = historyMsgs.length;
    check('H1 provider 历史窗口 <= 20 + 当前问题（=21）', n === 21, `messages=${n}`);
    check('H2 窗口取最近历史（丢弃更早消息）', (historyMsgs[0]?.content ?? '') === '历史消息-10', `${historyMsgs[0]?.content}`);
    const stored = JSON.parse(convRow(pub).messages);
    check('H3 存储历史不裁剪（旧消息仍在）', stored.length === 32, `stored=${stored.length}`);
    check('H4 providerCalls = 1', provider.bodies.length === before + 1);
  }

  // =========================================================================
  section('RATE LIMIT. provider 之前判决');
  // =========================================================================
  {
    const beforeCalls = provider.calls;
    const beforeConv = convCount();
    const rlEnv = { AI_RL_PER_MIN: '1', AI_RL_PER_DAY: '500' };
    const r = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: '限流测试' }, env: rlEnv }));
    check('I1 minute limited → 429', r.status === 429, `status=${r.status}`);
    check('I2 code = RATE_LIMITED', r.json?.error?.code === 'RATE_LIMITED');
    check('I3 限流 providerCalls = 0', r.calls === 0, `calls=${r.calls}`);
    check('I4 限流时 conversation 未变化', convCount() === beforeConv);
    check('I5 details 含窗口与安全 retry 建议',
      r.json?.error?.details?.window === 'minute' && Number(r.json?.error?.details?.retry_after_seconds) >= 1);
    check('I6 限流响应不含计数明细/凭证', scanForBanned(r.json) == null, scanForBanned(r.json) ?? '');

    const rMsg = await delta(() =>
      call('POST', `/api/v2/ai/conversations/${created.publicId}/messages`, { ...ALICE, body: { message: '限流下追加' }, env: rlEnv }));
    check('I7 messages 端点同样 429', rMsg.status === 429, `status=${rMsg.status}`);
    check('I8 messages 端点限流 providerCalls = 0', rMsg.calls === 0);
    check('I9 messages 端点限流时会话未变化', JSON.parse(convRow(created.publicId).messages).length === 6);

    const dayEnv = { AI_RL_PER_MIN: '100000', AI_RL_PER_DAY: '1' };
    const rDay = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: '日限流测试' }, env: dayEnv }));
    check('I10 day limited → 429', rDay.status === 429, `status=${rDay.status}`);
    check('I11 day details.window = day', rDay.json?.error?.details?.window === 'day');
    check('I12 day 限流 providerCalls = 0', rDay.calls === 0);
    check('I13 本区块共 0 次 provider 调用', provider.calls === beforeCalls);

    const list = await delta(() => call('GET', '/api/v2/ai/conversations', { ...ALICE, env: rlEnv }));
    check('I14 list 不受限流影响（只读）', list.status === 200);
  }

  // =========================================================================
  section('CAS. EXPECTED_STORED_MESSAGES');
  // =========================================================================
  {
    const pub = mkId(2);
    const original = [
      { role: 'user', content: '初始问题' },
      { role: 'assistant', content: '初始回复', source_labels: [] },
    ];
    ins(
      `INSERT INTO ai_conversations (id, user_id, team_id, public_id, capability, provider, model, messages, title, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      9200, U.alice, T.A, pub, 'volunteer_assist', 'http-chat', MODEL_NAME, JSON.stringify(original), 'CAS 会话', 1750000000, 1750000000,
    );
    const racing = [
      ...original,
      { role: 'user', content: '并发写入的问题' },
      { role: 'assistant', content: '并发写入的回复', source_labels: [] },
    ];
    // 模拟并发：provider 调用期间另一个写者更新了 messages
    provider.mutateDuringCall = () => {
      sqlite.prepare('UPDATE ai_conversations SET messages = ? WHERE public_id = ?').run(JSON.stringify(racing), pub);
    };
    const beforeCalls = provider.calls;
    const usageBefore = usageCount(U.alice);
    const r = await delta(() => call('POST', `/api/v2/ai/conversations/${pub}/messages`, { ...ALICE, body: { message: '另一个请求' } }));
    check('J1 CAS stale → 409', r.status === 409, `status=${r.status}`);
    check('J2 code = CONFLICT', r.json?.error?.code === 'CONFLICT');
    check('J3 reason = conversation_stale', r.json?.error?.details?.reason === 'conversation_stale');
    check('J4 stale 不自动重试 provider（providerCalls = 1）', r.calls === 1, `calls=${r.calls}`);
    check('J5 较新 messages 未被覆盖',
      JSON.parse(convRow(pub).messages).some((m) => m.content === '并发写入的回复'));
    check('J6 usage 已产生且保留（NOT_ATOMIC，不补偿删除）', usageCount(U.alice) === usageBefore + 1);
    provider.mutateDuringCall = null;

    const ok = await delta(() => call('POST', `/api/v2/ai/conversations/${pub}/messages`, { ...ALICE, body: { message: '正常追加' } }));
    check('J7 CAS 正常路径 → 200', ok.status === 200, `status=${ok.status}`);
    check('J8 CAS 正常 providerCalls = 1', ok.calls === 1);
    check('J9 CAS 正常精确追加 2 条', JSON.parse(convRow(pub).messages).length === 6);
    check('J10 本区块 provider 调用总数 = 2', provider.calls - beforeCalls === 2);
  }

  // =========================================================================
  section('FAILURE. provider 错误 / 持久化失败');
  // =========================================================================
  {
    const pub = mkId(3);
    ins(
      `INSERT INTO ai_conversations (id, user_id, team_id, public_id, capability, provider, model, messages, title, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      9300, U.alice, T.A, pub, 'volunteer_assist', 'http-chat', MODEL_NAME,
      JSON.stringify([{ role: 'user', content: '失败前' }, { role: 'assistant', content: '回复前', source_labels: [] }]),
      '失败会话', 1750000000, 1750000000,
    );
    const beforeMsgs = JSON.parse(convRow(pub).messages).length;
    const usageBefore = usageCount(U.alice);

    provider.mode = 'error';
    const r = await delta(() => call('POST', `/api/v2/ai/conversations/${pub}/messages`, { ...ALICE, body: { message: '会失败吗' } }));
    provider.mode = 'ok';
    check('K1 provider error → 5xx（非 2xx）', r.status >= 500, `status=${r.status}`);
    check('K2 provider error 时会话未变化', JSON.parse(convRow(pub).messages).length === beforeMsgs);
    check('K3 provider error 未写 assistant',
      !JSON.parse(convRow(pub).messages).some((m) => m.role === 'assistant' && m.content === 'AI 回复内容'));
    check('K4 provider error 未写 usage', usageCount(U.alice) === usageBefore);
    check('K5 响应不含上游原始 body/凭证', scanForBanned(r.json) == null, scanForBanned(r.json) ?? '');
    check('K6 响应不回显上游错误文案', !JSON.stringify(r.json ?? {}).includes(UPSTREAM_SECRET));

    const cBefore = convCount();
    const callsBefore = provider.calls;
    failConversationInsert = true;
    const rCreate = await delta(() => call('POST', '/api/v2/ai/conversations', { ...ALICE, body: { message: '持久化失败' } }));
    failConversationInsert = false;
    check('K7 persistence failure 非 2xx', rCreate.status >= 500, `status=${rCreate.status}`);
    check('K8 persistence failure 未创建会话', convCount() === cBefore);
    check('K9 persistence failure 不重调 provider（providerCalls = 1）', provider.calls - callsBefore === 1, `delta=${provider.calls - callsBefore}`);
    check('K10 响应不含 SQL/内部细节', !/INSERT INTO|ai_conversations|stack|SQL/i.test(JSON.stringify(rCreate.json ?? {})));
  }

  // =========================================================================
  section('SECURITY + BUSINESS STATE');
  // =========================================================================
  {
    let leak = null;
    for (const item of scanned) {
      // 成功 payload：键级 + 子串级全禁；错误响应：只做子串级（details 允许回显客户端提交的字段名）
      const r = item.status < 400 ? scanForBanned(item.json?.data) : scanSecrets(item.json);
      if (r) {
        leak = `${item.method} ${item.path} → ${r}`;
        break;
      }
    }
    let secretLeak = null;
    for (const item of scanned) {
      const r = scanSecrets(item.json);
      if (r) {
        secretLeak = `${item.method} ${item.path} → ${r}`;
        break;
      }
    }
    check('L1 全部响应无 numeric/internal ID / provider / model / tokens', leak == null, leak ?? '');
    check('L1b 全部响应无密钥 / 上游 / baseUrl / system prompt / raw context 子串', secretLeak == null, secretLeak ?? '');

    const rows = qa('SELECT messages FROM ai_conversations');
    let badRow = null;
    for (const row of rows) {
      const txt = row.messages ?? '';
      if (/(user_id|team_id|real_name_enc|id_card|phone_enc|emergency_contact_enc|identity_hash)/.test(txt)) badRow = 'forbidden key in stored messages';
      if (txt.includes(SYSTEM_PROMPT_MARK)) badRow = 'system prompt persisted';
      if (txt.includes(DATA_OPEN_MARK)) badRow = 'raw business context persisted';
      if (/(api_key|authorization|Bearer )/i.test(txt)) badRow = 'credential persisted';
      if (badRow) break;
    }
    check('L2 存储 messages 无 PII / numeric id / system prompt / raw context / 凭证', badRow == null, badRow ?? '');

    const usageRows = qa('SELECT provider, model, cost_estimate FROM ai_usage_logs');
    check('L3 usage 不记录 API key', !usageRows.some((r) => JSON.stringify(r).includes(API_KEY)));
    check('L4 cost_estimate 不伪造（NULL）', usageRows.every((r) => r.cost_estimate == null));
    check('L5 未启用 tool calling（无 tool_calls 落库）', qa('SELECT 1 FROM ai_conversations WHERE tool_calls IS NOT NULL').length === 0);

    const S_END = tableCounts();
    const diffs = BUSINESS_TABLES.filter((t) => S_BASE[t] !== S_END[t]).map((t) => `${t}:${S_BASE[t]}→${S_END[t]}`);
    check('L6 业务表零变更（activities +1 为 context fixture）',
      diffs.every((d) => d.startsWith('activities:')) && S_END.activities - S_BASE.activities === 1,
      diffs.join(' | '));
    check('L7 AI 只写 ai_conversations / ai_usage_logs',
      qa('SELECT public_id FROM ai_conversations').length > 0 && usageRows.length > 0);
    check('L8 迁移链最新为 0030（P37 合法新增 analytics index migration）', migrationsLatest === '0030_analytics_index.sql', migrationsLatest);
    check('L9 未暴露 provider/model 给客户端（v1 为 HIDDEN）',
      scanned.every((s) => !JSON.stringify(s.json ?? {}).includes(MODEL_NAME)));
  }

  // =========================================================================
  section('ENDPOINT SURFACE');
  // =========================================================================
  {
    const del = await call('DELETE', `/api/v2/ai/conversations/${created.publicId}`, ALICE);
    check('M1 未提供 DELETE（非 2xx）', del.status >= 400, `status=${del.status}`);
    const put = await call('PUT', `/api/v2/ai/conversations/${created.publicId}`, ALICE);
    check('M2 未提供 rename/PUT（非 2xx）', put.status >= 400, `status=${put.status}`);
    const stream = await call('GET', `/api/v2/ai/conversations/${created.publicId}/stream`, ALICE);
    check('M3 未提供 SSE/stream 端点（非 2xx）', stream.status >= 400, `status=${stream.status}`);
    const unknown = await call('GET', '/api/v2/ai/unknown-endpoint', ALICE);
    check('M4 未提供额外 AI 端点（非 2xx）', unknown.status >= 400, `status=${unknown.status}`);
  }
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    console.log('\n========================================');
    console.log(`P36-C3-2 RESULT: PASS=${pass}  FAIL=${fail}`);
    console.log('========================================');
    if (fail > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    globalThis.fetch = realFetch;
    console.error('\n[FATAL]', err);
    process.exit(1);
  });
