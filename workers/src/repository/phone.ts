/**
 * PhoneRepository（P0-B 微信可信手机号绑定）。
 *
 * scope 事实：phone_verifications 为 USER_SCOPED
 * （已在 repository/tenant-scope.ts 登记；查询永远限定 user_id = ctx.tenant.userId）。
 *
 * 不读取 HTTP / Cookie；身份由 RepositoryContext 传入。
 * 单一事实来源 = phone_verifications（status 真相从此表派生）。
 *
 * 安全纪律：
 * - 失败行（INVALID_CODE / PROVIDER_ERROR）phone_enc / phone_mask 存空串，绝不落明文。
 * - 动态 code 永不落库（本层不接收 code 参数）。
 * - 历史不覆盖：每次绑定/失败都是一条新行；状态派生永远取最新 BOUND 行，
 *   因此一次失败的重新授权不会破坏既有的 WECHAT_PHONE_BOUND 状态。
 */

import { BaseRepository } from './base';
import { userScopeRequired } from '../utils/errors';
import { generateUlid } from '../utils/crypto';

export type PhoneVerificationStatus = 'BOUND' | 'PROVIDER_ERROR' | 'INVALID_CODE';

export interface PhoneVerificationRow {
  id: number;
  public_id: string;
  user_id: number;
  provider: string;
  phone_enc: string;
  phone_hash: string;
  phone_mask: string;
  status: PhoneVerificationStatus;
  failure_reason_code: string | null;
  provider_request_id: string | null;
  bound_at: number | null;
  created_at: number;
  updated_at: number | null;
}

export class PhoneRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  /** 最新一条 BOUND 行（任意手机号）：派生当前 WECHAT_PHONE_BOUND 状态真相。 */
  async getLatestBound(userId: number): Promise<PhoneVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    return this.first<PhoneVerificationRow>(
      `SELECT * FROM phone_verifications
        WHERE user_id = ? AND status = 'BOUND'
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
  }

  /** 同 user + 同 phone_hash 已 BOUND → 幂等命中（不新建当前事实）。 */
  async findLatestBoundByHash(userId: number, phoneHash: string): Promise<PhoneVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    return this.first<PhoneVerificationRow>(
      `SELECT * FROM phone_verifications
        WHERE user_id = ? AND phone_hash = ? AND status = 'BOUND'
        ORDER BY id DESC LIMIT 1`,
      [userId, phoneHash],
    );
  }

  /** 持久化一次绑定/失败尝试（单次原子 INSERT，最终态一次性写入）。 */
  async createAttempt(p: {
    userId: number;
    provider: string;
    phoneEnc: string;
    phoneHash: string;
    phoneMask: string;
    status: PhoneVerificationStatus;
    failureReasonCode?: string | null;
    providerRequestId?: string | null;
    boundAt?: number | null;
  }): Promise<PhoneVerificationRow> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO phone_verifications
         (public_id, user_id, provider, phone_enc, phone_hash, phone_mask, status, failure_reason_code, provider_request_id, bound_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        publicId,
        p.userId,
        p.provider,
        p.phoneEnc,
        p.phoneHash,
        p.phoneMask,
        p.status,
        p.failureReasonCode ?? null,
        p.providerRequestId ?? null,
        p.boundAt ?? null,
      ],
    );
    return (await this.first<PhoneVerificationRow>(
      `SELECT * FROM phone_verifications WHERE public_id = ?`,
      [publicId],
    ))!;
  }

  /** 最新一次尝试（调试/审计用；状态派生以 getLatestBound 为准）。 */
  async getLatest(userId: number): Promise<PhoneVerificationRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    return this.first<PhoneVerificationRow>(
      `SELECT * FROM phone_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [userId],
    );
  }

  /** 该用户全部记录数（断言历史保留 / 幂等不新增用）。 */
  async countByUser(userId: number): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM phone_verifications WHERE user_id = ?`,
      [userId],
    );
    return r?.n ?? 0;
  }

  /** 该用户 BOUND 状态记录数（断言重绑后旧历史保留）。 */
  async countBoundByUser(userId: number): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('phone_verifications');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM phone_verifications WHERE user_id = ? AND status = 'BOUND'`,
      [userId],
    );
    return r?.n ?? 0;
  }
}
