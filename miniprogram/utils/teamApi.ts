// utils/teamApi.ts
// P3-D Team Domain 统一客户端（团队目录 / 加入团队 / 我的团队 / 团队公开联系人 / 创建团队）。
//
// 纪律（与 P3-B authApi / P3-C profileApi 一致）：
// - 本文件是【唯一】Team 域接入层；Team 页面不得再各自 wx.request / jhzyRequest / 读写 session storage。
// - 会话读写一律经 Session Manager（utils/session）；错误一律经 classifyTeamError 归一。
// - V2 能力走 transport.send；Legacy 能力走 utils/request（jhzyRequest）——原因见下方 Backend Authority。
// - Team 能力不再向 activityApi / adminApi 增补；二者已有的 Team 方法本阶段不改动（禁止跨域）。
//
// ============ Backend Authority（P3-D Phase A 审计结论，禁止猜测）============
// 已核对 workers/src/routes/teams.ts + workers/src/repository/teams.ts（逐行）+ workers/src/app.ts：
//   * GET  /api/v2/teams/mine                    —— 已实现（repository.listMine，本人拥有 TEAM 作用域的团队）。
//   * GET  /api/v2/teams/:id                     —— 已实现（最小只读，前端未消费）。
//   * POST /api/v2/teams/:teamId/join            —— 已实现；ULID public_id；服务端固定 member + volunteer。
//   * GET  /api/v2/teams/:id/public-contact      —— 已实现（N0-E5B，team.settings.update）。
//   * PATCH /api/v2/teams/:id/public-contact     —— 已实现（N0-E5B，仅两个公开字段）。
//   * 【团队目录】= "列出可加入团队"  —— NO V2 IMPLEMENTATION：
//       workers/src 全仓无 listAll / discover / directory 路由；TeamRepository 仅 findByPublicId / listMine / joinTeam。
//       /teams/mine 语义为"我已加入"，不可用作"可加入目录"。
//   * 【创建团队】—— NO V2 IMPLEMENTATION：workers/src 全仓无 createTeam / POST /teams 实现。
//
// 由此得出 P3-D 的两条硬约束（用户决策 1=A / 2=A）：
//   ① 禁止混用 ID 体系：Legacy 目录返回 numeric group_id；V2 join 只接受 ULID public_id
//      （routes/teams.ts requireUlidParam）。因此【目录 + 加入】必须同源于 Legacy，
//      绝不可出现 "Legacy 列表 + V2 join"（必然 404 / 误加入）。
//   ② 后端未实现的能力不伪造 V2：统一 wrapper，底层仍调用 legacy PHP，
//      并在函数头显式标注 NO V2 IMPLEMENTATION（与 P3-C Profile 同范式）。
//
// - 禁止：Workers / Migration / Database / Permission / RBAC / Activity / Signup /
//          Attendance / Points / Admin / 其它业务域。

import { send, ApiError } from './transport';
import { resolveV2Base } from './apiEnv';
import { ensureV2Session } from './auth-v2';
import { getLegacyToken, getActiveTeamId, setActiveTeamId } from './session';
import jhzyRequest from './request';

const V2_BASE = resolveV2Base();

// ============================== 统一错误分类 ==============================

export type TeamErrorKind = 'backend' | 'network' | 'unauthorized' | 'expired' | 'denied';

export interface TeamError {
  kind: TeamErrorKind;
  /** 可直接展示给用户的中文提示。 */
  message: string;
  /** HTTP 状态码；legacy 端点无 HTTP 状态时为 0。 */
  status: number;
  /** 后端业务码（legacy 为 code，V2 为 error.code）。 */
  code: string;
}

function isTeamError(e: any): e is TeamError {
  return !!e && typeof e === 'object' && typeof e.kind === 'string';
}

/**
 * Team 域唯一错误归一入口：Backend / Network / Unauthorized / Session Expired / Permission Denied。
 * 同时接受 transport 的 ApiError、legacy PHP 拒绝形状 {code,msg} 与 wx 原生失败对象。
 */
