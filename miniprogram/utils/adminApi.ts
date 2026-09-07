// utils/adminApi.ts
// 嘉禾志愿 2.0 管理端统一 v2 client（P31-P1B）。
// 仅对接 /api/v2 后端；绝不调用 legacy PHP 端点。
// 复用与 activityApi 相同的 contract：Bearer / X-Team-Id / success envelope / backend error / network error。
//
// TEAM context：管理端同样使用 activeTeamPublicId（public_id ULID，不暴露 numeric team id）。
// 仅实现 P31 页面实际用到的方法；不建"万能 admin client"。
// 严禁加入 training / certificate / community / AI / BI / mall / points-admin。

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

export interface ActivityRow {
  public_id: string;
  title: string;
  summary: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  max_session_minutes: number | null;
}

export interface ActivityScalarUpdate {
  title?: string;
  summary?: string | null;
  start_time?: number;
  end_time?: number;
  signup_deadline?: number | null;
  quota?: number;
  max_session_minutes?: number | null;
}

export interface SlotInput {
  name: string;
  start_time: number;
  end_time: number;
  capacity?: number;
}

export interface PositionInput {
  name: string;
  description?: string | null;
  required_count?: number;
  slots?: SlotInput[];
}

export interface OccurrenceInput {
  start_time: number;
  end_time: number;
  positions?: PositionInput[];
  slots?: SlotInput[];
}

export interface CreateActivityCommand {
  title: string;
  summary?: string | null;
  start_time: number;
  end_time: number;
  signup_deadline?: number | null;
  quota?: number;
  status?: number;
  max_session_minutes?: number | null;
  occurrences?: OccurrenceInput[];
}

export interface SignupView {
  activity_public_id: string;
  user_public_id: string;
  signup: {
    review_status: number;
    status: number;
    cancel_count: number;
    created_at: number;
    updated_at: number | null;
  } | null;
  form_submission: { public_id: string; status: number; version_public_id: string | null } | null;
}

export interface AttendanceSessionView {
  session_id: number;
  activity_public_id: string;
  activity_title: string;
  volunteer_public_id: string;
  volunteer_name: string;
  checkin_at: number | null;
  checkout_at: number | null;
  status: number;
  review_status: number;
  created_at: number;
}

export interface ServiceRecordView {
  public_id: string;
  minutes: number;
  business_service_date: string | null;
  points_awarded_units: number;
  settlement_status: number;
  created_at: number;
  user_public_id: string;
  activity_public_id: string;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
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

type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

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
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        reject(buildError(0, null, true));
      },
    });
  });
}

export const adminApi = {
  // ===================== 团队上下文（非团队作用域） =====================
  /** GET /teams/mine —— 当前用户拥有 TEAM 作用域的团队列表。 */
  getTeamsMine(): Promise<{ teams: TeamView[] }> {
    return request<{ teams: TeamView[] }>('GET', '/teams/mine', undefined, { teamScoped: false });
  },

  // ===================== 活动管理（团队作用域） =====================
  /** POST /activities —— 创建活动（含嵌套 occurrence/position/slot；P31-P1A 真实 schema）。 */
  createActivity(cmd: CreateActivityCommand): Promise<{ activity: { public_id: string } }> {
    return request<{ activity: { public_id: string } }>('POST', '/activities', cmd);
  },

  /** PUT /activities/:id —— 仅标量字段更新（v1 不重配置嵌套）。 */
  updateActivity(publicId: string, patch: ActivityScalarUpdate): Promise<{ activity: { public_id: string } }> {
    return request<{ activity: { public_id: string } }>('PUT', `/activities/${publicId}`, patch);
  },

  /** POST /activities/:id/publish —— 发布草稿（status 0 → 1）。 */
  publishActivity(publicId: string): Promise<{ activity: { public_id: string; status: number } }> {
    return request<{ activity: { public_id: string; status: number } }>(
      'POST',
      `/activities/${publicId}/publish`,
      {},
    );
  },

  /** GET /activities —— 本团队活动列表（分页）。 */
  listActivities(page = 1, pageSize = 20): Promise<{ items: ActivityRow[]; pagination: Pagination }> {
    return request<{ items: ActivityRow[]; pagination: Pagination }>(
      'GET',
      `/activities?page=${page}&page_size=${pageSize}`,
    );
  },

  /** GET /activities/:id —— 本团队单个活动详情。 */
  getActivity(publicId: string): Promise<{ activity: ActivityRow }> {
    return request<{ activity: ActivityRow }>('GET', `/activities/${publicId}`);
  },

  // ===================== 报名管理（团队作用域） =====================
  /** GET /activities/:activityId/signups —— 团队报名列表。 */
  listSignups(activityPublicId: string): Promise<{ signups: SignupView[] }> {
    return request<{ signups: SignupView[] }>('GET', `/activities/${activityPublicId}/signups`);
  },

  /** GET /activities/:activityId/signups/users/:userPublicId —— 指定志愿者报名详情。 */
  getSignupByUser(activityPublicId: string, userPublicId: string): Promise<{ signup: SignupView }> {
    return request<{ signup: SignupView }>(
      'GET',
      `/activities/${activityPublicId}/signups/users/${userPublicId}`,
    );
  },

  // ===================== 考勤管理（团队作用域） =====================
  /** GET /attendance-sessions —— 团队考勤 roster（可 filter activity_public_id / status）。 */
  listAttendanceSessions(query: {
    activityPublicId?: string;
    status?: number;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ sessions: AttendanceSessionView[]; pagination: Pagination }> {
    const q: string[] = [];
    if (query.activityPublicId) q.push(`activity_public_id=${query.activityPublicId}`);
    if (query.status !== undefined && query.status !== null) q.push(`status=${query.status}`);
    if (query.page) q.push(`page=${query.page}`);
    if (query.pageSize) q.push(`page_size=${query.pageSize}`);
    const qs = q.length > 0 ? `?${q.join('&')}` : '';
    return request<{ sessions: AttendanceSessionView[]; pagination: Pagination }>(
      'GET',
      `/attendance-sessions${qs}`,
    );
  },

  /** POST /attendance-sessions/:sessionId/review —— 审核会话（decision: approve | reject）。 */
  reviewAttendanceSession(
    sessionId: number,
    decision: 'approve' | 'reject',
    reason?: string,
  ): Promise<{ session: any }> {
    return request<{ session: any }>(
      'POST',
      `/attendance-sessions/${sessionId}/review`,
      { decision, reason: reason ?? '' },
    );
  },

  /** POST /attendance-sessions/:sessionId/force-checkout —— 强制签退（reason 必填）。 */
  forceCheckoutAttendanceSession(sessionId: number, reason: string): Promise<{ session: any }> {
    return request<{ session: any }>(
      'POST',
      `/attendance-sessions/${sessionId}/force-checkout`,
      { reason },
    );
  },

  // ===================== 服务记录（团队作用域） =====================
  /** GET /service-records —— 当前团队服务记录列表（摘要）。 */
  listServiceRecords(limit = 50): Promise<{ records: ServiceRecordView[] }> {
    return request<{ records: ServiceRecordView[] }>('GET', `/service-records?limit=${limit}`);
  },
};

export default adminApi;