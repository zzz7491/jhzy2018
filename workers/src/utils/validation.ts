/**
 * 最小输入校验层（S2-5）。
 *
 * 纪律（用户 §十七）：
 * - 禁止直接信任 req.param() / req.query() / req.json() 中的值。
 * - 不引入大型 validation framework（现有依赖未使用）。
 * - 分页默认/上限为 IMPLEMENTATION DEFAULT。
 */

import { PAGINATION_DEFAULTS } from '../types/api';
import type { PaginationQuery } from '../types/api';
import { invalidParam } from './errors';

/**
 * ULID 字符集（Crockford Base32，排除 I/L/O/U）。
 * Schema 中 users/teams/activities 的 public_id 均为 ULID（S2-3 设计）。
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** 校验 path 参数为合法 ULID（public_id）。非法 → 400 INVALID_PARAM（先于任何 DB 访问）。 */
export function requireUlidParam(value: string | undefined, name: string): string {
  if (value == null || !isUlid(value)) {
    throw invalidParam(name, 'must be a 26-char ULID');
  }
  return value;
}

/**
 * 校验 path 参数为正整数（S2-6i：attendance_sessions.id 为 INTEGER PRIMARY KEY）。
 * 非法（非整数 / ≤0 / 空 / 注入载荷）→ 400 INVALID_PARAM（先于任何 DB 访问）。
 * 仅做格式校验；资源是否存在、是否属于当前租户由 Repository 的 team_id WHERE 决定（§八/§九）。
 */
export function requirePositiveIntParam(value: string | undefined, name: string): number {
  if (value == null || value.trim() === '') {
    throw invalidParam(name, 'must be a positive integer');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw invalidParam(name, 'must be a positive integer');
  }
  return n;
}

/**
 * 解析并 clamp 分页参数。
 * - page / page_size 必须是正整数字符串；非数字 → 400。
 * - page_size 上限 = PAGINATION_DEFAULTS.maxPageSize（IMPLEMENTATION DEFAULT）。
 */
export function parsePagination(query: Record<string, string>): PaginationQuery {
  const rawPage = query.page ?? String(PAGINATION_DEFAULTS.page);
  const rawSize = query.page_size ?? String(PAGINATION_DEFAULTS.pageSize);

  const page = Number(rawPage);
  const pageSize = Number(rawSize);
  if (!Number.isInteger(page) || page < 1) {
    throw invalidParam('page', 'must be a positive integer');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw invalidParam('page_size', 'must be a positive integer');
  }
  const clampedSize = Math.min(pageSize, PAGINATION_DEFAULTS.maxPageSize);
  return { page, pageSize: clampedSize, offset: (page - 1) * clampedSize };
}

