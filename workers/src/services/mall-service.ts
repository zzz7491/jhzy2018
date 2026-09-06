/**
 * MallService（P24-P2D）—— 兑换原子执行编排层。
 *
 * 设计冻结依据：
 *   P24-P1 DESIGN = PASS
 *   P24-P2A PREFLIGHT = PASS（attempt token 协议）
 *   P24-P2B = PASS（3 权限 + 6 绑定）
 *   P24-P2C = PASS（buildRedeemStatements S1–S4 已验证）
 *
 * 【本阶段边界】
 * - 唯一职责：把 P2C 已验证的 S1→S4 真正推进 db.batch 原子执行，并处理
 *   幂等（order_no 复用）、冲突（409）、失败原因分类。
 * - 禁止 route/app、禁止正式 test、禁止修改 migration/catalog、禁止进入 P24-P3。
 *
 * 【客户端输入冻结（P24 v1）】
 * - 唯一兑换输入：productPublicId（商品 ULID）+ orderNo（客户端 26-char ULID）。
 * - 禁止接受 verifyCode / userId / teamId / productId / title / points / cost / stock / quantity。
 * - verifyCode 由本服务每次新建订单时服务端生成（generateUlid），绝不由客户端提交。
 * - quantity = 1 fixed（真实 mall_orders 无 quantity 列）。
 */

import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { MallRedemptionRepository, MALL_PRODUCT_STATUS_ACTIVE } from '../repository/mall-redemption';
import { generateUlid } from '../utils/crypto';
import { isUlid } from '../utils/validation';
import {
  conflict,
  notFound,
  invalidParam,
  internalError,
  ConflictReason,
  AppError,
} from '../utils/errors';

/** 服务依赖（由路由层从 Context 组装；Service 不接触 HTTP 对象）。 */
export interface MallServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

/** 兑换请求（客户端仅允许这两个字段）。 */
export interface RedeemRequest {
  /** 商品外部 id（mall_products.public_id，ULID）。 */
  productPublicId: string;
  /** 客户端生成的 26 位 ULID 订单号（幂等键）。 */
  orderNo: string;
}

/** 兑换结果（内部稳定结构；route 层再投影为 API 视图，禁止直接暴露内部 id）。 */
export type RedeemOutcome =
  | { status: 'created'; orderNo: string }
  | { status: 'existing'; orderNo: string };

export class MallService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly repo: MallRedemptionRepository;

  constructor(deps: MallServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.repo = new MallRedemptionRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /** 执行一次兑换（原子 db.batch；幂等/冲突/失败分类）。 */
  async redeem(req: RedeemRequest): Promise<RedeemOutcome> {
    // 1. 输入冻结 + ULID 校验（非法 → 400，不 normalize，不进入任何 DB）。
    if (!isUlid(req.productPublicId)) {
      throw invalidParam('productPublicId', 'must be a 26-char ULID');
    }
    if (!isUlid(req.orderNo)) {
      throw invalidParam('orderNo', 'must be a 26-char ULID');
    }

    // 2. 既有 order_no 归属判定（纯 SELECT，不暴露跨团队字段）。
    const pre = await this.repo.getOrderNoState(req.orderNo, req.productPublicId);
    if (pre.taken) {
      if (pre.sameIdentity) {
        // 同 user + 同 team + 同 product 复用 order_no → 幂等成功，绝不二次执行 batch。
        return { status: 'existing', orderNo: req.orderNo };
      }
      // 不同 user/team/product 占用了该 order_no → 409 冲突（不泄露既存订单任何信息）。
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }

    // 3. 服务端生成本次 attempt token（绝不接受客户端 verifyCode）。
    const verifyCode = generateUlid();
    const now = Math.floor(Date.now() / 1000);

    // 4. 一次性 db.batch([S1,S2,S3,S4])（禁止四次独立 run / 两个 batch / 先扣再建）。
    const { statements } = this.repo.buildRedeemStatements({
      productPublicId: req.productPublicId,
      orderNo: req.orderNo,
      verifyCode,
      now,
    });

    let results: D1Result[];
    try {
      results = await this.db.batch(statements);
    } catch (e) {
      // 真正的 SQL 错误（FK/约束/语法）→ D1 batch 已整体 rollback；不伪装成成功。
      // 不依赖 UNIQUE(points_ledger.request_id) 作为正常 retry 路径。
      throw this.classifyDbError(e);
    }

    const [c1, c2, c3, c4] = results.map((r) => Number(r.meta?.changes ?? 0));

    // 5. 结果不变量处理。
    if (c1 === 1 && c2 === 1 && c3 === 1 && c4 === 1) {
      return { status: 'created', orderNo: req.orderNo };
    }
    if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0) {
      // gate 失败 / 并发输家 / retry 竞态 → 重新只读判定当前状态。
      return this.handleZeroChanges(req);
    }
    // 其它 pattern（1/1/0/1 等）按设计不应发生 → 内部错误（batch 已完成，仅侦测不可能状态）。
    throw internalError();
  }

  /** 0/0/0/0 后的状态再判定与稳定错误分类（不执行任何写）。 */
  private async handleZeroChanges(req: RedeemRequest): Promise<RedeemOutcome> {
    const post = await this.repo.getOrderNoState(req.orderNo, req.productPublicId);
    if (post.taken) {
      if (post.sameIdentity) return { status: 'existing', orderNo: req.orderNo };
      throw conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }
    // order_no 未出现 → 按真实状态分类稳定错误（无 mutation）。
    const product = await this.repo.getProductRedeemState(req.productPublicId);
    if (product == null) {
      // 不存在 / 跨团队 → 一律 404，不泄露。
      throw notFound('Product');
    }
    if (product.status !== MALL_PRODUCT_STATUS_ACTIVE || product.deletedAt != null) {
      throw notFound('Product');
    }
    if (product.stock < 1) {
      // 库存耗尽 → 专用 Mall reason（不泄露真实库存数字）。
      throw conflict(ConflictReason.MALL_OUT_OF_STOCK);
    }
    const balance = await this.repo.getSelfBalance();
    if (balance == null || balance < product.pointsPrice) {
      // 无账户（balance=null）/ 余额不足 → 统一按"余额不足"语义，专用 Mall reason（不泄露具体余额）。
      throw conflict(ConflictReason.MALL_INSUFFICIENT_BALANCE);
    }
    // 兜底：不应到达（gate 已覆盖所有可兑换前提）。
    throw internalError();
  }

  /** 把真实 DB 约束/FK 错误映射为项目 error；已知 domain conflict 映射，未知保持内部错误。 */
  private classifyDbError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    // 并发竞争下 UNIQUE(order_no) 命中（极小概率；verify_code 为服务端生成）。
    if (/UNIQUE constraint failed.*order_no|unique.*mall_orders.*order_no/i.test(msg)) {
      return conflict(ConflictReason.PUBLIC_ID_CONFLICT);
    }
    return internalError();
  }
}
