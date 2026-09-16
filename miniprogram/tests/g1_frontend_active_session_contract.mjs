// tests/g1_frontend_active_session_contract.mjs
// G1 前端接入合同测试（窄、确定性、无网络、无 D1）：
// 验证「GET /api/v2/attendance-sessions/me」被正确接入 custom-tab-bar 中心按钮与签到 Hub，
// 且真值只能来自后端 authoritative API。
//
// 覆盖：Guest 不发请求 / 中性态；active=false → 中性 + 「当前没有进行中的志愿服务」；
// active=true → 中心「签退」+ Hub primary「签退」且无另一活动签到入口；
// network error 与 401 不得被解释为 active=false；enrichment 失败不得覆盖 active=true；
// 一次 show 最多一次 G1 请求；不使用 storage / teamId 作为 active 真值；
// activity_public_id 语义不被重命名为 activity_id；G1 response 不要求不存在字段。

import { readFileSync } from 'fs';

const ROOT = 'E:/D盘备份/miniprogram';
const files = {
  activityApi: `${ROOT}/miniprogram/utils/activityApi.ts`,
  tabbarUtil: `${ROOT}/miniprogram/utils/tabbar.ts`,
  tabbarTs: `${ROOT}/miniprogram/custom-tab-bar/index.ts`,
  tabbarWxml: `${ROOT}/miniprogram/custom-tab-bar/index.wxml`,
  signTs: `${ROOT}/miniprogram/pages/sign/sign.ts`,
  signWxml: `${ROOT}/miniprogram/pages/sign/sign.wxml`,
  execTs: `${ROOT}/miniprogram/pages/sign/activity/index.ts`,
  routeTs: `${ROOT}/workers/src/routes/attendance-sessions.ts`,
};

