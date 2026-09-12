// utils/activityApi.ts
// 嘉禾志愿 2.0 志愿者核心闭环统一客户端（P30-P1B）。
// 仅对接 /api/v2 后端；绝不调用 legacy PHP 端点。
// 不修改 legacy utils/request.js；Bearer 从本地存储读取（与 mallApi 同范式）。
//
// 统一处理：API base / Bearer token / X-Team-Id / success envelope / backend error / network error。
// - teams.mine / teams/:id/join 为【非】团队作用域（不注入 X-Team-Id）。
// - activities / participations / attendance / points / service-records 为【团队作用域】（自动注入 X-Team-Id）。
//   X-Team-Id 取自 wx.getStorageSync('activeTeamPublicId')，由 teams 页「选择团队」写入。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

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

export interface ServiceRecordView {
  public_id: string;
  business_service_date?: string;
  effective_minutes?: number;
  minutes?: number;
  points_awarded_units?: number;
  settlement_status?: number;
  [key: string]: unknown;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function getActiveTeamId(): string {
  return wx.getStorageSync('activeTeamPublicId') || '';
}

function buildError(status: number, body: any, isNetwork: boolean): ApiError {
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : '请求失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

interface RequestOpts {
  teamScoped?: boolean;
  base?: string;
}

// 与 wx.request 的 method 枚举保持一致（string 无法赋值给该枚举）
type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, data?: any, opts: RequestOpts = {}): Promise<T> {
  const base = opts.base || V2_BASE;
  const teamScoped = opts.teamScoped !== false; // 默认团队作用域
  return new Promise<T>((resolve, reject) => {
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) header['Authorization'] = `Bearer ${token}`;
    if (teamScoped) {
      const teamId = getActiveTeamId();
      if (teamId) header['X-Team-Id'] = teamId;
    }

    wx.request({
      url: base + path,
      method: method,
      data,
      header,
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        const body = res.data;
        if (statusCode >= 200 && statusCode < 300) {
          // 成功信封：{ success:true, data, request_id }
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message,details} }
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        // 网络层失败：结果未知，交由调用方决定后续
        reject(buildError(0, null, true));
      },
    });
  });
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

  /** POST /activities/:activityId/signups —— 报名（本人）。 */
  signup(activityId: string): Promise<{ signup: any }> {
    return request<{ signup: any }>('POST', `/activities/${activityId}/signups`, {}, { teamScoped: true });
  },

  /** GET /activities/:activityId/signups/me —— 本人报名详情。 */
  getSignupMe(activityId: string): Promise<{ signup: any }> {
    return request<{ signup: any }>('GET', `/activities/${activityId}/signups/me`);
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
