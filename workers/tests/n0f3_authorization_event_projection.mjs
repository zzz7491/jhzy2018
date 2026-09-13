// =============================================================================
// N0-F3 AUTHORIZATION EVENT PROJECTION — deterministic test harness
// -----------------------------------------------------------------------------
// 运行（managed Node 22，仓库根目录 miniprogram/workers 下）：
//   node tests/n0f3_authorization_event_projection.mjs
//
// 设计（对齐 N0-F3 冻结契约 + 用户 PHASE 11/13/14）：
//   - 零真实微信调用：全局 fetch 守卫（REAL_WECHAT_SEND_CALLS=0）。
//   - esbuild 打包 TS（repository + adapter + service）为自包含 ESM，
//     以 node:sqlite 充当 D1 内存库（通过 tests/lib/d1-shim.mjs 的 D1Database，
//     batch 走 BEGIN/COMMIT/ROLLBACK 原子）。
//   - 注入 FakeWeChatSubscribeProvider（success 模式）确定性控制 provider 行为。
// =============================================================================

import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { D1Database, generateUlid } from './lib/d1-shim.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS = join(__dirname, '..');
const MIG_DIR = join(WORKERS, 'migrations');
const ENTRY = join(__dirname, '_n0f3_test_entry.ts');
const OUT = join(__dirname, '.build', 'n0f3_bundle.mjs');

// -----------------------------------------------------------------------------
// 0. 零真实微信调用守卫
// -----------------------------------------------------------------------------
let realWechatCalls = 0;
globalThis.fetch = (async (url) => {
  realWechatCalls++;
  const u = typeof url === 'string' ? url : (url && url.url) || '';
  throw new Error('REAL_WECHAT_SEND_CALLS must be 0 but fetch was called: ' + u);
});

// -----------------------------------------------------------------------------
// 1. esbuild 打包
// -----------------------------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });
await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  logLevel: 'error',
  external: ['@cloudflare/workers-types'],
});
const mod = await import(pathToFileURL(OUT).href);

// -----------------------------------------------------------------------------
// 2. DB + 全量迁移（含 0039/0040）+ 种子
// -----------------------------------------------------------------------------
const TMP = join(
  (await import('node:os')).tmpdir(),
  `wb_n0f3_${Date.now()}_${Math.floor(Math.random() * 1e6)}.sqlite`,
);
const sqlite = new DatabaseSync(TMP);
sqlite.exec('PRAGMA foreign_keys = ON;');

const migFiles = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
for (const f of migFiles) sqlite.exec(readFileSync(join(MIG_DIR, f), 'utf8'));

const db = new D1Database(sqlite);
const adapterEnv = { DB: db, ENVIRONMENT: 'local', WECHAT_SUBSCRIBE_PROVIDER: 'FAKE' };

// ---- 辅助 ----
function ctx(userId) {
  return {
    auth: { authenticated: true, userId, role: null, teamId: null, roles: [] },
    tenant: { scope: 'USER_SCOPED', teamId: null, userId },
  };
}
function addUser(id) {
  sqlite.prepare('INSERT INTO users (id, public_id, status) VALUES (?,?,1)').run(id, generateUlid());
}
function seedIdentity(userId) {
  const dis = new mod.DeliveryIdentityService({ env: adapterEnv, auth: ctx(userId).auth, tenant: ctx(userId).tenant });
  return dis.upsertFromWechatLogin({ userId, openid: 'openid_' + userId, now: 1000 });
}
const TPL = 'signupReview';
const TPL_ID = mod.WECHAT_TEMPLATE_SCHEMAS[TPL].wxTemplateId;

