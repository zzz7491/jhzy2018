/**
 * DeliveryDiagnosticRepository（N0-G1 — 只读投递诊断专用仓库）。
 *
 * 设计纪律（N0-G1 冻结契约）：
 * - 复刻 repository/analytics.ts 的「平台跨用户只读」模式：本仓库方法不调用
 *   assertUserScoped / ensureTableRead（route 已通过 audit.log.view @ 平台作用域 授权）。
 * - 仅 SELECT 响应白名单所需字段；绝不 JOIN notification_delivery_identities /
 *   notifications / notification_recipients。
 * - 不返回 raw openid / encrypted openid / phone / id_card / token / secret / provider payload。
 * - 全部 SQL 参数化（prepare().bind()），禁止拼接用户输入。
 * - 不修改普通 notification-delivery 的 USER_SCOPED 行为（N0-G1 §6）。
 * - 本仓库为只读诊断：无 mutation / resend / retry / recovery / dead-letter。
 */

import { BaseRepository } from './base';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';

/** 诊断投影行（严格白名单，对应 N0-G1 §4 响应 allowlist）。 */
export interface DeliveryDiagnosticRow {
  delivery_id: number;
  user_id: number;
  status: string;
  template_key: string | null;
  authorization_event_id: number | null;
  idempotency_key: string | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  attempted_at: number;
  delivered_at: number | null;
}

export interface DeliveryDiagnosticPage {
  items: DeliveryDiagnosticRow[];
  total: number;
}

/** 投影 SELECT（仅白名单字段）；供 stale / terminal 两类查询复用。 */
const DIAG_SELECT = `
  SELECT
    id                          AS delivery_id,
    user_id                     AS user_id,
    status                      AS status,
    template_key                AS template_key,
    authorization_event_id      AS authorization_event_id,
    idempotency_key             AS idempotency_key,
    provider_error_code         AS provider_error_code,
    provider_error_message      AS provider_error_message,
    attempted_at                AS attempted_at,
    delivered_at                AS delivered_at
  FROM notification_deliveries
`;

export class DeliveryDiagnosticRepository extends BaseRepository {
  // 不调用 ensureTableRead / assertUserScoped：route 已通过 audit.log.view 平台作用域授权。

  /**
   * 查询长期悬挂的 RESERVED 投递（stale reserved）。
   * - status = 'RESERVED'
   * - attempted_at < cutoff（= now - threshold），即超过阈值仍未定稿。
   * - 确定性排序：attempted_at DESC, id DESC。
   */
  async listStaleReserved(cutoff: number, limit: number, offset: number): Promise<DeliveryDiagnosticPage> {
    const items = await this.all<DeliveryDiagnosticRow>(
      `${DIAG_SELECT}
       WHERE status = 'RESERVED' AND attempted_at < ?
       ORDER BY attempted_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [cutoff, limit, offset],
    );
    const totalRow = await this.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM notification_deliveries WHERE status = 'RESERVED' AND attempted_at < ?`,
      [cutoff],
    );
    return { items, total: Number(totalRow?.c ?? 0) };
  }

  /**
   * 查询终态失败（terminal failures）。
   * - status IN ('PROVIDER_ERROR', 'NETWORK_ERROR')。
   * - 默认不含 DELIVERED / PROVIDER_REJECTED / INVALID_PAYLOAD / NOT_ELIGIBLE / RESERVED。
   * - 确定性排序：attempted_at DESC, id DESC。
   */
  async listTerminalFailures(limit: number, offset: number): Promise<DeliveryDiagnosticPage> {
    const items = await this.all<DeliveryDiagnosticRow>(
      `${DIAG_SELECT}
       WHERE status IN ('PROVIDER_ERROR', 'NETWORK_ERROR')
       ORDER BY attempted_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    const totalRow = await this.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM notification_deliveries WHERE status IN ('PROVIDER_ERROR', 'NETWORK_ERROR')`,
      [],
    );
    return { items, total: Number(totalRow?.c ?? 0) };
  }
}

/** Service 依赖（由 route 从 Context 组装；Service/Repository 不接触 HTTP 对象）。 */
export interface DeliveryDiagnosticRepoDeps {
  db: import('@cloudflare/workers-types').D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}
