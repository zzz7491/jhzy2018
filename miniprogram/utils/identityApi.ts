// utils/identityApi.ts
// P0-A 实名认证（真实姓名 + 身份证二要素）前端客户端（仅对接 /api/v2/volunteer/identity/*）。
//
// 纪律（与 P0-A 后端一致）：
// - 真实姓名 + 身份证号仅用于当次提交；本客户端绝不写入 storage / URL / log。
// - 响应只消费脱敏字段（masked_id_card）；绝不接收/缓存身份证明文。
// - 仅镜像 phoneApi 的调用风格（ensureV2Session + wx.request + Bearer）。

import { resolveV2Base } from './apiEnv';
import { ensureV2Session } from './auth-v2';
import { send } from './transport';

const V2_BASE = resolveV2Base();

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

async function request<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
  const token = await ensureV2Session();
  // P2-B：Header 拼装 / 信封解包 / 错误归一统一交 transport（非团队作用域）。
  return send<T>(method, V2_BASE + path, data, { token, teamScoped: false });
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
