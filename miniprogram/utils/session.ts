// utils/session.ts
// P2-B Session Manager —— 认证 / 会话 Storage 的【唯一读写入口】。
//
// 纪律（P2-B Authentication & Transport Consolidation）：
// - 所有 auth 相关 Storage key 的读写集中于此；API wrapper 不得各自读取 token /
//   拼接 Header / 清理登录态。
// - 登录态包含【两个令牌家族】，二者语义不同，本模块是唯一的存储权威：
//     * legacy  access_token / token_expire
//       —— 由 legacy PHP 登录端点（login.php / admin_login.php）签发；
//          仅供 legacy utils/request.js 及其少量页面使用。
//     * V2      v2_access_token / v2_token_expire
//       —— 由 /api/v2/auth/wechat/login 签发的【不透明 D1 Session Token】；
//          /api/v2 后端（workers/src/middleware/auth.ts）仅接受该令牌。
//   本模块统一二者的读写与生命周期；令牌「家族」的选择由调用方（wrapper）决定，
//   本模块【不改变既有令牌选择语义】（语义归一见 Remaining P2）。
// - 单位契约：token_expire / v2_token_expire 均为 Unix【秒】（P2-A L7）。

export const SESSION_KEYS = {
  legacyToken: 'access_token',
  legacyExpire: 'token_expire',
  userInfo: 'userInfo',
  isLoggedIn: 'isLoggedIn',
  adminInfo: 'adminInfo',
  pendingApproval: 'pendingApproval',
  v2Token: 'v2_access_token',
  v2Expire: 'v2_token_expire',
  activeTeamPublicId: 'activeTeamPublicId',
} as const;

/** 当前 Unix 秒（所有过期判定的统一基准）。 */
export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ============================== legacy（PHP）令牌家族 ==============================

/** 读取 legacy access_token（PHP 登录令牌）。 */
export function getLegacyToken(): string {
  return wx.getStorageSync(SESSION_KEYS.legacyToken) || '';
}

/** 读取 legacy token_expire（Unix 秒；0 表示未记录）。 */
export function getLegacyExpireSeconds(): number {
  return Number(wx.getStorageSync(SESSION_KEYS.legacyExpire) || 0);
}

/** legacy token 是否已过期（未记录过期时间时视为不过期，与既有语义一致）。 */
export function isLegacyTokenExpired(): boolean {
  const expire = getLegacyExpireSeconds();
  return !!expire && expire < nowUnixSeconds();
}

/** 写入 legacy 登录态（access_token + userInfo + isLoggedIn + token_expire[秒]）。 */
export function setLegacyLogin(token: string, userInfo: any, expireSeconds: number, adminInfo?: any): void {
  wx.setStorageSync(SESSION_KEYS.legacyToken, token || '');
  wx.setStorageSync(SESSION_KEYS.userInfo, userInfo);
  wx.setStorageSync(SESSION_KEYS.isLoggedIn, true);
  wx.setStorageSync(SESSION_KEYS.legacyExpire, expireSeconds);
  if (adminInfo !== undefined) {
    wx.setStorageSync(SESSION_KEYS.adminInfo, adminInfo);
  }
}

/**
 * 写入【待审核】登录态（注册成功、未激活）：保留 access_token（临时）/userInfo，
 * 但 isLoggedIn=false、pendingApproval=true，禁止以已登录身份进入业务流。
 * 统一经 Session Manager（与 setLegacyLogin 同一存储权威），禁止页面各自散写。
 */
export function setLegacyPending(token: string, userInfo: any, expireSeconds: number): void {
  wx.setStorageSync(SESSION_KEYS.legacyToken, token || '');
  wx.setStorageSync(SESSION_KEYS.userInfo, userInfo);
  wx.setStorageSync(SESSION_KEYS.isLoggedIn, false);
  wx.setStorageSync(SESSION_KEYS.legacyExpire, expireSeconds);
  wx.setStorageSync(SESSION_KEYS.pendingApproval, true);
}

// ============================== V2 会话令牌家族 ==============================

