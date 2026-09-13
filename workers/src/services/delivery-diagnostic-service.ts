/**
 * DeliveryDiagnosticService（N0-G1 — 只读投递诊断编排层）。
 *
 * 职责（N0-G1 冻结契约）：
 * - 服务端权威查询解析：mode 必填（stale_reserved | terminal_failure）；
 *   stale_reserved 的 threshold 必须有 min/max 边界，非法 → 400，禁止负数 / NaN / 无限大。
 * - RESERVED 一律视为 provider outcome = AMBIGUOUS（N0-G1 §5）；不创建 not_sent / safe_to_retry /
 *   retryable 之类字段，不改变数据库。
 * - 响应严格白名单（N0-G1 §4）；保留分页 metadata（沿用 PAGINATION_DEFAULTS）。
 * - 无 mutation / resend / retry / recovery；auth 由 route 的 requirePermission 前置裁决。
 * - Service 不接触 HTTP 对象；依赖由 route 从 Context 组装。
 */

import { DeliveryDiagnosticRepository, type DeliveryDiagnosticRow } from '../repository/delivery-diagnostic';
import { parsePagination } from '../utils/validation';
import { invalidParam } from '../utils/errors';
import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import type { Paginated, PaginationQuery } from '../types/api';

/** stale_reserved threshold 边界（诊断语义默认值，非业务规则）。 */
export const STALE_THRESHOLD_DEFAULT_SEC = 3600; // 1h
export const STALE_THRESHOLD_MIN_SEC = 60; // 1m
export const STALE_THRESHOLD_MAX_SEC = 2592000; // 30d

export type DiagnosticMode = 'stale_reserved' | 'terminal_failure';

/** 解析后的查询（已校验 + clamp）。 */
export interface ResolvedDiagnosticQuery {
  mode: DiagnosticMode;
  thresholdSec: number; // 仅 stale_reserved 使用
  pagination: PaginationQuery;
}

const ALLOWED_QUERY_KEYS = new Set(['mode', 'threshold', 'page', 'page_size']);

export class DeliveryDiagnosticService {
  private readonly repo: DeliveryDiagnosticRepository;

  constructor(deps: { db: D1Database; auth: AuthContext; tenant: TenantContext }) {
    this.repo = new DeliveryDiagnosticRepository({
      db: deps.db,
      ctx: { auth: deps.auth, tenant: deps.tenant },
    });
  }

  /**
   * 解析 query（仅允许 mode / threshold / page / page_size）。
   * - mode 缺失 / 非法 → 400
   * - 其它 key → 400（对齐 analytics 防御式）
   * - stale_reserved 的 threshold：缺省 DEFAULT；非整数 / 越界 → 400
   */
  parseQuery(query: Record<string, string | undefined>): ResolvedDiagnosticQuery {
    const keys = Object.keys(query ?? {});
    for (const k of keys) {
      if (!ALLOWED_QUERY_KEYS.has(k)) throw invalidParam(k, 'unknown query parameter');
    }

    const mode = query?.['mode'];
    if (mode !== 'stale_reserved' && mode !== 'terminal_failure') {
      throw invalidParam('mode', 'must be stale_reserved or terminal_failure');
    }

    const pagination = parsePagination(query as Record<string, string>);

    let thresholdSec = STALE_THRESHOLD_DEFAULT_SEC;
    if (mode === 'stale_reserved') {
      const raw = query?.['threshold'];
      if (raw != null && raw !== '') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < STALE_THRESHOLD_MIN_SEC || n > STALE_THRESHOLD_MAX_SEC) {
          throw invalidParam(
            'threshold',
            `must be an integer between ${STALE_THRESHOLD_MIN_SEC} and ${STALE_THRESHOLD_MAX_SEC} (seconds)`,
          );
        }
        thresholdSec = n;
      }
    }

    return { mode, thresholdSec, pagination };
  }

  /** 执行诊断查询并返回分页投影（白名单 + AMBIGUOUS 语义）。 */
  async diagnose(q: ResolvedDiagnosticQuery): Promise<Paginated<DeliveryDiagnosticView>> {
    const now = Math.floor(Date.now() / 1000);
    const { pageSize, offset } = q.pagination;

    const page =
      q.mode === 'stale_reserved'
        ? await this.repo.listStaleReserved(now - q.thresholdSec, pageSize, offset)
        : await this.repo.listTerminalFailures(pageSize, offset);

    const items: DeliveryDiagnosticView[] = page.items.map((r: DeliveryDiagnosticRow) => {
      const view: DeliveryDiagnosticView = {
        delivery_id: r.delivery_id,
        user_id: r.user_id,
        status: r.status,
        template_key: r.template_key,
        authorization_event_id: r.authorization_event_id,
        idempotency_key: r.idempotency_key,
        provider_error_code: r.provider_error_code,
        provider_error_message: r.provider_error_message,
        attempted_at: r.attempted_at,
        delivered_at: r.delivered_at,
        reserved_age_seconds: now - r.attempted_at,
      };
      // N0-G1 §5：RESERVED 一律视为 provider outcome 未知（ambiguous），绝不暗示可安全重发。
      if (r.status === 'RESERVED') view.provider_outcome = 'AMBIGUOUS';
      return view;
    });

    const totalPages = Math.max(1, Math.ceil(page.total / pageSize));
    return {
      items,
      pagination: {
        page: q.pagination.page,
        page_size: pageSize,
        total: page.total,
        total_pages: totalPages,
      },
    };
  }
}

/** 响应项（N0-G1 §4 白名单 + §5 可选固定诊断字段）。 */
export interface DeliveryDiagnosticView {
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
  reserved_age_seconds: number;
  /** 仅 RESERVED 行返回；固定语义标记，不改变数据库。 */
  provider_outcome?: 'AMBIGUOUS';
}
