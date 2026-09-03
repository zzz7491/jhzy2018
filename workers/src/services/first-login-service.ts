/**
 * 首次微信登录建档（S2-6c-3，指令 §一 OPEN-1 / §二）。
 *
 * 裁决要点：
 * - 微信身份验证成功但 user_identities 未命中（且不存在身份冲突）时，
 *   【允许】创建最小用户主体：仅 users + user_identities，然后创建 Session。
 * - 严禁连带创建：user_roles / team_members / volunteer / team_admin / team_owner /
 *   platform role / 默认团队 / permissions / role_permissions —— 本文件不含这些表的任何写入。
 * - "成功登录" 与 "拥有志愿者角色" 严格分离：首登用户 role = none、team context = none。
 *
 * 原子性（指令 §二硬要求）：
 * - users + user_identities + sessions 必须同生同灭，绝不允许出现
 *   "users 创建成功、user_identity 创建失败" 留下半成品用户。
 * - 实现：D1 `db.batch()` —— 单事务，任一语句失败整批回滚。
 * - batch 内无法跨语句取 last_insert_rowid()，改用【业务键 public_id 子查询引用】：
 *     (SELECT id FROM users WHERE public_id = ?)
 *   同一事务内语句按序执行，前序 INSERT 对后序语句可见，因此该引用成立。
 *
 * 事务边界说明（写入报告 §二）：
 * - 本 batch = users + user_identities(1~2 行) + sessions，是【唯一】的原子单元。
 * - 冲突审计（security_events）刻意【不在】该 batch 内：它是旁路审计，
 *   失败必须 fail-open，不能污染登录事务；且冲突路径根本不创建用户。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { generateUlid, hmacSha256Hex } from '../utils/crypto';
import { normalizeUserAgentForStore } from '../utils/device-name';
import { planSessionInsert } from './session-service';

/** 首登用户初始认证等级：L1 已注册（cert_level CHECK IN (0,1,2)；0=L0 游客占位，2=L2 认证志愿者）。 */
export const FIRST_LOGIN_CERT_LEVEL = 1;

/** 首登用户初始账号状态：1 正常（status CHECK IN (1,2,3)；2=禁用，3=注销）。 */
export const FIRST_LOGIN_USER_STATUS = 1;

export interface ProvisionFirstLoginParams {
  db: D1Database;
  /** 身份摘要密钥（HMAC-SHA256，来自 Secret；本函数不打印、不返回）。 */
  identityKey: string;
  openid: string;
  unionid: string | null;
  userAgent?: string | null;
  /** 会话 TTL（秒），来自统一配置 config/session-ttl.ts。 */
  ttlSeconds: number;
}

export interface ProvisionFirstLoginResult {
  userId: number;
  publicId: string;
  token: string;
  expiresAt: number;
  /** 实际写入的身份行数（unionid 存在时为 2，否则 1）。 */
  identityRows: number;
}

/**
 * 原子创建：users + user_identities + sessions。
 *
 * 并发保护：user_identities 的 UNIQUE(identity_type, identity_hash, active_marker)
 * 保证同一微信标识不会被并发建档两次；若整批因唯一约束失败，
 * 由调用方重新解析身份（命中既有用户则正常登录），不留半成品。
 */
export async function provisionFirstLogin(
  params: ProvisionFirstLoginParams,
): Promise<ProvisionFirstLoginResult> {
  const { db, identityKey, openid, unionid, ttlSeconds } = params;
  const now = Math.floor(Date.now() / 1000);

  const publicId = generateUlid();
  const openidHash = await hmacSha256Hex(identityKey, openid);
  const unionidHash = unionid != null ? await hmacSha256Hex(identityKey, unionid) : null;
  const userAgent = normalizeUserAgentForStore(params.userAgent ?? null);

  const userRefSql = `(SELECT id FROM users WHERE public_id = ?)`;

  // ① users —— 最小主体：不写昵称占位假数据（nickname=NULL），不触碰任何其它业务表。
  const stmts = [
    db
      .prepare(
        `INSERT INTO users (public_id, nickname, cert_level, status, last_login_at, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
      )
      .bind(publicId, FIRST_LOGIN_CERT_LEVEL, FIRST_LOGIN_USER_STATUS, now, now),
  ];

  // ② user_identities —— unionid（若有）+ openid，均 active_marker=1 / status=1。
  if (unionidHash != null) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO user_identities (user_id, identity_type, identity_hash, active_marker, status, bound_at)
           VALUES (${userRefSql}, 'wechat_unionid', ?, 1, 1, ?)`,
        )
        .bind(publicId, unionidHash, now),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO user_identities (user_id, identity_type, identity_hash, active_marker, status, bound_at)
         VALUES (${userRefSql}, 'wechat_openid', ?, 1, 1, ?)`,
      )
      .bind(publicId, openidHash, now),
  );

  // ③ sessions —— 与上面同一 batch，全部成功或全部回滚。
  const sessionPlan = await planSessionInsert({
    usersPublicId: publicId,
    userAgent,
    ttlSeconds,
  });
  stmts.push(db.prepare(sessionPlan.sql).bind(...sessionPlan.binds));

  await db.batch(stmts);

  // batch 成功后回读 id（仅用于响应与审计，不依赖它做业务判定）。
  const row = await db
    .prepare(`SELECT id FROM users WHERE public_id = ?`)
    .bind(publicId)
    .first<{ id: number }>();
  if (row == null) throw new Error('provisionFirstLogin: user missing after batch');

  return {
    userId: row.id,
    publicId,
    token: sessionPlan.token,
    expiresAt: sessionPlan.expiresAt,
    identityRows: unionidHash != null ? 2 : 1,
  };
}