function consent(userId, state, authorizationRequestId, now) {
  const c = new mod.SubscriptionConsentRepository({ db, ctx: ctx(userId) });
  return c.upsertConsent({ userId, templateKey: TPL, templateId: TPL_ID, state, authorizationRequestId, now });
}
function consentRow(userId) {
  return sqlite
    .prepare('SELECT * FROM wechat_subscription_consents WHERE user_id=? AND template_key=?')
    .get(userId, TPL);
}
function eventRows(userId) {
  return sqlite
    .prepare('SELECT * FROM wechat_subscription_authorization_events WHERE user_id=? AND template_key=? ORDER BY id ASC')
    .all(userId, TPL);
}
function deliveryRows(userId) {
  return sqlite
    .prepare('SELECT * FROM notification_deliveries WHERE user_id=? ORDER BY id ASC')
    .all(userId);
}

// 投递身份
function mkAdapter(mode = 'success', errcode) {
  const provider = new mod.FakeWeChatSubscribeProvider({ mode, errcode });
  const adapter = new mod.WeChatSubscribeAdapter({ env: adapterEnv, provider });
  return { adapter, provider };
}
function samplePayload() {
  const data = {};
  for (const f of mod.WECHAT_TEMPLATE_SCHEMAS[TPL].fields) data[f.providerKey] = '示例' + f.providerKey;
  return data;
}

// -----------------------------------------------------------------------------
// 3. 断言框架
// -----------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}
async function scenario(name, fn) {
  try { await fn(); } catch (e) { fail++; failures.push(`${name}: ${e?.message || e}`); console.log(`  ✗ SCENARIO FAIL [${name}]:`, e?.message || e); }
}

// =============================================================================
// A. ADVANCE 单调推进（全部状态 ACCEPT/REJECT/BAN 都推进投影）
// =============================================================================
console.log('\n— A ADVANCE 单调推进（全部状态）—');
await scenario('A', async () => {
  const u = 1; addUser(u);
  await consent(u, 'ACCEPT', 'r1', 1000);
  let c = consentRow(u);
  check('A1 ACCEPT 后 current=事件1 state=ACCEPT consumed_at=NULL', c.current_authorization_event_id === 1 && c.consent_state === 'ACCEPT' && c.consumed_at === null, JSON.stringify(c));
  check('A1b requested_at/responded_at=1000', c.requested_at === 1000 && c.responded_at === 1000);

  await consent(u, 'REJECT', 'r2', 2000);
  c = consentRow(u);
  check('A2 REJECT 后 ADVANCE(current=2) state=REJECT', c.current_authorization_event_id === 2 && c.consent_state === 'REJECT', JSON.stringify(c));
  check('A2b consumed_at 保留(NULL) 且 responded_at=2000', c.consumed_at === null && c.responded_at === 2000);

  await consent(u, 'ACCEPT', 'r3', 3000);
  c = consentRow(u);
  check('A3 再次 ACCEPT 后 ADVANCE(current=3) state=ACCEPT', c.current_authorization_event_id === 3 && c.consent_state === 'ACCEPT', JSON.stringify(c));
  check('A3b ADVANCE+ACCEPT → consumed_at 复位 NULL', c.consumed_at === null);
  check('A3c 事件表恰好 3 行', eventRows(u).length === 3);
});

// =============================================================================
// B. STALE EVENT = 零投影变更（重放更旧事件 id 不产生任何变更，不新生成事件）
// =============================================================================
console.log('\n— B STALE EVENT 零变更 —');
await scenario('B', async () => {
  const u = 1; // 延续 A：current=3
  const evBefore = eventRows(u).length;
  await consent(u, 'ACCEPT', 'r1', 4000); // 重放 r1（事件 id=1 < current=3）→ DO NOTHING + 零投影
  const c = consentRow(u);
  check('B1 重放旧 req 不新增事件', eventRows(u).length === evBefore, 'before=' + evBefore + ' after=' + eventRows(u).length);
  check('B2 current 仍为 3（零投影）', c.current_authorization_event_id === 3, JSON.stringify(c));
  check('B3 state 仍为 ACCEPT（零投影）', c.consent_state === 'ACCEPT');
  check('B4 responded_at 不被重放覆盖（仍 3000）', c.responded_at === 3000, 'got ' + c.responded_at);
  check('B5 consumed_at 仍 NULL', c.consumed_at === null);
});

