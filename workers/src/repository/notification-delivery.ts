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
  | 'RESERVED'
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
  authorization_event_id: number | null;
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

  /**
   * N0-F3-R1 —— 投递预留（at-most-once claim，硬唯一索引语义）。
   *
   * 单次 guarded INSERT…SELECT … RETURNING id：把「一次性订阅授权权」锁成一条 RESERVED 投递行。
   * eligibility 由 JOIN 保证：consent_state=ACCEPT 且 consumed_at IS NULL 且
   * e.id = c.current_authorization_event_id 且 e.state='ACCEPT'（事件权威投影）。
   *
   * 硬唯一索引 UNIQUE(authorization_event_id)（无 status 谓词，见 0039）兜底：
   *   - 资格满足且事件未被占用 → 新插入 RESERVED 行，RETURNING 返回新 id（非 null）→ 调用方据此调用 provider（claim）。
   *   - 事件已被占用（REERVED / DELIVERED / 任何终态，含 terminal failure）→ 唯一约束命中 → INSERT 被 IGNORE
   *     → RETURNING 无行 → 返回 null（不二次 claim、不调用 provider）。
   *
   * 这保证 ONE AUTHORIZATION EVENT → AT MOST ONE PROVIDER ATTEMPT：
   *   - 已 RESERVED 重入（未定稿）→ 不把既有 RESERVED 当作新 claim、不二次调用 provider（要求 4）。
   *   - terminal failure（PROVIDER_ERROR / NETWORK_ERROR）亦视为该 grant 已使用，须 NEW ACCEPT → NEW event.id 才有新机会（要求 5）。
   */
  async reserve(p: {
    userId: number;
    templateKey: string;
    idempotencyKey?: string | null;
    notificationId?: number | null;
    recipientId?: number | null;
    attemptedAt: number;
  }): Promise<number | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_deliveries');
    // INSERT OR IGNORE … RETURNING id：
    //   INSERT 成功 → 返回 { id }（新 RESERVED 行，调用方据此 claim 并调用 provider）。
    //   唯一约束命中（事件已被任意状态占用）→ INSERT 被忽略 → RETURNING 无行 → 返回 null（不 claim / 不调用 provider）。
    const row = await this.first<{ id: number }>(
      `INSERT OR IGNORE INTO notification_deliveries
         (user_id, channel, template_key, provider_template_id, status,
          authorization_event_id, idempotency_key, notification_id, recipient_id, attempted_at)
       SELECT c.user_id, 'WECHAT_SUBSCRIBE', c.template_key, c.template_id, 'RESERVED',
              c.current_authorization_event_id, ?, ?, ?, ?
       FROM wechat_subscription_consents c
       JOIN wechat_subscription_authorization_events e
         ON e.id = c.current_authorization_event_id AND e.state = 'ACCEPT'
       WHERE c.user_id = ? AND c.template_key = ? AND c.consent_state = 'ACCEPT' AND c.consumed_at IS NULL
       RETURNING id`,
      [
        p.idempotencyKey ?? null,
        p.notificationId ?? null,
        p.recipientId ?? null,
        p.attemptedAt,
        p.userId,
        p.templateKey,
      ],
    );
    return row?.id ?? null;
  }

  /**
   * N0-F3 —— 最终态定稿（仅 finalize 已预留的 RESERVED 行）。
   * 把 provider 结果写回：status / provider_message_id / provider_error_code /
   * provider_error_message / delivered_at。
   */
  async finalize(p: {
    deliveryId: number;
    status: DeliveryStatus;
    providerMessageId?: string | null;
    providerErrorCode?: string | null;
    providerErrorMessage?: string | null;
    deliveredAt?: number | null;
  }): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('notification_deliveries');
    await this.run(
      `UPDATE notification_deliveries
        SET status = ?, provider_message_id = ?, provider_error_code = ?, provider_error_message = ?, delivered_at = ?
        WHERE id = ? AND status = 'RESERVED'`,
      [
        p.status,
        p.providerMessageId ?? null,
        p.providerErrorCode ?? null,
        p.providerErrorMessage ?? null,
        p.deliveredAt ?? null,
        p.deliveryId,
      ],
    );
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
