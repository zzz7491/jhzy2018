// utils/authApi.ts
// P3-B Authentication Domain 统一客户端。
//
// 纪律（与 P2-B / P2-C 一致）：
// - 本文件是【唯一】认证接入层；页面 / app 不得再各自 wx.request 登录端点或散写 token。
// - V2 认证能力（/api/v2/auth/*）：统一走 transport.send（Header / Error / Transport 单一权威）。
// - Legacy 凭证认证（login.php / admin_login.php / register.php / get_openid.php / wxlogin.php）：
//   仍走 legacy PHP 端点（utils/request，jhzyRequest）——V2 后端【无】对应端点
//   （NO V2 IMPLEMENTATION：V2 auth.ts 仅有 wechat/login + 会话管理），故凭证登录保留 legacy；
//   但其登录态写入统一经 Session Manager（setLegacyLogin / setLegacyPending），消除页面内散落的
//   wx.setStorageSync('access_token'/'userInfo'/'isLoggedIn'/'token_expire'/'adminInfo')。
// - 禁止：Workers / DB / Migration / 页面 UI。仅 Authentication / Transport / Session / Wrapper / Request。

import { send } from './transport';
import { resolveV2Base } from './apiEnv';
import { saveV2Session, getV2Token, setLegacyLogin, setLegacyPending } from './session';
import jhzyRequest from './request';

const V2_BASE = resolveV2Base();
const LEGACY_EXPIRE_SECONDS = 30 * 24 * 60 * 60;

// ============================== V2 认证能力（/api/v2/auth/*） ==============================

export interface V2WechatLoginResult {
  token: string;
  expiresAt: number;
  isNewUser: boolean;
  user: { public_id: string | null; nickname: string | null; cert_level: number | null };
}

/**
 * POST /api/v2/auth/wechat/login —— code 换取 V2 Bearer 会话（不透明 D1 Session Token）。
 * 成功后持久化 v2_access_token / v2_token_expire（Unix 秒，与后端 expires_at 同单位）。
 */
export async function wechatLogin(code: string): Promise<V2WechatLoginResult> {
  const data = await send<{ token: string; expires_at: number; is_new_user: boolean; user: any }>(
    'POST',
    V2_BASE + '/auth/wechat/login',
    { code },
    { token: '', teamScoped: false },
  );
  saveV2Session(data.token, data.expires_at);
  return {
    token: data.token,
    expiresAt: data.expires_at,
    isNewUser: !!data.is_new_user,
    user: data.user || { public_id: null, nickname: null, cert_level: null },
  };
}

/** POST /api/v2/auth/logout —— 撤销当前 V2 会话（best-effort，失败不影响本地登出）。 */
export async function logoutV2(): Promise<void> {
  try {
    await send('POST', V2_BASE + '/auth/logout', {}, { token: getV2Token(), teamScoped: false });
  } catch (e) {
    // best-effort：服务端会话撤销失败（网络/已撤销）不影响本地清理
  }
}

/** POST /api/v2/auth/logout-all —— 全端下线（仅本人）。返回受影响会话数。 */
export async function logoutAllV2(): Promise<number> {
  const data = await send<{ revoked: number }>('POST', V2_BASE + '/auth/logout-all', {}, {
    token: getV2Token(),
    teamScoped: false,
  });
  return data.revoked || 0;
}

/** GET /api/v2/auth/sessions —— 当前用户会话（设备）列表。 */
export async function listSessions(): Promise<any[]> {
  const data = await send<{ items: any[] }>('GET', V2_BASE + '/auth/sessions', {}, {
    token: getV2Token(),
    teamScoped: false,
  });
  return data.items || [];
}

/** POST /api/v2/auth/session/rotate —— 轮换当前会话令牌。 */
export async function rotateSession(): Promise<{ token: string; expiresAt: number }> {
  const data = await send<{ token: string; expires_at: number }>('POST', V2_BASE + '/auth/session/rotate', {}, {
    token: getV2Token(),
    teamScoped: false,
  });
  saveV2Session(data.token, data.expires_at);
  return { token: data.token, expiresAt: data.expires_at };
}

// ============================== Legacy 凭证认证（PHP，保留） ==============================

/** 从 legacy PHP 响应中安全提取 openid（兼容 {openid} 与 {data:{openid}} 两种信封）。 */
function extractOpenid(res: any): string {
  if (res && typeof res.openid === 'string' && res.openid) return res.openid;
  if (res && res.data && typeof res.data.openid === 'string' && res.data.openid) return res.data.openid;
  if (res && res.data && res.data.data && typeof res.data.data.openid === 'string') return res.data.data.openid;
  return '';
}