// =============================================================================
// C. REQUEST IDEMPOTENCY（首写胜出：相同 (user,tpl,req) 重复上报不产生新事件/变更）
// =============================================================================
console.log('\n— C REQUEST IDEMPOTENCY 首写胜出 —');
await scenario('C', async () => {
  const u = 1; // current=3
  const evBefore = eventRows(u).length;
  await consent(u, 'REJECT', 'r2', 5000); // 与 A2 同 req r2 → 事件 DO NOTHING；excluded.current=2 < 3 → 零投影
  const c = consentRow(u);
  check('C1 重复相同 req 不新增事件', eventRows(u).length === evBefore, 'before=' + evBefore + ' after=' + eventRows(u).length);
  check('C2 current 仍为 3（零投影）', c.current_authorization_event_id === 3);
  check('C3 state 仍为 ACCEPT（REJECT 重放不覆盖）', c.consent_state === 'ACCEPT');
});

// =============================================================================
// D. consumed_at 规则
// =============================================================================
console.log('\n— D consumed_at 规则 —');
await scenario('D1 ADVANCE+REJECT 保留已有 consumed_at', async () => {
  const u = 2; addUser(u);
  await consent(u, 'ACCEPT', 'd1a', 100);
  const repo = new mod.SubscriptionConsentRepository({ db, ctx: ctx(u) });
  await repo.markConsumed(u, TPL, 150);
  let c = consentRow(u); check('D1a 消费后 consumed_at=150', c.consumed_at === 150);
  await consent(u, 'REJECT', 'd1b', 200); // ADVANCE(1→2)+REJECT → 保留
  c = consentRow(u);
  check('D1b ADVANCE+REJECT 后 consumed_at 保留=150', c.consumed_at === 150 && c.consent_state === 'REJECT', JSON.stringify(c));
});
await scenario('D2 ADVANCE+ACCEPT 复位 consumed_at=NULL', async () => {
  const u = 3; addUser(u);
  await consent(u, 'ACCEPT', 'd2a', 100); // current=1 consumed_at=NULL
  await consent(u, 'REJECT', 'd2b', 200); // current=2 consumed_at=NULL(保留)
  await consent(u, 'ACCEPT', 'd2c', 300); // current=3 ADVANCE+ACCEPT → NULL
  const c = consentRow(u);
  check('D2 current>0 state=ACCEPT consumed_at=NULL（ADVANCE+ACCEPT 复位）', c.current_authorization_event_id > 0 && c.consent_state === 'ACCEPT' && c.consumed_at === null, JSON.stringify(c));
});
await scenario('D3 无 ADVANCE（STALE）保留 consumed_at', async () => {
  const u = 4; addUser(u);
  await consent(u, 'ACCEPT', 'd3a', 100);
  const repo = new mod.SubscriptionConsentRepository({ db, ctx: ctx(u) });
  await repo.markConsumed(u, TPL, 999);
  await consent(u, 'ACCEPT', 'd3a', 4000); // 重放同一 req → 零投影
  const c = consentRow(u);
  check('D3 无 ADVANCE（STALE）后 consumed_at 仍为 999', c.consumed_at === 999 && c.current_authorization_event_id > 0, JSON.stringify(c));
});

// =============================================================================
// E. requested_at 不被 replay 覆盖（仅首次 INSERT 落库）
// =============================================================================
console.log('\n— E requested_at 不重放 —');
await scenario('E', async () => {
  const u = 5; addUser(u);
  await consent(u, 'ACCEPT', 'e1', 1000); // requested_at=1000
  await consent(u, 'REJECT', 'e2', 9999); // ADVANCE，但 requested_at 不在 UPDATE SET → 仍 1000
  const c = consentRow(u);
  check('E1 requested_at 仍为首次 1000（未被 e2 的 9999 覆盖）', c.requested_at === 1000, 'got ' + c.requested_at);
  check('E2 responded_at 更新为 9999', c.responded_at === 9999);
});

