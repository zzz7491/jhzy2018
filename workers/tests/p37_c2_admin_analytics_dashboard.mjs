// workers/tests/p37_c2_admin_analytics_dashboard.mjs
// P37-C2 前端单测 + 结构校验（§18）。
//
// 覆盖范围：
//   A. app registration（analytics 页面已注册，未新增 tabBar）
//   B. endpoint contract（TEAM / PLATFORM 正确 path）
//   C. TEAM headers（active team -> X-Team-Id；不发送 team_id query）
//   D. platform（不发送 team_id；不依赖 active team 决定 scope）
//   E. ranges（today/7d/30d/month；default=7d）
//   F. response（只消费 11 metrics；不客户端重算）
//   G. permissions（入口存在；后端 403 权威；不硬编码 role）
//   H. team missing（无 active team 不调用 team API；显示选团队）
//   I. privacy（无 provider/model/PII/numeric id 泄露）
//   J. structure（无 chart library；tabBar 未变；无新 backend code）
//   K. concurrency（_reqSeq 防旧请求覆盖新请求）

import { build } from 'esbuild';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // workers/tests -> project root
const MINI = join(ROOT, 'miniprogram');
const ENTRY = join(MINI, 'utils', 'analyticsApi.ts');
const APP_JSON = join(MINI, 'app.json');
const PAGE_TS = join(MINI, 'pages', 'admin', 'analytics.ts');
const PAGE_WXML = join(MINI, 'pages', 'admin', 'analytics.wxml');
const ADMIN_TS = join(MINI, 'pages', 'adminPanel', 'adminPanel.ts');
const ADMIN_WXML = join(MINI, 'pages', 'adminPanel', 'adminPanel.wxml');

// ---- mock wx ----
let storage = {};
let requestLog = [];
let responder = null;

globalThis.wx = {
  getStorageSync(k) { return storage[k]; },
  setStorageSync(k, v) { storage[k] = v; },
  request(req) {
    requestLog.push(req);
    if (!responder) { req.fail && req.fail(new Error('no responder set')); return; }
    const res = responder(req);
    if (res && res.__fail) { req.fail && req.fail(res.__err || new Error('network')); return; }
    req.success({ statusCode: res.statusCode, data: res.data });
  },
  showToast() {}, navigateTo() {}, showModal() {}, stopPullDownRefresh() {}, redirectTo() {},
};

// ---- harness ----
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function resetMocks() { storage = {}; requestLog = []; responder = null; }
function setStorage(s) { storage = Object.assign({}, s); }
function setResponder(fn) { responder = fn; }
function lastReq() { return requestLog[requestLog.length - 1]; }
function allUrls() { return requestLog.map((r) => r.url); }
function overviewFixture() {
  return {
    scope: 'team', range: '7d', period: { start: 1700000000, end: 1700086400 },
    metrics: {
      volunteer_count: 10, new_volunteer_count: 2, activity_count: 5, active_activity_count: 3,
      service_participation_count: 8, service_minutes_total: 240, activity_review_pending: 1,
      service_adjustment_pending: 1, community_review_pending: 1, ai_call_count: 4, ai_active_user_count: 3,
    },
  };
}
function okResponderFor(path) {
  return (req) => {
    if (req.url.indexOf(path) === -1) return { statusCode: 404, data: { success: false, error: { code: 'NOT_FOUND', message: '' } } };
    return { statusCode: 200, data: { success: true, data: overviewFixture() } };
  };
}

