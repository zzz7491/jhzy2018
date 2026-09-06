/**
 * PointsService（P23-P4B）—— 个人积分账户 / 流水 SELF 只读编排层。
 *
 * 设计冻结依据：
 *   P23-P4A DESIGN = PASS
 *
 * 职责（本切片范围，P23-P4B）：
 * - getAccount()     ：当前登录用户（auth.userId）的积分账户，缺失返回逻辑零对象（GET 纯读）。
 * - listTransactions()：当前登录用户自己的积分流水，项目规范分页（page/page_size，max=100）。
 *
 * 范围纪律（用户 §三 / §九 / §十）：
 * - 不接受任何 userId / user_id 参数；SELF scope 强制由 auth.userId 决定。
 * - 不暴露内部 id（id/user_id/source_id/operator_id/request_id/last_ledger_id/last_checked_at）。
 * - 全部返回整数 units（API 以 *_units 后缀命名）；不提供浮点 points 展示字段，不引入 decimal/currency lib。
 * - GET 零 DB mutation（仅 first()/all()，无 run()/batch()/INSERT）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import type { Paginated, PaginationQuery } from '../types/api';
import {
  PointsLedgerRepository,
  type PointsAccountView,
  type PointsLedgerView,
} from '../repository/points-ledger';
import { parsePagination } from '../utils/validation';
import { authRequired } from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装；Service 不接触 HTTP 对象）。 */
export interface PointsServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

/** GET /account 对外投影（整数 units；缺失账户返回全零）。 */
export interface PointsAccountSelfView {
  balance_units: number;
  total_earned_units: number;
  total_spent_units: number;
  total_debits_units: number;
  updated_at: number | null;
}

/** GET /transactions 单条对外投影（整数 units；内部 id 不暴露）。 */
export interface PointsTransactionSelfView {
  direction: number;
  amount_units: number;
  balance_after_units: number;
  type: string;
  source_type: string | null;
  source_public_id: string | null;
  remark: string | null;
  created_at: number;
}

/** 逻辑零账户（账户尚不存在时的稳定非 null 响应）。 */
const ZERO_ACCOUNT: PointsAccountSelfView = {
  balance_units: 0,
  total_earned_units: 0,
  total_spent_units: 0,
  total_debits_units: 0,
  updated_at: null,
};

export class PointsService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly pointsRepo: PointsLedgerRepository;

  constructor(deps: PointsServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.pointsRepo = new PointsLedgerRepository({
      db: deps.db,
      ctx: { auth: deps.auth, tenant: deps.tenant },
    });
  }

  /**
   * 当前登录用户的积分账户（SELF）。
   * - 未认证 / userId 缺失 → authRequired()（401）。
   * - 真实账户不存在 → 返回逻辑零对象（**不写入**任何 account row）。
   */
  async getAccount(): Promise<PointsAccountSelfView> {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    const row: PointsAccountView | null = await this.pointsRepo.getAccount(this.auth.userId);
    if (row == null) return ZERO_ACCOUNT;
    return {
      balance_units: row.balance,
      total_earned_units: row.total_earned,
      total_spent_units: row.total_spent,
      total_debits_units: row.total_debits,
      updated_at: row.updated_at,
    };
  }

  /**
   * 当前登录用户自己的积分流水（SELF），项目规范分页。
   * - 未认证 / userId 缺失 → authRequired()（401）。
   * - 不接受任何 user_id query；范围完全由 auth.userId 决定。
   * - 返回 Paginated<PointsTransactionSelfView>（整数 units，内部 id 已剔除）。
   */
  async listTransactions(query: Record<string, string>): Promise<Paginated<PointsTransactionSelfView>> {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    const pg: PaginationQuery = parsePagination(query);

    const rows = await this.pointsRepo.listTransactions(this.auth.userId, pg.page, pg.pageSize, pg.offset);
    const total = await this.pointsRepo.countTransactions(this.auth.userId);

    const items: PointsTransactionSelfView[] = rows.map((r: PointsLedgerView) => ({
      direction: r.direction,
      amount_units: r.amount,
      balance_after_units: r.balance_after,
      type: r.type,
      source_type: r.source_type,
      source_public_id: r.source_public_id,
      remark: r.remark,
      created_at: r.created_at,
    }));

    return {
      items,
      pagination: {
        page: pg.page,
        page_size: pg.pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pg.pageSize)),
      },
    };
  }
}
