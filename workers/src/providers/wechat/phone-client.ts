/**
 * 微信可信手机号 Provider / Client（P0-B）。
 *
 * 业务语义：WECHAT_PHONE_BOUND 只能来源于微信可信手机号授权事实。
 * 前端 <button open-type="getPhoneNumber"> → bindgetphonenumber → e.detail.code（动态 code）。
 * 后端用该动态 code 调微信官方 getuserphonenumber 换取微信验证过的手机号。
 *
 * 官方 contract（核实 2026-09-11，developers.weixin.qq.com）：
 *   - endpoint : POST https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=ACCESS_TOKEN
 *   - access_token：cgi-bin/token（client_credential）获取，需缓存；
 *   - 动态 code：一次性、有效期 5 分钟；
 *   - 响应    ：{ errcode, errmsg, phone_info:{ phoneNumber, purePhoneNumber, countryCode, watermark } }；
 *   - 错误码  ：-1 系统繁忙 / 40013 appid 不匹配 / 40029 code 无效 / 45011 频率限制。
 *
 * 安全纪律（冻结）：
 * - 不使用旧 session_key + encryptedData + iv 作为 2.0 主方案。
 * - 动态 code 不落业务库、不进日志、不进响应、不进错误回显。
 * - AppSecret / access_token 仅服务端使用：不前端暴露、不落业务库明文、不进日志。
 * - access_token 必须缓存（不得每次绑定重新取）；模块级 Map 缓存（单实例足够）。
 * - 真实外网调用仅在 env 显式 WECHAT 且配置 Secret 时执行；测试阶段 Fake 路径确定性、零外网。
 */

import type { Env } from '../../env';
import { internalError } from '../../utils/errors';

export type PhoneVerificationResult =
  | { result: 'BOUND'; phoneNumber: string; providerRequestId?: string | null; failureReasonCode?: string | null }
  | { result: 'INVALID_CODE'; failureReasonCode?: string | null }
  | { result: 'PROVIDER_ERROR'; failureReasonCode?: string | null };

export interface PhoneVerificationProvider {
  readonly name: 'WECHAT' | 'FAKE';
  verify(code: string): Promise<PhoneVerificationResult>;
}

