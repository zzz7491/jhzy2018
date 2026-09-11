// utils/phoneApi.ts
// P0-B 微信可信手机号绑定客户端（仅对接 /api/v2/users/me/phone/*）。
//
// 纪律：
// - 仅接受微信动态 code（来自 <button open-type="getPhoneNumber"> → bindgetphonenumber → e.detail.code）；
//   绝不向任何端点发送客户端自填手机号。
// - 响应与存储均不含完整手机号明文；本客户端只消费脱敏字段（phone_mask）。

import { ensureV2Session } from './auth-v2';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface PhoneStatus {
  bound: boolean;
  phone_mask: string | null;
  source: string | null;
  bound_at: number | null;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  isNetwork: boolean;
}

function buildError(status: number, body: any, isNetwork: boolean): ApiError {
  const e = body && body.error ? body.error : null;
  return {
    status,
    code: e ? e.code : '',
    message: e ? e.message : isNetwork ? '网络异常，请重试' : '请求失败',
    isNetwork,
  };
}

async function request<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
  const token = await ensureV2Session();
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: V2_BASE + path,
      method,
      data,
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // 成功信封：{ success:true, data, request_id }
          resolve((res.data && res.data.data !== undefined ? res.data.data : res.data) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message,details} }
          reject(buildError(res.statusCode, res.data, false));
        }
      },
      fail: () => reject(buildError(0, null, true)),
    });
  });
}

export const phoneApi = {
  /** POST /api/v2/users/me/phone/wechat/bind —— 仅接受微信动态 code。 */
  bind(code: string): Promise<PhoneStatus> {
    return request<PhoneStatus>('POST', '/users/me/phone/wechat/bind', { code });
  },

  /** GET /api/v2/users/me/phone/status */
  getStatus(): Promise<PhoneStatus> {
    return request<PhoneStatus>('GET', '/users/me/phone/status');
  },
};

export default phoneApi;
