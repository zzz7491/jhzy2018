// =============================================================================
// N0-E5C SIGNUP REVIEW WECHAT — deterministic test harness
// -----------------------------------------------------------------------------
// 运行（managed Node 22，仓库根目录 miniprogram/workers 下）：
//   node tests/n0e5c_signup_review_wechat.mjs
//
// 设计（对齐 N0-D §16/§17 与用户 PHASE 11/13/14）：
//   - 零真实微信调用：全局 fetch 守卫（REAL_WECHAT_SEND_CALLS=0）。
//   - esbuild 打包 TS（ActivitySignupService + WeChat adapter + payload builder + schema）为自包含 ESM，
//     以 node:sqlite 充当 D1 内存库（通过 tests/lib/d1-shim.mjs 的 D1Database，batch 回传 meta.changes）。
//   - 注入 FakeWeChatSubscribeProvider（success / reject / network 模式）确定性控制 provider 行为。
//   - 覆盖：A migration runtime / B schema 精确 4 字段 / C payload 映射 / D 缺地址跳过且业务成功 /
//           E consent 旧新 ID 隔离 / F 原子提交后错误隔离 / G best-effort 幂等 / H 前端 consent（静态）。
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
const ENTRY = join(__dirname, '_n0e5c_test_entry.ts');
const OUT = join(__dirname, '.build', 'n0e5c_bundle.mjs');

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
// 2. DB + 全量迁移（含 0038）+ 种子
// -----------------------------------------------------------------------------
const TMP = join(
  (await import('node:os')).tmpdir(),
  `wb_n0e5c_${Date.now()}_${Math.floor(Math.random() * 1e6)}.sqlite`,
);
const sqlite = new DatabaseSync(TMP);
sqlite.exec('PRAGMA foreign_keys = ON;');

const migFiles = readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
for (const f of migFiles) sqlite.exec(readFileSync(join(MIG_DIR, f), 'utf8'));

const db = new D1Database(sqlite);
const adapterEnv = { DB: db, ENVIRONMENT: 'local', WECHAT_SUBSCRIBE_PROVIDER: 'FAKE' };

// ---- 种子 ----
const NOW = 1000;
function addUser(id, pub) {
  sqlite.prepare('INSERT INTO users (id, public_id, nickname, status) VALUES (?,?,?,1)').run(id, pub, 'u' + id);
}
function addTeam(id, pub, owner) {
  sqlite.prepare('INSERT INTO teams (id, public_id, name, owner_user_id, status) VALUES (?,?,?,?,1)').run(id, pub, 'T' + id, owner);
}
function addActivity(id, pub, teamId, title, address) {
  sqlite
    .prepare(
      `INSERT INTO activities (id, public_id, team_id, title, status, created_by, start_time, end_time, need_audit, address, audit_status)
       VALUES (?,?,?,?,1,?,?,?,1,?,2)`,
    )
    .run(id, pub, teamId, title, 3, NOW, NOW + 3600, address);
}
function addPendingSignup(userId, activityId) {
  sqlite
    .prepare('INSERT INTO activity_signups (activity_id, user_id, review_status, status, created_at) VALUES (?,?,0,1,?)')
    .run(activityId, userId, NOW);
  return sqlite.prepare('SELECT id FROM activity_signups WHERE activity_id=? AND user_id=?').get(activityId, userId).id;
}
function ctx(userId) {
  return {
    auth: { authenticated: true, userId, role: 'volunteer', teamId: 1, roles: [{ role: 'volunteer', scopeTeamId: 1 }] },
    tenant: { scope: 'TEAM_SCOPED', teamId: 1, userId },
  };
}
function seedIdentity(userId) {
  const dis = new mod.DeliveryIdentityService({ env: adapterEnv, auth: ctx(userId).auth, tenant: ctx(userId).tenant });
  return dis.upsertFromWechatLogin({ userId, openid: 'openid_' + userId, now: NOW });
}
function seedConsent(userId, templateKey) {
  const c = new mod.SubscriptionConsentRepository({ db, ctx: ctx(userId) });
  return c.upsertConsent({
    userId,
    templateKey,
    templateId: mod.WECHAT_TEMPLATE_SCHEMAS[templateKey].wxTemplateId,
    state: 'ACCEPT',
    now: NOW,
  });
}

