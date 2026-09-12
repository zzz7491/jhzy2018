// utils/subscriptionApi.ts
// N0-C 微信订阅授权前端客户端（仅对接 /api/v2/subscriptions/* 的授权基础闭环）。
//
// 纪律：
// - 只上送 template_key / template_id / state；【绝不上送 openid】
//   （openid 仅在服务端登录交换期出现，前端无从也不该获得）。
// - 所有请求经 ensureV2Session() 取得 Bearer token，基线 V2_BASE。
// - requestSubscribeMessage 调用成功 ≠ 授权成功：授权结果以微信真实返回（accept/reject/ban）为准，
//   并由 recordConsent 上报后端落库（幂等）。
// - 不使用任何 legacy PHP（get_subscribe_status.php / save_subscribe_status.php）。

import { ensureV2Session } from './auth-v2';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export type ConsentState = 'ACCEPT' | 'REJECT' | 'BAN';

export interface ConsentTemplateItem {
  template_key: string;
  template_id: string;
  title: string | null;
}

export interface ConsentStatusItem {
  template_key: string;
  template_id: string;
  consent_state: ConsentState;
  responded_at: number;
  updated_at: number;
}

export interface ConsentStatusResult {
  delivery_identity_ready: boolean;
  templates: ConsentTemplateItem[];
  items: ConsentStatusItem[];
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
          // 成功信封：{ success:true, data }
          resolve((res.data && res.data.data !== undefined ? res.data.data : res.data) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message} }
          reject(new Error(res.data && res.data.error ? res.data.error.message : `HTTP ${res.statusCode}`));
        }
      },
      fail: () => reject(new Error('网络异常，请重试')),
    });
  });
}

export const subscriptionApi = {
  /** GET /api/v2/subscriptions/status → 当前用户订阅状态 + 模板目录 + 投递身份 readiness。 */
  status(): Promise<ConsentStatusResult> {
    return request<ConsentStatusResult>('GET', '/subscriptions/status');
  },

  /** POST /api/v2/subscriptions/consent → 记录一次授权结果（幂等）。 */
  recordConsent(p: {
    templateKey: string;
    templateId: string;
    state: ConsentState;
  }): Promise<{ status: string; item: ConsentStatusItem }> {
    return request<{ status: string; item: ConsentStatusItem }>('POST', '/subscriptions/consent', {
      template_key: p.templateKey,
      template_id: p.templateId,
      state: p.state,
    });
  },
};

export default subscriptionApi;
