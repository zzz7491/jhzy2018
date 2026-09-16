// utils/activityApi.ts
// 嘉禾志愿 2.0 志愿者核心闭环统一客户端（P30-P1B）。
// 仅对接 /api/v2 后端；绝不调用 legacy PHP 端点。
// 不修改 legacy utils/request.js；Bearer 从本地存储读取（与 mallApi 同范式）。
//
// 统一处理：API base / Bearer token / X-Team-Id / success envelope / backend error / network error。
// - teams.mine / teams/:id/join 为【非】团队作用域（不注入 X-Team-Id）。
// - activities / participations / attendance / points / service-records 为【团队作用域】（自动注入 X-Team-Id）。
//   X-Team-Id 取自 wx.getStorageSync('activeTeamPublicId')，由 teams 页「选择团队」写入。

import { resolveV2Base } from './apiEnv';
import { ensureV2Session } from './auth-v2';
import { send } from './transport';

const V2_BASE = resolveV2Base();

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface TeamView {
  public_id: string;
  name: string;
}

/** 团队公开业务联系人（N0-E5B；对报名者公开的 PUBLIC BUSINESS DATA，非私人/认证电话）。 */
export interface TeamPublicContact {
  public_contact_name: string | null;
  public_contact_phone: string | null;
}

export interface ActivityRow {
  public_id: string;
  title: string;
  summary: string | null;
  start_time: string | null;
  end_time: string | null;
  signup_deadline: string | null;
  quota: number;
  signed_count: number;
  status: number;
  max_session_minutes: number | null;
}

export interface PointsAccountSelfView {
  balance_units: number;
  total_earned_units: number;
  total_spent_units: number;
  total_debits_units: number;
  updated_at: number | null;
}

/**
 * G1：GET /api/v2/attendance-sessions/me 响应契约（AUTHORITATIVE ACTIVE SESSION）。
 * 字段严格最小化：active；active=true 时仅 session.activity_public_id + session.checkin_at。
 * 注意：activity_public_id 是 activities.public_id（ULID），绝不是内部 numeric attendance_sessions.activity_id。
 */
export type ActiveAttendanceSessionNone = { active: false };
export type ActiveAttendanceSessionActive = {
  active: true;
  session: {
    activity_public_id: string;
    checkin_at: number | null;
  };
};
export type ActiveAttendanceSession = ActiveAttendanceSessionNone | ActiveAttendanceSessionActive;

export interface ServiceRecordView {
  public_id: string;
  business_service_date?: string;
  effective_minutes?: number;
  minutes?: number;
  points_awarded_units?: number;
  settlement_status?: number;
  [key: string]: unknown;
}

async function getToken(): Promise<string> {
  // V2 会话独立存于 v2_access_token（auth-v2.ts）；绝不依赖 legacy access_token（PHP 令牌）。
  try {
    return await ensureV2Session();
  } catch {
    return '';
  }
}

/**
 * 是否持有【未过期】的 V2 会话（纯本地读取，绝不触发 wx.login / 不发起任何网络请求）。
 *
 * G1 前置门禁：custom-tab-bar 渲染时不得无条件调用需要认证的 G1 API（会为 Guest 触发登录），
 * 因此先用本函数判断；Guest 一律保持中性态，不发请求。
 * 单位契约与 auth-v2.ts 一致：v2_token_expire 与后端 expires_at 同为 Unix【秒】。
 */
export function hasV2Session(): boolean {
  try {
    const token = wx.getStorageSync('v2_access_token') || '';
    if (!token) return false;
    const expire = Number(wx.getStorageSync('v2_token_expire') || 0);
    if (!expire) return false;
    return expire > Math.floor(Date.now() / 1000);
  } catch (e) {
    return false;
  }
}

interface RequestOpts {
  teamScoped?: boolean;
  base?: string;
}

// 与 wx.request 的 method 枚举保持一致（string 无法赋值给该枚举）
type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'CONNECT';

