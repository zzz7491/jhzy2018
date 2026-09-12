/**
 * DeliveryIdentityService（N0-C §3 / §4 / §12 / §18）。
 *
 * 职责：微信投递身份（raw openid）的加密静态存储 + hash 索引 + readiness + 可信解析。
 *
 * 三分纪律（禁止压缩为单一 boolean）：
 *   USER_NOTIFICATION_PREFERENCE ≠ WECHAT_SUBSCRIPTION_PERMISSION ≠ DELIVERY_ELIGIBILITY
 *   本服务只负责「投递身份」基础，不表达用户偏好，也不做投递资格判定（→ N0-D）。
 *
 * 安全纪律：
 *   - raw openid 只在此层加解密；repository 只见密文 / hash。
 *   - 密钥来自 Worker env（DELIVERY_IDENTITY_ENC_KEY）；local 用 TEST-ONLY 固定密钥（同 IDENTITY_HMAC_KEY 约定）。
 *   - resolveTouser 为【内部可信路径】，仅供未来 N0-D adapter 调用；绝不返回给客户端。
 *   - 本模块【绝不】调用 api.weixin.qq.com 的任何发送接口（subscribeMessage.send）。
 */

import type { Env } from '../env';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  DeliveryIdentityRepository,
  type DeliveryProvider,
} from '../repository/delivery-identity';
import { aesGcmEncrypt, aesGcmDecrypt, hmacSha256Hex } from '../utils/crypto';
import { getIdentityKey } from './wechat-auth-service';
import { internalError } from '../utils/errors';

const PROVIDER: DeliveryProvider = 'WECHAT_MINIPROGRAM';

/** 域分隔前缀：投递身份 hash 与 user_identities.identity_hash 不可互相复用（防跨表关联）。 */
const DELIVERY_HASH_DOMAIN = 'delivery:v1:';

/** local TEST-ONLY 加密密钥（与 IDENTITY_HMAC_KEY 的 local 兜底同约定；非生产密钥）。 */
const LOCAL_TEST_ENC_KEY = 'local-test-only-delivery-enc-key';

/**
 * 取投递身份加密密钥（AES-GCM secret）。
 * - 优先 env.DELIVERY_IDENTITY_ENC_KEY（生产必须来自 Workers Secret）。
 * - local 缺省 → TEST-ONLY 固定密钥。
 * - 非 local 缺密钥 → 统一 500（配置错误，不泄露细节）。
 */
export async function getDeliveryIdentityKey(env: Env): Promise<string> {
  if (typeof env.DELIVERY_IDENTITY_ENC_KEY === 'string' && env.DELIVERY_IDENTITY_ENC_KEY.length > 0) {
    return env.DELIVERY_IDENTITY_ENC_KEY;
  }
  if ((env.ENVIRONMENT ?? 'local') === 'local') return LOCAL_TEST_ENC_KEY;
  throw internalError();
}

export class DeliveryIdentityService {
  constructor(
    private readonly deps: { env: Env; auth: AuthContext; tenant: TenantContext },
  ) {}

  private repo(): DeliveryIdentityRepository {
    return new DeliveryIdentityRepository({
      db: this.deps.env.DB,
      ctx: { auth: this.deps.auth, tenant: this.deps.tenant },
    });
  }

  /** 计算外部标识的域分隔 HMAC-SHA256 摘要（不可逆；用于 dedupe / lookup）。 */
  static async hashExternalId(env: Env, externalId: string): Promise<string> {
    const key = await getIdentityKey(env);
    return hmacSha256Hex(key, DELIVERY_HASH_DOMAIN + externalId);
  }

  /**
   * 登录交换期：以 raw openid 幂等 upsert 投递身份。
   * - 加密：AES-GCM（密文入库；明文绝不落库 / 日志 / 响应）。
   * - hash：域分隔 HMAC-SHA256。
   * - 幂等：UNIQUE(user_id, provider, external_id_hash) + UPSERT。
   */
  async upsertFromWechatLogin(p: { userId: number; openid: string; now?: number }): Promise<void> {
    const now = p.now ?? Math.floor(Date.now() / 1000);
    const encKey = await getDeliveryIdentityKey(this.deps.env);
    const encryptedExternalId = await aesGcmEncrypt(encKey, p.openid);
    const externalIdHash = await DeliveryIdentityService.hashExternalId(this.deps.env, p.openid);
    await this.repo().upsertActive({
      userId: p.userId,
      provider: PROVIDER,
      encryptedExternalId,
      externalIdHash,
      now,
    });
  }

  /** readiness（仅布尔；不返回任何身份值）。 */
  async isReady(userId: number): Promise<boolean> {
    return this.repo().isReady(userId, PROVIDER);
  }

  /**
   * 解析投递 touser（raw openid 明文）——【内部可信路径】。
   *
   * 仅供未来 N0-D 的 WECHAT_SUBSCRIBE adapter 在服务端调用；绝不由 API 端点直接返回。
   * 无 ACTIVE 身份 → null。N0-C 不发送任何消息。
   */
  async resolveTouser(userId: number): Promise<string | null> {
    const row = await this.repo().findActive(userId, PROVIDER);
    if (row == null) return null;
    const encKey = await getDeliveryIdentityKey(this.deps.env);
    return aesGcmDecrypt(encKey, row.encrypted_external_id);
  }
}
