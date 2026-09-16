// utils/auth-v2.ts
// 最小 V2 会话接入（P0-B）：仅用于建立/复用 V2 Bearer 会话，
// 供 phoneApi 调用 /api/v2/users/me/phone/* 使用。
//
// 纪律（与 P0-B 后端一致）：
// - 不改动 legacy utils/request.js 与 legacy 登录态（access_token）；
//   V2 会话独立存于 v2_access_token / v2_token_expire。
// - 仅当无有效 V2 会话时才 wx.login() 换取 code → POST /api/v2/auth/wechat/login。

import { resolveV2Base } from './apiEnv';
import { getV2Token, getV2ExpireSeconds, nowUnixSeconds, saveV2Session } from './session';

const V2_BASE = resolveV2Base();

export interface V2LoginResult {
  token: string;
  expires_at: number;
}

/** 复用安全窗口（秒）：剩余有效期不足此值时提前重登，避免边界请求失败。 */
const V2_EXPIRY_SAFETY_WINDOW_SECONDS = 30;

/**
 * 确保存在有效的 V2 Bearer 会话；返回 token。
 * - 若已有未过期 token → 直接复用（不触发 wx.login）。
 * - 否则 wx.login() 换取 code → POST /api/v2/auth/wechat/login → 存储。
 * - 失败抛错（由调用方决定重试/提示）；绝不静默返回空 token。
 *
 * 单位修复（STEP 6A.2）：后端 expires_at 为 Unix 秒，历史实现误与 Date.now()（毫秒）比较，
 * 导致复用判断恒为 false、每次强制 wx.login。现在统一到秒级语义：
 *   expireSeconds > currentUnixSeconds() + safetyWindowSeconds
 * release / develop / trial 使用同一正确语义，无环境特判。
 */
export async function ensureV2Session(): Promise<string> {
  const token = getV2Token();
  if (token && getV2ExpireSeconds() > nowUnixSeconds() + V2_EXPIRY_SAFETY_WINDOW_SECONDS) {
    return token;
  }
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (r: any) => (r.code ? resolve(r.code) : reject(new Error('wx.login 未返回 code'))),
      fail: (err: any) => reject(new Error('wx.login 失败: ' + (err && err.errMsg ? err.errMsg : '未知'))),
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
  saveV2Session(login.token, login.expires_at);
  return login.token;
}

export default ensureV2Session;