// reviewer（team1 owner）
const REVIEWER = {
  auth: { authenticated: true, userId: 3, role: 'team_owner', teamId: 1, roles: [{ role: 'team_owner', scopeTeamId: 1 }] },
  tenant: { scope: 'TEAM_SCOPED', teamId: 1, userId: 3 },
};
function mkService(adapter) {
  return new mod.ActivitySignupService({ db, auth: REVIEWER.auth, tenant: REVIEWER.tenant, wechatAdapter: adapter });
}
function mkAdapter(mode, errcode) {
  const provider = new mod.FakeWeChatSubscribeProvider({ mode, errcode });
  const adapter = new mod.WeChatSubscribeAdapter({ env: adapterEnv, provider });
  return { adapter, provider };
}

// 团队 / 审核者
addUser(3, generateUlid());
addTeam(1, generateUlid(), 3);
// 活动
const actMain = generateUlid();
const actSecond = generateUlid();
const actNoAddr = generateUlid();
addActivity(1, actMain, 1, '春季社区志愿清扫', '浙江省嘉兴市南湖区中山东路1号');
addActivity(2, actSecond, 1, '图书馆导览志愿', '上海市黄浦区南京东路100号');
addActivity(99, actNoAddr, 1, '线上公益讲座', null); // 缺地址

// 志愿者
const volE1 = 100, volE2 = 101, volE3 = 102;
const volF1 = 103, volF2 = 104, volF3 = 105, volF4 = 106, volF5 = 107, volF6 = 108;
const volD = 109, volG = 110, volH = 111;
for (const id of [volE1, volE2, volE3, volF1, volF2, volF3, volF4, volF5, volF6, volD, volG, volH]) addUser(id, generateUlid());

// 报名（PENDING）
const sE1 = addPendingSignup(volE1, 1);
const sE2 = addPendingSignup(volE2, 1);
const sE3a = addPendingSignup(volE3, 1);
const sE3b = addPendingSignup(volE3, 2);
const sF1 = addPendingSignup(volF1, 1);
const sF2 = addPendingSignup(volF2, 1);
const sF3 = addPendingSignup(volF3, 1);
const sF4 = addPendingSignup(volF4, 1);
const sF5 = addPendingSignup(volF5, 1);
const sF6 = addPendingSignup(volF6, 1);
const sD = addPendingSignup(volD, 99);
const sH = addPendingSignup(volH, 1);

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
// A. MIGRATION RUNTIME
// =============================================================================
console.log('\n— A migration runtime（0038 注册 + 退役旧 signup）—');
{
  const row = sqlite.prepare("SELECT * FROM message_templates WHERE code='signupReview' AND channel='wechat_subscribe'").get();
  check('A1 signupReview 行存在', !!row);
  check('A2 signupReview status=1（active）', row && row.status === 1, JSON.stringify(row));
  check('A3 signupReview wx_template_id 精确', row && row.wx_template_id === 'PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8', row && row.wx_template_id);
  check('A4 signupReview title=活动报名审核结果通知', row && row.title === '活动报名审核结果通知');

  const oldRow = sqlite.prepare("SELECT * FROM message_templates WHERE code='signup' AND channel='wechat_subscribe'").get();
  check('A5 旧 signup 行仍保留（不删行）', !!oldRow);
  check('A6 旧 signup status=2（退役，非 0/1）', oldRow && oldRow.status === 2, oldRow && oldRow.status);
  check('A7 旧 signup wx_template_id=No.620', oldRow && oldRow.wx_template_id === '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4');
}

// =============================================================================
// B. SCHEMA 精确 4 字段
// =============================================================================
console.log('\n— B schema 精确 4 字段（固定顺序）—');
{
  const sc = mod.WECHAT_TEMPLATE_SCHEMAS.signupReview;
  check('B1 恰好 4 字段', sc.fields.length === 4, 'len=' + sc.fields.length);
  const keys = sc.fields.map((f) => f.providerKey);
  check('B2 顺序 phrase1/thing2/thing4/time7', JSON.stringify(keys) === JSON.stringify(['phrase1', 'thing2', 'thing4', 'time7']), JSON.stringify(keys));
  const labels = sc.fields.map((f) => f.businessLabel);
  check('B3 业务标签 审核结果/活动名称/活动地点/审批时间', JSON.stringify(labels) === JSON.stringify(['审核结果', '活动名称', '活动地点', '审批时间']), JSON.stringify(labels));
  const types = sc.fields.map((f) => f.type);
  check('B4 类型 phrase/thing/thing/time', JSON.stringify(types) === JSON.stringify(['phrase', 'thing', 'thing', 'time']), JSON.stringify(types));
  check('B5 templateNo=4877', sc.templateNo === '4877');
  check('B6 wxTemplateId 精确', sc.wxTemplateId === 'PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8');
}

