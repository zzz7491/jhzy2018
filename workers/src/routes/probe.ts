import { Hono } from 'hono';
import type { Env, AppVars } from '../env';

/**
 * GET /probe —— 只读 DB probe，确认 Worker → D1 → SQL 完整链路。
 *
 * 仅返回非敏感聚合计数，不写任何业务数据：
 * - migration tracking 行数
 * - roles 数量
 * - permissions / role_permissions / user_roles 数量（验证权限目录冻结：应为 0）
 * - 6 角色 code + scope（验证 volunteer = team）
 */
const probe = new Hono<{ Bindings: Env; Variables: AppVars }>();

probe.get('/', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM d1_migrations)   AS migrations,
       (SELECT COUNT(*) FROM roles)            AS roles,
       (SELECT COUNT(*) FROM permissions)      AS permissions,
       (SELECT COUNT(*) FROM role_permissions) AS role_permissions,
       (SELECT COUNT(*) FROM user_roles)       AS user_roles`,
  ).first<{
    migrations: number;
    roles: number;
    permissions: number;
    role_permissions: number;
    user_roles: number;
  }>();

  return c.json({
    probe: 'db',
    data: row ?? null,
  });
});

probe.get('/roles', async (c) => {
  const res = await c.env.DB.prepare('SELECT code, name, scope FROM roles ORDER BY id')
    .all<{ code: string; name: string; scope: string }>();
  return c.json({
    roles: res.results ?? [],
    // 关键断言：volunteer 必须为 team scope（S2-2G 裁定，不得回退为 platform）。
    volunteerScope: (res.results ?? []).find((r) => r.code === 'volunteer')?.scope ?? null,
  });
});

export default probe;
