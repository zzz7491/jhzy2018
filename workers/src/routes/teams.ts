/**
 * /api/v2/teams —— 团队端点（S2-5 最小只读 + P30-P1A 团队上下文后端）。
 *
 * teams 为 PLATFORM_GLOBAL（S2-3 矩阵）：已认证即可读单团详情，不强制 team 上下文。
 * :id / :teamId 均为 ULID public_id（与 S2-5 冻结契约一致；新 join 沿用同一 public contract）。
 *
 * P30-P1A 新增（MINIMAL TEAM CONTEXT BACKEND ONLY）：
 * - GET  /api/v2/teams/mine          —— 已登录用户「真正拥有 TEAM 作用域」的团队列表（SELF，不要求 X-Team-Id）。
 * - POST /api/v2/teams/:teamId/join —— 本人加入团队（SELF；服务端固定 member + volunteer scope；幂等）。
 *
 * N0-E5B 新增（TEAM_PUBLIC_CONTACT，最小读写；复用 team.settings.update，不新增权限）：
 * - GET   /api/v2/teams/:id/public-contact —— 读取团队公开业务联系人（TEAM 管理面，窄读）。
 * - PATCH /api/v2/teams/:id/public-contact —— 更新团队公开业务联系人（TEAM 管理面，窄写）。
 *   * 授权 = requirePermission('team.settings.update')（D1 裁决；team_admin / team_owner / 平台管理员持有）。
 *   * 目标团队必须等于 active team，否则 404（禁止平台级任意改动 / 跨团队越权）。
 *   * 只接受 public_contact_name / public_contact_phone；unknown 字段一律 400。
 *
 * 纪律（用户 §R1 / §七 / §十三）：
 * - 客户端不得提交 user_id / role_id / role / team_member_id / team_role_code / scope_team_id；
 *   违反一律 400（最小信任面）。
 * - 加入固定为 team_members.team_role_code='member' + user_roles role='volunteer'(scope_team_id=目标团)；
 *   绝不授予 owner / admin / team_admin / team_owner / platform_super_admin。
 * - 响应投影只暴露 public_id / name，不泄露 numeric team id / role id / user_roles id / team_members id。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { TeamRepository } from '../repository/teams';
import { TeamContactService, PUBLIC_CONTACT_ALLOWED_FIELDS } from '../services/team-contact-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';
import { requireUlidParam } from '../utils/validation';

const teams = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** GET /api/v2/teams/mine —— 当前用户拥有 TEAM 作用域的团队（SELF，不要求 X-Team-Id）。 */
teams.get('/mine', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  const repo = new TeamRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const rows = await repo.listMine(auth.userId);
  // 投影：只暴露 public_id / name（不泄露 numeric team id 等内部字段）。
  const teamsOut = rows.map((t) => ({ public_id: t.public_id, name: t.name }));
  return ok(c, { teams: teamsOut });
});

/** GET /api/v2/teams/:id —— 团队详情（S2-5 最小只读）。 */
teams.get('/:id', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');
  const repo = new TeamRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const team = await repo.findByPublicId(publicId);

  return ok(c, { team });
});

/**
 * POST /api/v2/teams/:teamId/join —— 本人加入团队。
 * - SELF：auth.userId 由服务端派生（R1 铁律），客户端 body 不得携带身份/角色字段。
 * - 服务端固定：team_members.team_role_code='member' + user_roles role='volunteer'(scope_team_id=目标团)。
 * - 幂等：重复 join 不新增 membership / scope 行，返回 { status: 'existing' }。
 * - 原子：team_members 写入 + user_roles scope 写入在同一 D1 batch（事务）内完成。
 */
teams.post('/:teamId/join', async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated || auth.userId == null) throw authRequired();

  // 拒绝客户端携带任何身份/角色/作用域字段（R1 铁律 + §七 最小信任面）。
  const FORBIDDEN_BODY_KEYS = [
    'user_id',
    'role_id',
    'role',
    'team_member_id',
    'team_role_code',
    'scope_team_id',
  ];
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of FORBIDDEN_BODY_KEYS) {
      if (k in body) throw invalidParam(k, 'must not be provided by client');
    }
  }

  const publicId = requireUlidParam(c.req.param('teamId'), 'teamId');
  const repo = new TeamRepository({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const team = await repo.findByPublicId(publicId); // 不存在 → 404（不泄露存在性）
  const { status } = await repo.joinTeam(team.id, auth.userId);

  return ok(c, { status, team: { public_id: team.public_id, name: team.name } }, 200);
});

// =========================================================================
// N0-E5B —— TEAM_PUBLIC_CONTACT 窄端点（团队公开业务联系人）
//
// 授权：team.settings.update（D1 裁决；复用既有冻结权限，不新增权限、不改权限目录）。
// TeamContactService 把 team_id 收口为【当前 active team】，并要求 URL :id 等于该团队。
// =========================================================================

/** 允许的请求字段集合（unknown / forbidden 字段一律 400，禁止借 PATCH 篡改其他团队数据）。 */
const PUBLIC_CONTACT_ALLOWED = new Set<string>(PUBLIC_CONTACT_ALLOWED_FIELDS);

/** GET /api/v2/teams/:id/public-contact —— 读取团队公开业务联系人（窄读，仅两个公开字段）。 */
teams.get('/:id/public-contact', requirePermission('team.settings.update'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');
  const svc = new TeamContactService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const public_contact = await svc.getPublicContact(publicId);
  return ok(c, { public_contact });
});

/**
 * PATCH /api/v2/teams/:id/public-contact —— 更新团队公开业务联系人（窄写）。
 * - body 仅接受 public_contact_name / public_contact_phone（可只其一；至少其一）。
 * - 规范化 / 校验由 TeamContactService 收口（单一 SSOT）。
 * - team_id 由服务端从 active team 派生；URL :id 必须等于 active team（跨团队 → 404）。
 */
teams.patch('/:id/public-contact', requirePermission('team.settings.update'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireUlidParam(c.req.param('id'), 'id');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    throw invalidParam('request', 'invalid request body');
  }

  // 窄信任面：只接受两个公开字段，其余键一律 400（不静默忽略）。
  for (const k of Object.keys(body)) {
    if (!PUBLIC_CONTACT_ALLOWED.has(k)) {
      throw invalidParam(k, 'unknown or forbidden field');
    }
  }

  const svc = new TeamContactService({ db: c.env.DB, ctx: { auth, tenant: c.get('tenant') } });
  const public_contact = await svc.updatePublicContact(publicId, body);
  return ok(c, { public_contact });
});

export default teams;
