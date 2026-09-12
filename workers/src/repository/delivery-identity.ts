/**
 * DeliveryIdentityRepository（N0-C 微信投递身份基础）。
 *
 * 冻结依据（N0-C §3 / §4 / §12）：
 *   - 独立于 user_identities 的投递身份存储（禁止把 raw openid 塞回 user_identities）。
 *   - repository 【只接触密文与 hash】；明文（raw openid）的加解密由 DeliveryIdentityService 负责，
 *     且解密仅限可信 backend 路径，绝不进入此层以上的 API 响应。
 *   - USER_SCOPED：仅本人可读写（表级 guard 要求 userId）。
 *
 * 安全纪律：
 *   - 全部 SQL 参数化（prepare().bind()）。
 *   - 幂等由 DB 层 UNIQUE(user_id, provider, external_id_hash) + UPSERT 保证。
 *   - 不向任何调用方返回密文 / hash 的语义解释以外的内容（调用方亦不得外泄）。
 */

import { BaseRepository } from './base';
import { userScopeRequired } from '../utils/errors';

export type DeliveryProvider = 'WECHAT_MINIPROGRAM';
export type DeliveryIdentityStatus = 'ACTIVE' | 'REVOKED';

export interface DeliveryIdentityRow {
  id: number;
  user_id: number;
  provider: DeliveryProvider;
  encrypted_external_id: string;
  external_id_hash: string;
  status: DeliveryIdentityStatus;
  created_at: number;
  updated_at: number | null;
}

export class DeliveryIdentityRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  /**
   * 幂等 UPSERT 投递身份（同一 user + provider + external identity 唯一）。
   * 重复调用（例如每次 wx.login）只更新密文 / status / updated_at，不产生重复行。
   * 密文与 hash 由 service 层计算后传入，repository 不接触明文。
   */
  async upsertActive(p: {
    userId: number;
    provider: DeliveryProvider;
    encryptedExternalId: string;
    externalIdHash: string;
    now: number;
  }): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('notification_delivery_identities');
    await this.run(
      `INSERT INTO notification_delivery_identities
         (user_id, provider, encrypted_external_id, external_id_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
       ON CONFLICT (user_id, provider, external_id_hash)
       DO UPDATE SET encrypted_external_id = excluded.encrypted_external_id,
                     status = 'ACTIVE',
                     updated_at = excluded.updated_at`,
      [p.userId, p.provider, p.encryptedExternalId, p.externalIdHash, p.now, p.now],
    );
  }

  /** 当前用户在某 provider 下最新的 ACTIVE 投递身份行（含密文 / hash；仅 trusted 路径使用）。 */
  async findActive(userId: number, provider: DeliveryProvider): Promise<DeliveryIdentityRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_delivery_identities');
    return this.first<DeliveryIdentityRow>(
      `SELECT * FROM notification_delivery_identities
        WHERE user_id = ? AND provider = ? AND status = 'ACTIVE'
        ORDER BY id DESC LIMIT 1`,
      [userId, provider],
    );
  }

  /** readiness：当前用户是否存在 ACTIVE 投递身份（不返回任何身份值）。 */
  async isReady(userId: number, provider: DeliveryProvider): Promise<boolean> {
    this.assertUserScoped();
    this.ensureTableRead('notification_delivery_identities');
    const row = await this.first<{ n: number }>(
      `SELECT 1 AS n FROM notification_delivery_identities
        WHERE user_id = ? AND provider = ? AND status = 'ACTIVE' LIMIT 1`,
      [userId, provider],
    );
    return row != null;
  }
}
