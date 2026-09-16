/**
 * P3-C Profile V2 Migration —— 前端静态契约。
 *
 * 校验目标（Backend Authority First）：
 *   1) 新增统一接入层 utils/profileApi.ts，Profile 域能力（资料读 / 资料写 / 改密 / 头像）集中于此。
 *   2) Profile 页面不再散落 wx.request / wx.uploadFile / jhzyRequest / request() 直调。
 *   3) 头像上传不再散落 wx.setStorageSync('userInfo')，统一经 session.setUserInfo。
 *   4) 改密后清理会话统一经 session.clearSession()（唯一登出出口），不得各自 removeStorage。
 *   5) 存在统一错误分类（Backend / Network / Unauthorized / Expired / Denied）。
 *   6) V2 能力经 transport.send 打到 /api/v2/users/me（不伪造未实现的端点）。
 *   7) 回归：P3-B 认证范式（authApi / session）不被破坏。
 *
 * 运行：node miniprogram/tests/profile_v2_contract.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');
const UTILS = join(HERE, '..', 'utils');

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
  profileApi: read(join(UTILS, 'profileApi.ts')),
  session: read(join(UTILS, 'session.ts')),
  edit: read(join(PAGES, 'profile', 'edit', 'edit.ts')),
  changePwd: read(join(PAGES, 'profile', 'change-password', 'change-password.ts')),
  mine: read(join(PAGES, 'mine', 'mine.ts')),
  authApi: read(join(UTILS, 'authApi.ts')),
};

console.log('P3-C Profile V2 Contract');
console.log('------------------------');

// 1) 统一接入层存在且导出 Profile 四能力 + 错误分类
check(/export async function getProfile\b/.test(F.profileApi), 'profileApi: getProfile 存在');
check(/export async function updateProfile\b/.test(F.profileApi), 'profileApi: updateProfile 存在');
check(/export async function changePassword\b/.test(F.profileApi), 'profileApi: changePassword 存在');
check(/export async function uploadAvatar\b/.test(F.profileApi), 'profileApi: uploadAvatar 存在');
check(/export async function getV2Profile\b/.test(F.profileApi), 'profileApi: getV2Profile 存在（V2 投影能力）');
check(/export function classifyProfileError\b/.test(F.profileApi), 'profileApi: 统一错误分类存在');

// 2) 错误分类覆盖 5 类
check(/'backend'/.test(F.profileApi), 'profileApi: 覆盖 Backend Error');
check(/'network'/.test(F.profileApi), 'profileApi: 覆盖 Network Error');
check(/'unauthorized'/.test(F.profileApi), 'profileApi: 覆盖 Unauthorized');
check(/'expired'/.test(F.profileApi), 'profileApi: 覆盖 Session Expired');
check(/'denied'/.test(F.profileApi), 'profileApi: 覆盖 Permission Denied');

// 3) V2 路径必须经 transport.send 打到 /users/me；不得伪造未实现端点
check(/from '\.\/transport'/.test(F.profileApi), 'profileApi: 复用 transport（统一 Header/Error/Send）');
check(/\/users\/me/.test(F.profileApi), 'profileApi: V2 端点为 /users/me');
check(/send</.test(F.profileApi), 'profileApi: V2 调用经 transport.send');
check(
  !/send<\w+>\('(PATCH|PUT|POST)'/.test(F.profileApi),
  'profileApi: 不伪造 V2 写端点（后端无 PATCH/PUT /users/me）',
);

// 4) Legacy 端点集中声明、禁止使用 any 逃逸（不使用 @ts-ignore / @ts-nocheck）
check(!/@ts-ignore|@ts-nocheck/.test(F.profileApi), 'profileApi: 未使用 @ts-ignore / @ts-nocheck');
check(
  /user_profile\.php/.test(F.profileApi) &&
    /update_profile\.php/.test(F.profileApi) &&
    /change_password\.php/.test(F.profileApi) &&
    /upload_avatar\.php/.test(F.profileApi),
  'profileApi: 4 个 legacy Profile 端点集中声明',
);
check(/NO V2 IMPLEMENTATION/.test(F.profileApi), 'profileApi: 显式标注 NO V2 IMPLEMENTATION（禁止猜测）');

// 5) Profile 页面不得散落直调
for (const [name, src] of [
  ['edit.ts', F.edit],
  ['change-password.ts', F.changePwd],
]) {
  check(!/wx\.request\(/.test(src), name + ': 不再使用 wx.request');
  check(!/jhzyRequest/.test(src), name + ': 不再直接依赖 jhzyRequest');
  check(!/from '\.\.\/\.\.\/utils\/request'/.test(src), name + ': 不再 import utils/request');
  check(/utils\/profileApi/.test(src), name + ': 统一经 utils/profileApi');
}
check(!/wx\.uploadFile\(/.test(F.mine), 'mine.ts: 不再散落 wx.uploadFile');
check(/uploadAvatar\(/.test(F.mine), 'mine.ts: 头像上传统一经 profileApi.uploadAvatar');

// 6) Session 统一
check(/export function setUserInfo\b/.test(F.session), 'session: 新增 setUserInfo 唯一写入口');
check(/setUserInfo\(/.test(F.edit), 'edit.ts: 缓存更新经 session.setUserInfo');
check(/setUserInfo\(/.test(F.mine), 'mine.ts: 缓存更新经 session.setUserInfo');
check(
  !/wx\.setStorageSync\('userInfo'/.test(F.edit) && !/wx\.setStorageSync\('userInfo'/.test(F.mine),
  'Profile 页面: 不再散写 wx.setStorageSync(userInfo)',
);
check(/clearSession\(\)/.test(F.changePwd), 'change-password.ts: 改密后经 session.clearSession');
check(
  !/wx\.removeStorageSync\('access_token'\)/.test(F.changePwd),
  'change-password.ts: 不再各自 removeStorage',
);

// 7) 回归：P3-B 认证范式不被破坏
check(/export async function wechatLogin\b/.test(F.authApi), 'regression: P3-B authApi 仍存在');
check(/export function setLegacyLogin\b/.test(F.session), 'regression: session.setLegacyLogin 仍存在');
check(/export function saveV2Session\b/.test(F.session), 'regression: session.saveV2Session 仍存在');

console.log('------------------------');
console.log('PASS: ' + pass);
console.log('FAIL: ' + fail);
console.log('TOTAL: ' + (pass + fail));

if (fail > 0) process.exit(1);
