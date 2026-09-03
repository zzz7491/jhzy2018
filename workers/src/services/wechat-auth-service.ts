/**
 * 微信身份提供层（S2-6c-2）。
 *
 * 职责（用户 §①）：wx.login code → code2Session → openid/unionid/session_key → 身份摘要匹配。
 *
 * 安全纪律（冻结）：
 * - AppID/AppSecret 只来自 Worker Secret/Binding（env.WECHAT_APPID / env.WECHAT_APP_SECRET），
 *   仅做【存在性检查】，绝不硬编码、绝不打印、绝不返回客户端。
 * - session_key 只存在于请求处理生命周期，不写 D1、不返回客户端、不进日志。
 * - 微信原始错误（errcode/errmsg）不返回客户端，收敛为统一 WECHAT_AUTH_FAILED。
 * - openid/unionid 明文不进业务日志（本文件无任何 openid/unionid 日志输出）。
 *
 * 本地联调策略（用户 §四）：未配置 Secret 不阻塞阶段——local 环境启用严格 mock provider：
 *   MOCK_WECHAT_CODE.<openid>.<unionid|-> → fixture openid/unionid → 真实 user_identities 查询
 *   → 真实 SessionService。生产环境无 Secret 时真实路径统一拒绝（不 fallback mock）。
 *
 * 首登规则（S2-6c-3 已裁决，不再是 OPEN）：
 * - OPEN-1：微信身份验证成功但 user_identities 未命中 → 【允许】创建最小 users + user_identities，
 *   然后创建 Session；严禁连带创建 user_roles / team_members / 团队 / permission。
 * - OPEN-2：首登不授予任何默认角色（尤其不得自动授予 volunteer）；role = none、team = none。
 * - OPEN-7：unionid 优先、openid 兜底；两者指向不同 user 主体 → 冲突拒绝 + 审计 + 不合并。
 * - OPEN-8：session_key 仅存在于本请求生命周期，不写 D1、不进日志、不返回、不入 Session/Cookie。
 */

import type { Env } from '../env';
import { hmacSha256Hex } from '../utils/crypto';
import { invalidParam, internalError, forbidden } from '../utils/errors';
import type { D1Database } from '@cloudflare/workers-types';

export interface WeChatSession {
  openid: string;
  unionid: string | null;
  /** 仅存在于请求生命周期；绝不持久化/返回/记录。 */
  sessionKey: string | null;
}

/** 身份摘要密钥（S2-3：identity_hash = HMAC-SHA256(标识, 服务端密钥)）。 */
export async function getIdentityKey(env: Env): Promise<string> {
  if (typeof env.IDENTITY_HMAC_KEY === 'string' && env.IDENTITY_HMAC_KEY.length > 0) {
    return env.IDENTITY_HMAC_KEY;
  }
  // 仅 local/TEST 允许使用固定测试密钥（TEST-ONLY，非生产密钥；fixture 与服务端一致）。
  if ((env.ENVIRONMENT ?? 'local') === 'local') {
    return 'local-test-only-identity-key';
  }
  throw internalError(); // 生产缺密钥 = 服务器配置错误，统一 500，不泄露细节。
}

/**
 * 双密钥集合（S2-6c-4 OPEN-6：密钥轮换无停机）。
 * - primary：当前生效密钥（新建身份摘要用它）。
 * - secondary：上一把密钥（轮换过渡期提供；旧身份摘要仍可被匹配）。
 * local 仅单密钥（TEST-ONLY），secondary 恒为 null。
 */
export interface IdentityKeys {
  primary: string;
  secondary: string | null;
}

export async function getIdentityKeys(env: Env): Promise<IdentityKeys> {
  const primary = await getIdentityKey(env);
  const secondary =
    typeof env.IDENTITY_HMAC_KEY_PREVIOUS === 'string' && env.IDENTITY_HMAC_KEY_PREVIOUS.length > 0
      ? env.IDENTITY_HMAC_KEY_PREVIOUS
      : null;
  return { primary, secondary };
}

/** 身份摘要（openid/unionid 通用，单密钥）。 */
export async function identityHash(key: string, identifier: string): Promise<string> {
  return hmacSha256Hex(key, identifier);
}