async function request<T>(method: RequestMethod, path: string, data?: any, opts: RequestOpts = {}): Promise<T> {
  const base = opts.base || V2_BASE;
  const teamScoped = opts.teamScoped !== false; // 默认团队作用域
  // G1 FIX: getToken() 是 async，此前未 await 导致 Authorization 恒为 "Bearer [object Promise]"，
  // 所有经本模块的鉴权请求实际未携带有效 Bearer（后端一律 401）。此处补齐 await。
  const token = await getToken();
  // P2-B：Header 拼装 / 成功信封解包 / 失败错误归一，统一交由 transport（唯一 Header Builder + Error Pipeline）。
  return send<T>(method, base + path, data, { token, teamScoped });
}

export const activityApi = {
  // ===================== 团队上下文（非团队作用域） =====================
  /** GET /teams/mine —— 当前用户拥有 TEAM 作用域的团队列表。 */
  getTeamsMine(): Promise<{ teams: TeamView[] }> {
    return request<{ teams: TeamView[] }>('GET', '/teams/mine', undefined, { teamScoped: false });
  },

  /** POST /teams/:teamId/join —— 本人加入团队（幂等）。 */
  joinTeam(teamId: string): Promise<{ status: 'created' | 'existing'; team: TeamView }> {
    return request<{ status: 'created' | 'existing'; team: TeamView }>(
      'POST',
      `/teams/${teamId}/join`,
      {},
      { teamScoped: false },
    );
  },

  // ===================== 团队公开业务联系人（团队作用域，N0-E5B） =====================
  // 需 team.settings.update 权限（team_admin / team_owner）；非管理员会收到 403/404。
  /** GET /teams/:id/public-contact —— 读取团队公开业务联系人。 */
  getTeamPublicContact(teamId: string): Promise<{ public_contact: TeamPublicContact }> {
    return request<{ public_contact: TeamPublicContact }>('GET', `/teams/${teamId}/public-contact`);
  },

  /** PATCH /teams/:id/public-contact —— 更新团队公开业务联系人（只接受两个公开字段）。 */
  updateTeamPublicContact(
    teamId: string,
    patch: { public_contact_name?: string | null; public_contact_phone?: string | null },
  ): Promise<{ public_contact: TeamPublicContact }> {
    return request<{ public_contact: TeamPublicContact }>(
      'PATCH',
      `/teams/${teamId}/public-contact`,
      patch,
    );
  },

  // ===================== 活动（团队作用域） =====================
  /** GET /activities —— 本团队活动列表（分页）。 */
  getActivities(page = 1, pageSize = 20): Promise<{ items: ActivityRow[]; pagination: { page: number; page_size: number; total: number; total_pages: number } }> {
    return request('GET', `/activities?page=${page}&page_size=${pageSize}`);
  },

  /** GET /activities/:id —— 本团队单个活动详情。 */
  getActivity(id: string): Promise<{ activity: ActivityRow }> {
    return request<{ activity: ActivityRow }>('GET', `/activities/${id}`);
  },

  /** POST /activities/:activityId/signups —— 报名（本人）。可附带 P20 表单提交引用。 */
  signup(activityId: string, formSubmissionPublicId?: string): Promise<{ signup: any }> {
    const body: Record<string, unknown> = {};
    if (formSubmissionPublicId) body.form_submission_public_id = formSubmissionPublicId;
    return request<{ signup: any }>('POST', `/activities/${activityId}/signups`, body, { teamScoped: true });
  },

  /** GET /forms/consumers/activity.signup/:activityId/form —— 报名动态表单（P20；无绑定 → 404）。 */
  getSignupForm(activityId: string): Promise<{ definition_public_id: string; version_public_id: string; fields: any[] }> {
    return request('GET', `/forms/consumers/activity.signup/${activityId}/form`);
  },

  /** POST /forms/submissions —— 提交报名动态表单（P20）。 */
  submitFormSubmission(input: {
    consumerType: string;
    consumerPublicId: string;
    versionPublicId: string;
    newPublicId: string;
    answers: Record<string, unknown>;
  }): Promise<{ submission: any }> {
    return request('POST', '/forms/submissions', {
      consumer_type: input.consumerType,
      consumer_public_id: input.consumerPublicId,
      version_public_id: input.versionPublicId,
      new_public_id: input.newPublicId,
      answers: input.answers,
      status: 'submitted',
    });
  },

  /** GET /activities/:activityId/signups/me —— 本人报名详情。 */
  getSignupMe(activityId: string): Promise<{ signup: any }> {
    return request<{ signup: any }>('GET', `/activities/${activityId}/signups/me`);
  },

  /** DELETE /activities/:activityId/signups/me —— 取消本人报名（S2-6g；signup.signup.cancel 权限）。 */
  cancelOwn(activityId: string): Promise<{ signup: any }> {
    return request<{ signup: any }>('DELETE', `/activities/${activityId}/signups/me`);
  },

  // ===================== 参与 / 排班（团队作用域） =====================
  /** GET /activities/:activityId/participations/setup —— 本人参与就绪状态（纯读）。 */
  getParticipationSetup(activityId: string): Promise<{ status: string; participations: any[]; occurrences: any[] }> {
    return request('GET', `/activities/${activityId}/participations/setup`);
  },

  /** POST /activities/:activityId/participations/ensure —— 确定性物化 occurrence-level 参与。 */
  ensureParticipation(activityId: string, occurrencePublicId: string): Promise<{ status: 'READY'; participation: any }> {
    return request('POST', `/activities/${activityId}/participations/ensure`, {
      occurrence_public_id: occurrencePublicId,
    });
  },

  // ===================== 签到 / 签退（团队作用域） =====================
  /** POST /activities/:activityId/attendance/checkin —— 本人签到。 */
  checkin(activityId: string, participationPublicId: string, location?: { latitude: number; longitude: number; accuracy?: number } | null): Promise<{ attendance: any }> {
    const body: Record<string, unknown> = { participation_public_id: participationPublicId };
    if (location) body['location'] = location;
    return request<{ attendance: any }>('POST', `/activities/${activityId}/attendance/checkin`, body);
  },

  /** POST /activities/:activityId/attendance/checkout —— 本人签退（触发服务记录结算 + 积分）。 */
  checkout(activityId: string): Promise<{ attendance: any }> {
    return request<{ attendance: any }>('POST', `/activities/${activityId}/attendance/checkout`, {});
  },

  // ===================== G1：本人活跃考勤会话（SELF / 权威） =====================
  /**
   * GET /attendance-sessions/me —— 本人当前【活跃】考勤会话（G1 AUTHORITATIVE ACTIVE SESSION）。
   *
   * - 语义：active = (status=1 AND checkout_at IS NULL)；SCOPE = GLOBAL_PER_USER（后端不按 X-Team-Id 过滤）。
   * - 仍按默认【团队作用域】发送 X-Team-Id：志愿者角色/租户上下文依赖该头，
   *   缺失会被后端判为无团队上下文（403）。该头只用于鉴权，不过滤结果。
   * - 不得用 storage / 页面参数 / 当前 team / 客户端推断替代本接口判定 active。
   */
  getMyActiveAttendanceSession(): Promise<ActiveAttendanceSession> {
    return request<ActiveAttendanceSession>('GET', '/attendance-sessions/me');
  },

  // ===================== 成长数据（团队作用域） =====================
  /** GET /points/account —— 当前登录用户积分账户（SELF）。 */
  getPointsAccount(): Promise<PointsAccountSelfView> {
    return request<PointsAccountSelfView>('GET', '/points/account');
  },

  /** GET /service-records/mine —— 当前登录用户服务记录（SELF）。 */
  getServiceRecordsMine(limit = 50): Promise<{ records: ServiceRecordView[] }> {
    return request<{ records: ServiceRecordView[] }>('GET', `/service-records/mine?limit=${limit}`);
  },
};

export default activityApi;