/** 微信 getuserphonenumber 错误码 → 内部状态（确定性映射，供单测）。 */
export function mapWechatErrCode(errcode: number | string | undefined): 'INVALID_CODE' | 'PROVIDER_ERROR' {
  // 40029 code 无效/已使用/过期 → 属用户授权问题，归 INVALID_CODE（前端可重试授权）。
  if (String(errcode) === '40029') return 'INVALID_CODE';
  // -1 系统繁忙 / 40013 appid 不匹配 / 45011 频率限制 / 其它 → 上游错误，归 PROVIDER_ERROR。
  return 'PROVIDER_ERROR';
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** 微信 access_token 客户端（带缓存）。 */
export class WeChatAccessTokenClient {
  constructor(private readonly env: Env) {}

  async getToken(): Promise<string> {
    const appid = this.env.WECHAT_APPID;
    const secret = this.env.WECHAT_APP_SECRET;
    if (typeof appid !== 'string' || typeof secret !== 'string' || appid.length === 0 || secret.length === 0) {
      // 未配置 Secret：统一错误（不暴露"未配置"细节）。
      throw internalError();
    }
    const now = Date.now();
    const cached = tokenCache.get(appid);
    if (cached && cached.expiresAt - 5 * 60 * 1000 > now) return cached.token;

    const url =
      'https://api.weixin.qq.com/cgi-bin/token' +
      `?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { method: 'GET' });
    } catch {
      throw internalError();
    }
    if (!resp.ok) throw internalError();

    type Tok = { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    let data: Tok;
    try {
      data = (await resp.json()) as Tok;
    } catch {
      throw internalError();
    }
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) throw internalError();
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
    tokenCache.set(appid, { token: data.access_token, expiresAt: now + expiresIn * 1000 });
    return data.access_token;
  }
}

export class WeChatPhoneProvider implements PhoneVerificationProvider {
  readonly name = 'WECHAT' as const;

  constructor(private readonly env: Env) {}

  async verify(code: string): Promise<PhoneVerificationResult> {
    let token: string;
    try {
      token = await new WeChatAccessTokenClient(this.env).getToken();
    } catch {
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'WECHAT_TOKEN_UNAVAILABLE' };
    }

    const url =
      'https://api.weixin.qq.com/wxa/business/getuserphonenumber' +
      `?access_token=${encodeURIComponent(token)}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch {
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'WECHAT_CALL_FAILED' };
    }
    if (!resp.ok) return { result: 'PROVIDER_ERROR', failureReasonCode: 'WECHAT_HTTP_ERROR' };

    type PhoneInfo = { phoneNumber?: string; purePhoneNumber?: string; countryCode?: string };
    type WxResp = { errcode?: number; errmsg?: string; phone_info?: PhoneInfo };
    let data: WxResp;
    try {
      data = (await resp.json()) as WxResp;
    } catch {
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'WECHAT_PARSE_ERROR' };
    }

    if (data.errcode == null || data.errcode === 0) {
      const phone = data.phone_info?.purePhoneNumber ?? data.phone_info?.phoneNumber;
      if (!phone) return { result: 'PROVIDER_ERROR', failureReasonCode: 'WECHAT_NO_PHONE' };
      // 微信 getuserphonenumber 无 request id → 允许 null（schema 已声明可空）。
      return { result: 'BOUND', phoneNumber: phone, providerRequestId: null, failureReasonCode: null };
    }
    const mapped = mapWechatErrCode(data.errcode);
    return { result: mapped, failureReasonCode: `WECHAT_${data.errcode}` };
  }
}

export class FakeWeChatPhoneProvider implements PhoneVerificationProvider {
  readonly name = 'FAKE' as const;

  async verify(code: string): Promise<PhoneVerificationResult> {
    if (code === 'FAKE_PHONE_BOUND') {
      return {
        result: 'BOUND',
        phoneNumber: '13800005678',
        providerRequestId: `fake-${Date.now()}`,
        failureReasonCode: null,
      };
    }
    // 第二组可信手机号（用于重绑/幂等测试；与 13800005678 不同 hash）。
    if (code === 'FAKE_PHONE_BOUND_2') {
      return {
        result: 'BOUND',
        phoneNumber: '13900001234',
        providerRequestId: `fake-${Date.now()}`,
        failureReasonCode: null,
      };
    }
    if (code === 'FAKE_PHONE_INVALID') {
      return { result: 'INVALID_CODE', failureReasonCode: 'FAKE_INVALID_CODE' };
    }
    if (code === 'FAKE_PHONE_ERROR') {
      return { result: 'PROVIDER_ERROR', failureReasonCode: 'FAKE_PROVIDER_ERROR' };
    }
    return { result: 'PROVIDER_ERROR', failureReasonCode: 'FAKE_UNKNOWN_CODE' };
  }
}

/** Provider 选择（config-driven；local 默认 FAKE 确定性、零外网）。 */
export function getWeChatPhoneProvider(env: Env): PhoneVerificationProvider {
  const cfg = (env.WECHAT_PHONE_PROVIDER ?? '').toUpperCase();
  if (cfg === 'WECHAT') return new WeChatPhoneProvider(env);
  if (cfg === 'FAKE') return new FakeWeChatPhoneProvider();
  // 未显式配置：local 默认 FAKE；非 local 默认 WECHAT（真实路径，缺 Secret 时安全降级）。
  const isLocal = (env.ENVIRONMENT ?? 'local') === 'local';
  return isLocal ? new FakeWeChatPhoneProvider() : new WeChatPhoneProvider(env);
}
