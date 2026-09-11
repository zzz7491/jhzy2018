/**
 * 身份核验 Provider 抽象（P0-A）。
 *
 * 核心业务只通过 IdentityVerificationProvider 接口交互，绝不感知任何供应商专有协议
 * （腾讯云错误码 / 字段 / response shape）。统一结果映射在 service 层完成。
 */

export type IdentityVerificationResult = 'VERIFIED' | 'MISMATCH' | 'PROVIDER_ERROR' | 'MANUAL_REVIEW' | 'INVALID_INPUT';

export interface ProviderVerifyInput {
  realName: string;
  idCard: string;
}

export interface ProviderVerifyOutput {
  result: IdentityVerificationResult;
  /** 上游请求 id（用于审计 / 对账，非敏感）。 */
  providerRequestId?: string;
  /** 内部失败枚举（MISMATCH / PROVIDER_ERROR / MANUAL_FALLBACK / ...），绝不泄露给客户端。 */
  failureReasonCode?: string;
}

export interface IdentityVerificationProvider {
  /** 供应商标识（对应 identity_verifications.provider），稳定且不泄露专有细节。 */
  readonly name: string;
  verify(input: ProviderVerifyInput): Promise<ProviderVerifyOutput>;
}
