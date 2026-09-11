import type { AuthContext } from './types/auth';
import type { TenantContext } from './types/tenant';

/**
 * Worker 运行环境 Bindings。
 * - DB：D1 数据库绑定（统一名称，代码通过 c.env.DB 访问）。
 * - ENVIRONMENT：当前环境（local/preview/production），由 wrangler.jsonc vars 注入。
 *
 * S2-6c-2：微信/身份密钥绑定声明（仅做存在性检查，绝不读取值/打印/硬编码）。
 * - WECHAT_APPID / WECHAT_APP_SECRET：真实 code2Session 必需，由用户配置 Workers Secret。
 * - IDENTITY_HMAC_KEY：user_identities.identity_hash 的 HMAC 密钥（S2-3 设计）。
 * 未配置时：local 走 mock provider + 本地测试密钥（TEST-ONLY）；真实登录路径统一拒绝。
 */
export interface Env {
  DB: D1Database;
  /**
   * P33-P3A-2：文件对象存储绑定（R2）。
   * - local 由 Miniflare 内置 R2 模拟（.wrangler/state），不连接远端。
   * - 仅作为绑定声明；本阶段【未】在 Cloudflare 创建任何 bucket，也未 deploy。
   * - object_key 由服务端生成并仅在服务端使用，绝不返回客户端。
   */
  FILES: R2Bucket;
  ENVIRONMENT?: string;
  WECHAT_APPID?: string;
  WECHAT_APP_SECRET?: string;
  /**
   * P0-B：微信可信手机号 Provider 选择（区分大小写不敏感）。
   * 取值：WECHAT / FAKE。
   * local 且无配置 → 默认 FAKE（确定性、零外网）；非 local 无配置 → 默认 WECHAT（缺 Secret 安全降级）。
   * 仅做【存在性】声明，绝不读取值 / 打印 / 硬编码。
   */
  WECHAT_PHONE_PROVIDER?: string;
  IDENTITY_HMAC_KEY?: string;
  /**
   * S2-6c-4 OPEN-6：身份 HMAC 密钥【前一版】（用于密钥轮换双密钥过渡）。
   * 仅在正式轮换 IDENTITY_HMAC_KEY 时短暂提供：旧身份摘要（用上一把密钥算出）仍可匹配，
   * 实现无停机轮换。不读取值、不打印、不返回；local 不需要（TEST-ONLY 单密钥）。
   */
  IDENTITY_HMAC_KEY_PREVIOUS?: string;
  /**
   * S2-6c-3：Session TTL 覆盖（IMPLEMENTATION DEFAULT = 小程序 30d / 管理端 12h）。
   * 均为【非敏感】普通 var（不是 Secret）：只影响会话时长，不含任何凭据。
   * 缺省 / 非法值 → 回落 config/session-ttl.ts 的安全默认，并受上下界钳制。
   */
  SESSION_TTL_MINIPROGRAM_SECONDS?: string;
  SESSION_TTL_ADMIN_SECONDS?: string;
  /**
   * 管理端允许的 Origin（逗号分隔），用于 Cookie 通道 CSRF 校验。
   * 生产环境必须在部署配置中显式提供；未提供 → 空列表 → Cookie 状态改变请求全部拒绝（fail-closed）。
   */
  ADMIN_ALLOWED_ORIGINS?: string;
  /**
   * S2-6i（TEST-ONLY / local）：原子性故障注入开关。仅当 ENVIRONMENT==='local' 且本值显式为 '1' 时，
   * AttendanceManagementService 会令 audit event INSERT 故意违反 CHECK 约束，从而在 db.batch 中触发回滚，
   * 以证明「UPDATE + event INSERT」的真实原子性（§10 / §17-L）。生产环境（非 local）永不触发，无副作用。
   */
  JHZY_FAULT_INJECT?: string;
  /**
   * P36-C1：嘉禾 AI V1 基础层绑定声明。
   *
   * 纪律：
   * - AI_API_KEY 只允许来自 Workers Secret（本文件仅做【存在性】声明，绝不读取值 / 打印 / 硬编码 / 写库）。
   * - provider / model 一律来自 server config，业务代码不得硬编码任何供应商或模型名。
   * - 未配置（缺省）时：resolveAIConfig 给出安全默认与 configured=false，绝不伪造生产配置。
   *
   * 详细默认值与钳制见 src/config/ai.ts。
   */
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
  AI_RL_PER_MIN?: string;
  AI_RL_PER_DAY?: string;
  /**
   * P0-A：身份核验 Provider 选择（区分大小写不敏感）。
   * 取值：TENCENT / ALIYUN / OTHER / MANUAL / FAKE。
   * local 且无配置 → 默认 FAKE（确定性、无真实收费）。生产应显式配置供应商。
   * 仅做【存在性】声明，绝不读取值 / 打印 / 硬编码。
   */
  IDENTITY_PROVIDER?: string;
  /**
   * P0-A：腾讯云身份核验密钥（仅当 IDENTITY_PROVIDER=TENCENT 时需要）。
   * 必须来自 Workers Secret；本文件仅做【存在性】声明，绝不读取值 / 打印 / 硬编码 / 写库。
   */
  IDENTITY_TENCENT_SECRET_ID?: string;
  IDENTITY_TENCENT_SECRET_KEY?: string;
}

/** Hono 上下文变量（S2-5：requestId / auth / tenant 均由 middleware 注入）。 */
export type AppVars = {
  requestId: string;
  auth: AuthContext;
  tenant: TenantContext;
};

/** 统一的 App 类型，供 route / middleware 复用。 */
export type App = Hono<{ Bindings: Env; Variables: AppVars }>;

// 仅用于类型标注，运行时由 Hono 提供。
import type { Hono } from 'hono';
