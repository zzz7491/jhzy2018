/**
 * Repository 基础层（S2-5）。
 *
 * 纪律（用户 §十三 / §十六）：
 * - 所有 SQL 参数化：只允许 prepare().bind()，禁止字符串拼接用户输入。
 * - Repository 不读 HTTP request / Cookie，不决定当前用户身份；
 *   身份与租户上下文（RepositoryContext）由 middleware/路由层传入。
 * - 遵循 D1 习惯：first()/all()/run()/batch()，不假设 MySQL BEGIN/COMMIT。
 * - 表级 scope guard 在此统一执行（单一事实来源 = S2-3 Table Matrix）。
 */

import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { RepositoryContext } from '../types/tenant';
import { checkReadAccess } from './tenant-scope';
import { forbidden, teamScopeRequired, userScopeRequired, authRequired } from '../utils/errors';

/** Repository 构造上下文（由路由层组装，绝不来自 HTTP 对象本身）。 */
export interface RepoDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

export class BaseRepository {
  protected readonly db: D1Database;
  protected readonly ctx: RepositoryContext;

  constructor(deps: RepoDeps) {
    this.db = deps.db;
    this.ctx = deps.ctx;
  }

  /**
   * 表级读访问 guard：按 S2-3 矩阵判定。
   * - PLATFORM_GLOBAL：已认证即可（不强制 team_id）。
   * - TEAM_SCOPED：必须带团队上下文。
   * - USER_SCOPED：必须带用户上下文。
   * - AUDIT_ONLY：普通业务 API 不暴露。
   */
  protected ensureTableRead(table: string): void {
    const auth = this.ctx.auth;
    if (!auth.authenticated) throw authRequired();

    const check = checkReadAccess(table, auth);
    if (!check.ok) {
      if (check.reason === 'team_scope_required') throw teamScopeRequired();
      if (check.reason === 'user_scope_required') throw userScopeRequired();
      throw forbidden('Access denied for this resource');
    }
  }

  // ===== 参数化访问封装（禁止任何拼接调用绕过 bind）=====

  protected async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db.prepare(sql).bind(...(params as never[])).all<T>();
    return res.results ?? [];
  }

  protected async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.db.prepare(sql).bind(...(params as never[])).first<T>();
    return (res as T | null) ?? null;
  }

  protected async run(sql: string, params: unknown[] = []): Promise<D1Result> {
    return this.db.prepare(sql).bind(...(params as never[])).run();
  }

  /** 多语句批处理（D1 batch，原子执行；用于本地测试 fixture 等场景）。 */
  protected async batch(stmts: { sql: string; params?: unknown[] }[]): Promise<void> {
    await this.db.batch(
      stmts.map((s) => this.db.prepare(s.sql).bind(...((s.params ?? []) as never[]))),
    );
  }

}