/** 读取 V2 access_token（不透明 D1 Session Token）。 */
export function getV2Token(): string {
  return wx.getStorageSync(SESSION_KEYS.v2Token) || '';
}

/** 读取 v2_token_expire（Unix 秒；与后端 expires_at 同单位，不做换算）。 */
export function getV2ExpireSeconds(): number {
  return Number(wx.getStorageSync(SESSION_KEYS.v2Expire) || 0);
}

/** 是否存在【未过期】的 V2 会话（纯本地读取，不触发任何网络 / 登录）。 */
export function isV2SessionValid(): boolean {
  const token = getV2Token();
  if (!token) return false;
  const expire = getV2ExpireSeconds();
  if (!expire) return false;
  return expire > nowUnixSeconds();
}

/** 持久化 V2 会话（token + expires_at[秒]）。 */
export function saveV2Session(token: string, expiresAtSeconds: number): void {
  wx.setStorageSync(SESSION_KEYS.v2Token, token);
  wx.setStorageSync(SESSION_KEYS.v2Expire, expiresAtSeconds);
}

// ============================== 团队作用域 ==============================

/** 读取当前 active team 的 public_id（ULID）；无则空串。 */
export function getActiveTeamId(): string {
  return wx.getStorageSync(SESSION_KEYS.activeTeamPublicId) || '';
}

/** 写入当前 active team。 */
export function setActiveTeamId(teamPublicId: string): void {
  wx.setStorageSync(SESSION_KEYS.activeTeamPublicId, teamPublicId);
}

/** 清除当前 active team。 */
export function clearActiveTeamId(): void {
  wx.removeStorageSync(SESSION_KEYS.activeTeamPublicId);
}

// ============================== 登录态 ==============================

/** 是否已登录（legacy 登录标志）。 */
export function isLoggedIn(): boolean {
  return wx.getStorageSync(SESSION_KEYS.isLoggedIn) === true;
}

/** 读取 userInfo（原样返回；openid 剥离由 app 启动路径负责，本模块不改变该语义）。 */
export function getUserInfo(): any {
  return wx.getStorageSync(SESSION_KEYS.userInfo) || null;
}

// ============================== 生命周期（唯一 Logout 出口） ==============================

/**
 * 清除【全部】认证 / 会话存储并重置 globalData。
 * 这是唯一的登出实现；app.logout / 页面登出 / 401 处理均须经此，禁止各自 removeStorage。
 * 只清除 auth 相关 key，不动 hasAgreedProtocol / displayMode 等非认证偏好。
 */
export function clearSession(): void {
  wx.removeStorageSync(SESSION_KEYS.legacyToken);
  wx.removeStorageSync(SESSION_KEYS.legacyExpire);
  wx.removeStorageSync(SESSION_KEYS.userInfo);
  wx.removeStorageSync(SESSION_KEYS.isLoggedIn);
  wx.removeStorageSync(SESSION_KEYS.adminInfo);
  wx.removeStorageSync(SESSION_KEYS.pendingApproval);
  wx.removeStorageSync(SESSION_KEYS.v2Token);
  wx.removeStorageSync(SESSION_KEYS.v2Expire);
  wx.removeStorageSync(SESSION_KEYS.activeTeamPublicId);

  try {
    const app: any = getApp();
    if (app && app.globalData) {
      app.globalData.userInfo = null;
      app.globalData.isLoggedIn = false;
      app.globalData.pendingApproval = false;
    }
  } catch {
    // getApp() 在某些启动期不可用；storage 已清除，globalData 由 app 自持。
  }
}

export default {
  SESSION_KEYS,
  nowUnixSeconds,
  getLegacyToken,
  getLegacyExpireSeconds,
  isLegacyTokenExpired,
  setLegacyLogin,
  setLegacyPending,
  getV2Token,
  getV2ExpireSeconds,
  isV2SessionValid,
  saveV2Session,
  getActiveTeamId,
  setActiveTeamId,
  clearActiveTeamId,
  isLoggedIn,
  getUserInfo,
  clearSession,
};