/** 双密钥候选摘要：primary +（可选）secondary。匹配时任一命中即成功（OPEN-6）。 */
async function candidateHashes(keys: IdentityKeys, identifier: string): Promise<string[]> {
  const out = [await hmacSha256Hex(keys.primary, identifier)];
  if (keys.secondary != null) out.push(await hmacSha256Hex(keys.secondary, identifier));
  return out;
}

/**
 * code → 微信会话。
 * - 真实路径：Secrets 存在时调用官方 code2Session；errcode≠0 / 网络失败 → 统一错误。
 * - mock 路径：仅 local 且 code 以 MOCK_WECHAT_CODE. 开头。
 * - 其余（含非法格式）→ 统一 400 INVALID_PARAM（不区分原因，防枚举）。
 */
export async function wechatCodeToSession(env: Env, code: string): Promise<WeChatSession> {
  if (typeof code !== 'string' || code.length < 8 || code.length > 1024) {
    throw invalidParam('code', 'invalid code');
  }

  // ===== mock provider（严格 local-only）=====
  const isLocal = (env.ENVIRONMENT ?? 'local') === 'local';
  if (code.startsWith('MOCK_WECHAT_CODE.')) {
    if (!isLocal) throw invalidParam('code', 'invalid code'); // 非 local 一律拒绝 mock
    return mockCodeToSession(code);
  }

  // ===== 真实 provider =====
  const hasSecrets =
    typeof env.WECHAT_APPID === 'string' && env.WECHAT_APPID.length > 0 &&
    typeof env.WECHAT_APP_SECRET === 'string' && env.WECHAT_APP_SECRET.length > 0;
  if (!hasSecrets) {
    // 未配置 Secret：统一错误（不暴露"未配置"细节，不 fallback mock）。
    throw forbidden('Authentication unavailable');
  }

  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(env.WECHAT_APPID!)}` +
    `&secret=${encodeURIComponent(env.WECHAT_APP_SECRET!)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code';

  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET' });
  } catch {
    throw forbidden('Authentication unavailable'); // 网络失败 → 统一错误
  }
  if (!resp.ok) throw forbidden('Authentication unavailable');

  type WxResp = { openid?: string; unionid?: string; session_key?: string; errcode?: number; errmsg?: string };
  let data: WxResp;
  try {
    data = (await resp.json()) as WxResp;
  } catch {
    throw forbidden('Authentication unavailable');
  }
  // 微信原始错误：仅 local 记录 errcode 数字（不含 errmsg/openid），客户端统一错误。
  if (data.errcode != null && data.errcode !== 0) {
    if (isLocal) console.error('[wechat] provider error errcode=', data.errcode);
    throw forbidden('Authentication unavailable');
  }
  if (typeof data.openid !== 'string' || data.openid.length === 0) {
    throw forbidden('Authentication unavailable');
  }
  return { openid: data.openid, unionid: data.unionid ?? null, sessionKey: data.session_key ?? null };
}

/**
 * mock code2Session（local-only）。
 * 格式：MOCK_WECHAT_CODE.<openid>.<unionid 或 ->
 * 特殊值：MOCK_WECHAT_CODE.ERROR → 模拟 provider 故障（测试统一错误路径）。
 */
function mockCodeToSession(code: string): WeChatSession {
  const parts = code.split('.');
  if (parts.length !== 3) throw invalidParam('code', 'invalid code');
  const openid = parts[1];
  const unionid = parts[2] === '-' ? null : parts[2];
  if (openid === 'ERROR') throw forbidden('Authentication unavailable'); // 模拟微信侧故障
  return { openid, unionid, sessionKey: 'mock-session-key-never-persisted' };
}

/**
 * 身份解析结果（S2-6c-3，指令 OPEN-1 / OPEN-7）。
 *
 * - matched：唯一命中，可登录。
 * - not_found：unionid / openid 均未命中 → 【首登建档路径】（OPEN-1 裁决：允许创建最小 users）。
 * - conflict：unionid 与 openid 命中【两个不同】user 主体 → 禁止登录、禁止合并（OPEN-7）。
 *
 * 安全纪律：conflict 分支携带的 user id 【仅供服务端审计落库】，
 * 严禁进入任何客户端响应 / 日志（本模块无任何 console 输出）。
 */