// ---- load module ----
const out = await build({
  entryPoints: [ENTRY],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const tmp = join(tmpdir(), `p37_c2_analyticsapi_${Date.now()}.mjs`);
await writeFile(tmp, out.outputFiles[0].text);
const mod = await import(pathToFileURL(tmp).href);
const { analyticsApi } = mod;

// ---- capture Page options from analytics.ts (dynamic behavior testing) ----
const pageOut = await build({
  entryPoints: [PAGE_TS],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const pageTmp = join(tmpdir(), `p37_c2_analyticspage_${Date.now()}.mjs`);
await writeFile(pageTmp, pageOut.outputFiles[0].text);
let capturedPage = null;
globalThis.Page = (opts) => { capturedPage = opts; };
await import(pathToFileURL(pageTmp).href);
const PAGE_INITIAL = JSON.parse(JSON.stringify(capturedPage.data));

function banner(t) { console.log('\n=== ' + t + ' ==='); }
const METRIC_NAMES = [
  'volunteer_count', 'new_volunteer_count', 'activity_count', 'active_activity_count',
  'service_participation_count', 'service_minutes_total', 'activity_review_pending',
  'service_adjustment_pending', 'community_review_pending', 'ai_call_count', 'ai_active_user_count',
];

async function main() {
  // ---------- A. app registration ----------
  banner('A. app registration');
  {
    const app = JSON.parse(readFileSync(APP_JSON, 'utf8'));
    assert(Array.isArray(app.pages) && app.pages.includes('pages/admin/analytics'), 'A analytics 页面已注册到 app.json');
    const tabList = (app.tabBar && app.tabBar.list) || [];
    const inTabBar = tabList.some((t) => t.pagePath === 'pages/admin/analytics');
    assert(!inTabBar, 'A analytics 未新增到 tabBar（tabBar 语义不变）');
    assert(tabList.length === 4, 'A tabBar 仍为 4 项（未增加）', `len=${tabList.length}`);
  }

  // ---------- B. endpoint contract ----------
  banner('B. endpoint contract');
  resetMocks();
  setStorage({ activeTeamPublicId: 'TEAM123' });
  setResponder(okResponderFor('/analytics/team/overview'));
  await analyticsApi.getTeamOverview('7d');
  assert(lastReq().url === 'https://api.jhzyfw.com/api/v2/analytics/team/overview?range=7d', 'B TEAM endpoint 正确', lastReq().url);
  resetMocks();
  setStorage({ activeTeamPublicId: 'TEAM123' });
  setResponder(okResponderFor('/analytics/platform/overview'));
  await analyticsApi.getPlatformOverview('30d');
  assert(lastReq().url === 'https://api.jhzyfw.com/api/v2/analytics/platform/overview?range=30d', 'B PLATFORM endpoint 正确', lastReq().url);

  // ---------- C. TEAM headers ----------
  banner('C. TEAM headers');
  resetMocks();
  setStorage({ activeTeamPublicId: 'TEAM123' });
  setResponder(okResponderFor('/analytics/team/overview'));
  await analyticsApi.getTeamOverview('7d');
  {
    const r = lastReq();
    assert(r.header && r.header['X-Team-Id'] === 'TEAM123', 'C active team -> X-Team-Id', r.header && r.header['X-Team-Id']);
    assert(!/team_id/.test(r.url), 'C 客户端不发送 team_id query');
  }

  // ---------- D. platform ----------
  banner('D. platform');
  resetMocks();
  setStorage({}); // 无 active team
  setResponder(okResponderFor('/analytics/platform/overview'));
  await analyticsApi.getPlatformOverview('7d');
  {
    const r = lastReq();
    assert(!r.header || !r.header['X-Team-Id'], 'D platform 不发送 X-Team-Id（不依赖 active team）');
    assert(!/team_id/.test(r.url), 'D platform 不发送 team_id');
  }

  // ---------- E. ranges ----------
  banner('E. ranges');
  for (const range of ['today', '7d', '30d', 'month']) {
    resetMocks();
    setStorage({ activeTeamPublicId: 'TEAM123' });
    setResponder(okResponderFor('/analytics/team/overview'));
    await analyticsApi.getTeamOverview(range);
    assert(lastReq().url.indexOf(`range=${range}`) !== -1, `E range=${range} 正确`, lastReq().url);
  }
  resetMocks();
  setStorage({ activeTeamPublicId: 'TEAM123' });
  setResponder(okResponderFor('/analytics/team/overview'));
  await analyticsApi.getTeamOverview();
  assert(lastReq().url.indexOf('range=7d') !== -1, 'E default range=7d', lastReq().url);

  // ---------- F. response ----------
  banner('F. response (11 metrics)');
  {
    resetMocks();
    setStorage({ activeTeamPublicId: 'TEAM123' });
    setResponder(okResponderFor('/analytics/team/overview'));
    const res = await analyticsApi.getTeamOverview('7d');
    let ok = true;
    for (const m of METRIC_NAMES) { if (typeof res.metrics[m] !== 'number') ok = false; }
    assert(ok, 'F 响应包含全部 11 个 aggregate metrics');
    const src = readFileSync(PAGE_TS, 'utf8');
    let allKeys = true;
    for (const m of METRIC_NAMES) { if (src.indexOf(m) === -1) allKeys = false; }
    assert(allKeys, 'F 页面引用全部 11 metric 名称');
    assert(/buildGroups\(res\.metrics\)/.test(src) || /metrics\[it\.key\]/.test(src), 'F 页面直接消费 res.metrics（不客户端重算）');
  }

  // ---------- G. permissions ----------
  banner('G. permissions (backend-authoritative)');
  {
    const aw = readFileSync(ADMIN_WXML, 'utf8');
    const at = readFileSync(ADMIN_TS, 'utf8');
    assert(/数据运营/.test(aw) && /bindtap="goToAnalytics"/.test(aw), 'G adminPanel 存在「数据运营」入口卡片');
    assert(/goToAnalytics/.test(at), 'G adminPanel.ts 存在 goToAnalytics handler');
    const src = readFileSync(PAGE_TS, 'utf8');
    assert(!/adminInfo\.role\s*===|role\s*===\s*'super_admin'|isSuperAdmin/.test(src), 'G 页面不按 role 硬编码判断权限');
    assert(/showNoPermission/.test(src), 'G 无权限时显示无权限状态（不展示数据）');
  }

  // ---------- H. team missing ----------
  banner('H. team missing');
  {
    const src = readFileSync(PAGE_TS, 'utf8');
    // 实际守卫：if (scope === 'team' && !this.data.hasTeam) return; 早于任何 team API 调用。
    assert(/scope === 'team' && !this\.data\.hasTeam/.test(src), 'H 无 active team 时不调用 team analytics API（if guard 防止 team 请求）');
    assert(/getTeamOverview/.test(src), 'H 页面仍定义 getTeamOverview（仅在 hasTeam 时调用）');
    assert(/showSelectTeam/.test(src), 'H 无 active team 显示「选择团队」状态');
  }

  // ---------- I. privacy ----------
  banner('I. privacy');
  {
    const apiSrc = readFileSync(ENTRY, 'utf8');
    const pageSrc = readFileSync(PAGE_TS, 'utf8');
    const forbidden = ['provider', 'model', 'real_name', 'phone', 'id_card', 'prompt', 'system_prompt'];
    let clean = true; let hit = '';
    for (const f of forbidden) {
      if (apiSrc.indexOf(f) !== -1 || pageSrc.indexOf(f) !== -1) { clean = false; hit = f; }
    }
    assert(clean, 'I 客户端不出现 provider/model/PII/AI prompt 字面量', hit);
    assert(!/team_id=/.test(apiSrc), 'I 不泄露 team_id 等内部参数');
  }

  // ---------- J. structure ----------
  banner('J. structure');
  {
    const pageSrc = readFileSync(PAGE_TS, 'utf8');
    const wxml = readFileSync(PAGE_WXML, 'utf8');
    assert(!/echarts|@antv|antv|f2|ucharts|wxcharts|<ec-canvas|<canvas/.test(pageSrc + wxml), 'J 未引入任何 chart library / canvas 组件');
    const app = JSON.parse(readFileSync(APP_JSON, 'utf8'));
    const tabList = (app.tabBar && app.tabBar.list) || [];
    assert(!tabList.some((t) => t.pagePath === 'pages/admin/analytics'), 'J tabBar 未增加 analytics 入口');
    assert(!/from ['"]\.\.\/\.\.\/workers|require\(['"]workers/.test(pageSrc), 'J 页面不引入 backend code');
  }

  // ---------- K. concurrency ----------
  banner('K. concurrency (stale request protection)');
  {
    const src = readFileSync(PAGE_TS, 'utf8');
    assert(/_reqSeq/.test(src), 'K 使用 _reqSeq 请求序列令牌');
    assert(/seq !== \(this as any\)\._reqSeq/.test(src) || /if \(seq !== .*_reqSeq.*\) return/.test(src), 'K 仅接受最新请求结果（旧请求被丢弃）');
  }

  // ---------- L. dynamic permission/scope behavior (capability-based, no 403 probing) ----------
  banner('L. dynamic scope/permission behavior');
  {
    const flush = () => new Promise((r) => setTimeout(r, 25));
    function newPage() {
      const inst = Object.create(capturedPage);
      inst.data = JSON.parse(JSON.stringify(PAGE_INITIAL));
      inst.setData = function (patch) { Object.assign(this.data, patch); };
      inst._reqSeq = 0;
      return inst;
    }
    function pageResponder(caps, overview) {
      return (req) => {
        const url = req.url || '';
        if (url.indexOf('/users/me') !== -1) {
          return { statusCode: 200, data: { success: true, data: { user: {}, analytics_capabilities: caps } } };
        }
        if (url.indexOf('/analytics/team/overview') !== -1) {
          return { statusCode: 200, data: { success: true, data: Object.assign({ scope: 'team', range: '7d', period: { start: 1, end: 2 } }, overview) } };
        }
        if (url.indexOf('/analytics/platform/overview') !== -1) {
          return { statusCode: 200, data: { success: true, data: Object.assign({ scope: 'platform', range: '7d', period: { start: 1, end: 2 } }, overview) } };
        }
        return { statusCode: 404, data: { success: false, error: { code: 'NOT_FOUND' } } };
      };
    }
    const ov = overviewFixture();

    // B. 无权限 → 0 次 overview 请求（不靠 403 探测）
    resetMocks();
    setStorage({ access_token: 'T', activeTeamPublicId: 'TEAM123' });
    setResponder(pageResponder({ team_view: false, platform_view: false }, ov));
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      const urls = allUrls();
      assert(!urls.some((u) => u.indexOf('/analytics/') !== -1), 'B 无权限 → 0 次 analytics overview 请求（不靠 403 探测）', urls.join('|'));
      assert(pg.data.showNoPermission === true, 'B 无权限 → 显示无权限状态');
      assert(pg.data.scope === '' || pg.data.scope == null, 'B 无权限 → scope 为空');
    }

    // C. 仅 team → TEAM
    resetMocks();
    setStorage({ access_token: 'T', activeTeamPublicId: 'TEAM123' });
    setResponder(pageResponder({ team_view: true, platform_view: false }, ov));
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      const urls = allUrls();
      const team = urls.filter((u) => u.indexOf('/analytics/team/overview') !== -1).length;
      const plat = urls.filter((u) => u.indexOf('/analytics/platform/overview') !== -1).length;
      assert(team === 1 && plat === 0, 'C 仅 team → 恰好 1 次 team overview，0 次 platform', `team=${team} plat=${plat}`);
      assert(pg.data.scope === 'team', 'C 默认 scope=team');
    }

    // D. 仅 platform → PLATFORM
    resetMocks();
    setStorage({ access_token: 'T', activeTeamPublicId: 'TEAM123' });
    setResponder(pageResponder({ team_view: false, platform_view: true }, ov));
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      const urls = allUrls();
      const team = urls.filter((u) => u.indexOf('/analytics/team/overview') !== -1).length;
      const plat = urls.filter((u) => u.indexOf('/analytics/platform/overview') !== -1).length;
      assert(team === 0 && plat === 1, 'D 仅 platform → 恰好 1 次 platform overview，0 次 team', `team=${team} plat=${plat}`);
      assert(pg.data.scope === 'platform', 'D 默认 scope=platform');
    }

    // E. 两者皆有 → 默认 TEAM，可切换 PLATFORM
    resetMocks();
    setStorage({ access_token: 'T', activeTeamPublicId: 'TEAM123' });
    setResponder(pageResponder({ team_view: true, platform_view: true }, ov));
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      const urls1 = allUrls();
      const team1 = urls1.filter((u) => u.indexOf('/analytics/team/overview') !== -1).length;
      assert(team1 === 1, 'E 两者皆有 → 默认 1 次 team overview', `team=${team1}`);
      assert(pg.data.scope === 'team', 'E 默认 scope=team');
      // 切换到 platform
      resetMocks();
      setResponder(pageResponder({ team_view: true, platform_view: true }, ov));
      await pg.switchScope({ currentTarget: { dataset: { scope: 'platform' } } });
      await flush();
      const urls2 = allUrls();
      const plat2 = urls2.filter((u) => u.indexOf('/analytics/platform/overview') !== -1).length;
      assert(plat2 === 1, 'E 切换后 → 1 次 platform overview', `plat=${plat2}`);
      assert(pg.data.scope === 'platform', 'E 切换后 scope=platform');
    }

    // F. 持有 team 权限但无 active team → TEAM_CONTEXT_MISSING（非 NO_PERMISSION），0 请求
    resetMocks();
    setStorage({ access_token: 'T' }); // 无 activeTeamPublicId
    setResponder(pageResponder({ team_view: true, platform_view: false }, ov));
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      const urls = allUrls();
      assert(!urls.some((u) => u.indexOf('/analytics/') !== -1), 'F team 权限但无 team → 0 次 overview 请求', urls.join('|'));
      assert(pg.data.showSelectTeam === true, 'F 显示「请先选择团队」');
      assert(pg.data.showNoPermission !== true, 'F 不是 NO_PERMISSION');
      assert(pg.data.canTeam === true, 'F capability 仍记录 canTeam=true（持有团队权限）');
    }

    // I. 权限发现不依赖 analytics 端点 403：即便 team overview 返回 403，也不改变 scope 判定
    resetMocks();
    setStorage({ access_token: 'T', activeTeamPublicId: 'TEAM123' });
    setResponder((req) => {
      const url = req.url || '';
      if (url.indexOf('/users/me') !== -1) return { statusCode: 200, data: { success: true, data: { user: {}, analytics_capabilities: { team_view: true, platform_view: false } } } };
      if (url.indexOf('/analytics/team/overview') !== -1) return { statusCode: 403, data: { success: false, error: { code: 'FORBIDDEN' } } };
      return { statusCode: 404, data: { success: false, error: { code: 'NOT_FOUND' } } };
    });
    {
      const pg = newPage();
      await pg.onLoad();
      await flush();
      // 403 是真实数据拉取失败，不是权限探测；scope 仍由 capability 决定为 team
      assert(pg.data.scope === 'team', 'I scope 由 capability 决定为 team（不靠 403 探测）');
      assert(pg.data.loadError && pg.data.loadError.length > 0, 'I team 请求 403 表现为数据加载失败（非权限发现）');
    }
  }

  // ---- summary ----
  await rm(tmp, { force: true }).catch(() => {});
  await rm(pageTmp, { force: true }).catch(() => {});
  console.log('\n========================================');
  console.log(`P37-C2 FRONTEND TEST: PASS=${pass}  FAIL=${fail}`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
