/**
 * AnalyticsService（P37-C1）—— 数据运营运营概览编排层。
 *
 * 职责（P37-C1 §6 / §7 / §9 / §11）：
 * - 服务端权威的 range 解析（server-authoritative）：仅允许 today / 7d / 30d / month，
 *   其它值 → 400；缺失 → 冻结默认值 7d。不接收自定义日期，不依赖 Worker runtime 时区。
 * - 时区固定 Asia/Shanghai（UTC+8，无 DST）：区间 [start, end) 半开。
 * - 授权前提由 route middleware 判定（analytics.team.view / analytics.platform.view）；
 *   本服务只调用正确的 repository 路径并返回安全投影（仅聚合数字）。
 * - 拒绝任何其它 query key（team_id / user_id / sql / fields / groupBy / filters / raw / start / end）。
 *
 * 服务层不接触 HTTP 对象；依赖由 route 从 Context 组装。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { AnalyticsRepository, type AnalyticsMetrics, type ResolvedRange, type RangeKey } from '../repository/analytics';
import { invalidParam } from '../utils/errors';

/** 冻结的默认 range（缺失 query 时使用）。 */
export const DEFAULT_RANGE: RangeKey = '7d';

/** 允许的 range 取值。 */
export const VALID_RANGES: readonly RangeKey[] = ['today', '7d', '30d', 'month'] as const;

/**
 * 禁止出现在 query 中的 key（P37-C1 §9）。
 * 任何此类 key → 400 INVALID_REQUEST；TEAM endpoint 永远从 active team 取 team_id，
 * PLATFORM endpoint 不接收 team_id。
 */
export const FORBIDDEN_QUERY_KEYS: readonly string[] = [
  'team_id',
  'user_id',
  'sql',
  'fields',
  'groupBy',
  'filters',
  'raw',
  'start',
  'end',
] as const;

// ---------------------------------------------------------------------------
// 时区：Asia/Shanghai = UTC+8，无 DST。所有「日界」以服务端上海时区为权威，
// 不读取 Worker runtime 时区，避免被部署区时区污染。
// ---------------------------------------------------------------------------
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400_000;

/** 当前上海墙钟的年/月/日（month 0-based）。 */
function shanghaiTodayParts(): { y: number; m: number; d: number } {
  const sh = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  return { y: sh.getUTCFullYear(), m: sh.getUTCMonth(), d: sh.getUTCDate() };
}

/** 由 (y, m, d) 计算「上海自然日 00:00」对应的 epoch 秒。 */
function shanghaiMidnightEpochSec(y: number, m: number, d: number): number {
  const asUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0);
  return Math.floor((asUtcMs - SHANGHAI_OFFSET_MS) / 1000);
}

/**
 * 计算给定 range 的 [start, end) epoch 秒区间（上海时区，半开）。
 * - today：今天上海 00:00 → 明天上海 00:00
 * - 7d：今天-6 天 00:00 → 明天 00:00
 * - 30d：今天-29 天 00:00 → 明天 00:00
 * - month：本月 1 日 00:00 → 下月 1 日 00:00
 */
export function computeRange(range: RangeKey): ResolvedRange {
  const { y, m, d } = shanghaiTodayParts();
  const todayMidSec = shanghaiMidnightEpochSec(y, m, d);
  const tomorrowSec = Math.floor((Date.UTC(y, m, d, 0, 0, 0, 0) - SHANGHAI_OFFSET_MS + DAY_MS) / 1000);

  switch (range) {
    case 'today':
      return { range, start: todayMidSec, end: tomorrowSec };

    case '7d':
      return {
        range,
        start: Math.floor((Date.UTC(y, m, d, 0, 0, 0, 0) - SHANGHAI_OFFSET_MS - 6 * DAY_MS) / 1000),
        end: tomorrowSec,
      };

    case '30d':
      return {
        range,
        start: Math.floor((Date.UTC(y, m, d, 0, 0, 0, 0) - SHANGHAI_OFFSET_MS - 29 * DAY_MS) / 1000),
        end: tomorrowSec,
      };

    case 'month': {
      const monthStartSec = shanghaiMidnightEpochSec(y, m, 1);
      const nextMonthSec = shanghaiMidnightEpochSec(y, m + 1, 1);
      return { range, start: monthStartSec, end: nextMonthSec };
    }
  }
}

/**
 * 解析 query（仅允许 range 一个 key）。返回已解析区间。
 * - 其它 key → 400 INVALID_PARAM（unknown query parameter）
 * - range 缺省 → DEFAULT_RANGE (7d)
 * - range 非法值 → 400 INVALID_PARAM
 */
export function parseRangeQuery(query: Record<string, string | undefined>): ResolvedRange {
  const keys = Object.keys(query ?? {});
  for (const k of keys) {
    if (k === 'range') continue;
    if (FORBIDDEN_QUERY_KEYS.includes(k)) {
      throw invalidParam(k, 'query parameter is not allowed');
    }
    throw invalidParam(k, 'unknown query parameter');
  }

  const raw = query?.['range'];
  if (raw == null || raw === '') return computeRange(DEFAULT_RANGE);
  if (!(VALID_RANGES as readonly string[]).includes(raw)) {
    throw invalidParam('range', 'must be one of today|7d|30d|month');
  }
  return computeRange(raw as RangeKey);
}

/** 服务依赖（由 route 从 Context 组装；Service 不接触 HTTP 对象）。 */
export interface AnalyticsServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export class AnalyticsService {
  private readonly repo: AnalyticsRepository;

  constructor(deps: AnalyticsServiceDeps) {
    this.repo = new AnalyticsRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /** TEAM 运营概览（team_id 来自 server active team，由 repository 内部从 ctx 取）。 */
  async getTeamOverview(range: ResolvedRange): Promise<AnalyticsMetrics> {
    return this.repo.computeTeamMetrics(range);
  }

  /** PLATFORM 运营概览（不依赖 active team）。 */
  async getPlatformOverview(range: ResolvedRange): Promise<AnalyticsMetrics> {
    return this.repo.computePlatformMetrics(range);
  }
}
