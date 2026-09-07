/**
 * MallVerificationService（P25-P3B1）—— 兑换码归一化 + 原子核销编排层。
 *
 * 设计冻结依据：
 *   P25-P1 / P25-P1-REV1 / P25-P1-REV2（exchange_code 12 位 Crockford Base32 / 60-bit）
 *   P25-P3A DESIGN = PASS / P25-P3A-REV1（TEAM 双层守卫 + 精确文件边界）
 *
 * 【本服务唯一职责】
 *  1. 归一化并严格校验 exchange_code（400 若非法）；
 *  2. 调用 MallAdminRepository 的原子核销 UPDATE；
 *  3. changes=0 后经 MallAdminRepository 的 TEAM 守卫重读并分类。
 *
 * 【明确禁止】
 *  - 不直接写 SQL（一律经 repository）；
 *  - 不绕过 repository 的 ensureTableRead 作用域守卫；
 *  - 不修改积分账户 / 流水 / 商品库存（核销不是二次兑换，也不是反向兑换）；
 *  - 不调用 MallService.redeem；
 *  - 不解释 status 3/4 的业务含义（RESERVED，只返回稳定冲突 reason）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { MallAdminRepository, TeamOrderView } from '../repository/mall-admin';
import { conflict, invalidParam, notFound, ConflictReason } from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装；Service 不接触 HTTP 对象）。 */
export interface MallVerificationServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

/**
 * 规范化后的兑换码正则：12 位 Crockford Base32（剔除易混淆的 I / L / O / U）。
 * 与 MallService.generateExchangeCode() 的输出字符集严格一致。
 */
const EXCHANGE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** 已核销状态：2 = 已领取 / 已核销。 */
const MALL_ORDER_STATUS_VERIFIED = 2;

/**
 * 归一化管理员输入的 exchange_code：
 *   trim → 移除所有空白 → 移除连字符 → 转大写
 * 之后严格校验 12 位 Crockford Base32；非法 → invalidParam（400）。
 * 返回值即 DB / API 的 canonical 形式（不含连字符）。
 */
export function normalizeExchangeCode(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw invalidParam('exchange_code', 'must be a string');
  }
  const normalized = raw.trim().replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
  if (!EXCHANGE_CODE_RE.test(normalized)) {
    throw invalidParam('exchange_code', 'must be 12 Crockford Base32 characters');
  }
  return normalized;
}

/** 核销结果（HTTP 语义由路由折叠：verified / already_verified 均为 200）。 */
export type VerifyOutcome =
  | { status: 'verified'; order: TeamOrderView }
  | { status: 'already_verified'; order: TeamOrderView };

export class MallVerificationService {
  private readonly auth: AuthContext;
  private readonly repo: MallAdminRepository;

  constructor(deps: MallVerificationServiceDeps) {
    this.auth = deps.auth;
    this.repo = new MallAdminRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /** 按兑换码核销（幂等：重复核销返回 already_verified，不改写首次核销记录）。 */
  async verifyExchangeCode(rawCode: unknown): Promise<VerifyOutcome> {
    // 1. 归一化 + 严格校验（非法 → 400，不进入任何 DB）。
    const code = normalizeExchangeCode(rawCode);

    // 2. 核销操作人必须来自认证上下文（绝不接受客户端提交）。
    const verifiedBy = this.auth.userId;
    if (verifiedBy == null) {
      throw invalidParam('verifier', 'authenticated user required');
    }
    const now = Math.floor(Date.now() / 1000);

    // 3. 单条原子 UPDATE（WHERE exchange_code + team_id + status=1）。
    const changes = await this.repo.verifyOrder(code, verifiedBy, now);
    if (changes === 1) {
      const order = await this.repo.getByExchangeCode(code);
      if (!order) throw notFound('Order');
      return { status: 'verified', order };
    }

    // 4. changes=0 → TEAM 作用域内重读分类（不产生跨团队存在性 oracle）。
    const existing = await this.repo.getByExchangeCode(code);

    // 不存在 / 兑换码错误 / 跨团队 / legacy NULL（exchange_code IS NULL）→ 统一 404。
    if (!existing) throw notFound('Order');

    // 已核销 → 幂等成功；绝不再次更新 verified_by / verified_at / updated_at，
    // 保留第一次核销的操作人与时间。
    if (existing.status === MALL_ORDER_STATUS_VERIFIED) {
      return { status: 'already_verified', order: existing };
    }

    // status ∈ {3,4}：RESERVED，不解释其业务含义，统一 409。
    throw conflict(ConflictReason.MALL_ORDER_NOT_VERIFIABLE);
  }
}
