/**
 * WeChat Subscribe Channel Adapter（N0-D — 微信订阅消息渠道适配器）。
 *
 * 架构定位（N0-D §2，冻结）：
 *   Notification Core → Channel Adapter → WeChat Subscribe Adapter → WeChat Official API
 *   业务模块（N0-E）未来只能调用 Notification Domain / Channel Adapter，绝不直接触 api.weixin.qq.com。
 *
 * 职责边界（N0-D §3 / §4 / §9 / §13 / §14 / §15）：
 *   - eligibility：delivery identity ACTIVE + openid 可解密 + 模板存在且 status=1 + channel=wechat_subscribe
 *     + consent ACCEPT 且未消费 + payload 符合 provider schema；任一不满足 → 不调用 provider，返回 NOT_ELIGIBLE。
 *   - 一次性订阅语义：一次 ACCEPT → 最多一次成功 provider send；成功或授权失效后消费 consent。
 *   - payload 校验：必须命中该模板 provider field keys（禁止多/少/错/猜测字段）。
 *   - provider 错误 → 确定性映射（AUTH_INVALID / TEMPLATE_INVALID / RECIPIENT_INVALID /
 *     SUBSCRIPTION_NOT_AVAILABLE / PAYLOAD_INVALID / RATE_LIMITED / PROVIDER_ERROR / NETWORK_ERROR）。
 *   - idempotency：调用方提供 idempotency_key 时，DB UNIQUE 防重复发送。
 *   - 上层业务模块不感知 access_token / openid 加密 / provider URL / 微信 errcode（全部封装于本 adapter）。
 *
 * 安全纪律（N0-D §7 / §17，冻结）：
 *   - touser（raw openid）仅 backend 内存短暂存在；不日志、不 API 返回、不持久化明文。
 *   - page 仅接受内部可信输入；不允许公共 API 任意指定外部 URL。
 *   - 不存 raw/decrypted openid / AppSecret / access_token；delivery 表只存安全裁剪后的稳定 token。
 */

import type { Env } from '../../env';
import type { AuthContext } from '../../types/auth';
import type { TenantContext } from '../../types/tenant';
import { DeliveryIdentityService } from '../../services/delivery-identity-service';
import { SubscriptionConsentRepository } from '../../repository/subscription-consent';
import { NotificationDeliveryRepository } from '../../repository/notification-delivery';
import { WECHAT_TEMPLATE_SCHEMAS, validateWeChatPayload } from './wechat-template-schema';
import {
  getWeChatSubscribeProvider,
  type WeChatSubscribeProvider,
  type WeChatSubscribeSendRequest,
} from './wechat-provider-client';

export type WeChatSendStatus =
  | 'DELIVERED'
  | 'NOT_ELIGIBLE'
  | 'INVALID_PAYLOAD'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR';

export interface WeChatSendResult {
  delivered: boolean;
  status: WeChatSendStatus;
  deliveryId?: number;
  providerErrorCode?: string;
}

export interface WeChatSendParams {
  userId: number;
  templateKey: string;
  /** payload 按 provider field key 键入（如 { thing4: '...' }）；模板全部必需字段必须齐备。 */
  data: Record<string, string>;
  page?: string;
  notificationId?: number | null;
  recipientId?: number | null;
  idempotencyKey?: string;
}

/** provider 失败态 → 表内稳定 delivery status + 安全裁剪 message token。 */
const FAILURE_MAP: Record<
  string,
  { status: WeChatSendStatus; message: string }
> = {
  SUBSCRIPTION_NOT_AVAILABLE: { status: 'PROVIDER_REJECTED', message: 'SUBSCRIPTION_NOT_AVAILABLE' },
  AUTH_INVALID: { status: 'PROVIDER_ERROR', message: 'AUTH_INVALID' },
  TEMPLATE_INVALID: { status: 'PROVIDER_ERROR', message: 'TEMPLATE_INVALID' },
  RECIPIENT_INVALID: { status: 'PROVIDER_ERROR', message: 'RECIPIENT_INVALID' },
  PAYLOAD_INVALID: { status: 'PROVIDER_ERROR', message: 'PAYLOAD_INVALID' },
  RATE_LIMITED: { status: 'PROVIDER_ERROR', message: 'RATE_LIMITED' },
  PROVIDER_ERROR: { status: 'PROVIDER_ERROR', message: 'PROVIDER_ERROR' },
  NETWORK_ERROR: { status: 'NETWORK_ERROR', message: 'NETWORK_ERROR' },
};

export class WeChatSubscribeAdapter {
  private readonly env: Env;
  private readonly provider: WeChatSubscribeProvider;

  constructor(deps: { env: Env; provider?: WeChatSubscribeProvider }) {
    this.env = deps.env;
    this.provider = deps.provider ?? getWeChatSubscribeProvider(deps.env);
  }

  /** server-side 合成上下文：已认证 + 指定 userId + USER_SCOPED（满足 repository scope guard）。 */
  private ctx(userId: number): { auth: AuthContext; tenant: TenantContext } {
    const auth: AuthContext = {
      authenticated: true,
      userId,
      role: null,
      teamId: null,
      roles: [],
    };
    const tenant: TenantContext = { scope: 'USER_SCOPED', teamId: null, userId };
    return { auth, tenant };
  }

