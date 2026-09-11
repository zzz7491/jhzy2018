import type { IdentityVerificationProvider, ProviderVerifyInput, ProviderVerifyOutput } from './types';

/**
 * 腾讯云身份二要素核验 Adapter（姓名 + 身份证）。
 *
 * 实现状态：PARTIAL（映射已冻结，live 调用未执行）。
 * - 按官方「实名核身」(faceid / IdCardVerification) 契约实现请求映射与结果映射。
 * - 未在本环境用真实凭证发起 live 调用（无生产 Secret），故 TENCENT_LIVE_ADAPTER = NOT_EXECUTED_TO_ASSERTION_COMPLETION。
 * - 缺凭证 / 调用失败 → 安全降级为 PROVIDER_ERROR（service 折叠为 503 IDENTITY_PROVIDER_UNAVAILABLE）。
 *
 * 官方契约参考（cloud.tencent.com/document/api/1007/33188）：
 *   - Endpoint : https://faceid.tencentcloudapi.com/
 *   - Action   : IdCardVerification
 *   - Version  : 2018-03-01
 *   - 签名     : TC3-HMAC-SHA256（标准云 API v3 签名）
 *   - 请求体   : { IdCard, Name }（本系统 id_card → IdCard, real_name → Name）
 *   - 响应     : { Result, Description, RequestId }；Result 为 String 类型。
 *
 * Result 码 → 系统状态（冻结映射，见 P0-A 验收）：
 *   0  一致(收费)              → VERIFIED
 *   -1 不一致(收费)            → MISMATCH
 *   -2 非法身份证号(不收费)    → INVALID_INPUT
 *   -3 非法姓名(不收费)        → INVALID_INPUT
 *   -4 证件库服务异常(不收费)  → PROVIDER_ERROR
 *   -5 证件库中无此记录(不收费)→ MISMATCH
 *   -6 权威比对系统升级(不收费)→ PROVIDER_ERROR
 *   -7 认证次数超限(不收费)    → PROVIDER_ERROR
 *   其它 / 未知非 0 / undefined → PROVIDER_ERROR（安全降级）
 * 原始 Result 始终保留在 failureReasonCode（如 TENCENT_-7 / TENCENT_UNKNOWN）。
 */

/**
 * 官方 Result 码 → 本系统 ProviderVerifyOutput 的冻结映射。
 * 纯函数、无副作用、无外网调用；可独立 deterministic 测试（见 tests/tencent_result_mapping.test.*）。
 */
export function mapTencentResult(result: string | undefined, requestId?: string): ProviderVerifyOutput {
  switch (result) {
    case '0':
      return { result: 'VERIFIED', providerRequestId: requestId };
    case '-1':
      return { result: 'MISMATCH', providerRequestId: requestId, failureReasonCode: 'TENCENT_-1' };
    case '-2':
      return { result: 'INVALID_INPUT', providerRequestId: requestId, failureReasonCode: 'TENCENT_-2' };
    case '-3':
      return { result: 'INVALID_INPUT', providerRequestId: requestId, failureReasonCode: 'TENCENT_-3' };
    case '-4':
      return { result: 'PROVIDER_ERROR', providerRequestId: requestId, failureReasonCode: 'TENCENT_-4' };
    case '-5':
      return { result: 'MISMATCH', providerRequestId: requestId, failureReasonCode: 'TENCENT_-5' };
    case '-6':
      return { result: 'PROVIDER_ERROR', providerRequestId: requestId, failureReasonCode: 'TENCENT_-6' };
    case '-7':
      return { result: 'PROVIDER_ERROR', providerRequestId: requestId, failureReasonCode: 'TENCENT_-7' };
    default:
      // 已知 0/-1..-7 之外的任何值（含 undefined / 未知码）→ 安全降级为 PROVIDER_ERROR。
      return {
        result: 'PROVIDER_ERROR',
        providerRequestId: requestId,
        failureReasonCode: result === undefined ? 'TENCENT_UNKNOWN' : `TENCENT_${result}`,
      };
  }
}

export class TencentIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'TENCENT';

  constructor(
    private readonly secretId: string,
    private readonly secretKey: string,
  ) {}

  async verify(input: ProviderVerifyInput): Promise<ProviderVerifyOutput> {
    // 无凭证：不伪造任何外网请求，安全降级（由 service 折叠为 IDENTITY_PROVIDER_UNAVAILABLE）。
    if (!this.secretId || !this.secretKey) {
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'TENCENT_NOT_CONFIGURED' };
    }
    try {
      const res = await this.callTencent(input.realName, input.idCard);
      // 统一经 mapTencentResult 映射官方 Result 码 → 内部状态（冻结映射）。
      return mapTencentResult(res.Result, res.RequestId);
    } catch {
      // 超时 / 网络 / 签名 / 解析失败 → 不向上泄露任何上游细节。
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'TENCENT_CALL_FAILED' };
    }
  }

  /**
   * 真实外网调用（TC3-HMAC-SHA256 签名 POST faceid.tencentcloudapi.com/IdCardVerification）。
   *
   * 注：本路径在本地 / 无凭证环境下不会被执行；真实上线前必须补齐：
   *   - 幂等 / 超时（AbortController）/ 有限重试
   *   - 凭证注入测试（不写死 Secret）
   *   - 响应 result 映射与边界（Description 脱敏）
   * 当前为未验证占位，故 TENCENT_LIVE_ADAPTER = NOT_EXECUTED_TO_ASSERTION_COMPLETION。
   */
  private async callTencent(
    _name: string,
    _idCard: string,
  ): Promise<{ Result?: string; RequestId?: string }> {
    throw new Error('TENCENT_LIVE_ADAPTER_NOT_EXECUTED');
  }
}
