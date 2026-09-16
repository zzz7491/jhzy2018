// utils/qualificationApi.ts
// P0-C 志愿者资格状态客户端（仅消费 /api/v2/users/me/qualification 投影；前端不自算）。
//
// 纪律（用户 P0-C §20）：
// - 后端 v2 为唯一权威；本客户端只读取并展示，绝不自行推导 qualified / reasons。
// - 不消费任何 PII；仅布尔事实 + 稳定 reason token。

import { resolveV2Base } from './apiEnv';
import { ensureV2Session } from './auth-v2';
import { send } from './transport';

const V2_BASE = resolveV2Base();

export interface VolunteerQualification {
  qualified: boolean;
  identity_verified: boolean;
  phone_bound: boolean;
  initial_training_exam_passed: boolean;
  reasons: string[];
}

async function request<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
  const token = await ensureV2Session();
  // P2-B：Header 拼装 / 信封解包 / 错误归一统一交 transport（非团队作用域）。
  return send<T>(method, V2_BASE + path, data, { token, teamScoped: false });
}

export const qualificationApi = {
  /** GET /api/v2/users/me/qualification —— 当前用户资格派生投影。 */
  getStatus(): Promise<VolunteerQualification> {
    return request<VolunteerQualification>('GET', '/users/me/qualification');
  },
};

export default qualificationApi;