  private repos(userId: number) {
    const ctx = this.ctx(userId);
    return {
      identity: new DeliveryIdentityService({ env: this.env, ...ctx }),
      consent: new SubscriptionConsentRepository({ db: this.env.DB, ctx }),
      delivery: new NotificationDeliveryRepository({ db: this.env.DB, ctx }),
    };
  }

  async send(p: WeChatSendParams): Promise<WeChatSendResult> {
    const now = Math.floor(Date.now() / 1000);
    const { identity, consent, delivery } = this.repos(p.userId);

    // 1. idempotency 短路：同一 idempotency_key 已有投递记录 → 直接返回，绝不重复调用 provider。
    if (p.idempotencyKey != null && p.idempotencyKey.length > 0) {
      const existing = await delivery.findByIdempotencyKey(p.userId, p.idempotencyKey);
      if (existing != null) {
        return {
          delivered: existing.status === 'DELIVERED',
          status: existing.status as WeChatSendStatus,
          deliveryId: existing.id,
          providerErrorCode: existing.provider_error_code ?? undefined,
        };
      }
    }

    // 2. eligibility —— 投递身份（解密 openid 仅内存使用）。
    const openid = await identity.resolveTouser(p.userId);
    if (openid == null) return { delivered: false, status: 'NOT_ELIGIBLE' };

    // 3. eligibility —— 授权（ACCEPT 且未消费的一次性权利）。
    const consentRow = await consent.findAcceptedUnconsumed(p.userId, p.templateKey);
    if (consentRow == null) return { delivered: false, status: 'NOT_ELIGIBLE' };

    // 4. eligibility —— 服务端权威模板映射。
    const tpl = await consent.findActiveWechatTemplate(p.templateKey);
    if (tpl == null || tpl.wx_template_id == null || tpl.wx_template_id !== consentRow.template_id) {
      return { delivered: false, status: 'NOT_ELIGIBLE' };
    }

    // 5. payload 校验（命中该模板 provider field keys）。
    const schema = WECHAT_TEMPLATE_SCHEMAS[p.templateKey];
    if (schema == null) return { delivered: false, status: 'NOT_ELIGIBLE' };
    const payload = validateWeChatPayload(schema, p.data);
    if (!payload.ok) {
      const deliveryId = await delivery.insert({
        userId: p.userId,
        channel: 'WECHAT_SUBSCRIBE',
        templateKey: p.templateKey,
        providerTemplateId: tpl.wx_template_id,
        status: 'INVALID_PAYLOAD',
        idempotencyKey: p.idempotencyKey ?? null,
        notificationId: p.notificationId ?? null,
        recipientId: p.recipientId ?? null,
        attemptedAt: now,
      });
      return { delivered: false, status: 'INVALID_PAYLOAD', deliveryId };
    }

    // 6. 组装 provider 请求（touser 仅 backend 内存短暂存在）。
    const request: WeChatSubscribeSendRequest = {
      touser: openid,
      template_id: tpl.wx_template_id,
      page: p.page,
      data: payload.wrapped,
      miniprogram_state: 'formal',
      lang: 'zh_CN',
    };

    // 7. 调用 provider（Fake 或 Http）。
    const outcome = await this.provider.send(request);

    // 8. 处理结果 + 持久化投递事实。
    if (outcome.status === 'SUCCESS') {
      const deliveryId = await delivery.insert({
        userId: p.userId,
        channel: 'WECHAT_SUBSCRIBE',
        templateKey: p.templateKey,
        providerTemplateId: tpl.wx_template_id,
        status: 'DELIVERED',
        providerMessageId: outcome.providerMessageId,
        idempotencyKey: p.idempotencyKey ?? null,
        notificationId: p.notificationId ?? null,
        recipientId: p.recipientId ?? null,
        attemptedAt: now,
        deliveredAt: now,
      });
      // 一次性订阅消费：成功即消费该 ACCEPT 权利（一次 ACCEPT → 最多一次成功 send）。
      await consent.markConsumed(p.userId, p.templateKey, now);
      return { delivered: true, status: 'DELIVERED', deliveryId };
    }

    const fm = FAILURE_MAP[outcome.status] ?? FAILURE_MAP.PROVIDER_ERROR;
    const deliveryId = await delivery.insert({
      userId: p.userId,
      channel: 'WECHAT_SUBSCRIBE',
      templateKey: p.templateKey,
      providerTemplateId: tpl.wx_template_id,
      status: fm.status,
      providerErrorCode: outcome.errorCode,
      providerErrorMessage: fm.message,
      idempotencyKey: p.idempotencyKey ?? null,
      notificationId: p.notificationId ?? null,
      recipientId: p.recipientId ?? null,
      attemptedAt: now,
    });

    // 一次性订阅消费：若授权本身已失效（用户已取消 / 一次性订阅过期），消费以免反复误投。
    // 其它失败（AUTH/TEMPLATE/RECIPIENT/PAYLOAD/RATE/PROVIDER/NETWORK）不消费，保留重试权利。
    if (outcome.status === 'SUBSCRIPTION_NOT_AVAILABLE') {
      await consent.markConsumed(p.userId, p.templateKey, now);
    }

    return { delivered: false, status: fm.status, deliveryId, providerErrorCode: outcome.errorCode };
  }
}
