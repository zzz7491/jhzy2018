/**
 * GET /api/v2/users/me —— 当前用户（S2-5 最小只读）。
 *
 * USER_SCOPED：仅返回测试注入身份对应的本人数据；不提供他人查询端点。
 * 本阶段不实现注册 / 登录。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { UserRepository } from '../repository/users';
import { D1PermissionProvider } from '../services/permission-provider';
import { ok } from '../utils/response';
import { authRequired } from '../utils/errors';

const users = new Hono<{ Bindings: Env; Variables: AppVars }>();

users.get('/me', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const repo = new UserRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const user = await repo.findMe();
  const profile = await repo.findMyProfile();

  // 最小能力投影（P37-C2A）：仅返回 analytics 两个 scope 的权限布尔值。
  // 使用 DB-backed PermissionProvider（authoritative，不硬编码角色、不改 RBAC seed）。
  // 注意：团队权限按"角色持有"解析（忽略 active team），以便前端区分
  // 「持有团队权限但未选团队」(TEAM_CONTEXT_MISSING) 与「无团队权限」(NO_PERMISSION)。
  const provider = new D1PermissionProvider(c.env.DB);
  const perms = await provider.getPermissionsAcrossScopes(auth);
  const analyticsCapabilities = {
    team_view: perms.has('analytics.team.view'),
    platform_view: perms.has('analytics.platform.view'),
  };

  return ok(c, { user, profile: profile ?? null, analytics_capabilities: analyticsCapabilities });
});

export default users;
