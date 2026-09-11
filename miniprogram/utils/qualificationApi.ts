// utils/qualificationApi.ts
// P0-C 志愿者资格状态客户端（仅消费 /api/v2/users/me/qualification 投影；前端不自算）。
//
// 纪律（用户 P0-C §20）：
// - 后端 v2 为唯一权威；本客户端只读取并展示，绝不自行推导 qualified / reasons。
// - 不消费任何 PII；仅布尔事实 + 稳定 reason token。

import { ensureV2Session } from './auth-v2';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface VolunteerQualification {
  qualified: boolean;
  identity_verified: boolean;
  phone_bound: boolean;
  initial_training_exam_passed: boolean;
  reasons: string[];
}

function buildError(status: number, body: any, isNetwork: boolean): any {
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
          resolve((res.data && res.data.data !== undefined ? res.data.data : res.data) as T);
        } else {
          reject(buildError(res.statusCode, res.data, false));
        }
      },
      fail: () => reject(buildError(0, null, true)),
    });
  });
}

export const qualificationApi = {
  /** GET /api/v2/users/me/qualification —— 当前用户资格派生投影。 */
  getStatus(): Promise<VolunteerQualification> {
    return request<VolunteerQualification>('GET', '/users/me/qualification');
  },
};

export default qualificationApi;