/** POST login.php —— 志愿者手机号 + 密码登录。登录态统一经 Session Manager 写入。 */
export async function legacyVolunteerLogin(
  account: string,
  password: string,
  openid?: string,
): Promise<{ userInfo: any }> {
  let postData = `account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}`;
  if (openid && !openid.startsWith('ADMIN_')) postData += `&openid=${encodeURIComponent(openid)}`;

  const res: any = await jhzyRequest({
    url: 'login.php',
    method: 'POST',
    data: postData,
    header: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (res.code !== 0) throw res.msg || '登录失败';

  const token = res.token || (res.data && res.data.token);
  const userInfoData = (res.data && res.data.user_info) || res.user_info;
  const userInfo = {
    id: userInfoData?.id,
    username: userInfoData?.real_name || userInfoData?.username,
    real_name: userInfoData?.real_name,
    phone: userInfoData?.phone,
    points: userInfoData?.current_points || 0,
    volunteer_id: userInfoData?.volunteer_id,
    activity_count: userInfoData?.activity_count || 0,
    service_hours: userInfoData?.service_hours || 0,
    current_points: userInfoData?.current_points || 0,
    total_points: userInfoData?.total_points || 0,
  };

  setLegacyLogin(token, userInfo, Math.floor(Date.now() / 1000) + LEGACY_EXPIRE_SECONDS);
  return { userInfo };
}

/** POST admin_login.php —— 管理员账号 + 密码登录。 */
export async function legacyAdminLogin(
  account: string,
  password: string,
): Promise<{ userInfo: any; adminInfo: any }> {
  const res: any = await jhzyRequest({
    url: 'admin_login.php',
    method: 'POST',
    data: { username: account, password },
  });

  if (res.success !== true) throw res.message || '登录失败';

  const adminData = res.data;
  const adminRole = adminData.role;
  const adminInfo = {
    id: adminData.id,
    name: adminData.real_name,
    username: adminData.username,
    role: adminRole,
    email: adminData.email,
  };
  const userInfo = {
    id: adminData.id,
    real_name: adminData.real_name,
    username: adminData.username,
    email: adminData.email,
    role: adminRole,
    is_admin: true,
  };

  setLegacyLogin(adminData.token || '', userInfo, Math.floor(Date.now() / 1000) + LEGACY_EXPIRE_SECONDS, adminInfo);
  return { userInfo, adminInfo };
}

/**
 * 获取 openid（注册/登录前置）。mode='login' 走 get_openid.php；mode='wxlogin' 走 wxlogin.php。
 */
export async function legacyGetOpenid(code: string, mode: 'login' | 'wxlogin'): Promise<string> {
  const res: any = await jhzyRequest({
    url: mode === 'login' ? 'get_openid.php' : 'wxlogin.php',
    method: 'POST',
    data: { code },
    header: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const openid = extractOpenid(res);
  if (!openid) throw '获取 openid 失败';
  return openid;
}

export interface LegacyRegisterResult {
  success?: boolean;
  pendingUserInfo?: any;
  alreadyRegistered?: boolean;
  underReview?: boolean;
}

/** POST register.php —— 志愿者注册（提交审核）。 */
export async function legacyRegister(registerData: Record<string, any>): Promise<LegacyRegisterResult> {
  const res: any = await jhzyRequest({
    url: 'register.php',
    method: 'POST',
    data: registerData,
    header: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (res.code === 0) {
    const rd = res.data || {};
    if (rd.temp_token) {
      const expireSeconds =
        rd.token_expire > 1e12 ? Math.floor(rd.token_expire / 1000) : rd.token_expire || 0;
      const pendingUserInfo = {
        real_name: registerData.real_name,
        phone: registerData.phone,
        status: 'pending',
        temp_token: rd.temp_token,
        token_expire: rd.token_expire,
        message: rd.message || '请等待管理员审核',
      };
      setLegacyPending(rd.temp_token, pendingUserInfo, expireSeconds);
      return { success: true, pendingUserInfo };
    }
    return { success: true };
  } else if (res.code === -6) {
    return { alreadyRegistered: true };
  } else if (res.code === -8) {
    return { underReview: true };
  } else {
    throw res.msg || '注册失败';
  }
}

export default {
  wechatLogin,
  logoutV2,
  logoutAllV2,
  listSessions,
  rotateSession,
  legacyVolunteerLogin,
  legacyAdminLogin,
  legacyGetOpenid,
  legacyRegister,
};
