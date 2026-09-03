/**
 * RBAC middleware（S2-6f：Runtime Authorization Core 接入点）。
 *
 * 纪律（用户 §三/§四/§九/§十/§十四/§二十）：
 * - 权限目录已解冻（S2-6e seed：permissions=83 / role_permissions=238），运行时权威 = D1 role_permissions。
 * - authorizePermission 完全 DB-backed（经 D1PermissionProvider）；不读 JSON、不硬编码角色→权限、
 *   不 wildcard、不写死 super_admin => true、不按角色名 if/else、不固化 permission list 于 Session。
 * - 裁决语义（§九）：
 *    未认证 → 401；
 *    code 不在目录（配置错误）→ 500 INTERNAL_ERROR（服务端记录，不泄露 code / SQL / id）；
 *    code 存在但当前用户/上下文无授权 → 403 FORBIDDEN；
 *    否则放行。
 * - TEST_ONLY_PERMISSION 已退役（§十四）：不再参与任何授权路径，仅作历史标记保留。
 */

import { createMiddleware } from 'hono/factory';
import type { Env, AppVars } from '../env';
import type { AuthContext, RoleCode } from '../types/auth';
import { ROLE_CODES } from '../types/auth';
import { authorizePermissionDecision } from '../services/permission-provider';
import { authRequired, forbidden, internalError, roleNotAllowed } from '../utils/errors';

/**
 * 已退役的测试专用权限码（NOT IN 正式目录 / DB，禁止写入）。
 * S2-6f 起授权判定完全 DB-backed；本常量仅作历史标记保留，不再参与任何授权路径。
 */
export const TEST_ONLY_PERMISSION = 'TEST_ONLY_PERMISSION';

/** 角色限制：仅允许列出的冻结角色通过。 */
export function requireRole(...roles: RoleCode[]) {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();
    if (auth.role == null || !roles.includes(auth.role)) throw roleNotAllowed();
    await next();
  });
}

/**
 * DB-backed 请求期权限判定（S2-6f）。
 * - 未认证 → 401；
 * - code 不在目录（配置错误）→ 500 INTERNAL_ERROR（服务端已记录，不向客户端泄露 code 细节）；
 * - code 存在但当前用户/上下文无授权 → 403 FORBIDDEN；
 * - 否则放行（不泄露 role binding / SQL / 内部 id）。
 */
export async function authorizePermission(env: Env, auth: AuthContext, code: string): Promise<void> {
  const decision = await authorizePermissionDecision(env, auth, code);
  switch (decision) {
    case 'allow':
      return;
    case 'unauthenticated':
      throw authRequired();
    case 'unknown_permission':
      throw internalError();
    case 'forbidden':
      throw forbidden();
  }
}

/**
 * 权限检查 middleware（S2-6f：DB-backed）。
 * 经 D1PermissionProvider 实时解析当前用户角色的有效 permissions，单次参数化查询、request-local 缓存。
 */
export function requirePermission(code: string) {
  return createMiddleware<{ Bindings: Env; Variables: AppVars }>(async (c, next) => {
    await authorizePermission(c.env, c.get('auth'), code);
    await next();
  });
}

/** 冻结角色集合校验（供 auth 注入通道复用）。 */
export function isFrozenRole(code: string): code is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(code);
}