// =============================================================================
// F. RESERVE 投递预留 + at-most-once
// =============================================================================
console.log('\n— F RESERVE 预留 + at-most-once —');
await scenario('F1 预留生成 RESERVED 并锚定授权事件', async () => {
  const u = 6; addUser(u);
  await consent(u, 'ACCEPT', 'f1', 1000); // current=1
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = await repo.reserve({ userId: u, templateKey: TPL, idempotencyKey: 'idem-f1', attemptedAt: 1000 });
  check('F1a 返回 RESERVED id', typeof id === 'number' && id > 0, 'id=' + id);
  const d = deliveryRows(u);
  check('F1b 恰好 1 条 delivery', d.length === 1, 'len=' + d.length);
  check('F1c status=RESERVED', d[0].status === 'RESERVED');
  check('F1d authorization_event_id 锚定当前事件(consent.current)', d[0].authorization_event_id === consentRow(6).current_authorization_event_id, 'deliv=' + d[0].authorization_event_id + ' consent=' + consentRow(6).current_authorization_event_id);
  check('F1e provider_template_id 取自 consent 投影', d[0].provider_template_id === TPL_ID, 'got ' + d[0].provider_template_id);
});
await scenario('F2 已 RESERVED 重预留 → 返回 null（事件被占用，不二次 claim）', async () => {
  const u = 6;
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id1 = await repo.reserve({ userId: u, templateKey: TPL, idempotencyKey: 'idem-f1', attemptedAt: 1001 });
  const d = deliveryRows(u);
  check('F2a 仍恰好 1 条 delivery（硬唯一索引阻止二次预留）', d.length === 1, 'len=' + d.length);
  check('F2b 重预留返回 null（事件已被首条 RESERVED 占用，不把既有 RESERVED 当作新 claim）', id1 === null, 'id1=' + id1);
});
await scenario('F3 finalize 定稿为 DELIVERED', async () => {
  const u = 6;
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = deliveryRows(u)[0].id;
  await repo.finalize({ deliveryId: id, status: 'DELIVERED', providerMessageId: 'msg-xyz' });
  const d = deliveryRows(u)[0];
  check('F3a status=DELIVERED', d.status === 'DELIVERED');
  check('F3b provider_message_id 已写回', d.provider_message_id === 'msg-xyz');
});
await scenario('F4 DELIVERED 后再次 reserve 不新增行（at-most-once）', async () => {
  const u = 6;
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = await repo.reserve({ userId: u, templateKey: TPL, idempotencyKey: 'idem-f1', attemptedAt: 1002 });
  const d = deliveryRows(u);
  check('F4a 仍 1 行', d.length === 1, 'len=' + d.length);
  check('F4b 已 DELIVERED → reserve 返回 null（不二次 claim/发送）', id === null);
});
await scenario('F5 REJECT 授权 → reserve 返回 null（无资格）', async () => {
  const u = 7; addUser(u);
  await consent(u, 'REJECT', 'f5', 1000);
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = await repo.reserve({ userId: u, templateKey: TPL, attemptedAt: 1000 });
  check('F5 reserve=null 且未写行', id === null && deliveryRows(u).length === 0);
});
await scenario('F6 无授权 → reserve 返回 null', async () => {
  const u = 8; addUser(u);
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = await repo.reserve({ userId: u, templateKey: TPL, attemptedAt: 1000 });
  check('F6 reserve=null 且未写行', id === null && deliveryRows(u).length === 0);
});
await scenario('F7 已消费授权 → reserve 返回 null', async () => {
  const u = 9; addUser(u);
  await consent(u, 'ACCEPT', 'f7', 1000);
  const crepo = new mod.SubscriptionConsentRepository({ db, ctx: ctx(u) });
  await crepo.markConsumed(u, TPL, 1000);
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id = await repo.reserve({ userId: u, templateKey: TPL, attemptedAt: 1000 });
  check('F7 reserve=null（consumed_at 已设）', id === null && deliveryRows(u).length === 0);
});
await scenario('F8 terminal failure 后事件被占用 → 重预留返回 null（须 NEW ACCEPT 才有新机会）', async () => {
  const u = 10; addUser(u);
  await consent(u, 'ACCEPT', 'f8', 1000); // current=event
  const evE = consentRow(u).current_authorization_event_id;
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const id1 = await repo.reserve({ userId: u, templateKey: TPL, attemptedAt: 1000 });
  await repo.finalize({ deliveryId: id1, status: 'PROVIDER_ERROR', providerErrorCode: '40003', providerErrorMessage: 'RECIPIENT_INVALID' });
  // terminal failure 视为该 grant 已使用 → 再次预留（同一事件）必须失败、不再产生新 claim
  const id2 = await repo.reserve({ userId: u, templateKey: TPL, attemptedAt: 1001 });
  const d = deliveryRows(u);
  check('F8a 仍只有 1 条 delivery（terminal failure 已 burn 事件，不新建）', d.length === 1, 'len=' + d.length);
  check('F8b 重预留返回 null（事件被占用）', id2 === null, 'id2=' + id2);
  check('F8c 既有行 status=PROVIDER_ERROR 且锚定原事件', d[0].status === 'PROVIDER_ERROR' && d[0].authorization_event_id === evE, 'st=' + d[0].status + ' ev=' + d[0].authorization_event_id);
});