export type WechatIdentityResolution =
  | { kind: 'matched'; userId: number; via: 'unionid' | 'openid' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; unionidUserId: number | null; openidUserId: number | null };

/**
 * 是否存在"占用唯一槽位"的【停用】身份行（active_marker=1 且 status=2）。
 *
 * 背景（user_identities 哨兵列设计的直接推论，非实现缺陷）：
 * - UNIQUE(identity_type, identity_hash, active_marker) 中，active_marker=1 的停用行（status=2）
 *   【仍然占用槽位】，因此该微信标识无法再绑定到任何新主体；
 * - 已撤销行（active_marker=NULL）因 SQLite 中 NULL 互不相等，【不占用】槽位，可重新绑定。
 *
 * 用途：首登建档前显式判定。若返回 true，建档必然撞唯一约束整批回滚，
 * 因此直接判定为不可登录（401，与"身份不存在"同构，不泄露该标识的历史绑定状态）。
 */
export async function hasDisabledIdentityBinding(
  db: D1Database,
  keys: IdentityKeys,
  session: WeChatSession,
): Promise<boolean> {
  const candidates: Array<['wechat_unionid' | 'wechat_openid', string]> = [];
  if (session.unionid != null) candidates.push(['wechat_unionid', session.unionid]);
  candidates.push(['wechat_openid', session.openid]);

  for (const [type, value] of candidates) {
    const hashes = await candidateHashes(keys, value);
    for (const h of hashes) {
      const row = await db
        .prepare(
          `SELECT id FROM user_identities
            WHERE identity_type = ? AND identity_hash = ? AND active_marker = 1 AND status = 2
            LIMIT 1`,
        )
        .bind(type, h)
        .first<{ id: number }>();
      if (row != null) return true;
    }
  }
  return false;
}

/** 按 (type, hashes[]) 查生效身份行（active_marker=1 且 status=1）；多密钥任一命中即成功（OPEN-6）。 */
async function lookupIdentity(
  db: D1Database,
  identityType: 'wechat_unionid' | 'wechat_openid',
  hashes: string[],
): Promise<number | null> {
  for (const h of hashes) {
    const hit = await db
      .prepare(
        `SELECT user_id FROM user_identities
          WHERE identity_type = ? AND identity_hash = ? AND active_marker = 1 AND status = 1`,
      )
      .bind(identityType, h)
      .first<{ user_id: number }>();
    if (hit?.user_id != null) return hit.user_id;
  }
  return null;
}

/**
 * 身份解析（严格基于现有 user_identities 表）：
 * 1) 有 unionid 则先查 unionid（OPEN-7 冻结：unionid 优先）；
 * 2) 查当前小程序 openid 作为兜底；
 * 3) 两者都命中且指向【不同】user → conflict（拒绝 + 审计 + 不自动合并）；
 * 4) 命中其一 → matched；均未命中 → not_found（首登建档路径）。
 *
 * 只匹配 active_marker=1 且 status=1 的生效身份行。
 */
export async function resolveWechatIdentity(
  db: D1Database,
  keys: IdentityKeys,
  session: WeChatSession,
): Promise<WechatIdentityResolution> {
  const unionidUserId =
    session.unionid != null
      ? await lookupIdentity(db, 'wechat_unionid', await candidateHashes(keys, session.unionid))
      : null;
  const openidUserId = await lookupIdentity(db, 'wechat_openid', await candidateHashes(keys, session.openid));

  // 冲突保护（OPEN-7）：禁止自动合并、禁止择一继续登录。
  if (unionidUserId != null && openidUserId != null && unionidUserId !== openidUserId) {
    return { kind: 'conflict', unionidUserId, openidUserId };
  }
  if (unionidUserId != null) return { kind: 'matched', userId: unionidUserId, via: 'unionid' };
  if (openidUserId != null) return { kind: 'matched', userId: openidUserId, via: 'openid' };
  return { kind: 'not_found' };
}
