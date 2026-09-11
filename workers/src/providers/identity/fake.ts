import type { IdentityVerificationProvider, ProviderVerifyInput, ProviderVerifyOutput } from './types';

/**
 * 确定性 Fake Provider（P0-A 测试 / local 默认）。
 *
 * 通过身份证魔数映射结果，便于集成测试稳定断言，绝不发起真实收费请求。
 * 身份证取值约定（均满足 17 位数字 + X 格式校验）：
 *   - 11010119900307001X → VERIFIED
 *   - 11010119900307002X → MISMATCH
 *   - 11010119900307003X → PROVIDER_ERROR（模拟上游故障）
 *   - 11010119900307004X → MANUAL_REVIEW（异常兜底）
 *   - 11010119900307006X → INVALID_INPUT（模拟上游判定输入非法，如腾讯 -2/-3）
 *   - 其它合法身份证      → VERIFIED
 */
export class FakeIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'FAKE';

  async verify(input: ProviderVerifyInput): Promise<ProviderVerifyOutput> {
    const { idCard } = input;
    const reqId = `fake-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    if (idCard === '11010119900307002X') {
      return { result: 'MISMATCH', providerRequestId: reqId, failureReasonCode: 'NAME_ID_MISMATCH' };
    }
    if (idCard === '11010119900307003X') {
      return { result: 'PROVIDER_ERROR', providerRequestId: reqId, failureReasonCode: 'SIMULATED_OUTAGE' };
    }
    if (idCard === '11010119900307004X') {
      return { result: 'MANUAL_REVIEW', providerRequestId: reqId, failureReasonCode: 'MANUAL_FALLBACK' };
    }
    if (idCard === '11010119900307006X') {
      return { result: 'INVALID_INPUT', providerRequestId: reqId, failureReasonCode: 'FAKE_INVALID_INPUT' };
    }
    return { result: 'VERIFIED', providerRequestId: reqId };
  }
}
