/**
 * /api/v2/activities/:activityId/participations —— 参与 / 排班分配端点（S2-NEW-ARCH-P11）。
 *
 * 资源键为 activity_participations.public_id；所有对外 ID 均为 public_id（不暴露内部 id）。
 * 粒度 = signup + occurrence + optional slot；occurrence_position_id 仅为属性（无独立资源键）。
 *
 * 授权链（§三/§九/§十四，DB-backed，无 role-name if/else）：
 *   requirePermission(<code>) → D1PermissionProvider（permissions / role_permissions）。
 *   SELF 写操作：participation.assignment.{create,cancel,update}（scopeType USER, risk LOW）。
 *   TEAM 管理操作：participation.assignment.manage（scopeType TEAM, risk MEDIUM）。
 *
 * 路由前缀策略：本路由挂载于 /activities（与 activities 资源同源），路径形如
 *   /activities/:activityId/participations[/assign]（POST）
 *   /activities/:activityId/participations/mine（GET 本人）  vs  /activities/:activityId/participations（GET 团队名册）
 *   /activities/:activityId/participations/mine/:pid/...（SELF） vs /activities/:activityId/participations/:pid/...（TEAM）
 *
 * 关键不变量（RE-V4 冻结）：
 * - 创建 / 改派一律由客户端提交 new_public_id（Crockford ULID）；命中 replay 指纹 → 200 IDEMPOTENT_REPLAY，
 *   否则新建 → 201；冲突 → 409（稳定 reason token，不泄露冲突行）。
 * - 同一 public_id 冲突 / 重复判定严格在 authentication + permission + ownership/team-scope 之后。
 * - 取消为逻辑取消（status=2 + cancelled_at），无 DELETE；取消重试 → 200 幂等。
 * - reassign 为原子双语句（插入新行 + 条件取消旧行），经真实 db.batch() 事务收口。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import { ParticipationService } from '../services/participation-service';
import type { CreateParticipationInput, ReassignInput } from '../services/participation-service';
import { requirePermission } from '../middleware/rbac';
import { ok } from '../utils/response';
import { authRequired, invalidParam } from '../utils/errors';

const participations = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** 安全解析 JSON body（空 / 非法 → {}，交由后续校验阶段 400）。 */
async function readBody(c: import('hono').Context): Promise<Record<string, unknown>> {
  try {
    const json = await c.req.json();
    if (json != null && typeof json === 'object') return json as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return {};
}

function buildService(c: import('hono').Context): ParticipationService {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();
  return new ParticipationService({ db: c.env.DB, auth, tenant: c.get('tenant') });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// =========================================================================
// CREATE
// =========================================================================

/**
 * POST /activities/:activityId/participations
 * Body: { occurrence_public_id, slot_public_id?, position_public_id?, new_public_id }
 * SELF（participation.assignment.create）。replay → 200；新建 → 201。
 */
participations.post(
  '/:activityId/participations',
  requirePermission('participation.assignment.create'),
  async (c) => {
    const activityId = c.req.param('activityId');
    const b = await readBody(c);
    const input: CreateParticipationInput = {
      occurrence_public_id: str(b.occurrence_public_id) ?? '',
      slot_public_id: str(b.slot_public_id),
      position_public_id: str(b.position_public_id),
      new_public_id: str(b.new_public_id) ?? '',
    };
    if (!input.occurrence_public_id) throw invalidParam('occurrence_public_id', 'required');
    if (!input.new_public_id) throw invalidParam('new_public_id', 'required');

    const svc = buildService(c);
    const result = await svc.createSelf(activityId, input);
    return ok(c, { participation: result.participation }, result.replay ? 200 : 201);
  },
);

/**
 * POST /activities/:activityId/participations/assign
 * Body: { user_public_id, occurrence_public_id, slot_public_id?, position_public_id?, new_public_id }
 * TEAM manage（participation.assignment.manage）。replay → 200；新建 → 201。
 * （P11-TEAM-ASSIGN-IDENTITY-FIX：signup 无 public_id 列，TEAM 目标以
 *   route activity + users.public_id 唯一解析，不再提交 signup_public_id。）
 */
participations.post(
  '/:activityId/participations/assign',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const activityId = c.req.param('activityId');
    const b = await readBody(c);
    const input: CreateParticipationInput = {
      user_public_id: str(b.user_public_id),
      occurrence_public_id: str(b.occurrence_public_id) ?? '',
      slot_public_id: str(b.slot_public_id),
      position_public_id: str(b.position_public_id),
      new_public_id: str(b.new_public_id) ?? '',
    };
    if (!input.user_public_id) throw invalidParam('user_public_id', 'required for team assignment');
    if (!input.occurrence_public_id) throw invalidParam('occurrence_public_id', 'required');
    if (!input.new_public_id) throw invalidParam('new_public_id', 'required');

    const svc = buildService(c);
    const result = await svc.createForTeam(activityId, input);
    return ok(c, { participation: result.participation }, result.replay ? 200 : 201);
  },
);

// =========================================================================
// PARTICIPATION SETUP（P19：纯读 setup + deterministic ensure）
// 注意：setup / ensure 为字面量段，必须先于 GET/POST 参数类路由注册，避免段名被当作 :pid。
// =========================================================================

/** GET /activities/:activityId/participations/setup —— 本人参与就绪状态（纯读，零写副作用）。 */
participations.get(
  '/:activityId/participations/setup',
  requirePermission('participation.assignment.create'),
  async (c) => {
    const svc = buildService(c);
    const view = await svc.getSetupSelf(c.req.param('activityId'));
    return ok(c, view);
  },
);

/**
 * POST /activities/:activityId/participations/ensure
 * Body: { occurrence_public_id }（必填；服务端生成 Participation public_id）
 * 仅当目标 occurrence 无 active slot 时确定性物化 occurrence-level Participation。
 * 已有 active → 200 READY；新建 → 201；有 active slot → 409 participation_requires_manual。
 */
participations.post(
  '/:activityId/participations/ensure',
  requirePermission('participation.assignment.create'),
  async (c) => {
    const activityId = c.req.param('activityId');
    const b = await readBody(c);
    const occurrencePublicId = str(b.occurrence_public_id);
    if (!occurrencePublicId) throw invalidParam('occurrence_public_id', 'required');
    const svc = buildService(c);
    const result = await svc.ensureSelf(activityId, occurrencePublicId);
    return ok(c, { status: 'READY', participation: result.participation }, result.created ? 201 : 200);
  },
);

// =========================================================================
// LIST / DETAIL
// =========================================================================

/** GET /activities/:activityId/participations/mine —— 本人参与列表（participation.assignment.create）。 */
participations.get(
  '/:activityId/participations/mine',
  requirePermission('participation.assignment.create'),
  async (c) => {
    const svc = buildService(c);
    const rows = await svc.listOwn(c.req.param('activityId'));
    return ok(c, { participations: rows });
  },
);

/** GET /activities/:activityId/participations —— 团队名册（participation.assignment.manage）。 */
participations.get(
  '/:activityId/participations',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const svc = buildService(c);
    const rows = await svc.listTeam(c.req.param('activityId'));
    return ok(c, { participations: rows });
  },
);

