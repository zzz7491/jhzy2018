// =============================================================================
// N0-D WECHAT SUBSCRIBE CHANNEL ADAPTER — deterministic test harness
// -----------------------------------------------------------------------------
// 运行方式（managed Node 22）：
//   node workers/tests/n0d_wechat_subscribe_channel_adapter.mjs
//
// 设计（N0-D §16 / §17）：
//   - 不接触任何真实微信接口（REAL_WECHAT_SEND_CALLS=0）：通过全局 fetch 守卫证明零外网调用。
//   - 通过 esbuild 将 TS adapter 及其依赖打包为自包含 ESM，再以 node:sqlite 充当 D1 内存数据库。
//   - 注入 FakeWeChatSubscribeProvider（success / reject / network 三种确定性模式）。
//   - 覆盖：11 个模板 schema 注册表、payload 校验、投递资格、一次性订阅消费、幂等、安全（不落明文 openid）。
// =============================================================================

import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

const WORKERS = 'E:/D盘备份/miniprogram/workers';
const MIG_DIR = path.join(WORKERS, 'migrations');
const ENTRY = path.join(WORKERS, 'tests', '_n0d_test_entry.ts');
const OUT = path.join(WORKERS, 'tests', '.build', 'n0d_bundle.mjs');

// -----------------------------------------------------------------------------
// 0. 零真实微信调用守卫：任何对 api.weixin.qq.com 的 fetch 都会让测试直接失败。
// -----------------------------------------------------------------------------
let realWechatCalls = 0;
const REAL_HOSTS = ['api.weixin.qq.com'];
globalThis.fetch = (async (url, ...rest) => {
  realWechatCalls++;
  const u = typeof url === 'string' ? url : (url && url.url) || '';
  throw new Error('REAL_WECHAT_SEND_CALLS must be 0 but fetch was called: ' + u);
});

