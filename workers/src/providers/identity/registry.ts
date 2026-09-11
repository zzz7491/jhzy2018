import type { Env } from '../../env';
import type { IdentityVerificationProvider } from './types';
import { FakeIdentityProvider } from './fake';
import { TencentIdentityProvider } from './tencent';

/**
 * 配置驱动的 Provider 注册表（P0-A）。
 *
 * - env.IDENTITY_PROVIDER 可选值：TENCENT / ALIYUN / OTHER / MANUAL / FAKE（大小写不敏感）。
 * - local 且无显式配置 → 默认 FAKE（确定性、无真实收费）。
 * - 核心业务只通过 IdentityVerificationProvider 接口交互，绝不感知供应商专有细节。
 * - IDENTITY_PROVIDER_PLUGGABLE = YES：未来 ALIYUN / OTHER_COMPLIANT / MANUAL_FALLBACK
 *   只需新增一个实现并在此处分支，无需改动 service / route / schema。
 */
export function getIdentityProvider(env: Env): IdentityVerificationProvider {
  const isLocal = (env.ENVIRONMENT ?? 'local') === 'local';
  const choice = (env.IDENTITY_PROVIDER ?? (isLocal ? 'FAKE' : 'TENCENT')).toUpperCase();

  switch (choice) {
    case 'FAKE':
      return new FakeIdentityProvider();
    case 'TENCENT':
      return new TencentIdentityProvider(
        env.IDENTITY_TENCENT_SECRET_ID ?? '',
        env.IDENTITY_TENCENT_SECRET_KEY ?? '',
      );
    // ALIYUN / OTHER / MANUAL：未来扩展点；当前未实现 → 安全降级（local=Fake，否则走 Tencent 缺凭证报错路径）。
    default:
      return isLocal
        ? new FakeIdentityProvider()
        : new TencentIdentityProvider(env.IDENTITY_TENCENT_SECRET_ID ?? '', env.IDENTITY_TENCENT_SECRET_KEY ?? '');
  }
}