/** GET /activities/:activityId/participations/mine/:pid —— 本人参与详情（participation.assignment.create）。 */
participations.get(
  '/:activityId/participations/mine/:pid',
  requirePermission('participation.assignment.create'),
  async (c) => {
    const svc = buildService(c);
    const row = await svc.getDetailSelf(c.req.param('pid'));
    return ok(c, { participation: row });
  },
);

/** GET /activities/:activityId/participations/:pid —— 团队名册中某行详情（participation.assignment.manage）。 */
participations.get(
  '/:activityId/participations/:pid',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const svc = buildService(c);
    const row = await svc.getDetailTeam(c.req.param('pid'));
    return ok(c, { participation: row });
  },
);

// =========================================================================
// CANCEL
// =========================================================================

/** POST /activities/:activityId/participations/mine/:pid/cancel —— 取消本人（participation.assignment.cancel）。 */
participations.post(
  '/:activityId/participations/mine/:pid/cancel',
  requirePermission('participation.assignment.cancel'),
  async (c) => {
    const svc = buildService(c);
    const row = await svc.cancelSelf(c.req.param('pid'));
    return ok(c, { participation: row });
  },
);

/** POST /activities/:activityId/participations/:pid/cancel —— 团队协调员取消（participation.assignment.manage）。 */
participations.post(
  '/:activityId/participations/:pid/cancel',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const svc = buildService(c);
    const row = await svc.cancelForTeam(c.req.param('pid'));
    return ok(c, { participation: row });
  },
);

