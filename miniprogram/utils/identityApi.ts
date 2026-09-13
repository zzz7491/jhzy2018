// utils/identityApi.ts
// P0-A 实名认证（真实姓名 + 身份证二要素）前端客户端（仅对接 /api/v2/volunteer/identity/*）。
//
// 纪律（与 P0-A 后端一致）：
// - 真实姓名 + 身份证号仅用于当次提交；本客户端绝不写入 storage / URL / log。
// - 响应只消费脱敏字段（masked_id_card）；绝不接收/缓存身份证明文。
// - 仅镜像 phoneApi 的调用风格（ensureV2Session + wx.request + Bearer）。

import { ensureV2Session } from './auth-v2';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export type IdentityStatus =
  | 'UNVERIFIED'
  | 'PENDING'
  | 'VERIFIED'
  | 'MISMATCH'
  | 'PROVIDER_ERROR'
  | 'MANUAL_REVIEW'
  | 'INVALID_INPUT';

export interface IdentityStatusResult {
  status: IdentityStatus;
  verified_at: number | null;
  masked_id_card: string | null;
  provider: string | null;
}

export interface IdentityVerifyResult {
  status: Exclude<IdentityStatus, 'UNVERIFIED'>;
  verified_at: number | null;
  masked_id_card: string | null;
  provider_request_id?: string | null;
  code?: string;
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

export const identityApi = {
  /** POST /api/v2/volunteer/identity/verify —— 提交真实姓名 + 身份证二要素。 */
  verify(realName: string, idCard: string): Promise<IdentityVerifyResult> {
    return request<IdentityVerifyResult>('POST', '/volunteer/identity/verify', {
      real_name: realName,
      id_card: idCard,
    });
  },

  /** GET /api/v2/volunteer/identity/status */
  getStatus(): Promise<IdentityStatusResult> {
    return request<IdentityStatusResult>('GET', '/volunteer/identity/status');
  },
};

export default identityApi;