export function classifyTeamError(e: any): TeamError {
  if (isTeamError(e)) return e;

  if (typeof e === 'string') {
    return { kind: 'backend', message: e, status: 0, code: '' };
  }

  // transport ApiError（V2 路径）
  if (e && typeof e === 'object' && 'isNetwork' in e) {
    const apiErr = e as ApiError;
    if (apiErr.isNetwork) {
      return { kind: 'network', message: apiErr.message || '网络异常，请重试', status: 0, code: 'NETWORK' };
    }
    if (apiErr.status === 401) {
      return { kind: 'unauthorized', message: apiErr.message || '登录已失效，请重新登录', status: 401, code: apiErr.code };
    }
    if (apiErr.status === 403) {
      return { kind: 'denied', message: apiErr.message || '没有权限执行该操作', status: 403, code: apiErr.code };
    }
    return { kind: 'backend', message: apiErr.message || '请求失败', status: apiErr.status, code: apiErr.code };
  }

  // legacy PHP / wx 原生形状
  const code = e && e.code;
  const msg = e && (e.msg || e.message);
  if (code === 401 || code === -3) {
    return { kind: 'expired', message: msg || '登录已过期，请重新登录', status: 401, code: String(code) };
  }
  if (code === 403) {
    return { kind: 'denied', message: msg || '没有权限执行该操作', status: 403, code: String(code) };
  }
  const errMsg = e && e.errMsg ? String(e.errMsg) : '';
  if (errMsg && /fail|timeout|error/i.test(errMsg)) {
    return { kind: 'network', message: '网络异常，请重试', status: 0, code: 'NETWORK' };
  }
  return { kind: 'backend', message: msg || '请求失败', status: 0, code: code != null ? String(code) : '' };
}

// ============================== V2 通用请求核 ==============================

async function getToken(): Promise<string> {
  // 与 activityApi 同范式：V2 会话令牌经 ensureV2Session 获取（绝不依赖 legacy access_token）。
  try {
    return await ensureV2Session();
  } catch {
    return '';
  }
}

type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'CONNECT';

async function v2Request<T>(
  method: RequestMethod,
  path: string,
  data?: any,
  opts: { teamScoped: boolean } = { teamScoped: false },
): Promise<T> {
  const token = await getToken();
  return send<T>(method, V2_BASE + path, data, { token, teamScoped: opts.teamScoped });
}

// ============================== 团队上下文（Session 唯一出入口） ==============================

/** 读取当前 active team 的 public_id（ULID）；无则空串。 */
export function getActiveTeam(): string {
  return getActiveTeamId();
}

/** 写入当前 active team（Team 页面唯一的上下文写入口）。 */
export function selectActiveTeam(teamPublicId: string): void {
  setActiveTeamId(teamPublicId);
}

// ============================== ① 我的团队（V2） ==============================

export interface TeamView {
  public_id: string;
  name: string;
}

/** GET /api/v2/teams/mine —— 本人拥有 TEAM 作用域的团队列表（V2，已实现）。 */
export function getMyTeams(): Promise<{ teams: TeamView[] }> {
  return v2Request<{ teams: TeamView[] }>('GET', '/teams/mine', undefined, { teamScoped: false });
}

// ============================== ② 团队公开联系人（V2，N0-E5B） ==============================

export interface TeamPublicContact {
  public_contact_name: string | null;
  public_contact_phone: string | null;
}

/** GET /api/v2/teams/:id/public-contact —— 读取公开业务联系人（团队作用域，需 team.settings.update）。 */
export function getPublicContact(teamId: string): Promise<{ public_contact: TeamPublicContact }> {
  return v2Request<{ public_contact: TeamPublicContact }>(
    'GET',
    `/teams/${teamId}/public-contact`,
    undefined,
    { teamScoped: true },
  );
}