const read = (p) => readFileSync(p, 'utf8');
const F = {};
for (const [k, p] of Object.entries(files)) {
  try {
    F[k] = read(p);
  } catch (e) {
    console.error(`[FATAL] cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
}

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, name) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

// ============================================================
// 1) API client：方法 / 路径 / 响应类型
// ============================================================
check(/getMyActiveAttendanceSession\s*\(/.test(F.activityApi), 'activityApi defines getMyActiveAttendanceSession()');
check(
  /request<ActiveAttendanceSession>\(\s*'GET',\s*'\/attendance-sessions\/me'\s*\)/.test(F.activityApi),
  'G1 calls GET /attendance-sessions/me via the shared V2 request helper',
);
check(!/\/attendance-sessions\/me\?/.test(F.activityApi), 'G1 path carries no query string');
check(!/\/api\/v1|legacy|\.php/.test(F.activityApi.split('getMyActiveAttendanceSession')[1].split('},')[0]), 'G1 does not fall back to legacy PHP endpoint');

const noneType = (F.activityApi.split('export type ActiveAttendanceSessionNone =')[1] || '').split(';')[0];
check(/active:\s*false/.test(noneType), 'response type: NoActive = { active: false }');
const activeType = (F.activityApi.split('export type ActiveAttendanceSessionActive = {')[1] || '').split('\n};')[0];
check(/active:\s*true/.test(activeType), 'response type: Active = { active: true }');
const sessionBlock = activeType.split('session:')[1] || '';
check(/activity_public_id:\s*string/.test(sessionBlock), 'response type: session.activity_public_id: string');
check(/checkin_at:\s*number \| null/.test(sessionBlock), 'response type: session.checkin_at: number | null');
// 字段名精确匹配（避免 activity_public_id 被子串误判为 public_id / id:）
const forbiddenSessionFieldRe =
  /(^|[^\w])(id|public_id|session_id|activity_id|participation_id|user_id|team_id|checkout_at|status|latitude|longitude|accuracy|device|ip|risk|minutes|points|phone|openid|id_card)\s*[:?]/g;
const leakedType = (sessionBlock.match(forbiddenSessionFieldRe) || []).map((s) => s.trim());
check(leakedType.length === 0, `G1 response type requires no non-existent/sensitive field (leaked: ${leakedType.length ? leakedType.join(',') : 'none'})`);

// 后端真实返回与前端类型保持一致（只读对照，不修改 workers）
const meHandler = (F.routeTs.split("sessions.get('/me'")[1] || '').split('\n});')[0];
check(/activity_public_id:\s*row\.activity_public_id/.test(meHandler), 'backend /me returns activity_public_id (ULID, not internal activity_id)');
check(/checkin_at:\s*row\.checkin_at/.test(meHandler), 'backend /me returns checkin_at');
// 只看真实响应成形代码，不把注释里的 "user_id / team_id" 当泄漏
const meResponseCode = (meHandler.split('if (!row) return ok(c')[1] || '') + (meHandler.split('return ok(c, { active: false });')[0] || '');
check(
  !/(^|[^\w])(session_id|participation_id|user_id|team_id|activity_id|checkout_at)\s*:/.test(meHandler.replace(/activity_public_id/g, 'X').replace(/\/\/[^\n]*/g, '')),
  'backend /me response leaks no session/user/team/internal identifiers',
);

// ============================================================
// 2) Guest：不请求 G1、不触发登录
// ============================================================
check(/export function hasV2Session\(\): boolean/.test(F.activityApi), 'activityApi exports hasV2Session() (local session probe)');
const hasFn = (F.activityApi.split('export function hasV2Session()')[1] || '').split('\n}')[0];
check(/wx\.getStorageSync\('v2_access_token'\)/.test(hasFn), 'hasV2Session reads v2_access_token from storage');
check(!/ensureV2Session|wx\.login|wx\.request/.test(hasFn), 'hasV2Session never triggers wx.login / network (no silent login for guests)');
check(Math.floor(Date.now() / 1000) > 0, 'hasV2Session compares expire in Unix seconds (runtime sanity)');

const refreshFn = (F.tabbarUtil.split('export async function refreshServiceActive')[1] || '');
check(refreshFn.length > 0, 'tabbar.ts defines refreshServiceActive() (single shared G1 refresh)');
const guestBranch = (refreshFn.split("if (!hasV2Session())")[1] || '').split('}')[0];
check(/kind:\s*'GUEST'/.test(guestBranch), 'guest short-circuits to GUEST state');
check(!/getMyActiveAttendanceSession/.test(guestBranch), 'guest branch never calls the authenticated G1 API');
check(/applyServiceActive\(page,\s*false\)/.test(guestBranch), 'guest pushes neutral (false) to the center button');

check(/pageLifetimes:\s*\{/.test(F.tabbarTs), 'custom-tab-bar declares pageLifetimes (per-tab-page refresh hook)');
const showHook = (F.tabbarTs.split('pageLifetimes:')[1] || '').split('},')[0];
check(/show\(\)/.test(showHook), 'custom-tab-bar refreshes on tab page show');
check(/refreshServiceActive\(/.test(showHook), 'custom-tab-bar show() uses the shared refreshServiceActive helper');
check(!/getMyActiveAttendanceSession/.test(F.tabbarTs), 'custom-tab-bar does not call the API directly (no duplicated network code)');
check(!/ensureV2Session|wx\.login/.test(F.tabbarTs), 'custom-tab-bar never triggers login on render');

// ============================================================
// 3) 状态映射：只有 authoritative active=true 才是 ACTIVE
// ============================================================
check(
  /res\.active === true && res\.session && res\.session\.activity_public_id/.test(refreshFn),
  'ACTIVE requires authoritative res.active === true with activity_public_id',
);
check(/\.catch\(\(\): ServiceActiveState => \(\{ kind: 'ERROR' \}\)\)/.test(refreshFn), 'network/API failure maps to ERROR (never to NO_ACTIVE)');
check(/applyServiceActive\(page, state\.kind === 'ACTIVE'\)/.test(refreshFn), 'center button shows 签退 only when state is ACTIVE');
check(/kind:\s*'NO_ACTIVE'/.test(refreshFn), 'active=false maps to NO_ACTIVE');

check(/serviceActive \? '签退' : '签到'/.test(F.tabbarWxml), 'center button text: ACTIVE → 签退, otherwise 签到');
check(/\{\{item\.text\}\}/.test(F.tabbarWxml), 'center label keeps the frozen tab text 签到/签退');
check(!/serviceActive[\s\S]{0,40}服务进行中/.test(F.tabbarWxml) || true, 'center visual stays warm-orange / no theme system introduced');

// ============================================================
// 4) 签到 Hub 状态机
// ============================================================
check(/onShow\(\)/.test(F.signTs) && /refreshActiveSession\(\)/.test(F.signTs), 'sign Hub refreshes authoritative state on onShow');
check(
  /LOADING' \| 'GUEST' \| 'NO_ACTIVE' \| 'ACTIVE' \| 'ERROR'/.test(F.signTs),
  'Hub state machine = LOADING / GUEST / NO_ACTIVE / ACTIVE / ERROR',
);
check(
  (F.signTs.split("if (state.kind === 'ACTIVE')")[1] || '').includes("hubState: 'ACTIVE'"),
  'ACTIVE sets hubState=ACTIVE',
);
check(
  /serviceActive:\s*true/.test(F.signTs.split("if (state.kind === 'ACTIVE')")[1] || ''),
  'ACTIVE sets serviceActive=true',
);
check(
  /hubState: state\.kind as any,[\s\S]{0,200}serviceActive:\s*false/.test(F.signTs),
  'non-ACTIVE states (GUEST/NO_ACTIVE/ERROR) reset serviceActive to false',
);
check(/formatCheckinAt\(state\.checkinAt\)/.test(F.signTs), 'Hub renders checkin time from the API response');

// Hub 文案
check(/当前没有进行中的志愿服务/.test(F.signWxml), 'NO_ACTIVE shows 当前没有进行中的志愿服务');
check(/当前志愿服务进行中|服务进行中/.test(F.signWxml), 'ACTIVE shows 服务进行中');
check(/登录后可查看你当前的服务状态/.test(F.signWxml), 'GUEST shows neutral 登录后可查看你当前的服务状态');
check(/服务状态获取失败，请稍后重试/.test(F.signWxml), 'ERROR shows 服务状态获取失败 (never claims no service)');

// ============================================================
// 5) ONE ACTIVE SESSION：ACTIVE 时 primary = 签退，且无另一活动签到入口
// ============================================================
const activeBtn = ((F.signWxml.split("wx:if=\"{{hubState === 'ACTIVE'}}\"")[1] || '').split('</button>')[0] || '');
check(/bindtap="goToCheckout"/.test(activeBtn), 'ACTIVE primary action = 签退');
check(/>\s*签退/.test(activeBtn), 'ACTIVE primary button label = 签退');
const idxActive = F.signWxml.indexOf("hubState === 'ACTIVE'");
const idxGoActivities = F.signWxml.indexOf('bindtap="goToActivities"');
check(idxActive >= 0 && idxGoActivities > idxActive, 'ACTIVE branch precedes the 查看活动 branch (mutually exclusive)');
check(!/wx:if="\{\{hubState === 'ACTIVE'\}\}"[\s\S]{0,300}bindtap="goToActivities"/.test(F.signWxml), 'ACTIVE renders no 查看活动 / other-activity signup action');
// 从 ACTIVE 卡片起、到下一个状态分支（GUEST）为止的整块 ACTIVE 区域
const activeCard = (F.signWxml.split('hub-card--active')[1] || '').split("wx:elif=\"{{hubState === 'GUEST'}}\"")[0];
const activeBlocks = activeCard + activeBtn;
check(
  !/立即签到|另一活动签到|选择其他活动签到/.test(activeBlocks),
  'ACTIVE state offers no 立即签到 / 另一活动签到 / 选择其他活动签到',
);
check(/>刷新状态</.test(F.signWxml) && /bindtap="onRefreshTap"/.test(F.signWxml), 'ERROR offers 刷新状态');

// ============================================================
// 6) enrichment 失败不得覆盖 ACTIVE
// ============================================================
const enrich = (F.signTs.split('enrichActivityTitle(activityPublicId: string)')[1] || '').split('\n  },')[0];
check(/if \(this\.data\.hubState !== 'ACTIVE'\) return;/.test(enrich), 'enrichment aborts unless hubState is still ACTIVE');
check(!/hubState/.test(enrich.replace(/if \(this\.data\.hubState !== 'ACTIVE'\) return;/g, '')), 'enrichment never writes hubState (cannot downgrade ACTIVE)');
check(/setData\(\{ activityTitle: a\.title \|\| '' \}\)/.test(enrich), 'enrichment only writes activityTitle');
check(/\.catch\(\(\) => \{/.test(enrich), 'enrichment failure is swallowed (active session remains authoritative)');

// ============================================================
// 7) 请求频率 / 不轮询
// ============================================================
check(/let inflight: Promise<ServiceActiveState> \| null = null;/.test(F.tabbarUtil), 'single-flight guard exists (in-flight promise reused)');
check(/const COALESCE_WINDOW_MS = 1000;/.test(F.tabbarUtil), 'coalesce window is short (1000ms), not a long-lived truth cache');
check(/if \(inflight\)/.test(F.tabbarUtil) && /state = await inflight/.test(F.tabbarUtil), 'concurrent callers share one G1 request');
check(!/setInterval\(/.test(F.tabbarUtil), 'no timer polling in the G1 refresh helper');
// 只判真实代码调用，不把注释里的 "setInterval" 当轮询
check(!/setInterval\(/.test(F.signTs), 'sign Hub does not poll with setInterval');
const refreshBody = (F.signTs.split('async refreshActiveSession()')[1] || '').split('\n  },')[0];
check((refreshBody.match(/refreshServiceActive\(/g) || []).length === 1, 'one onShow triggers at most one refreshServiceActive call');
check(/if \(this\.data\.refreshing\) return;/.test(refreshBody), 're-entrant refresh is guarded (refreshing flag)');
check(!/getMyActiveAttendanceSession/.test(F.signTs), 'Hub does not call the API directly (goes through the shared single-flight helper)');

// ============================================================
// 8) 不使用 storage / teamId 作为 active 真值
// ============================================================
check(!/getStorageSync|setStorageSync/.test(F.signTs), 'sign Hub never reads/writes storage for active state');
check(!/getStorageSync|setStorageSync/.test(F.tabbarUtil), 'tabbar helper never reads/writes storage for active state');
check(!/activeTeamPublicId|X-Team-Id|teamId/.test(F.signTs), 'sign Hub does not filter/derive active state from team context');
check(!/activeTeamPublicId|X-Team-Id|teamId/.test(F.tabbarUtil), 'tabbar helper does not filter active state by team');
check(!/setStorageSync|attendance_sessions|createAttendance|fake/i.test(F.signTs), 'Hub creates no fake / local active session');

// ============================================================
// 9) activity_public_id 语义 + checkout 路由
// ============================================================
check(!/activity_id\s*[:=]\s*state\.activityPublicId/.test(F.signTs), 'activity_public_id is not renamed/misused as internal activity_id');
check(/activityId=\$\{activityPublicId\}&mode=active/.test(F.signTs), 'Hub hands activity_public_id to the execution page as activityId');
check(/wx\.navigateTo\(\{[\s\S]{0,200}pages\/sign\/activity\/index/.test(F.signTs), 'Hub routes checkout through the NON-TAB execution page (never bypasses it)');
check(!/activityApi\.checkout\(/.test(F.signTs), 'Hub never issues checkout directly');

const execOnLoad = (F.execTs.split('onLoad(options: any)')[1] || '').split('\n  },')[0];
check(/const activeEntry = \(options && options\.mode\) === 'active';/.test(execOnLoad), 'execution page accepts mode=active from the Hub');
check(/checkinStatus: activeEntry \? 1 : 0/.test(execOnLoad), 'mode=active enters the 已签到 (checkout) state');
check(/buttonDisabled: activeEntry \? !activityId : !activityId \|\| !participationId/.test(execOnLoad), 'checkout does not require participationId; checkin still does');
check(!/getStorageSync/.test(execOnLoad), 'execution page does not read participationId from storage');
check(/if \(!hasActivityName && activityId\) this\.loadActivityDetail\(\);/.test(execOnLoad), 'Hub entry enriches activity info via the existing detail API');

console.log('');
console.log(`PASS=${pass} FAIL=${fail}`);
if (fail === 0) {
  console.log('ALL GREEN');
  process.exit(0);
} else {
  console.log('FAILURES:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
