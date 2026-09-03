/**
 * 本地测试专用路由（S2-5）——【TEST-ONLY，production 不可达】。
 *
 * 纪律：
 * - 仅当 ENVIRONMENT === 'local' 时处理器才工作；其他环境一律 404（无任何副作用）。
 * - /boom：故意抛出携带"伪 SQL / 伪路径 / 伪 secret / 伪 stack"的异常，
 *   用于验证 error-handler 不向客户端泄露任何内部信息（§十五 L）。
 * - /permission?code=...：验证 DB-backed 权限判定
 *   （code 存在且当前用户持有 → 200；存在但无授权 → 403 FORBIDDEN；不存在 → 500 配置错误）。
 * - /permissions：返回当前用户经 D1PermissionProvider 解析出的有效 permission 集合（调试/测试用）。
 * - 二者均只读 permissions / role_permissions，不写入任何权限数据。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ok } from '../utils/response';
import { authorizePermission } from '../middleware/rbac';
import { D1PermissionProvider } from '../services/permission-provider';
import { notFound } from '../utils/errors';

const testRoutes = new Hono<{ Bindings: Env; Variables: AppVars }>();

function localOnly(c: { env: Env }): void {
  if ((c.env.ENVIRONMENT ?? 'local') !== 'local') throw notFound('Route');
}

// 故意触发未知异常：message 含内部样式的敏感片段，error-handler 必须全部剥离。
testRoutes.get('/boom', (c) => {
  localOnly(c);
  throw new Error(
    'SELECT * FROM secret_table WHERE x=1 -- /home/user/.env password=hunter2 at StackTrace:frame0',
  );
});

// DB-backed 权限判定验证（请求期经 D1PermissionProvider 解析；只读，不写）。
testRoutes.get('/permission', async (c) => {
  localOnly(c);
  const code = c.req.query('code') ?? '';
  await authorizePermission(c.env, c.get('auth'), code);
  return ok(c, { authorized: true, code });
});

// 当前用户有效 permission 集合回显（S2-6f：验证 Platform ∪ Team(active) 解析）。
testRoutes.get('/permissions', async (c) => {
  localOnly(c);
  const auth = c.get('auth');
  const provider = new D1PermissionProvider(c.env.DB);
  const perms = await provider.getPermissions(auth);
  return ok(c, {
    authenticated: auth.authenticated,
    userId: auth.userId,
    teamId: auth.teamId,
    roleBindings: auth.roles,
    permissions: Array.from(perms).sort(),
  });
});

// Session AuthContext/TenantContext 解析结果回显（S2-6c-1 测试用；不泄露任何 token）。
testRoutes.get('/whoami', (c) => {
  localOnly(c);
  const auth = c.get('auth');
  const tenant = c.get('tenant');
  return ok(c, {
    authenticated: auth.authenticated,
    userId: auth.userId,
    role: auth.role,
    teamId: auth.teamId,
    tenant: { scope: tenant.scope, teamId: tenant.teamId, userId: tenant.userId },
  });
});

// 安全审计事件（只读计数 / 最近若干条）—— S2-6c-3/4 审计验证用；production 不可达。
testRoutes.get('/security-events/count', async (c) => {
  localOnly(c);
  const type = c.req.query('type') ?? '';
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM security_events WHERE event_type = ?`)
    .bind(type)
    .first<{ n: number }>();
  return ok(c, { count: row?.n ?? 0, type });
});

testRoutes.get('/security-events', async (c) => {
  localOnly(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, event_type, severity, detail, ip_hash, user_agent, user_id, created_at
       FROM security_events ORDER BY id DESC LIMIT 20`,
  ).all();
  return ok(c, { items: rows.results ?? [] });
});

export default testRoutes;
