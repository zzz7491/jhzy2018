// utils/phoneApi.ts
// P0-B 微信可信手机号绑定客户端（仅对接 /api/v2/users/me/phone/*）。
//
// 纪律：
// - 仅接受微信动态 code（来自 <button open-type="getPhoneNumber"> → bindgetphonenumber → e.detail.code）；
//   绝不向任何端点发送客户端自填手机号。
// - 响应与存储均不含完整手机号明文；本客户端只消费脱敏字段（phone_mask）。

import { resolveV2Base } from './apiEnv';
import { ensureV2Session } from './auth-v2';
import { send } from './transport';

const V2_BASE = resolveV2Base();

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

async function request<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
  const token = await ensureV2Session();
  // P2-B：Header 拼装 / 信封解包 / 错误归一统一交 transport（非团队作用域）。
  return send<T>(method, V2_BASE + path, data, { token, teamScoped: false });
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