// =============================================================================
// C. PAYLOAD 映射（纯函数）
// =============================================================================
console.log('\n— C payload 映射（buildSignupReviewWeChatData）—');
{
  const title = '春季社区志愿清扫';
  const address = '浙江省嘉兴市南湖区中山东路1号';
  const reviewAt = 1700000000; // 固定值，便于确定性校验
  const approved = mod.buildSignupReviewWeChatData({ title, address, decision: 'approve', reviewAt });
  check('C1 approve → phrase1=通过', approved && approved.phrase1 === mod.PHRASE_APPROVED, JSON.stringify(approved));
  check('C2 thing2=活动名称', approved && approved.thing2 === title);
  check('C3 thing4=活动地点', approved && approved.thing4 === address);
  check('C4 time7=formatWeChatTime7(reviewAt)', approved && approved.time7 === mod.formatWeChatTime7(reviewAt));

  const rejected = mod.buildSignupReviewWeChatData({ title, address, decision: 'reject', reviewAt });
  check('C5 reject → phrase1=未通过', rejected && rejected.phrase1 === mod.PHRASE_REJECTED, JSON.stringify(rejected));

  // 确定性 UTC+8：1700000000 秒 = 2023-11-14 22:13:20 UTC → +8 = 2023-11-15 06:13
  check('C6 time7 格式 YYYY-MM-DD HH:mm', approved && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(approved.time7), approved && approved.time7);
  check('C7 time7 为 UTC+8 确定性值', approved && approved.time7 === '2023-11-15 06:13', approved && approved.time7);

  // 跨日确定性：UTC 2023-03-12 20:00:00Z（+8h → 2023-03-13 04:00:00）Shanghai 日期与 UTC 日期不同。
  // 若实现依赖机器本地时区，UTC 机器会得到 UTC 日期 03-12；本实现固定 +8 偏移应得 03-13 04:00。
  const crossDayVal = mod.formatWeChatTime7(1678651200);
  check('C11 time7 跨日确定性（UTC 03-12 20:00Z → 上海 03-13 04:00）', crossDayVal === '2023-03-13 04:00', crossDayVal);
  check('C12 跨日结果格式固定且与时区无关', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(crossDayVal) && crossDayVal === '2023-03-13 04:00', crossDayVal);

  const nullAddr = mod.buildSignupReviewWeChatData({ title, address: null, decision: 'approve', reviewAt });
  check('C8 地址 null → 返回 null（跳过 WeChat）', nullAddr === null);
  const blankAddr = mod.buildSignupReviewWeChatData({ title, address: '   ', decision: 'approve', reviewAt });
  check('C9 地址 blank → 返回 null', blankAddr === null);
  const nullTitle = mod.buildSignupReviewWeChatData({ title: null, address, decision: 'approve', reviewAt });
  check('C10 标题 null → 返回 null', nullTitle === null);
}

// =============================================================================
// D. 缺地址 → 跳过 WeChat + 业务 review 成功
// =============================================================================
console.log('\n— D 缺活动地址（address=NULL）→ 跳过 WeChat，review 仍成功 —');
await scenario('D', async () => {
  await seedIdentity(volD);
  await seedConsent(volD, 'signupReview');
  const { adapter, provider } = mkAdapter('success');
  const svc = mkService(adapter);
  const view = await svc.reviewSignup(actNoAddr, sD, 'approve');
  check('D1 review_status=1（业务成功）', view.signup.review_status === 1, JSON.stringify(view.signup));
  check('D2 provider 未被调用（buildSignupReviewWeChatData 返回 null）', provider.callCount === 0, 'callCount=' + provider.callCount);
  const dels = sqlite.prepare('SELECT * FROM notification_deliveries WHERE user_id=?').all(volD);
  check('D3 无 delivery 记录', dels.length === 0);
  const note = sqlite.prepare("SELECT * FROM notifications WHERE event_type='ACTIVITY_SIGNUP_APPROVED' AND business_entity_id=?").get(sD);
  check('D4 IN_APP 通知仍生成', !!note);
});

