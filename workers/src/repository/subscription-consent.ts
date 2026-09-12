/**
 * SubscriptionConsentRepository（N0-C 微信订阅授权同意）。
 *
 * 冻结依据（N0-C §7 / §8 / §13）：
 *   - 每用户 × 每模板的授权结果（ACCEPT / REJECT / BAN），来自 wx.requestSubscribeMessage 真实返回。
 *   - 幂等：同一 (user_id, template_key) 唯一 → 重复上报 = UPSERT 更新（不产生无限重复行）。
 *   - template 映射复用 message_templates（PLATFORM_GLOBAL）：
 *       code（内部稳定 key）+ channel='wechat_subscribe' → wx_template_id（provider id）。
 *   - USER_SCOPED：consent 仅本人可读写。
 *   - template 的「是否存在 / 是否启用」由服务端权威判定（不信任前端任意 template id）。
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
  requested_at: number;
  responded_at: number;
  updated_at: number;
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
   * 幂等 UPSERT 授权结果：同一 (user_id, template_key) 唯一。
   * requested_at 仅在首次写入时记录（ON CONFLICT 不覆盖），保留「首次请求」语义。
   */
  async upsertConsent(p: {
    userId: number;
    templateKey: string;
    templateId: string;
    state: ConsentState;
    now: number;
  }): Promise<void> {
    this.assertUserScoped();
    this.ensureTableRead('wechat_subscription_consents');
    await this.run(
      `INSERT INTO wechat_subscription_consents
         (user_id, template_key, template_id, consent_state, requested_at, responded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, template_key)
       DO UPDATE SET template_id  = excluded.template_id,
                     consent_state = excluded.consent_state,
                     responded_at  = excluded.responded_at,
                     updated_at    = excluded.updated_at,
                     -- 一次性订阅语义：新的真实 ACCEPT = 一份新的一次性权利 → 重置消费锚点。
                     -- REJECT/BAN 不清除（只有新的 ACCEPT 才代表新 entitlement），ELSE 保留原值。
                     consumed_at   = CASE WHEN excluded.consent_state = 'ACCEPT' THEN NULL ELSE consumed_at END`,
      [p.userId, p.templateKey, p.templateId, p.state, p.now, p.now, p.now],
    );
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
