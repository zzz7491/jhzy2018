/**
 * 微信订阅消息 Provider 客户端（N0-D）。
 *
 * 职责（仅此一处接触 api.weixin.qq.com/cgi-bin/message/subscribe/send）：
 *   1. 获取 access_token（复用 N0-C/P0-B 的 WeChatAccessTokenClient，单一 token manager，禁止第二套）。
 *   2. 调用订阅消息发送接口。
 *   3. 将 provider 响应映射为内部 outcome（确定性，未知 errcode 一律 PROVIDER_ERROR）。
 *
 * 安全纪律（冻结）：
 *   - 本文件不读取任何业务表、不处理业务事件。
 *   - access_token / AppSecret 仅服务端使用：不落库、不日志、不进响应。
 *   - touser（raw openid）由 adapter 在调用前注入，本 client 只负责发送，不持有明文语义。
 *   - 真实外网调用仅在 env 显式 WECHAT + 配置 Secret 时执行；测试阶段 Fake 路径确定性、零外网。
 */

import type { Env } from '../../env';
import { WeChatAccessTokenClient } from '../../providers/wechat/phone-client';

export interface WeChatSubscribeSendRequest {
  touser: string; // raw openid（仅 backend 内存短暂存在；不落库 / 不日志 / 不响应）
  template_id: string;
  page?: string; // 内部可信输入；绝不允许公共 API 任意指定外部 URL
  data: Record<string, { value: string }>;
  miniprogram_state?: 'developer' | 'trial' | 'formal';
  lang?: string;
}

export type WeChatSubscribeOutcome =
  | { status: 'SUCCESS'; providerMessageId: string }
  | { status: 'AUTH_INVALID'; errorCode: string }
  | { status: 'TEMPLATE_INVALID'; errorCode: string }
  | { status: 'RECIPIENT_INVALID'; errorCode: string }
  | { status: 'SUBSCRIPTION_NOT_AVAILABLE'; errorCode: string }
  | { status: 'PAYLOAD_INVALID'; errorCode: string }
  | { status: 'RATE_LIMITED'; errorCode: string }
  | { status: 'PROVIDER_ERROR'; errorCode: string }
  | { status: 'NETWORK_ERROR'; errorCode: string };

export interface WeChatSubscribeProvider {
  readonly name: 'WECHAT' | 'FAKE';
  send(req: WeChatSubscribeSendRequest): Promise<WeChatSubscribeOutcome>;
}

/** 微信订阅消息发送 errcode → 内部失败态（确定性映射；未知 errcode → PROVIDER_ERROR）。 */
export type WeChatSubscribeFailure =
  | 'AUTH_INVALID'
  | 'TEMPLATE_INVALID'
  | 'RECIPIENT_INVALID'
  | 'SUBSCRIPTION_NOT_AVAILABLE'
  | 'PAYLOAD_INVALID'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR';

export function mapWeChatSubscribeErrcode(code: number | string | undefined): WeChatSubscribeFailure {
  const c = String(code ?? '');
  switch (c) {
    case '40003':
      return 'RECIPIENT_INVALID'; // openid 不合法 / 用户未关注
    case '40037':
    case '41030':
      return 'TEMPLATE_INVALID'; // template_id 不正确 / 不存在
    case '47003':
      return 'PAYLOAD_INVALID'; // 模板参数不准确
    case '43101':
      return 'SUBSCRIPTION_NOT_AVAILABLE'; // 用户拒绝接受消息 / 一次性订阅已过期
    case '40001':
    case '40013':
    case '41001':
    case '42001':
    case '42002':
      return 'AUTH_INVALID'; // access_token 问题
    case '45009':
    case '45011':
      return 'RATE_LIMITED'; // 接口调用超限 / 频率限制
    default:
      return 'PROVIDER_ERROR';
  }
}

/** 真实 Provider（仅在生产/预览且配置 Secret 时由 getWeChatSubscribeProvider 选择）。 */
export class HttpWeChatSubscribeProvider implements WeChatSubscribeProvider {
  readonly name = 'WECHAT' as const;

  constructor(private readonly env: Env) {}

  async send(req: WeChatSubscribeSendRequest): Promise<WeChatSubscribeOutcome> {
    let token: string;
    try {
      token = await new WeChatAccessTokenClient(this.env).getToken();
    } catch {
      return { status: 'AUTH_INVALID', errorCode: 'TOKEN_UNAVAILABLE' };
    }

    const url =
      'https://api.weixin.qq.com/cgi-bin/message/subscribe/send' +
      `?access_token=${encodeURIComponent(token)}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch {
      return { status: 'NETWORK_ERROR', errorCode: 'NETWORK' };
    }
    if (!resp.ok) return { status: 'PROVIDER_ERROR', errorCode: `HTTP_${resp.status}` };

    type WxResp = { errcode?: number; errmsg?: string; msgid?: string };
    let body: WxResp;
    try {
      body = (await resp.json()) as WxResp;
    } catch {
      return { status: 'PROVIDER_ERROR', errorCode: 'PARSE' };
    }

    const code = body.errcode ?? 0;
    if (code === 0) return { status: 'SUCCESS', providerMessageId: body.msgid ?? '' };
    const mapped = mapWeChatSubscribeErrcode(code);
    return { status: mapped, errorCode: String(code) };
  }
}

export interface FakeWeChatSubscribeOptions {
  mode?: 'success' | 'reject' | 'network';
  errcode?: number;
}

/** 测试用 Fake Provider（确定性、零外网；绝不接触 api.weixin.qq.com）。 */
export class FakeWeChatSubscribeProvider implements WeChatSubscribeProvider {
  readonly name = 'FAKE' as const;
  public mode: 'success' | 'reject' | 'network';
  public errcode: number;
  /** 调用计数（测试断言用；生产不使用）。 */
  public callCount = 0;

  constructor(opts?: FakeWeChatSubscribeOptions) {
    this.mode = opts?.mode ?? 'success';
    this.errcode = opts?.errcode ?? 43101;
  }

  async send(req: WeChatSubscribeSendRequest): Promise<WeChatSubscribeOutcome> {
    this.callCount++;
    if (this.mode === 'network') return { status: 'NETWORK_ERROR', errorCode: 'FAKE_NETWORK' };
    if (this.mode === 'reject') {
      const mapped = mapWeChatSubscribeErrcode(this.errcode);
      return { status: mapped, errorCode: String(this.errcode) };
    }
    return { status: 'SUCCESS', providerMessageId: `fake-msgid-${Date.now()}` };
  }
}

/** Provider 选择（config-driven；local 默认 FAKE 确定性、零外网）。 */
export function getWeChatSubscribeProvider(env: Env): WeChatSubscribeProvider {
  const cfg = (env.WECHAT_SUBSCRIBE_PROVIDER ?? '').toUpperCase();
  if (cfg === 'WECHAT') return new HttpWeChatSubscribeProvider(env);
  if (cfg === 'FAKE') return new FakeWeChatSubscribeProvider();
  const isLocal = (env.ENVIRONMENT ?? 'local') === 'local';
  return isLocal ? new FakeWeChatSubscribeProvider() : new HttpWeChatSubscribeProvider(env);
}
