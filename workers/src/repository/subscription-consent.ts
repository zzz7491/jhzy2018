/**
 * SubscriptionConsentRepository（N0-C 微信订阅授权同意 + N0-F3 授权事件权威投影）。
 *
 * 冻结依据（N0-C §7 / §8 / §13 + N0-F3 事件权威投影契约）：
 *   - 每用户 × 每模板的授权结果（ACCEPT / REJECT / BAN），来自 wx.requestSubscribeMessage 真实返回。
 *   - 幂等：同一 (user_id, template_key) 唯一 → 重复上报 = UPSERT 更新（不产生无限重复行）。
 *   - template 映射复用 message_templates（PLATFORM_GLOBAL）：
 *       code（内部稳定 key）+ channel='wechat_subscribe' → wx_template_id（provider id）。
 *   - USER_SCOPED：consent 仅本人可读写。
 *   - template 的「是否存在 / 是否启用」由服务端权威判定（不信任前端任意 template id）。
 *
 * N0-F3 授权写入契约（单次 D1 batch 原子）：
 *   authorization write = db.batch([ event INSERT … ON CONFLICT DO NOTHING,
 *                                   consent INSERT…SELECT 投影 STORED event 行 ])
 *   - GENERATION_IDENTITY = AUTHORIZATION_EVENT_ID：事件表 id 即生成身份。
 *   - CURRENT_EVENT_MEANING = LATEST_AUTHORIZATION_EVENT：consent.current_authorization_event_id
 *     指向最新事件；所有状态 ACCEPT/REJECT/BAN 都推进投影（单调 ADVANCE）。
 *   - REQUEST IDEMPOTENCY = UNIQUE(user_id, template_key, authorization_request_id)：重复上报首写胜出。
 *   - projection authority = STORED event row：consent 的投影字段一律来自「已存储事件行」，
 *     不信任 replay body；requested_at 仅首次 INSERT 落库，不被 replay/ADVANCE 覆盖。
 *   - 单调谓词 ADVANCE = (consent.current IS NULL OR consent.current < excluded.current)；
 *     该谓词统一守护全部投影字段（current_authorization_event_id / consent_state / template_id /
 *     responded_at / updated_at / consumed_at）。STALE EVENT（ADVANCE 不成立）= 零投影变更。
 *   - consumed_at：ADVANCE+ACCEPT → NULL（新一次性权利）；ADVANCE+REJECT|BAN → 保留；NO ADVANCE → 保留。
 */

import { BaseRepository } from './base';
import { userScopeRequired } from '../utils/errors';

export type ConsentState = 'ACCEPT' | 'REJECT' | 'BAN';

export interface SubscriptionConsentRow {
  id: number;
  user_id: number;
  template_key: string;
  template_id: string;
  consent_state: ConsentState;
  /** N0-F3：当前投影所锚定的授权事件 id（LATEST_AUTHORIZATION_EVENT）；旧行/base-line 为 NULL。 */
  current_authorization_event_id: number | null;
  requested_at: number;
  responded_at: number;
  updated_at: number;
  consumed_at: number | null;
}

/** N0-F3：已存储的授权事件行（projection authority 的唯一来源）。 */
export interface AuthorizationEventRow {
  id: number;
  user_id: number;
  template_key: string;
  template_id: string;
  state: ConsentState;
  authorization_request_id: string;
  requested_at: number;
  responded_at: number;
  created_at: number;
}

/** message_templates 中 wechat_subscribe 渠道的映射行（provider id 可为 NULL = 未映射）。 */
export interface WechatTemplateRow {
  code: string;
  wx_template_id: string | null;
  status: number;
}

/** 可供前端呈现 / 发起授权的模板目录项（provider id 为公开模板 id，非敏感）。 */
export interface WechatTemplateCatalogItem {
  code: string;
  wx_template_id: string;
  title: string | null;
}