// =============================================================================
// F9/F10. N0-F3-R1 关键证明：RESERVED 重入 + terminal failure 跨 logical key（at-most-once）
// =============================================================================
await scenario('F9 RESERVED 重入证明（adapter 级，要求 4）：既有 RESERVED 行 → 再 send 不新建/不调 provider', async () => {
  const u = 20; addUser(u); await seedIdentity(u);
  await consent(u, 'ACCEPT', 'f9', 1000); // current=event
  const repo = new mod.NotificationDeliveryRepository({ db, ctx: ctx(u) });
  const rid = await repo.reserve({ userId: u, templateKey: TPL, idempotencyKey: 'idem-F9', attemptedAt: 1000 });
  check('F9x 预置 RESERVED 行成功', typeof rid === 'number' && rid > 0 && deliveryRows(u)[0].status === 'RESERVED', 'rid=' + rid);
  // 再次 adapter.send（不同 idempotency_key 绕过步骤1短路，迫使 reserve 实际被调用）
  const { adapter, provider } = mkAdapter('success');
  const r = await adapter.send({ userId: u, templateKey: TPL, data: samplePayload(), idempotencyKey: 'idem-F9-other' });
  check('F9a 不产生新 delivery（仍 1 行）', deliveryRows(u).length === 1, 'len=' + deliveryRows(u).length);
  check('F9b provider 调用 0 次', provider.callCount === 0, 'callCount=' + provider.callCount);
  check('F9c 返回 NOT_ELIGIBLE（不把 existing RESERVED 当作新 claim）', r.status === 'NOT_ELIGIBLE', JSON.stringify(r));
  check('F9d 既有 RESERVED 行未被改动', deliveryRows(u)[0].status === 'RESERVED');
});
await scenario('F10 terminal failure 跨 logical key（要求 5）：event 被 burn → 不同 key 不得复用；NEW ACCEPT 可发', async () => {
  const u = 21; addUser(u); await seedIdentity(u);
  await consent(u, 'ACCEPT', 'f10a', 1000);
  const { adapter, provider } = mkAdapter('reject', 40003); // provider terminal failure → PROVIDER_ERROR
  const r1 = await adapter.send({ userId: u, templateKey: TPL, data: samplePayload(), idempotencyKey: 'idem-F10-A' });
  check('F10a 首次发送 provider 调用 1 次且终态(PROVIDER_ERROR)', provider.callCount === 1 && r1.status === 'PROVIDER_ERROR', 'call=' + provider.callCount + ' st=' + r1.status);
  const r2 = await adapter.send({ userId: u, templateKey: TPL, data: samplePayload(), idempotencyKey: 'idem-F10-B' });
  check('F10b 第二 logical key 同事件 → reservation 失败(NOT_ELIGIBLE)', r2.status === 'NOT_ELIGIBLE', JSON.stringify(r2));
  check('F10c 第二 logical key 未触发 provider 调用（仍为 1）', provider.callCount === 1, 'call=' + provider.callCount);
  check('F10d 仍只有 1 条 delivery（事件被 burn，无新 claim）', deliveryRows(u).length === 1, 'len=' + deliveryRows(u).length);
  // NEW explicit ACCEPT → NEW event
  await consent(u, 'ACCEPT', 'f10b', 2000);
  const { adapter: a2, provider: p2 } = mkAdapter('success');
  const r3 = await a2.send({ userId: u, templateKey: TPL, data: samplePayload(), idempotencyKey: 'idem-F10-C' });
  check('F10e NEW ACCEPT → NEW event 正常发送(DELIVERED)', r3.status === 'DELIVERED' && p2.callCount === 1, 'call=' + p2.callCount + ' st=' + r3.status);
  check('F10f 现 2 条 delivery（旧事件 terminal + 新事件 delivered）', deliveryRows(u).length === 2, 'len=' + deliveryRows(u).length);
});