// =============================================================================
// E. CONSENT 旧/新 ID 隔离
// =============================================================================
console.log('\n— E consent 旧 No.620 不可用于 signupReview / 新 key 资格 / 重授权恢复 —');
await scenario('E1 旧 No.620 ACCEPT 不继承', async () => {
  await seedIdentity(volE1);
  await seedConsent(volE1, 'signup'); // 仅旧 No.620 授权
  const { adapter, provider } = mkAdapter('success');
  const svc = mkService(adapter);
  const view = await svc.reviewSignup(actMain, sE1, 'approve');
  check('E1.1 review 成功（业务不受影响）', view.signup.review_status === 1);
  check('E1.2 provider 未被调用（无 signupReview 授权）', provider.callCount === 0, 'callCount=' + provider.callCount);
  const dels = sqlite.prepare('SELECT * FROM notification_deliveries WHERE user_id=?').all(volE1);
  check('E1.3 无 delivery 记录', dels.length === 0);
});

await scenario('E2 新 signupReview ACCEPT → 资格齐备 → DELIVERED', async () => {
  await seedIdentity(volE2);
  await seedConsent(volE2, 'signupReview');
  const { adapter, provider } = mkAdapter('success');
  const svc = mkService(adapter);
  const view = await svc.reviewSignup(actMain, sE2, 'approve');
  check('E2.1 review 成功', view.signup.review_status === 1);
  check('E2.2 provider 被调用 1 次', provider.callCount === 1, 'callCount=' + provider.callCount);
  const dels = sqlite.prepare('SELECT * FROM notification_deliveries WHERE user_id=?').all(volE2);
  check('E2.3 生成 1 条 DELIVERED 记录', dels.length === 1 && dels[0].status === 'DELIVERED', JSON.stringify(dels));
  const c = sqlite.prepare("SELECT * FROM wechat_subscription_consents WHERE user_id=? AND template_key='signupReview'").get(volE2);
  check('E2.4 一次性授权已消费', c && c.consumed_at != null);
});

await scenario('E3 重授权（re-consent）恢复资格 → 第二次仍 DELIVERED', async () => {
  await seedIdentity(volE3);
  await seedConsent(volE3, 'signupReview');
  const { adapter, provider } = mkAdapter('success');
  const svc = mkService(adapter);
  const v1 = await svc.reviewSignup(actMain, sE3a, 'approve');
  check('E3.1 第一次 review 成功', v1.signup.review_status === 1);
  check('E3.2 provider 第 1 次调用', provider.callCount === 1, 'callCount=' + provider.callCount);
  const c1 = sqlite.prepare("SELECT * FROM wechat_subscription_consents WHERE user_id=? AND template_key='signupReview'").get(volE3);
  check('E3.3 第一次后授权已消费', c1 && c1.consumed_at != null);
  // 用户再次真实 ACCEPT（重授权）
  await seedConsent(volE3, 'signupReview');
  const c2 = sqlite.prepare("SELECT * FROM wechat_subscription_consents WHERE user_id=? AND template_key='signupReview'").get(volE3);
  check('E3.4 再次 ACCEPT 后 consumed_at 复位', c2 && c2.consumed_at == null);
  const v2 = await svc.reviewSignup(actSecond, sE3b, 'approve');
  check('E3.5 第二次 review 成功', v2.signup.review_status === 1);
  check('E3.6 provider 第 2 次调用（权利恢复）', provider.callCount === 2, 'callCount=' + provider.callCount);
});