export class SubscriptionConsentRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  /**
   * 查询启用的 wechat_subscribe 模板映射（服务端权威）。
   * 前端提供的 template_key 必须命中此表且 status=1 且 wx_template_id 与上报一致，方可写入。
   */
  async findActiveWechatTemplate(code: string): Promise<WechatTemplateRow | null> {
    this.ensureTableRead('message_templates');
    return this.first<WechatTemplateRow>(
      `SELECT code, wx_template_id, status FROM message_templates
        WHERE code = ? AND channel = 'wechat_subscribe' AND status = 1
        LIMIT 1`,
      [code],
    );
  }

  /** 启用的 wechat_subscribe 模板目录（供前端呈现；provider id 为公开值）。 */
  async listActiveWechatTemplates(): Promise<WechatTemplateCatalogItem[]> {
    this.ensureTableRead('message_templates');
    return this.all<WechatTemplateCatalogItem>(
      `SELECT code, wx_template_id, title FROM message_templates
        WHERE channel = 'wechat_subscribe' AND status = 1 AND wx_template_id IS NOT NULL
        ORDER BY code ASC`,
    );
  }

  /**
   * N0-F3 授权写入（原子 batch = 事件首写 + consent 投影 UPSERT）。
   *
   * 设计要点：
   *   - stmt1：事件 INSERT … ON CONFLICT(user_id, template_key, authorization_request_id) DO NOTHING
   *            （首写胜出；replay 不产生新事件）。
   *   - stmt2：consent INSERT…SELECT 直接投影「已存储事件行」e（projection authority），
   *            ON CONFLICT(user_id, template_key) DO UPDATE 以 ADVANCE 单调谓词守护全部投影字段。
   *   - requested_at 仅在首次 INSERT 落库（SELECT 取 e.requested_at），ON CONFLICT SET 列表不含它 → 不被覆盖。
   *   - consumed_at：ADVANCE+ACCEPT→NULL；ADVANCE+REJECT|BAN→保留原值；NO ADVANCE→保留原值（STALE EVENT 零变更）。
   */
  async upsertConsent(p: {
    userId: number;
    templateKey: string;
    templateId: string;
    state: ConsentState;
    authorizationRequestId: string;
    now: number;
  }): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_authorization_events');
    this.ensureTableRead('wechat_subscription_consents');

    const eventInsert = {
      sql: `INSERT INTO wechat_subscription_authorization_events
              (user_id, template_key, template_id, state, authorization_request_id, requested_at, responded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, template_key, authorization_request_id) DO NOTHING`,
      params: [p.userId, p.templateKey, p.templateId, p.state, p.authorizationRequestId, p.now, p.now],
    };

    // ADVANCE 单调谓词：consent.current IS NULL OR consent.current < excluded.current。
    const ADVANCE = `(consent.current_authorization_event_id IS NULL OR consent.current_authorization_event_id < excluded.current_authorization_event_id)`;
    const consentUpsert = {
      sql: `INSERT INTO wechat_subscription_consents AS consent
              (user_id, template_key, current_authorization_event_id, consent_state, template_id,
               requested_at, responded_at, updated_at, consumed_at)
            SELECT ?, ?, e.id, e.state, e.template_id, e.requested_at, e.responded_at, ?, NULL
            FROM wechat_subscription_authorization_events e
            WHERE e.user_id = ? AND e.template_key = ? AND e.authorization_request_id = ?
            ON CONFLICT (user_id, template_key) DO UPDATE SET
              current_authorization_event_id =
                CASE WHEN ${ADVANCE} THEN excluded.current_authorization_event_id ELSE consent.current_authorization_event_id END,
              consent_state =
                CASE WHEN ${ADVANCE} THEN excluded.consent_state ELSE consent.consent_state END,
              template_id =
                CASE WHEN ${ADVANCE} THEN excluded.template_id ELSE consent.template_id END,
              responded_at =
                CASE WHEN ${ADVANCE} THEN excluded.responded_at ELSE consent.responded_at END,
              updated_at =
                CASE WHEN ${ADVANCE} THEN excluded.updated_at ELSE consent.updated_at END,
              consumed_at =
                CASE WHEN ${ADVANCE}
                     THEN (CASE WHEN excluded.consent_state = 'ACCEPT' THEN NULL ELSE consent.consumed_at END)
                     ELSE consent.consumed_at END`,
      params: [
        p.userId,
        p.templateKey,
        p.now, // INSERT 分支的 updated_at
        p.userId,
        p.templateKey,
        p.authorizationRequestId,
      ],
    };

    await this.batch([eventInsert, consentUpsert]);
  }

  /** 当前用户全部授权记录（newest first by template_key）。 */
  async listByUser(userId: number): Promise<SubscriptionConsentRow[]> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_consents');
    return this.all<SubscriptionConsentRow>(
      `SELECT * FROM wechat_subscription_consents WHERE user_id = ? ORDER BY template_key ASC`,
      [userId],
    );
  }

  /** N0-F3 测试 / 调试：某用户某模板的授权事件列表（按 id 升序，呈现推进顺序）。 */
  async listAuthorizationEvents(userId: number, templateKey: string): Promise<AuthorizationEventRow[]> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_authorization_events');
    return this.all<AuthorizationEventRow>(
      `SELECT * FROM wechat_subscription_authorization_events
        WHERE user_id = ? AND template_key = ?
        ORDER BY id ASC`,
      [userId, templateKey],
    );
  }

  /**
   * N0-D：eligibility 用 —— ACCEPT 且尚未消费的一次性授权记录。
   * 一次性订阅语义：consumed_at IS NULL 才视为可发送。
   */
  async findAcceptedUnconsumed(userId: number, templateKey: string): Promise<SubscriptionConsentRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_consents');
    return this.first<SubscriptionConsentRow>(
      `SELECT * FROM wechat_subscription_consents
        WHERE user_id = ? AND template_key = ? AND consent_state = 'ACCEPT' AND consumed_at IS NULL
        LIMIT 1`,
      [userId, templateKey],
    );
  }

  /**
   * N0-D：一次性订阅消费（成功投递或授权失效后写入），使后续 eligibility 不再误判为可发送。
   * 不破坏既有幂等（UNIQUE(user_id, template_key)）；仅更新 consumed_at / updated_at。
   */
  async markConsumed(userId: number, templateKey: string, now: number): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_consents');
    await this.run(
      `UPDATE wechat_subscription_consents
        SET consumed_at = ?, updated_at = ?
        WHERE user_id = ? AND template_key = ?`,
      [now, now, userId, templateKey],
    );
  }
}
