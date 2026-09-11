// utils/auth-v2.ts
// 最小 V2 会话接入（P0-B）：仅用于建立/复用 V2 Bearer 会话，
// 供 phoneApi 调用 /api/v2/users/me/phone/* 使用。
//
// 纪律（与 P0-B 后端一致）：
// - 不改动 legacy utils/request.js 与 legacy 登录态（access_token）；
//   V2 会话独立存于 v2_access_token / v2_token_expire。
// - 仅当无有效 V2 会话时才 wx.login() 换取 code → POST /api/v2/auth/wechat/login。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface V2LoginResult {
  token: string;
  expires_at: number;
}

function getV2Token(): string {
  return wx.getStorageSync('v2_access_token') || '';
}

function getV2Expire(): number {
  return Number(wx.getStorageSync('v2_token_expire') || 0);
}

/**
 * 确保存在有效的 V2 Bearer 会话；返回 token。
 * - 若已有未过期 token → 直接复用（不触发 wx.login）。
 * - 否则 wx.login() 换取 code → POST /api/v2/auth/wechat/login → 存储。
 * - 失败抛错（由调用方决定重试/提示）；绝不静默返回空 token。
 */
export async function ensureV2Session(): Promise<string> {
  const token = getV2Token();
  if (token && getV2Expire() > Date.now() + 30_000) {
    return token;
  }
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 未返回 code'))),
      fail: (err) => reject(new Error('wx.login 失败: ' + (err && err.errMsg ? err.errMsg : '未知'))),
    });
  });
  const login = await new Promise<V2LoginResult>((resolve, reject) => {
    wx.request({
      url: V2_BASE + '/auth/wechat/login',
      method: 'POST',
      data: { code },
      header: { 'Content-Type': 'application/json' },
      success: (res: any) => {
        if (
          res.statusCode === 200 &&
          res.data &&
          res.data.success &&
          res.data.data &&
          res.data.data.token
        ) {
          resolve({
            token: res.data.data.token,
            expires_at: Number(res.data.data.expires_at) || 0,
          });
        } else {
          reject(new Error('V2 登录失败: ' + (res.data && res.data.error ? res.data.error.message : res.statusCode)));
        }
      },
      fail: () => reject(new Error('网络异常，请重试')),
    });
  });
  wx.setStorageSync('v2_access_token', login.token);
  wx.setStorageSync('v2_token_expire', login.expires_at);
  return login.token;
}

export default ensureV2Session;
