/**
 * PhoneBindingService（P0-B 核心业务编排）。
 *
 * 职责：
 * - 调用可插拔微信可信手机号 Provider，将供应商结果统一映射为内部状态。
 * - 安全持久化 PII（AES-256-GCM 手机号 + HMAC 指纹 + 脱敏展示），完整明文不落库、不进日志、不进响应。
 * - 绑定语义：
 *     · 同 user + 同 phone_hash 已 BOUND → 幂等成功（不新建当前事实）。
 *     · 新 phone_hash → 允许重绑（新 BOUND 当前，旧历史保留）。
 *     · 失败授权（INVALID_CODE / PROVIDER_ERROR）绝不破坏既有的 WECHAT_PHONE_BOUND 状态。
 * - 状态派生：永远取最新 BOUND 行（getLatestBound），失败的重新授权不改变 bound 真相。
 *
 * 不拥有的职责（遵守范围边界）：
 * - qualification / 培训 / 考试 / team join / 保险 / 通知 —— 均不在本阶段。
 * - 不信任客户端自填 phone；phone 仅来自微信可信授权事实。
 */

import type { Env } from '../env';
import { PhoneRepository } from '../repository/phone';
import type { PhoneVerificationProvider } from '../providers/wechat/phone-client';
import { PiiCrypto } from '../utils/pii';
import { getIdentityKeys } from '../services/wechat-auth-service';
import { AppError, ErrorCode } from '../utils/errors';

export interface PhoneStatusResult {
  bound: boolean;
  phone_mask: string | null;
  /** 绑定来源（提供方名，如 'WECHAT'）；未绑定为 null。 */
  source: string | null;
  bound_at: number | null;
}

export class PhoneBindingService {
  constructor(
    private readonly repo: PhoneRepository,
    private readonly provider: PhoneVerificationProvider,
    private readonly env: Env,
  ) {}

  /** 微信可信手机号绑定的逻辑来源常量（本功能唯一通道 = 微信可信手机号）。
   *  与 migration 的 provider CHECK('WECHAT') 一致；Fake Provider 仅是测试替身，不改变逻辑来源。 */
  private static readonly SOURCE = 'WECHAT';

  /** 构造 PiiCrypto（复用 IDENTITY_HMAC_KEY，与身份证/姓名同源密钥体系）。 */
  private async pii(): Promise<PiiCrypto> {
    const { primary } = await getIdentityKeys(this.env);
    return new PiiCrypto(primary);
  }

  /**
   * 绑定微信可信手机号。
   * @param userId 当前已认证用户 id（由路由层经 auth context 保证）
   * @param code   前端 <button open-type="getPhoneNumber"> 换得的动态 code（一次性 / 5 分钟）
   * @returns 绑定成功后的状态结果（仅脱敏手机号，绝不返回明文）
   * @throws PHONE_INVALID_CODE(400) / PHONE_PROVIDER_UNAVAILABLE(503)
   */
  async bind(userId: number, code: string): Promise<PhoneStatusResult> {
    const pii = await this.pii();

    let out;
    try {
      out = await this.provider.verify(code);
    } catch {
      // Provider 内部意外抛错 → 记录 PROVIDER_ERROR（不破坏既有 BOUND），折叠为 503。
      await this.repo.createAttempt({
        userId,
        provider: PhoneBindingService.SOURCE,
        phoneEnc: '',
        phoneHash: '',
        phoneMask: '',
        status: 'PROVIDER_ERROR',
        failureReasonCode: 'PROVIDER_CALL_FAILED',
      });
      throw new AppError(ErrorCode.PHONE_PROVIDER_UNAVAILABLE, 503, 'Phone provider unavailable');
    }

    if (out.result === 'BOUND') {
      const phone = out.phoneNumber;
      const phoneEnc = await pii.encryptPhone(phone);
      const phoneHash = await pii.hashPhone(phone);
      const phoneMask = pii.maskPhone(phone);

      // 1) 幂等：同 user + 同 hash 已 BOUND → 直接复用，不新建当前事实。
      const existing = await this.repo.findLatestBoundByHash(userId, phoneHash);
      if (existing) {
        return { bound: true, phone_mask: existing.phone_mask, source: PhoneBindingService.SOURCE, bound_at: existing.bound_at };
      }

      // 2) 新手机号 → 允许重绑（新 BOUND 当前，旧历史保留于既有行）。
      const boundAt = Math.floor(Date.now() / 1000);
      await this.repo.createAttempt({
        userId,
        provider: PhoneBindingService.SOURCE,
        phoneEnc,
        phoneHash,
        phoneMask,
        status: 'BOUND',
        failureReasonCode: null,
        providerRequestId: out.providerRequestId ?? null,
        boundAt,
      });
      return { bound: true, phone_mask: phoneMask, source: PhoneBindingService.SOURCE, bound_at: boundAt };
    }

    if (out.result === 'INVALID_CODE') {
      // 失败授权：记录 INVALID_CODE（空 enc/mask），但不破坏既有 BOUND 状态。
      await this.repo.createAttempt({
        userId,
        provider: PhoneBindingService.SOURCE,
        phoneEnc: '',
        phoneHash: '',
        phoneMask: '',
        status: 'INVALID_CODE',
        failureReasonCode: out.failureReasonCode ?? 'INVALID_CODE',
      });
      throw new AppError(ErrorCode.PHONE_INVALID_CODE, 400, 'WeChat phone authorization code invalid');
    }

    // PROVIDER_ERROR（如微信侧 -1 / 40013 / 45011 等上游错误）。
    await this.repo.createAttempt({
      userId,
      provider: PhoneBindingService.SOURCE,
      phoneEnc: '',
      phoneHash: '',
      phoneMask: '',
      status: 'PROVIDER_ERROR',
      failureReasonCode: out.failureReasonCode ?? 'PROVIDER_ERROR',
    });
    throw new AppError(ErrorCode.PHONE_PROVIDER_UNAVAILABLE, 503, 'Phone provider returned error');
  }

  /** 当前 WECHAT_PHONE_BOUND 状态（永不返回完整手机号）。 */
  async getStatus(userId: number): Promise<PhoneStatusResult> {
    const bound = await this.repo.getLatestBound(userId);
    if (bound) {
      return { bound: true, phone_mask: bound.phone_mask, source: bound.provider, bound_at: bound.bound_at };
    }
    return { bound: false, phone_mask: null, source: null, bound_at: null };
  }
}