// =========================================================================
// UPDATE POSITION
// =========================================================================

/**
 * POST /activities/:activityId/participations/mine/:pid/position
 * Body: { position_public_id }
 * 仅改同一条活跃参与行的 occurrence_position_id（participation.assignment.update）。
 */
participations.post(
  '/:activityId/participations/mine/:pid/position',
  requirePermission('participation.assignment.update'),
  async (c) => {
    const b = await readBody(c);
    const positionPublicId = str(b.position_public_id);
    if (!positionPublicId) throw invalidParam('position_public_id', 'required');
    const svc = buildService(c);
    const row = await svc.updatePositionSelf(c.req.param('pid'), positionPublicId);
    return ok(c, { participation: row });
  },
);

/**
 * POST /activities/:activityId/participations/:pid/position
 * Body: { position_public_id }（TEAM manage）。
 */
participations.post(
  '/:activityId/participations/:pid/position',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const b = await readBody(c);
    const positionPublicId = str(b.position_public_id);
    if (!positionPublicId) throw invalidParam('position_public_id', 'required');
    const svc = buildService(c);
    const row = await svc.updatePositionForTeam(c.req.param('pid'), positionPublicId);
    return ok(c, { participation: row });
  },
);

// =========================================================================
// REASSIGN SLOT
// =========================================================================

/**
 * POST /activities/:activityId/participations/mine/:pid/reassign
 * Body: { new_slot_public_id, new_position_public_id?, new_public_id }
 * SELF 改派（participation.assignment.update）。replay → 200；新建 → 201。
 */
participations.post(
  '/:activityId/participations/mine/:pid/reassign',
  requirePermission('participation.assignment.update'),
  async (c) => {
    const b = await readBody(c);
    const input: ReassignInput = {
      new_slot_public_id: str(b.new_slot_public_id) ?? '',
      new_position_public_id: str(b.new_position_public_id),
      new_public_id: str(b.new_public_id) ?? '',
    };
    if (!input.new_slot_public_id) throw invalidParam('new_slot_public_id', 'required');
    if (!input.new_public_id) throw invalidParam('new_public_id', 'required');
    const svc = buildService(c);
    const result = await svc.reassignSelf(c.req.param('pid'), input);
    return ok(c, { participation: result.participation }, result.replay ? 200 : 201);
  },
);

/**
 * POST /activities/:activityId/participations/:pid/reassign
 * Body: { new_slot_public_id, new_position_public_id?, new_public_id }（TEAM manage）。
 */
participations.post(
  '/:activityId/participations/:pid/reassign',
  requirePermission('participation.assignment.manage'),
  async (c) => {
    const b = await readBody(c);
    const input: ReassignInput = {
      new_slot_public_id: str(b.new_slot_public_id) ?? '',
      new_position_public_id: str(b.new_position_public_id),
      new_public_id: str(b.new_public_id) ?? '',
    };
    if (!input.new_slot_public_id) throw invalidParam('new_slot_public_id', 'required');
    if (!input.new_public_id) throw invalidParam('new_public_id', 'required');
    const svc = buildService(c);
    const result = await svc.reassignForTeam(c.req.param('pid'), input);
    return ok(c, { participation: result.participation }, result.replay ? 200 : 201);
  },
);

export default participations;
