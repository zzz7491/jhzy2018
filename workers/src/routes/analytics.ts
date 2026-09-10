/**
 * /api/v2/analytics —— 数据运营运营概览（P37-C1）。
 *
 * 允许端点（精确两个，不新增其它）：
 *   GET /api/v2/analytics/team/overview      → TEAM scope（ACTIVE_TEAM_REQUIRED + analytics.team.view）
 *   GET /api/v2/analytics/platform/overview   → PLATFORM scope（analytics.platform.view；不要求 active team）
 *
 * 授权链（DB-backed，D1PermissionProvider，不硬编码角色）：
 *   TEAM：    authentication → active team（tenant.teamId） → analytics.team.view
 *   PLATFORM：authentication → analytics.platform.view（platform 角色恒生效，不依赖 active team）
 *
 * 投影（§10 / §11）：仅返回 scope / range / period{start,end} / metrics（11 个聚合数字）。
 * 不返回 raw rows / PII / numeric id / provider / model / AI conversation / raw SQL。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { AnalyticsService, parseRangeQuery } from '../services/analytics-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, teamScopeRequired } from '../utils/errors';

const analytics = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * GET /api/v2/analytics/team/overview
 * TEAM scope：必须已认证 + 处于 active team + 持有 analytics.team.view。
 * team_id 永远来自 server active team（tenant.teamId），绝不接受客户端指定。
 */
analytics.get('/team/overview', requirePermission('analytics.team.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  const tenant = c.get('tenant');
  if (tenant.teamId == null) throw teamScopeRequired();

  const range = parseRangeQuery(c.req.query());
  const svc = new AnalyticsService({ db: c.env.DB, auth, tenant });
  const metrics = await svc.getTeamOverview(range);

  return ok(c, {
    scope: 'team',
    range: range.range,
    period: { start: range.start, end: range.end },
    metrics,
  });
});

/**
 * GET /api/v2/analytics/platform/overview
 * PLATFORM scope：必须已认证 + 持有 analytics.platform.view。
 * 不要求 active team（platform 角色平台级绑定恒生效）。
 * 专用平台聚合路径，不返回按团队拆分的数据。
 */
analytics.get('/platform/overview', requirePermission('analytics.platform.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const range = parseRangeQuery(c.req.query());
  const svc = new AnalyticsService({ db: c.env.DB, auth, tenant: c.get('tenant') });
  const metrics = await svc.getPlatformOverview(range);

  return ok(c, {
    scope: 'platform',
    range: range.range,
    period: { start: range.start, end: range.end },
    metrics,
  });
});

export default analytics;