// =============================================================================
// F. 原子提交后错误隔离（provider 各种失败均不改 review / IN_APP）
// =============================================================================
console.log('\n— F 原子提交后 best-effort 错误隔离 —');
async function postCommitCase(name, volId, signupId, fakeMode, fakeErrcode, setupIdentity, setupConsent) {
  if (setupIdentity) await seedIdentity(volId);
  if (setupConsent) await seedConsent(volId, 'signupReview');
  const { adapter, provider } = mkAdapter(fakeMode, fakeErrcode);
  const svc = mkService(adapter);
  let threw = false;
  let view = null;
  try { view = await svc.reviewSignup(actMain, signupId, 'approve'); } catch (e) { threw = true; }
  check(`${name} review 不抛错（best-effort）`, threw === false);
  check(`${name} review_status=1（业务成功）`, view && view.signup.review_status === 1, JSON.stringify(view && view.signup));
  const note = sqlite.prepare("SELECT * FROM notifications WHERE event_type='ACTIVITY_SIGNUP_APPROVED' AND business_entity_id=?").get(signupId);
  check(`${name} IN_APP 通知已生成`, !!note);
  return { provider, view };
}
await scenario('F1 provider success', async () => {
  const r = await postCommitCase('F1', volF1, sF1, 'success', undefined, true, true);
  check('F1 provider 被调用 1 次', r.provider.callCount === 1, 'callCount=' + r.provider.callCount);
  const dels = sqlite.prepare('SELECT * FROM notification_deliveries WHERE user_id=?').all(volF1);
  check('F1 生成 DELIVERED 记录', dels.length === 1 && dels[0].status === 'DELIVERED');
});
await scenario('F2 provider RECIPIENT_INVALID（errcode 40003）', async () => {
  const r = await postCommitCase('F2', volF2, sF2, 'reject', 40003, true, true);
  check('F2 provider 仍被调用（错误隔离，非跳过）', r.provider.callCount === 1, 'callCount=' + r.provider.callCount);
});
await scenario('F3 provider AUTH_INVALID / token fail（errcode 40001）', async () => {
  const r = await postCommitCase('F3', volF3, sF3, 'reject', 40001, true, true);
  check('F3 provider 被调用 1 次', r.provider.callCount === 1, 'callCount=' + r.provider.callCount);
});
await scenario('F4 provider NETWORK_ERROR', async () => {
  const r = await postCommitCase('F4', volF4, sF4, 'network', undefined, true, true);
  check('F4 provider 被调用 1 次', r.provider.callCount === 1, 'callCount=' + r.provider.callCount);
});
await scenario('F5 无 consent → NOT_ELIGIBLE（provider 不被调用）', async () => {
  // 有身份、无授权
  const r = await postCommitCase('F5', volF5, sF5, 'success', undefined, true, false);
  check('F5 provider 未被调用', r.provider.callCount === 0, 'callCount=' + r.provider.callCount);
});
await scenario('F6 无投递身份 → NOT_ELIGIBLE（provider 不被调用）', async () => {
  // 有授权、无身份
  const r = await postCommitCase('F6', volF6, sF6, 'success', undefined, false, true);
  check('F6 provider 未被调用', r.provider.callCount === 0, 'callCount=' + r.provider.callCount);
});

// =============================================================================
// G. best-effort 本地幂等（相同 idempotency_key 不二次 provider call）
// =============================================================================
console.log('\n— G best-effort 本地幂等（adapter 级，服务依赖此机制）—');
await scenario('G', async () => {
  await seedIdentity(volG);
  await seedConsent(volG, 'signupReview');
  const { adapter, provider } = mkAdapter('success');
  const data = mod.buildSignupReviewWeChatData({
    title: '春季社区志愿清扫',
    address: '浙江省嘉兴市南湖区中山东路1号',
    decision: 'approve',
    reviewAt: 1700000000,
  });
  const p = { userId: volG, templateKey: 'signupReview', data, idempotencyKey: 'idem-n0e5c-g', page: '/pages/detail/detail?id=x' };
  const r1 = await adapter.send(p);
  const r2 = await adapter.send(p);
  check('G1 两次均 DELIVERED', r1.status === 'DELIVERED' && r2.status === 'DELIVERED', JSON.stringify(r1) + ' / ' + JSON.stringify(r2));
  check('G2 provider 仅被调用 1 次（幂等短路）', provider.callCount === 1, 'callCount=' + provider.callCount);
  const rows = sqlite.prepare("SELECT * FROM notification_deliveries WHERE user_id=? AND idempotency_key='idem-n0e5c-g'").all(volG);
  check('G3 仅 1 条幂等记录', rows.length === 1, 'rows=' + rows.length);
});

// =============================================================================
// J. 真实 throw 隔离（adapter.send 边界真实 throw，业务 review 仍成功）
// =============================================================================
console.log('\n— J 真实 throw 隔离（provider.send 抛错）—');
await scenario('J 真实 throw 隔离', async () => {
  await seedIdentity(volH);
  await seedConsent(volH, 'signupReview');
  let attempted = 0;
  const throwingProvider = {
    async send() {
      attempted++;
      throw new Error('synthetic provider failure');
    },
  };
  const adapter = new mod.WeChatSubscribeAdapter({ env: adapterEnv, provider: throwingProvider });
  const svc = mkService(adapter);
  let threw = false;
  let view = null;
  try { view = await svc.reviewSignup(actMain, sH, 'approve'); } catch (e) { threw = true; }
  check('J1 异常未逃逸到业务 review 调用方（best-effort catch）', threw === false);
  check('J2 review_status=1（业务成功）', view && view.signup.review_status === 1, JSON.stringify(view && view.signup));
  const note = sqlite.prepare("SELECT * FROM notifications WHERE event_type='ACTIVITY_SIGNUP_APPROVED' AND business_entity_id=?").get(sH);
  check('J3 IN_APP 通知仍生成', !!note);
  const dels = sqlite.prepare('SELECT * FROM notification_deliveries WHERE user_id=?').all(volH);
  check('J4 未生成 delivery 记录（provider 抛错前未写入）', dels.length === 0);
  check('J5 provider.send 边界真实被调用并抛出（attempted=1）', attempted === 1, 'attempted=' + attempted);
});