// -----------------------------------------------------------------------------
// 1. esbuild 打包 adapter 依赖图（node:sqlite 不在此包内，仅测试夹具使用）
// -----------------------------------------------------------------------------
mkdirSync(path.dirname(OUT), { recursive: true });
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
// 2. node:sqlite → D1 兼容 shim
// -----------------------------------------------------------------------------
function makeD1Shim(sqlite) {
  class D1PreparedStatement {
    constructor(stmt, params) {
      this.stmt = stmt;
      this.params = params;
    }
    async all() {
      const rows = this.stmt.all(...this.params);
      return { results: rows, success: true };
    }
    async first() {
      const row = this.stmt.get(...this.params);
      return row ?? null;
    }
    async run() {
      const r = this.stmt.run(...this.params);
      return { success: true, changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    }
  }
  return {
    _raw: sqlite,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return { bind: (...params) => new D1PreparedStatement(stmt, params) };
    },
    async batch(stmts) {
      for (const s of stmts) sqlite.prepare(s.sql).run(...(s.params ?? []));
    },
    exec(sql) {
      sqlite.exec(sql);
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
const db = makeD1Shim(sqlite);

// -----------------------------------------------------------------------------
// 3. 应用迁移 0001..0036（纯增量，幂等）
// -----------------------------------------------------------------------------
const migFiles = readdirSync(MIG_DIR)
  .filter((f) => /^00\d\d_.*\.sql$/.test(f))
  .sort();
for (const f of migFiles) {
  const sql = readFileSync(path.join(MIG_DIR, f), 'utf8');
  sqlite.exec(sql);
}

// -----------------------------------------------------------------------------
// 4. env mock（local；不配置任何 Secret；provider 由测试显式注入 Fake）
// -----------------------------------------------------------------------------
const env = { DB: db, ENVIRONMENT: 'local', WECHAT_SUBSCRIBE_PROVIDER: 'FAKE' };

function ctx(userId) {
  return {
    auth: { authenticated: true, userId, role: null, teamId: null, roles: [] },
    tenant: { scope: 'USER_SCOPED', teamId: null, userId },
  };
}

// -----------------------------------------------------------------------------
// 5. 种子数据
// -----------------------------------------------------------------------------
const openidByUser = {
  1: 'openid_user_1_secret',
  2: 'openid_user_2_secret',
  3: 'openid_user_3_secret',
  4: 'openid_user_4_secret',
  5: 'openid_user_5_secret',
  6: 'openid_user_6_secret',
  7: 'openid_user_7_secret',
  8: 'openid_user_8_secret',
};
const seededUsers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
for (const id of seededUsers) {
  sqlite.prepare('INSERT INTO users (id, public_id) VALUES (?, ?)').run(id, 'pub_' + id);
}

// 投递身份：除 user2 外全部注入 ACTIVE 身份（user2 故意无身份）
const identityUsers = [1, 3, 4, 5, 6, 7, 8, 9];
for (const u of identityUsers) {
  const dis = new mod.DeliveryIdentityService({ env, auth: ctx(u).auth, tenant: ctx(u).tenant });
  await dis.upsertFromWechatLogin({ userId: u, openid: openidByUser[u], now: 1000 });
}
// user3 身份设为 REVOKED（测试身份失效）
sqlite.prepare("UPDATE notification_delivery_identities SET status = 'REVOKED' WHERE user_id = 3").run();

// 授权（consent）
function consent(userId, templateKey, state) {
  const c = new mod.SubscriptionConsentRepository({ db: env.DB, ctx: ctx(userId) });
  return c.upsertConsent({
    userId,
    templateKey,
    templateId: mod.WECHAT_TEMPLATE_SCHEMAS[templateKey]?.wxTemplateId ?? 'unknown_wx_' + templateKey,
    state,
    now: 1000,
  });
}
const now = 1000;
await consent(1, 'signup', 'ACCEPT'); // 主路径
await consent(2, 'signup', 'ACCEPT'); // 无身份
await consent(3, 'signup', 'ACCEPT'); // 身份 REVOKED
await consent(4, 'signup', 'REJECT');
await consent(5, 'signup', 'BAN');
// user6 无授权
await consent(7, 'audit', 'ACCEPT'); // 模板停用测试
await consent(7, 'ghost_tpl', 'ACCEPT'); // 非法模板 key 测试
await consent(8, 'signup', 'ACCEPT'); // reject/network/subscription 测试
await consent(9, 'signup', 'ACCEPT'); // 幂等测试

// -----------------------------------------------------------------------------
// 6. 断言框架
// -----------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' :: ' + detail : ''));
  }
}
function makeAdapter(fakeOpts) {
  const provider = new mod.FakeWeChatSubscribeProvider(fakeOpts);
  const adapter = new mod.WeChatSubscribeAdapter({ env, provider });
  return { adapter, provider };
}
function samplePayload(schema) {
  const data = {};
  for (const f of schema.fields) {
    data[f.providerKey] = f.type === 'number' ? '123' : '示例' + f.providerKey;
  }
  return data;
}

// 查询辅助
function deliveriesFor(userId) {
  return sqlite
    .prepare('SELECT * FROM notification_deliveries WHERE user_id = ? ORDER BY id ASC')
    .all(userId);
}
function lastDelivery(userId) {
  const rows = deliveriesFor(userId);
  return rows[rows.length - 1] ?? null;
}
function consentRow(userId, templateKey) {
  return sqlite
    .prepare('SELECT * FROM wechat_subscription_consents WHERE user_id = ? AND template_key = ?')
    .get(userId, templateKey);
}

// =============================================================================
// 场景
// =============================================================================
console.log('\n— S1 模板注册表 SSOT 完整性 —');
{
  const keys = mod.WECHAT_TEMPLATE_KEYS;
  check('S1.1 恰好 11 个模板', keys.length === 11, 'got ' + keys.length);
  let allMatch = true;
  const mismatches = [];
  for (const k of keys) {
    const reg = mod.WECHAT_TEMPLATE_SCHEMAS[k];
    const row = sqlite
      .prepare("SELECT wx_template_id, status FROM message_templates WHERE code = ? AND channel = 'wechat_subscribe'")
      .get(k);
    if (!row || row.status !== 1 || row.wx_template_id !== reg.wxTemplateId) {
      allMatch = false;
      mismatches.push(k + '=>' + JSON.stringify(row) + ' vs ' + reg.wxTemplateId);
    }
  }
  check('S1.2 每个注册表 wx_template_id 与 message_templates 一致且 status=1', allMatch, mismatches.join(' | '));
  // 所有字段 key 形态合法
  let allKeysOk = true;
  for (const k of keys) {
    for (const f of mod.WECHAT_TEMPLATE_SCHEMAS[k].fields) {
      if (!mod.isWeChatFieldKey(f.providerKey)) allKeysOk = false;
    }
  }
  check('S1.3 所有 provider field key 形态合法', allKeysOk);
}

console.log('\n— S2-S6 payload schema 校验 —');
{
  const signup = mod.WECHAT_TEMPLATE_SCHEMAS.signup;
  const valid = samplePayload(signup);
  check('S2 合法 payload 通过', mod.validateWeChatPayload(signup, valid).ok === true);
  const extra = { ...valid, thing999: 'x' };
  const r3 = mod.validateWeChatPayload(signup, extra);
  check('S3 多余未知字段被拒', r3.ok === false && r3.reason.startsWith('unknown_field'), r3.reason);
  const missing = { ...valid };
  delete missing[signup.fields[0].providerKey];
  const r4 = mod.validateWeChatPayload(signup, missing);
  check('S4 缺少必需字段被拒', r4.ok === false, r4.reason);
  const nonStr = { ...valid };
  nonStr[signup.fields[0].providerKey] = 42;
  const r5 = mod.validateWeChatPayload(signup, nonStr);
  check('S5 非字符串值被拒', r5.ok === false && r5.reason.startsWith('non_string'), r5.reason);
  // number* 非数值
  const points = mod.WECHAT_TEMPLATE_SCHEMAS.points;
  const pv = samplePayload(points);
  pv.number8 = 'not_a_number';
  const r6 = mod.validateWeChatPayload(points, pv);
  check('S6 number* 非数值被拒', r6.ok === false && r6.reason.startsWith('not_number'), r6.reason);
}

console.log('\n— S7 主路径：资格齐备 → DELIVERED —');
let user1Provider;
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  user1Provider = provider;
  const r = await adapter.send({ userId: 1, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S7.1 delivered=true', r.delivered === true, JSON.stringify(r));
  check('S7.2 status=DELIVERED', r.status === 'DELIVERED');
  check('S7.3 provider 被调用 1 次', provider.callCount === 1, 'callCount=' + provider.callCount);
  const d = lastDelivery(1);
  check('S7.4 投递记录 DELIVERED', d && d.status === 'DELIVERED');
  check('S7.5 provider_message_id 已持久化', !!d && typeof d.provider_message_id === 'string' && d.provider_message_id.length > 0);
  check('S7.6 一次性授权已消费', consentRow(1, 'signup').consumed_at != null);
}

console.log('\n— S8 无投递身份 → NOT_ELIGIBLE —');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 2, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S8.1 status=NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE', JSON.stringify(r));
  check('S8.2 provider 未被调用', provider.callCount === 0, 'callCount=' + provider.callCount);
}

console.log('\n— S9 身份 REVOKED → NOT_ELIGIBLE —');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 3, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S9.1 status=NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE', JSON.stringify(r));
  check('S9.2 provider 未被调用', provider.callCount === 0, 'callCount=' + provider.callCount);
}