// =============================================================================
// G. H6 适配器级：inactive/retired 模板即使有历史 ACCEPT 也不通过资格
// =============================================================================
console.log('\n— G H6 停用模板（历史 ACCEPT 仍失败）—');
await scenario('G1 启用模板 + 历史 ACCEPT → DELIVERED', async () => {
  const u = 11; addUser(u); await seedIdentity(u);
  await consent(u, 'ACCEPT', 'g1', 1000);
  const { adapter, provider } = mkAdapter('success');
  const r = await adapter.send({ userId: u, templateKey: TPL, data: samplePayload() });
  check('G1a DELIVERED', r.status === 'DELIVERED' && r.delivered === true, JSON.stringify(r));
  check('G1b provider 调用 1 次', provider.callCount === 1, 'callCount=' + provider.callCount);
  check('G1c delivery 表有 DELIVERED 行', deliveryRows(u).some((d) => d.status === 'DELIVERED'));
});
await scenario('G2 停用模板（status=2）+ 历史 ACCEPT → NOT_ELIGIBLE', async () => {
  const u = 12; addUser(u); await seedIdentity(u);
  await consent(u, 'ACCEPT', 'g2', 1000);
  sqlite.prepare("UPDATE message_templates SET status=2 WHERE code=? AND channel='wechat_subscribe'").run(TPL);
  const { adapter, provider } = mkAdapter('success');
  const r = await adapter.send({ userId: u, templateKey: TPL, data: samplePayload() });
  check('G2a NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE', JSON.stringify(r));
  check('G2b provider 未被调用', provider.callCount === 0, 'callCount=' + provider.callCount);
  check('G2c 未生成 delivery 行（资格在 reserve 前被模板否决）', deliveryRows(u).length === 0);
  // 恢复模板，供后续 H 段使用
  sqlite.prepare("UPDATE message_templates SET status=1 WHERE code=? AND channel='wechat_subscribe'").run(TPL);
});

