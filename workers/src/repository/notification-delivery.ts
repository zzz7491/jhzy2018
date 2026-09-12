/**
 * NotificationDeliveryRepository（N0-D 投递事实 / 尝试记录）。
 *
 * 纪律（N0-D §5 / §17）：
 *   - USER_SCOPED：仅本人可读写。
 *   - 不存 raw openid / decrypted openid / AppSecret / access_token。
 *   - provider error message 只存稳定 token（adapter 负责裁剪），绝不存原始 errmsg。
 *   - delivery record 不得成为 business recipient authority。
 *   - idempotency_key：同一 user + key 唯一（NULL 时不冲突），支撑去重防重复发送。
 */

import { BaseRepository } from './base';
import { userScopeRequired } from '../utils/errors';

export type DeliveryStatus =
  | 'DELIVERED'
  | 'NOT_ELIGIBLE'
  | 'INVALID_PAYLOAD'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR';

export interface NotificationDeliveryRow {
  id: number;
  user_id: number;
  channel: 'WECHAT_SUBSCRIBE';
  template_key: string;
  provider_template_id: string;
  notification_id: number | null;
  recipient_id: number | null;
  status: DeliveryStatus;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  idempotency_key: string | null;
  attempted_at: number;
  delivered_at: number | null;
  created_at: number;
}

export interface InsertDeliveryParams {
  userId: number;
  channel: 'WECHAT_SUBSCRIBE';
  templateKey: string;
  providerTemplateId: string;
  status: DeliveryStatus;
  providerMessageId?: string | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  idempotencyKey?: string | null;
  notificationId?: number | null;
  recipientId?: number | null;
  attemptedAt: number;
  deliveredAt?: number | null;
}

export class NotificationDeliveryRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  async insert(p: InsertDeliveryParams): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('notification_deliveries');
    await this.run(
      `INSERT INTO notification_deliveries
        (user_id, channel, template_key, provider_template_id, notification_id, recipient_id,
         status, provider_message_id, provider_error_code, provider_error_message, idempotency_key,
         attempted_at, delivered_at)
       VALUES (?, 'WECHAT_SUBSCRIBE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.userId,
        p.templateKey,
        p.providerTemplateId,
        p.notificationId ?? null,
        p.recipientId ?? null,
        p.status,
        p.providerMessageId ?? null,
        p.providerErrorCode ?? null,
        p.providerErrorMessage ?? null,
        p.idempotencyKey ?? null,
        p.attemptedAt,
        p.deliveredAt ?? null,
      ],
    );
    const row = await this.first<{ id: number }>('SELECT last_insert_rowid() AS id');
    return row?.id ?? 0;
  }

  /** 幂等查询：同一 idempotency_key 的最新投递记录。 */
  async findByIdempotencyKey(userId: number, key: string): Promise<NotificationDeliveryRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_deliveries');
    return this.first<NotificationDeliveryRow>(
      `SELECT * FROM notification_deliveries
        WHERE user_id = ? AND idempotency_key = ? ORDER BY id DESC LIMIT 1`,
      [userId, key],
    );
  }

  /** 调试 / 测试用：某用户某模板的最新投递记录。 */
  async findLatest(userId: number, templateKey: string): Promise<NotificationDeliveryRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_deliveries');
    return this.first<NotificationDeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE user_id = ? AND template_key = ? ORDER BY id DESC LIMIT 1`,
      [userId, templateKey],
    );
  }
}