// =============================================================================
// H. 前端 consent（静态校验：signup 成功后才请求、reject/ban/error 不报报名失败）
// =============================================================================
console.log('\n— H 前端 consent 静态校验 —');
{
  const subSrc = readFileSync(join(WORKERS, '..', 'miniprogram', 'utils', 'subscribe.js'), 'utf8');
  const detailSrc = readFileSync(join(WORKERS, '..', 'miniprogram', 'pages', 'detail', 'detail.ts'), 'utf8');
  check('H1 源码不再硬编码 No.4877 template id', !subSrc.includes("PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8"));
  check('H2 使用 server-driven catalog（subscriptionApi.status + signupReview 动态 ID）', subSrc.includes('subscriptionApi') && subSrc.includes("'signupReview'") && subSrc.includes('requestSubscribeMessage'));
  check('H3 旧 SIGNUP_RESULT（No.620）标记已退役', subSrc.includes('已退役') || subSrc.includes('status=2'));
  check('H4 detail.ts 在报名成功后请求订阅且 .catch 包裹（不阻塞报名）', detailSrc.includes('subscribeAfterSignup().catch'));
}

// =============================================================================
// K. 前端 consent 行为（source/deterministic HARNESS_VALIDATION，非运行时集成）
// =============================================================================
console.log('\n— K 前端 consent 行为（HARNESS_VALIDATION：源码级确定性校验）—');
{
  const subSrc = readFileSync(join(WORKERS, '..', 'miniprogram', 'utils', 'subscribe.js'), 'utf8');
  const detailSrc = readFileSync(join(WORKERS, '..', 'miniprogram', 'pages', 'detail', 'detail.ts'), 'utf8');
  const signupIdx = detailSrc.indexOf('.signup(activityId)');
  const subIdx = detailSrc.indexOf('subscribeAfterSignup().catch');
  check('K1 订阅请求位于 signup 成功路径之后（A: signup 失败不请求订阅）', signupIdx >= 0 && subIdx > signupIdx, 'signup@' + signupIdx + ' sub@' + subIdx);
  check('K2 subscribeAfterSignup 触发 signupReview 动态订阅（B）', subSrc.includes('subscribeSignupReview'));
  check('K3 catalog 返回 No.4877 → 使用该动态 ID 传给 wx（C）', subSrc.includes('tpl.template_id'));
  check('K4 源码不含硬编码 No.4877（D）', !subSrc.includes('PGRSuLr34NVlbNE3L33-Dtqm_ad9uG-WSrZ0ew4oYs8'));
  check('K5 accept → recordConsent ACCEPT（E）', subSrc.includes('mapWxResultToState') && subSrc.includes("'ACCEPT'"));
  check('K6 reject → recordConsent REJECT（F）', subSrc.includes("'REJECT'"));
  check('K7 ban → recordConsent BAN（G）', subSrc.includes("'BAN'"));
  check('K8 wx 抛错 / recordConsent 失败 → 整段 try/catch 包裹（H/I: signup 仍成功）', subSrc.includes('catch (e)') && subSrc.includes('non-fatal'));
  check('K9 detail.ts 以 .catch 兜底，订阅失败不影响报名', detailSrc.includes('subscribeAfterSignup().catch'));
}

// =============================================================================
// I. REAL_WECHAT_SEND_CALLS=0
// =============================================================================
console.log('\n— I REAL_WECHAT_SEND_CALLS=0 —');
check('I1 全局 fetch 调用次数=0', realWechatCalls === 0, 'calls=' + realWechatCalls);

// -----------------------------------------------------------------------------
// 汇总
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log(`N0-E5C DETERMINISTIC TEST: ${pass} passed, ${fail} failed`);
console.log('REAL_WECHAT_SEND_CALLS = ' + realWechatCalls);
if (fail > 0) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); }
console.log('========================================');

try { sqlite.close(); } catch {}
try { rmSync(TMP, { force: true }); } catch {}
rmSync(OUT, { force: true });
process.exit(fail > 0 ? 1 : 0);
