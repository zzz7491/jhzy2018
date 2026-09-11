/**
 * IdentityRepository（P0-A 身份核验）。
 *
 * scope 事实：identity_verifications / volunteer_profiles 均为 USER_SCOPED
 * （已在 repository/tenant-scope.ts 登记；查询永远限定 user_id = ctx.tenant.userId）。
 *
 * 不读取 HTTP / Cookie；身份由 RepositoryContext 传入。
 * 单一事实来源 = identity_verifications（status / verified_at 真相从此表派生，
 * 不引入 volunteer_profiles.identity_status 第二真相）。
 */

import { BaseRepository } from './base';
import { userScopeRequired } from '../utils/errors';
import { generateUlid } from '../utils/crypto';

export interface IdentityVerificationRow {
  id: number;
  public_id: string;
  user_id: number;
  provider: string;
  status: 'PENDING' | 'VERIFIED' | 'MISMATCH' | 'PROVIDER_ERROR' | 'MANUAL_REVIEW' | 'INVALID_INPUT';
  identity_fingerprint: string;
  provider_request_id: string | null;
  attempt_key: string;
  failure_reason_code: string | null;
  created_at: number;
  updated_at: number | null;
  verified_at: number | null;
}

export interface ProfilePiiRow {
  real_name_enc: string | null;
  id_card_hash: string | null;
  id_card_mask: string | null;
}

export class IdentityRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  /** 安全持久化志愿者 PII：real_name_enc（AES-GCM）/ id_card_hash（HMAC）/ id_card_mask。身份证明文不落库。 */
  async upsertProfilePii(
    userId: number,
    realNameEnc: string,
    idCardHash: string,
    idCardMask: string,
  ): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('volunteer_profiles');
    await this.run(
      `INSERT INTO volunteer_profiles (user_id, real_name_enc, id_card_hash, id_card_mask, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(user_id) DO UPDATE SET
         real_name_enc = excluded.real_name_enc,
         id_card_hash   = excluded.id_card_hash,
         id_card_mask   = excluded.id_card_mask,
         updated_at    = unixepoch()`,
      [userId, realNameEnc, idCardHash, idCardMask],
    );
  }

  async getProfilePii(userId: number): Promise<ProfilePiiRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('volunteer_profiles');
    return this.first<ProfilePiiRow>(
      `SELECT real_name_enc, id_card_hash, id_card_mask
         FROM volunteer_profiles
        WHERE user_id = ?`,
      [userId],
    );
  }

  /** 同一 user + 同指纹 已 VERIFIED → 可直接复用，避免重复调用收费 Provider。 */
  async findLatestVerified(userId: number, fingerprint: string): Promise<IdentityVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    return this.first<IdentityVerificationRow>(
      `SELECT * FROM identity_verifications
        WHERE user_id = ? AND identity_fingerprint = ? AND status = 'VERIFIED'
        ORDER BY id DESC LIMIT 1`,
      [userId, fingerprint],
    );
  }

  /** 30s 内的在途 PENDING 尝试：并发 / 重复点击 / 前端重发 → 拒绝新建收费 attempt（防重复计费）。 */
  async findInFlightPending(
    userId: number,
    fingerprint: string,
    withinSec: number,
  ): Promise<IdentityVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    return this.first<IdentityVerificationRow>(
      `SELECT * FROM identity_verifications
        WHERE user_id = ? AND identity_fingerprint = ? AND status = 'PENDING'
          AND created_at >= (unixepoch() - ?)
        ORDER BY id DESC LIMIT 1`,
      [userId, fingerprint, withinSec],
    );
  }

  async createAttempt(p: {
    userId: number;
    provider: string;
    fingerprint: string;
    attemptKey: string;
  }): Promise<IdentityVerificationRow> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO identity_verifications
         (public_id, user_id, provider, status, identity_fingerprint, attempt_key, created_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, unixepoch())`,
      [publicId, p.userId, p.provider, p.fingerprint, p.attemptKey],
    );
    return {
      id: 0,
      public_id: publicId,
      user_id: p.userId,
      provider: p.provider,
      status: 'PENDING',
      identity_fingerprint: p.fingerprint,
      provider_request_id: null,
      attempt_key: p.attemptKey,
      failure_reason_code: null,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: null,
      verified_at: null,
    };
  }

  /** 按 public_id 更新尝试结果（不覆盖历史：每次调用都对应一个 attempt 行）。 */
  async updateAttempt(
    publicId: string,
    p: {
      status: IdentityVerificationRow['status'];
      providerRequestId?: string | null;
      failureReasonCode?: string | null;
      verifiedAt?: number | null;
    },
  ): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    await this.run(
      `UPDATE identity_verifications
         SET status = ?, provider_request_id = ?, failure_reason_code = ?, verified_at = ?, updated_at = unixepoch()
       WHERE public_id = ?`,
      [
        p.status,
        p.providerRequestId ?? null,
        p.failureReasonCode ?? null,
        p.verifiedAt ?? null,
        publicId,
      ],
    );
  }

  /** 最新一次尝试（用于 GET /status 派生当前身份状态）。 */
  async getLatest(userId: number): Promise<IdentityVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    return this.first<IdentityVerificationRow>(
      `SELECT * FROM identity_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [userId],
    );
  }

  /** 该用户全部核验记录数（防重复计费断言用）。 */
  async countByUser(userId: number): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('identity_verifications');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM identity_verifications WHERE user_id = ?`,
      [userId],
    );
    return r?.n ?? 0;
  }
}