/** PATCH /api/v2/teams/:id/public-contact —— 更新公开业务联系人（只接受两个公开字段）。 */
export function updatePublicContact(
  teamId: string,
  patch: { public_contact_name?: string | null; public_contact_phone?: string | null },
): Promise<{ public_contact: TeamPublicContact }> {
  return v2Request<{ public_contact: TeamPublicContact }>(
    'PATCH',
    `/teams/${teamId}/public-contact`,
    patch,
    { teamScoped: true },
  );
}

// ============================== ③ 团队目录（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface JoinableTeamRow {
  /** Legacy numeric group id —— 与 Legacy join_group.php 同一标识体系，绝不是 ULID public_id。 */
  id: number | string;
  name: string;
  description?: string;
  member_count?: number;
}

interface LegacyEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

/**
 * GET all_groups.php —— 可加入的团队目录。
 *
 * NO V2 IMPLEMENTATION：workers/src 无团队目录（listAll / discover）端点，
 * /teams/mine 语义为"已加入"，不可作为目录使用。
 * 返回行携带 numeric id；下游 joinTeam() 必须与其同源于 Legacy（§ Backend Authority ①）。
 */
export async function listJoinableTeams(): Promise<JoinableTeamRow[]> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyTeamError({ code: 401, msg: '登录信息失效，请重新登录' });
  }
  const res = await jhzyRequest<LegacyEnvelope<JoinableTeamRow[]>>({
    url: 'all_groups.php',
    method: 'GET',
    data: { token },
  });
  if (!res || res.code !== 0) {
    throw classifyTeamError(res || { code: -1, msg: '加载失败' });
  }
  return res.data || [];
}

/**
 * POST join_group.php —— 加入团队（numeric group_id）。
 *
 * NO V2 IMPLEMENTATION（在本仓库的目录语境下不可用）：V2 join 端点虽已实现，
 * 但只接受 ULID public_id；目录由 Legacy 提供 numeric id，二者不同源，
 * 混用将 404 / 误加入。故【目录 → 加入】全程走 Legacy。
 * 服务端角色由后端固定，本函数不提交任何 role / user / scope 字段。
 */
export async function joinTeam(groupId: number | string): Promise<void> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyTeamError({ code: 401, msg: '登录信息失效，请重新登录' });
  }
  const res = await jhzyRequest<LegacyEnvelope<unknown>>({
    url: 'join_group.php',
    method: 'POST',
    data: { token, group_id: groupId },
  });
  if (!res || res.code !== 0) {
    throw classifyTeamError(res || { code: -1, msg: '加入失败' });
  }
}

// ============================== ④ 创建团队（Legacy：NO V2 IMPLEMENTATION） ==============================

export interface CreateTeamPayload {
  name: string;
  description: string;
  /** 团队主题色（Legacy create_group.php 接受；V2 teams 表无 color 列）。 */
  color: string;
}

/**
 * POST create_group.php —— 创建团队。
 *
 * NO V2 IMPLEMENTATION：workers/src 全仓无创建团队端点。
 * 创建涉及 owner 角色授予，属 Responsibilities / RBAC，必须由后端权威实现，前端不得伪造。
 */
export async function createTeam(payload: CreateTeamPayload): Promise<void> {
  const token = getLegacyToken();
  if (!token) {
    throw classifyTeamError({ code: 401, msg: '登录信息失效，请重新登录' });
  }
  const res = await jhzyRequest<LegacyEnvelope<unknown>>({
    url: 'create_group.php',
    method: 'POST',
    data: { token, ...payload },
  });
  if (!res || res.code !== 0) {
    throw classifyTeamError(res || { code: -1, msg: '创建失败' });
  }
}

export default {
  classifyTeamError,
  getActiveTeam,
  selectActiveTeam,
  getMyTeams,
  getPublicContact,
  updatePublicContact,
  listJoinableTeams,
  joinTeam,
  createTeam,
};