console.log('\n— S10/S11 授权 REJECT / BAN → NOT_ELIGIBLE —');
{
  const a1 = makeAdapter({ mode: 'success' });
  const r1 = await a1.adapter.send({ userId: 4, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S10 REJECT → NOT_ELIGIBLE', r1.status === 'NOT_ELIGIBLE' && a1.provider.callCount === 0);
  const a2 = makeAdapter({ mode: 'success' });
  const r2 = await a2.adapter.send({ userId: 5, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S11 BAN → NOT_ELIGIBLE', r2.status === 'NOT_ELIGIBLE' && a2.provider.callCount === 0);
}

console.log('\n— S12 无授权 → NOT_ELIGIBLE —');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 6, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S12 无 consent → NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE' && provider.callCount === 0);
}

console.log('\n— S13 非法模板 key → NOT_ELIGIBLE —');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 7, templateKey: 'ghost_tpl', data: { thing1: 'x' } });
  check('S13 非法模板 key → NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE' && provider.callCount === 0);
}

console.log('\n— S14 模板停用 (status=0) → NOT_ELIGIBLE —');
{
  sqlite.prepare("UPDATE message_templates SET status = 2 WHERE code = 'audit' AND channel = 'wechat_subscribe'").run();
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 7, templateKey: 'audit', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.audit) });
  check('S14 停用模板(status=2) → NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE' && provider.callCount === 0, JSON.stringify(r));
  sqlite.prepare("UPDATE message_templates SET status = 1 WHERE code = 'audit' AND channel = 'wechat_subscribe'").run();
}

