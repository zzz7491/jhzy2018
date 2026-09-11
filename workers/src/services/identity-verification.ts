/**
 * IdentityVerificationService（P0-A 核心业务编排）。
 *
 * 职责：
 * - 输入校验（真实姓名 / 身份证格式）
 * - 安全持久化 PII（AES-256-GCM 姓名 + HMAC 指纹 + 脱敏展示），身份证明文不落库
 * - 防重复计费：同 user + 同指纹已 VERIFIED → 复用；在途 PENDING（30s）→ 拒绝重复收费 attempt
 * - 调用可插拔 Provider，将供应商专有结果统一映射为内部状态
 * - 历史记录不覆盖（每次核验都是一条新 attempt 行）
 *
 * 不拥有的职责（遵守范围边界）：
 * - 手机号绑定 / 培训 / 考试 / qualification / team join / 保险 —— 均不在本阶段。
 */

import type { Env } from '../env';
import { IdentityRepository } from '../repository/identity';
import type { IdentityVerificationProvider } from '../providers/identity/types';
import { PiiCrypto } from '../utils/pii';
import { getIdentityKeys } from '../services/wechat-auth-service';
import { AppError, ErrorCode } from '../utils/errors';

export type IdentityStatus =
  | 'UNVERIFIED'
  | 'PENDING'
  | 'VERIFIED'
  | 'MISMATCH'
  | 'PROVIDER_ERROR'
  | 'MANUAL_REVIEW'
  | 'INVALID_INPUT';

export interface VerifyResult {
  status: Exclude<IdentityStatus, 'UNVERIFIED'>;
  verified_at: number | null;
  masked_id_card: string | null;
  /** 上游请求 id（审计/对账用，非敏感），VERIFIED / MANUAL_REVIEW 时返回。 */
  provider_request_id?: string | null;
  code?: string;
}

export interface StatusResult {
  status: IdentityStatus;
  verified_at: number | null;
  masked_id_card: string | null;
  provider: string | null;
}

export class IdentityVerificationService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly provider: IdentityVerificationProvider,
    private readonly env: Env,
  ) {}

  /** 构造 PiiCrypto（复用 IDENTITY_HMAC_KEY，与 user_identities.identity_hash 同源）。 */
  private async pii(): Promise<PiiCrypto> {
    const { primary } = await getIdentityKeys(this.env);
    return new PiiCrypto(primary);
  }

  async verify(userId: number, realName: string, idCard: string): Promise<VerifyResult> {
    const pii = await this.pii();
    // 指纹 = HMAC(realName|idCard)：姓名或身份证任一变更都形成新指纹 → 需重新核验（§6.2）。
    const fingerprint = await pii.hashIdCard(`${realName}|${idCard}`);
    // id_card_hash（仅身份证）用于跨姓名变更的重复身份检测，单独存储于 volunteer_profiles。
    const idCardHash = await pii.hashIdCard(idCard);
    const mask = pii.maskIdCard(idCard);

    // 1) 已 VERIFIED（同指纹）→ 直接复用，不重复调用收费 Provider；仍回传已确立的 provider_request_id。
    const verified = await this.repo.findLatestVerified(userId, fingerprint);
    if (verified) {
      return { status: 'VERIFIED', verified_at: verified.verified_at, masked_id_card: mask, provider_request_id: verified.provider_request_id };
    }

    // 2) 在途 PENDING（30s 内同指纹）→ 拒绝重复收费 attempt（防 double-click / 重发 / 并发）。
    const inFlight = await this.repo.findInFlightPending(userId, fingerprint, 30);
    if (inFlight) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Duplicate in-flight identity verification', {
        retry_after_seconds: '5',
      });
    }

    // 3) 安全持久化 PII（姓名加密 + 身份证指纹 + 脱敏展示）。
    const realNameEnc = await pii.encryptRealName(realName);
    await this.repo.upsertProfilePii(userId, realNameEnc, idCardHash, mask);

    // 4) 创建 PENDING 尝试。
    const attempt = await this.repo.createAttempt({
      userId,
      provider: this.provider.name,
      fingerprint,
      attemptKey: fingerprint,
    });

    // 5) 调用可插拔 Provider（异常 → 标记 PROVIDER_ERROR 并折叠为 503）。
    let out;
    try {
      out = await this.provider.verify({ realName, idCard });
    } catch {
      await this.repo.updateAttempt(attempt.public_id, {
        status: 'PROVIDER_ERROR',
        failureReasonCode: 'PROVIDER_CALL_FAILED',
      });
      throw new AppError(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, 503, 'Identity provider unavailable');
    }

    // 6) 统一映射内部状态（含上游 INVALID_INPUT → 400）。
    const providerRequestId = out.providerRequestId ?? null;
    switch (out.result) {
      case 'VERIFIED': {
        const verifiedAt = Math.floor(Date.now() / 1000);
        await this.repo.updateAttempt(attempt.public_id, {
          status: 'VERIFIED',
          providerRequestId,
          failureReasonCode: out.failureReasonCode ?? null,
          verifiedAt,
        });
        return { status: 'VERIFIED', verified_at: verifiedAt, masked_id_card: mask, provider_request_id: providerRequestId };
      }
      case 'MISMATCH': {
        await this.repo.updateAttempt(attempt.public_id, {
          status: 'MISMATCH',
          providerRequestId,
          failureReasonCode: out.failureReasonCode ?? null,
          verifiedAt: null,
        });
        throw new AppError(ErrorCode.IDENTITY_MISMATCH, 409, 'Identity verification mismatch');
      }
      case 'MANUAL_REVIEW': {
        await this.repo.updateAttempt(attempt.public_id, {
          status: 'MANUAL_REVIEW',
          providerRequestId,
          failureReasonCode: out.failureReasonCode ?? null,
          verifiedAt: null,
        });
        return { status: 'MANUAL_REVIEW', verified_at: null, masked_id_card: mask, provider_request_id: providerRequestId, code: 'IDENTITY_REVIEW_REQUIRED' };
      }
      case 'INVALID_INPUT': {
        // 上游判定输入非法（腾讯 -2/-3）→ 400 INVALID_INPUT。
        // 单一事实来源：attempt 行必须保留 INVALID_INPUT 语义（不得降级为 PROVIDER_ERROR，
        // PROVIDER_ERROR 仅保留给真正的 provider / upstream error）。
        await this.repo.updateAttempt(attempt.public_id, {
          status: 'INVALID_INPUT',
          providerRequestId,
          failureReasonCode: out.failureReasonCode ?? 'INVALID_INPUT',
          verifiedAt: null,
        });
        throw new AppError(ErrorCode.INVALID_INPUT, 400, 'Identity provider rejected input');
      }
      case 'PROVIDER_ERROR':
      default: {
        await this.repo.updateAttempt(attempt.public_id, {
          status: 'PROVIDER_ERROR',
          providerRequestId,
          failureReasonCode: out.failureReasonCode ?? null,
          verifiedAt: null,
        });
        throw new AppError(ErrorCode.IDENTITY_PROVIDER_UNAVAILABLE, 503, 'Identity provider returned error');
      }
    }
  }

  async getStatus(userId: number): Promise<StatusResult> {
    const profile = await this.repo.getProfilePii(userId);
    const mask = profile?.id_card_mask ?? null;
    const latest = await this.repo.getLatest(userId);
    if (!latest) {
      return { status: 'UNVERIFIED', verified_at: null, masked_id_card: mask, provider: null };
    }
    return {
      status: latest.status as IdentityStatus,
      verified_at: latest.verified_at,
      masked_id_card: mask,
      provider: latest.provider,
    };
  }
}
