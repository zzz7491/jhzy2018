/**
 * SubscriptionConsentService（N0-C §7 / §8 / §10 / §11 / §13 / §16）。
 *
 * 职责：记录 / 读取当前用户的微信订阅授权结果（WECHAT_SUBSCRIPTION_PERMISSION 层）。
 *
 * 三分纪律（禁止压缩）：
 *   USER_NOTIFICATION_PREFERENCE ≠ WECHAT_SUBSCRIPTION_PERMISSION ≠ DELIVERY_ELIGIBILITY
 *   本服务只表达 B（微信客户端授权结果），不表达用户偏好，也不做发送资格判定（→ N0-D）。
 *
 * 安全纪律：
 *   - 只接收 template_key / template_id / state；绝不接收 openid（openid 只在服务端登录交换期出现）。
 *   - 服务端权威校验模板：必须命中 message_templates（channel=wechat_subscribe、status=1）
 *     且 wx_template_id 与上报一致；否则拒绝（不信任前端任意 template id）。
 *   - 幂等：同一 (user_id, template_key) UPSERT。
 *   - 响应只含同意状态与 readiness 布尔，绝不含 openid / 密文 / hash。
 */

import type { Env } from '../env';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  SubscriptionConsentRepository,
  type ConsentState,
} from '../repository/subscription-consent';
import { DeliveryIdentityService } from './delivery-identity-service';
import { subscriptionInvalidState, subscriptionTemplateNotConfigured } from '../utils/errors';

/** 供 API 返回的安全 DTO（不含 openid / 密文 / hash / 内部 id）。 */
export interface ConsentStatusItem {
  template_key: string;
  template_id: string;
  consent_state: ConsentState;
  responded_at: number;
  updated_at: number;
}

/** 可订阅模板目录项（provider template id 为公开值，非敏感）。 */
export interface ConsentTemplateItem {
  template_key: string;
  template_id: string;
  title: string | null;
}

export interface ConsentStatusResult {
  delivery_identity_ready: boolean;
  templates: ConsentTemplateItem[];
  items: ConsentStatusItem[];
}

function isConsentState(v: unknown): v is ConsentState {
  return v === 'ACCEPT' || v === 'REJECT' || v === 'BAN';
}

export class SubscriptionConsentService {
  constructor(
    private readonly deps: { env: Env; auth: AuthContext; tenant: TenantContext },
  ) {}

  private repo(): SubscriptionConsentRepository {
    return new SubscriptionConsentRepository({
      db: this.deps.env.DB,
      ctx: { auth: this.deps.auth, tenant: this.deps.tenant },
    });
  }

  private identity(): DeliveryIdentityService {
    return new DeliveryIdentityService(this.deps);
  }

  /**
   * 当前用户的订阅状态（SELF）：
   * - delivery_identity_ready：是否具备投递身份（legacy 老用户为 false，待下次 wx.login 补齐）。
   * - items：已记录的每模板授权结果。
   */
  async getStatus(userId: number): Promise<ConsentStatusResult> {
    const deliveryIdentityReady = await this.identity().isReady(userId);
    const templates = await this.repo().listActiveWechatTemplates();
    const rows = await this.repo().listByUser(userId);
    return {
      delivery_identity_ready: deliveryIdentityReady,
      templates: templates.map((t) => ({
        template_key: t.code,
        template_id: t.wx_template_id,
        title: t.title,
      })),
      items: rows.map((r) => ({
        template_key: r.template_key,
        template_id: r.template_id,
        consent_state: r.consent_state,
        responded_at: r.responded_at,
        updated_at: r.updated_at,
      })),
    };
  }

  /**
   * 记录授权结果（幂等）。
   * 服务端权威校验：
   *   1) state ∈ {ACCEPT, REJECT, BAN}（否则 400 SUBSCRIPTION_INVALID_STATE）。
   *   2) template_key 命中启用的 wechat_subscribe 模板，且 wx_template_id === 上报 template_id
   *      （否则 400 SUBSCRIPTION_TEMPLATE_NOT_CONFIGURED）。
   * 【重点】requestSubscribeMessage 调用成功 ≠ ACCEPT：state 必须以微信返回的真实结果为准。
   */
  async recordConsent(
    userId: number,
    p: { templateKey: string; templateId: string; state: unknown },
  ): Promise<ConsentStatusItem> {
    if (!isConsentState(p.state)) throw subscriptionInvalidState();

    const templateKey = typeof p.templateKey === 'string' ? p.templateKey : '';
    const templateId = typeof p.templateId === 'string' ? p.templateId : '';
    const tpl = templateKey.length > 0 ? await this.repo().findActiveWechatTemplate(templateKey) : null;
    if (tpl == null || tpl.wx_template_id == null || tpl.wx_template_id !== templateId) {
      // 不存在 / 未启用 / 映射不符 → 统一折叠（防模板枚举）。
      throw subscriptionTemplateNotConfigured();
    }

    const now = Math.floor(Date.now() / 1000);
    await this.repo().upsertConsent({
      userId,
      templateKey,
      templateId,
      state: p.state,
      now,
    });
    return {
      template_key: templateKey,
      template_id: templateId,
      consent_state: p.state,
      responded_at: now,
      updated_at: now,
    };
  }
}