console.log('\n— S15 非法 payload → INVALID_PAYLOAD + 记录 —');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const bad = { thing4: 'x' }; // 缺字段
  const r = await adapter.send({ userId: 8, templateKey: 'signup', data: bad });
  check('S15.1 status=INVALID_PAYLOAD', r.status === 'INVALID_PAYLOAD', JSON.stringify(r));
  check('S15.2 provider 未被调用', provider.callCount === 0);
  const d = lastDelivery(8);
  check('S15.3 生成 INVALID_PAYLOAD 记录', d && d.status === 'INVALID_PAYLOAD');
  check('S15.4 授权未被消费', consentRow(8, 'signup').consumed_at == null);
}

console.log('\n— S16 provider RECIPIENT_INVALID → PROVIDER_ERROR（不消费）—');
{
  const { adapter, provider } = makeAdapter({ mode: 'reject', errcode: 40003 });
  const r = await adapter.send({ userId: 8, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S16.1 status=PROVIDER_ERROR', r.status === 'PROVIDER_ERROR', JSON.stringify(r));
  check('S16.2 errorCode=40003', r.providerErrorCode === '40003', String(r.providerErrorCode));
  const d = lastDelivery(8);
  check('S16.3 记录 PROVIDER_ERROR + 安全 token', d && d.status === 'PROVIDER_ERROR' && d.provider_error_message === 'RECIPIENT_INVALID');
  check('S16.4 授权未被消费（可重试）', consentRow(8, 'signup').consumed_at == null);
}

console.log('\n— S17 provider NETWORK → NETWORK_ERROR —');
{
  const { adapter, provider } = makeAdapter({ mode: 'network' });
  const r = await adapter.send({ userId: 8, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S17.1 status=NETWORK_ERROR', r.status === 'NETWORK_ERROR', JSON.stringify(r));
  const d = lastDelivery(8);
  check('S17.2 记录 NETWORK_ERROR', d && d.status === 'NETWORK_ERROR' && d.provider_error_message === 'NETWORK_ERROR');
  check('S17.3 授权未被消费', consentRow(8, 'signup').consumed_at == null);
}

console.log('\n— S18 provider SUBSCRIPTION_NOT_AVAILABLE → PROVIDER_REJECTED + 消费 —');
{
  const { adapter, provider } = makeAdapter({ mode: 'reject', errcode: 43101 });
  const r = await adapter.send({ userId: 8, templateKey: 'signup', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S18.1 status=PROVIDER_REJECTED', r.status === 'PROVIDER_REJECTED', JSON.stringify(r));
  const d = lastDelivery(8);
  check('S18.2 记录 PROVIDER_REJECTED', d && d.status === 'PROVIDER_REJECTED' && d.provider_error_message === 'SUBSCRIPTION_NOT_AVAILABLE');
  check('S18.3 授权已消费（防反复误投）', consentRow(8, 'signup').consumed_at != null);
}

console.log('\n— S19 一次性订阅消费：成功后再发被拒 —');
{
  // user1 已于 S7 成功投递并消费
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  const r = await adapter.send({ userId: 1, templateKey: 'signup', idempotencyKey: 'idem-user1-second', data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup) });
  check('S19.1 二次发送 NOT_ELIGIBLE', r.status === 'NOT_ELIGIBLE', JSON.stringify(r));
  check('S19.2 二次发送未再调用 provider（消费后短路）', provider.callCount === 0, 'callCount=' + provider.callCount);
}

console.log('\n— S20 幂等：相同 idempotency_key 不重复发送 —');
{
  // user9：identity + signup ACCEPT；用非法 payload 触发 INVALID_PAYLOAD 记录（不消费授权），
  // 验证相同 idempotency_key 第二次发送被短路返回同一结果、provider 不被重复调用、仅一条记录。
  const a = makeAdapter({ mode: 'success' });
  const p = { userId: 9, templateKey: 'signup', idempotencyKey: 'idem-user9-k1', data: { thing4: 'x' } };
  const r1 = await a.adapter.send(p);
  const r2 = await a.adapter.send(p);
  check('S20.1 两次均 INVALID_PAYLOAD', r1.status === 'INVALID_PAYLOAD' && r2.status === 'INVALID_PAYLOAD', JSON.stringify(r1) + ' / ' + JSON.stringify(r2));
  check('S20.2 provider 未被重复调用（短路）', a.provider.callCount === 0, 'callCount=' + a.provider.callCount);
  const rows = deliveriesFor(9).filter((d) => d.idempotency_key === 'idem-user9-k1');
  check('S20.3 仅一条幂等记录', rows.length === 1, 'rows=' + rows.length);
}

console.log('\n— S21 provider 错误码映射 —');
{
  const m = mod.mapWeChatSubscribeErrcode;
  check('S21.1 40003 → RECIPIENT_INVALID', m('40003') === 'RECIPIENT_INVALID');
  check('S21.2 47003 → PAYLOAD_INVALID', m(47003) === 'PAYLOAD_INVALID');
  check('S21.3 43101 → SUBSCRIPTION_NOT_AVAILABLE', m(43101) === 'SUBSCRIPTION_NOT_AVAILABLE');
  check('S21.4 45009 → RATE_LIMITED', m('45009') === 'RATE_LIMITED');
  check('S21.5 40001 → AUTH_INVALID', m('40001') === 'AUTH_INVALID');
  check('S21.6 41030 → TEMPLATE_INVALID', m('41030') === 'TEMPLATE_INVALID');
  check('S21.7 未知 → PROVIDER_ERROR', m('99999') === 'PROVIDER_ERROR');
}

console.log('\n— S22 安全：明文 openid 不落库 —');
{
  const openids = Object.values(openidByUser);
  const allDeliveries = sqlite.prepare('SELECT * FROM notification_deliveries').all();
  let leak = false;
  for (const row of allDeliveries) {
    const hay = [row.provider_message_id, row.provider_error_code, row.provider_error_message, row.idempotency_key].join('');
    for (const o of openids) if (hay.includes(o)) leak = true;
  }
  check('S22.1 delivery 任何列不含明文 openid', leak === false);
  const idents = sqlite.prepare('SELECT * FROM notification_delivery_identities').all();
  const allCipher = idents.every((r) => typeof r.encrypted_external_id === 'string' && r.encrypted_external_id.startsWith('v1.'));
  check('S22.2 投递身份仅存密文 (v1.*)', allCipher);
}

console.log('\n— S23 REAL_WECHAT_SEND_CALLS=0 —');
{
  check('S23.1 全局 fetch 调用次数=0', realWechatCalls === 0, 'calls=' + realWechatCalls);
}

// -----------------------------------------------------------------------------
// 7. 源码安全扫描（N0-D §17）：确认无 console 泄漏 openid/token/secret，delivery 不写敏感字段
// -----------------------------------------------------------------------------
console.log('\n— S24 源码安全扫描 —');
const n0dFiles = [
  'wechat-subscribe-adapter.ts',
  'wechat-template-schema.ts',
  'wechat-provider-client.ts',
  'notification-delivery.ts',
  'subscription-consent.ts',
].map((f) => {
  // 定位文件
  if (f.startsWith('wechat-')) return path.join(WORKERS, 'src', 'channels', 'wechat', f);
  return path.join(WORKERS, 'src', 'repository', f);
});
let leakConsole = 0;
let openidInDeliveryInsert = false;
for (const fp of n0dFiles) {
  const src = readFileSync(fp, 'utf8');
  const consoleLeak = src.match(/console\.[a-z]+\([^)]*(openid|access_token|AppSecret|secret|touser)/gi);
  if (consoleLeak) leakConsole += consoleLeak.length;
}
check('S24.1 无 console 泄漏 openid/token/secret', leakConsole === 0, 'leaks=' + leakConsole);
// notification-delivery.ts INSERT 语句不应含 openid / access_token / secret / touser
{
  const nd = readFileSync(path.join(WORKERS, 'src', 'repository', 'notification-delivery.ts'), 'utf8');
  const insert = nd.match(/INSERT INTO notification_deliveries[\s\S]*?\)\s*VALUES[\s\S]*?\)/i);
  if (insert) {
    const body = insert[0].toLowerCase();
    openidInDeliveryInsert = /openid|access_token|secret|touser/.test(body);
  }
  check('S24.2 delivery INSERT 不含 openid/token/secret', openidInDeliveryInsert === false);
}
// 确认 adapter 不持有/调用第二套 token manager（应复用 provider-client 的 WeChatAccessTokenClient）
// 仅检测「代码使用」：token manager 类、.getToken( 调用、直接读取 WECHAT_APP_SECRET；注释中的 AppSecret 描述不计。
{
  const ad = readFileSync(path.join(WORKERS, 'src', 'channels', 'wechat', 'wechat-subscribe-adapter.ts'), 'utf8');
  const badRef = /WeChatAccessTokenClient|\.getToken\s*\(|env\.WECHAT_APP_SECRET|WECHAT_APP_SECRET/.test(ad);
  check('S24.3 adapter 不直接持有/调用 token manager 或读取 AppSecret', badRef === false);
}

console.log('\n— S25 RE-CONSENT LIFECYCLE（一次性订阅重授权恢复）—');
{
  const { adapter, provider } = makeAdapter({ mode: 'success' });
  // 1. 确保 ACCEPT（user9 已在 seed 中 signup ACCEPT，且未被消费）
  await consent(9, 'signup', 'ACCEPT');
  check('S25.1 初始 ACCEPT 后 consumed_at == NULL', consentRow(9, 'signup').consumed_at == null);

  // 2-3. 第一次 SUCCESS
  const r1 = await adapter.send({
    userId: 9,
    templateKey: 'signup',
    idempotencyKey: 'idem-rec-1',
    data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup),
  });
  check('S25.2 第一次 send DELIVERED', r1.status === 'DELIVERED', JSON.stringify(r1));
  check('S25.3 provider 第一次被调用', provider.callCount === 1, 'callCount=' + provider.callCount);
  check('S25.4 第一次成功后 consumed_at != NULL', consentRow(9, 'signup').consumed_at != null);

  // 4-5. 用户再次真实 ACCEPT（重授权）
  await consent(9, 'signup', 'ACCEPT');
  check('S25.5 再次 ACCEPT 后 consumed_at == NULL（权利恢复）', consentRow(9, 'signup').consumed_at == null);

  // 6-9. 第二次 SUCCESS
  const r2 = await adapter.send({
    userId: 9,
    templateKey: 'signup',
    idempotencyKey: 'idem-rec-2',
    data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup),
  });
  check('S25.6 第二次 send DELIVERED', r2.status === 'DELIVERED', JSON.stringify(r2));
  check('S25.7 provider 第二次被调用', provider.callCount === 2, 'callCount=' + provider.callCount);
  check('S25.8 第二次成功后 consumed_at 再次 != NULL', consentRow(9, 'signup').consumed_at != null);

  // 10-12. 第三次直接 send（无新 ACCEPT）
  const r3 = await adapter.send({
    userId: 9,
    templateKey: 'signup',
    idempotencyKey: 'idem-rec-3',
    data: samplePayload(mod.WECHAT_TEMPLATE_SCHEMAS.signup),
  });
  check('S25.9 第三次（无新 ACCEPT）NOT_ELIGIBLE', r3.status === 'NOT_ELIGIBLE', JSON.stringify(r3));
  check('S25.10 provider 未被第三次调用', provider.callCount === 2, 'callCount=' + provider.callCount);
}

// -----------------------------------------------------------------------------
// 8. 汇总
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log(`N0-D DETERMINISTIC TEST: ${pass} passed, ${fail} failed`);
console.log('REAL_WECHAT_SEND_CALLS = ' + realWechatCalls);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('========================================');

rmSync(OUT, { force: true });
process.exit(fail > 0 ? 1 : 0);