// =============================================================================
// H. authorization_request_id 校验（N0-F3-R1：必填；缺失/空/非法/超长 → 400；无服务端兜底）
// =============================================================================
console.log('\n— H authorization_request_id 校验（必填）—');
function mkService(userId) {
  return new mod.SubscriptionConsentService({ env: adapterEnv, auth: ctx(userId).auth, tenant: ctx(userId).tenant });
}
function recArg(over) {
  return { templateKey: TPL, templateId: TPL_ID, state: 'ACCEPT', ...over };
}
await scenario('H1 非法字符 authorization_request_id → 400', async () => {
  const u = 13; addUser(u);
  let threw = null;
  try { await mkService(u).recordConsent(u, recArg({ authorizationRequestId: 'bad id with space' })); }
  catch (e) { threw = e; }
  check('H1 抛出 SUBSCRIPTION_INVALID_AUTH_REQ_ID（非法空格）', threw != null && (threw.code === 'SUBSCRIPTION_INVALID_AUTH_REQ_ID' || (threw.message || '').includes('AUTH_REQ_ID')), JSON.stringify(threw));
});
await scenario('H2 缺失 authorization_request_id → 400（无服务端兜底）', async () => {
  const u = 14; addUser(u);
  let threw = null;
  try { await mkService(u).recordConsent(u, recArg({})); } // 不传 authorization_request_id
  catch (e) { threw = e; }
  check('H2 抛出 SUBSCRIPTION_INVALID_AUTH_REQ_ID（缺失）', threw != null && (threw.code === 'SUBSCRIPTION_INVALID_AUTH_REQ_ID' || (threw.message || '').includes('AUTH_REQ_ID')), JSON.stringify(threw));
  check('H2b 未写入任何事件（服务端不生成新 identity）', eventRows(u).length === 0, 'ev=' + eventRows(u).length);
});
await scenario('H3 空字符串 authorization_request_id → 400', async () => {
  const u = 15; addUser(u);
  let threw = null;
  try { await mkService(u).recordConsent(u, recArg({ authorizationRequestId: '' })); }
  catch (e) { threw = e; }
  check('H3 抛出 SUBSCRIPTION_INVALID_AUTH_REQ_ID（空串）', threw != null && (threw.code === 'SUBSCRIPTION_INVALID_AUTH_REQ_ID' || (threw.message || '').includes('AUTH_REQ_ID')), JSON.stringify(threw));
});
await scenario('H4 合法非常规字符（.:_-）authorization_request_id → 接受', async () => {
  const u = 16; addUser(u);
  await mkService(u).recordConsent(u, recArg({ authorizationRequestId: 'wx-abc:def-123' }));
  const c = consentRow(u);
  check('H4 接受并写入（current>0）', c && c.current_authorization_event_id > 0, JSON.stringify(c));
});
await scenario('H5 超长 authorization_request_id → 400', async () => {
  const u = 17; addUser(u);
  let threw = null;
  try { await mkService(u).recordConsent(u, recArg({ authorizationRequestId: 'x'.repeat(200) })); }
  catch (e) { threw = e; }
  check('H5 抛出（超长）', threw != null && (threw.code === 'SUBSCRIPTION_INVALID_AUTH_REQ_ID' || (threw.message || '').includes('AUTH_REQ_ID')), JSON.stringify(threw));
});
await scenario('H6 同一次 invocation 的 retry 复用同一 id → 仅 1 个 authorization event', async () => {
  const u = 18; addUser(u);
  await mkService(u).recordConsent(u, recArg({ authorizationRequestId: 'repeat-id-001' }));
  await mkService(u).recordConsent(u, recArg({ authorizationRequestId: 'repeat-id-001' })); // 同 id 重试
  const ev = eventRows(u);
  check('H6 同 authorization_request_id 重试 → 仅 1 个事件（首写胜出，不重复产生）', ev.length === 1, 'len=' + ev.length);
});

// =============================================================================
// I. REAL_WECHAT_SEND_CALLS=0
// =============================================================================
console.log('\n— I REAL_WECHAT_SEND_CALLS=0 —');
check('I1 全局 fetch 调用次数=0', realWechatCalls === 0, 'calls=' + realWechatCalls);

// -----------------------------------------------------------------------------
// 汇总
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log(`N0-F3 DETERMINISTIC TEST: ${pass} passed, ${fail} failed`);
console.log('REAL_WECHAT_SEND_CALLS = ' + realWechatCalls);
if (fail > 0) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); }
console.log('========================================');

try { sqlite.close(); } catch {}
try { rmSync(TMP, { force: true }); } catch {}
rmSync(OUT, { force: true });
process.exit(fail > 0 ? 1 : 0);
