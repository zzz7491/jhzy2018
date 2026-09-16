/**
 * P3-D Team V2 Migration —— 前端静态契约（Backend Authority）。
 *
 * 校验目标：
 *   1) 新增 Team 域唯一接入层 utils/teamApi.ts；Team 能力不再寄生于 activityApi / adminApi。
 *   2) Team 页面（teams / select / create）不再散落 wx.request / 手拼 token / 散写 session storage。
 *   3) active team 写入统一经 teamApi.selectActiveTeam（Session Manager 唯一出入口）。
 *   4) 存在统一错误分类（Backend / Network / Unauthorized / Expired / Denied），页面一律使用。
 *   5) Backend Authority 逐能力断言（有无 V2 实现必须与 workers/src 真实一致，禁止伪造）：
 *        - Team Directory  → Legacy（NO V2 IMPLEMENTATION）
 *        - Join Team       → Legacy（numeric id，禁止与 V2 ULID join 混用）
 *        - My Teams        → V2
 *        - Public Contact  → V2
 *        - Create Team     → Legacy（NO V2 IMPLEMENTATION）
 *
 * 运行：node miniprogram/tests/team_v2_contract.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');
const UTILS = join(HERE, '..', 'utils');
const WORKERS = join(HERE, '..', '..', 'workers', 'src');

const read = (p) => readFileSync(p, 'utf8');

let pass = 0;
let fail = 0;
function check(cond, name) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error('  FAIL: ' + name);
  }
}

const F = {
  teamApi: read(join(UTILS, 'teamApi.ts')),
  teams: read(join(PAGES, 'teams', 'teams.ts')),
  select: read(join(PAGES, 'teams', 'select', 'select.ts')),
  create: read(join(PAGES, 'teams', 'create', 'create.ts')),
  activityApi: read(join(UTILS, 'activityApi.ts')),
  adminApi: read(join(UTILS, 'adminApi.ts')),
  beRoute: read(join(WORKERS, 'routes', 'teams.ts')),
  beRepo: read(join(WORKERS, 'repository', 'teams.ts')),
};

// =========================================================================
// 1) Team 域唯一接入层
// =========================================================================
check(/export function getMyTeams/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.getMyTeams');
check(/export function getPublicContact/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.getPublicContact');
check(/export function updatePublicContact/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.updatePublicContact');
check(/export async function listJoinableTeams/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.listJoinableTeams');
check(/export async function joinTeam/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.joinTeam');
check(/export async function createTeam/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.createTeam');
check(/export function selectActiveTeam/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.selectActiveTeam');
check(/export function classifyTeamError/.test(F.teamApi), 'WRAPPER_EXISTS: teamApi.classifyTeamError');

check(/from '\.\/transport'/.test(F.teamApi), 'TRANSPORT_USED: teamApi 复用统一 transport');
check(/from '\.\/session'/.test(F.teamApi), 'SESSION_USED: teamApi 复用统一 session');
check(!/wx\.request\(/.test(F.teamApi), 'NO_RAW_WXREQUEST_IN_WRAPPER: teamApi 不裸调 wx.request');
check(
  !/wx\.(get|set)StorageSync\(/.test(F.teamApi),
  'NO_RAW_STORAGE_IN_WRAPPER: teamApi 经 session 读写，不裸碰 storage',
);

// =========================================================================
// 2) 页面改用 teamApi（Team 能力收敛，不再经 activityApi / adminApi 的 team 方法）
// =========================================================================
check(/from '\.\.\/\.\.\/utils\/teamApi'/.test(F.teams), 'PAGE_TEAMS_IMPORTS_TEAMAPI');
check(/teamApi\.getMyTeams\(\)/.test(F.teams), 'PAGE_TEAMS_USES_getMyTeams');
check(/teamApi\.getPublicContact\(/.test(F.teams), 'PAGE_TEAMS_USES_getPublicContact');
check(/teamApi\.updatePublicContact\(/.test(F.teams), 'PAGE_TEAMS_USES_updatePublicContact');
check(
  !/activityApi\.(getTeamsMine|joinTeam|getTeamPublicContact|updateTeamPublicContact)/
    .test(F.teams),
  'TEAM_NOT_VIA_ACTIVITYAPI: teams 页不再经 activityApi 调 Team 能力',
);
check(/from '\.\.\/\.\.\/\.\.\/utils\/teamApi'/.test(F.select), 'PAGE_SELECT_IMPORTS_TEAMAPI');
check(/listJoinableTeams\(\)/.test(F.select), 'PAGE_SELECT_USES_listJoinableTeams');
check(/joinTeam\(groupId\)/.test(F.select), 'PAGE_SELECT_USES_joinTeam');
check(/from '\.\.\/\.\.\/\.\.\/utils\/teamApi'/.test(F.create), 'PAGE_CREATE_IMPORTS_TEAMAPI');
check(/createTeam\(\{ name, description, color \}\)/.test(F.create), 'PAGE_CREATE_USES_createTeam');

// Activity 域保持原样（禁止跨域改动）
check(/activityApi\.getActivities\(/.test(F.teams), 'ACTIVITY_DOMAIN_UNTouched: 活动仍经 activityApi');

// =========================================================================
// 3) 页面不得裸调网络 / 不得散写会话存储
// =========================================================================
for (const [name, src] of [['teams', F.teams], ['select', F.select], ['create', F.create]]) {
  check(!/wx\.request\(/.test(src), `NO_RAW_WXREQUEST_PAGE_${name}: 页面无裸 wx.request`);
  check(!/api\.jhzyfw\.com/.test(src), `NO_HARDCODED_HOST_PAGE_${name}: 页面无硬编码 API host`);
  check(
    !/wx\.getStorageSync\('access_token'\)/.test(src),
    `NO_TOKEN_RAW_READ_PAGE_${name}: 页面不裸读 legacy token`,
  );
  check(
    !/wx\.setStorageSync\('activeTeamPublicId'/.test(src),
    `NO_ACTIVE_TEAM_RAW_WRITE_PAGE_${name}: 页面不裸写 active team`,
  );
}
check(/selectActiveTeam\(id\)/.test(F.teams), 'ACTIVE_TEAM_VIA_SESSION: teams 页经 teamApi.selectActiveTeam 写入');

// =========================================================================
// 4) 统一错误分类（五类）且页面一律使用
// =========================================================================
for (const kind of ['backend', 'network', 'unauthorized', 'expired', 'denied']) {
  check(F.teamApi.includes(`'${kind}'`), `ERROR_KIND_${kind.toUpperCase()}: 错误分类含 ${kind}`);
}
for (const [name, src] of [['teams', F.teams], ['select', F.select], ['create', F.create]]) {
  check(/classifyTeamError\(/.test(src), `ERROR_CLASSIFIED_PAGE_${name}: 页面统一经 classifyTeamError`);
}

// =========================================================================
// 5) Backend Authority —— 逐能力核对（前端调用形状 vs workers/src 真实实现）
// =========================================================================

// 5.1 Team Directory → Legacy（NO V2 IMPLEMENTATION）
check(/'all_groups\.php'/.test(F.teamApi), 'BA_DIRECTORY_LEGACY: 团队目录走 legacy all_groups.php');
check(
  !/teams\.get\('\/'/.test(F.beRoute) && !/listAll|directory|discover/i.test(F.beRoute + F.beRepo),
  'BA_DIRECTORY_NO_V2: 后端确无团队目录端点（前端走 legacy 有据）',
);

// 5.2 Join Team → Legacy（numeric id；禁止混用 V2 ULID join）
check(/'join_group\.php'/.test(F.teamApi), 'BA_JOIN_LEGACY: 加入团队走 legacy join_group.php');
check(/group_id: groupId/.test(F.teamApi), 'BA_JOIN_NUMERIC_ID: 以 numeric group_id 加入（与目录同源）');
check(
  !/\/teams\/\$\{[^}]*\}\/join/.test(F.teamApi),
  'BA_JOIN_NO_MIXED_ID_SYSTEM: teamApi 不调用 V2 ULID join（禁止 Legacy 列表 + V2 join）',
);
check(
  /teams\.post\('\/:teamId\/join'/.test(F.beRoute) && /requireUlidParam/.test(F.beRoute),
  'BA_JOIN_NO_MIXED_EVIDENCE: V2 join 确要求 ULID（混用必 404/误加入）',
);

// 5.3 My Teams → V2
check(/\/teams\/mine/.test(F.teamApi), 'BA_MYTEAMS_V2: 我的团队走 GET /teams/mine');
check(/teams\.get\('\/mine'/.test(F.beRoute), 'BA_MYTEAMS_V2_EXISTS: 后端 /teams/mine 已实现');

// 5.4 Public Contact → V2（N0-E5B）
check(/\/teams\/\$\{teamId\}\/public-contact/.test(F.teamApi), 'BA_CONTACT_V2: 公开联系人走 /teams/:id/public-contact');
check(/'PATCH'/.test(F.teamApi), 'BA_CONTACT_PATCH: 窄写使用 PATCH');
check(
  /teams\.(get|patch)\('\/:id\/public-contact'/.test(F.beRoute),
  'BA_CONTACT_V2_EXISTS: 后端 public-contact 端点已实现',
);

// 5.5 Create Team → Legacy（NO V2 IMPLEMENTATION）
check(/'create_group\.php'/.test(F.teamApi), 'BA_CREATE_LEGACY: 创建团队走 legacy create_group.php');
check(
  !/teams\.post\('\/'/.test(F.beRoute) && !/async createTeam/.test(F.beRepo),
  'BA_CREATE_NO_V2: 后端确无创建团队端点（角色授予须后端权威）',
);

// 5.6 wrapper 内必须显式标注能力来源（禁止静默 legacy）
check(/NO V2 IMPLEMENTATION/.test(F.teamApi), 'BA_ANNOTATED: wrapper 显式标注 NO V2 IMPLEMENTATION');

if (fail > 0) {
  console.error(`\n  ${fail} assertion(s) failed.`);
  process.exit(1);
}
console.log(`  Team V2 contract: ${pass} assertions PASS`);
