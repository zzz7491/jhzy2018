import type { Env } from '../env';

/**
 * 数据访问基础层：统一 D1 访问入口，强制【参数化 SQL】。
 *
 * 纪律：
 * - 禁止字符串拼接 SQL（防止注入）。
 * - 所有动态值通过 prepare(...).bind(...params) 传入。
 * - 不引入 ORM。
 */

/** 取 D1 绑定。 */
export function db(c: { env: Env }): D1Database {
  return c.env.DB;
}

/** 查询多行。 */
export async function all<T = Record<string, unknown>>(
  c: { env: Env },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await c.env.DB.prepare(sql)
    .bind(...(params as never[]))
    .all<T>();
  return res.results ?? [];
}

/** 查询单行（无结果返回 null）。 */
export async function first<T = Record<string, unknown>>(
  c: { env: Env },
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await c.env.DB.prepare(sql)
    .bind(...(params as never[]))
    .first<T>();
  return (res as T | null) ?? null;
}

/** 执行写操作（INSERT/UPDATE/DELETE）。 */
export async function run(
  c: { env: Env },
  sql: string,
  params: unknown[] = [],
): Promise<D1Result> {
  return c.env.DB.prepare(sql)
    .bind(...(params as never[]))
    .run();
}

/** 执行多语句（同一事务内）。用于测试 fixture 等本地操作。 */
export async function batch(
  c: { env: Env },
  stmts: { sql: string; params?: unknown[] }[],
): Promise<void> {
  const tx = c.env.DB.batch(
    stmts.map((s) => c.env.DB.prepare(s.sql).bind(...((s.params ?? []) as never[]))),
  );
  await tx;
}
