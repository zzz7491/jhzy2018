// utils/analyticsApi.ts
// 数据运营后台统计客户端（P37-C2）。
// 仅对接 P37-C1 后端：GET /api/v2/analytics/team/overview 与 /platform/overview。
// 不调用 legacy PHP 端点；Bearer / X-Team-Id / 成功信封 / 后端错误 / 网络错误 与 activityApi 同范式。
//
// - TEAM scope：自动注入 X-Team-Id（取自 activeTeamPublicId）。
// - PLATFORM scope：teamScoped=false，不注入 X-Team-Id（platform 统计不依赖 active team）。
// - 仅接受 range query（today|7d|30d|month），默认 7d；不发送 team_id / user_id / sql / fields / groupBy / filters / raw / start / end。
// - 不自动重试（单次失败仅 1 次 request）。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export type AnalyticsRange = 'today' | '7d' | '30d' | 'month';

export interface AnalyticsMetrics {
  volunteer_count: number;
  new_volunteer_count: number;
  activity_count: number;
  active_activity_count: number;
  service_participation_count: number;
  service_minutes_total: number;
  activity_review_pending: number;
  service_adjustment_pending: number;
  community_review_pending: number;
  ai_call_count: number;
  ai_active_user_count: number;
}

export interface AnalyticsOverview {
  scope: 'team' | 'platform';
  range: AnalyticsRange;
  period: { start: number; end: number };
  metrics: AnalyticsMetrics;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
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
}

// 与 wx.request 的 method 枚举保持一致（string 无法赋值给该枚举）
type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, opts: RequestOpts = {}): Promise<T> {
  const teamScoped = opts.teamScoped === true;
  return new Promise<T>((resolve, reject) => {
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) header['Authorization'] = `Bearer ${token}`;
    if (teamScoped) {
      const teamId = getActiveTeamId();
      if (teamId) header['X-Team-Id'] = teamId;
    }

    wx.request({
      url: V2_BASE + path,
      method: method,
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
        // 网络层失败：结果未知，交由调用方决定后续（不自动重试）
        reject(buildError(0, null, true));
      },
    });
  });
}

export interface AnalyticsCapabilities {
  team_view: boolean;
  platform_view: boolean;
}

export const analyticsApi = {
  /** GET /api/v2/analytics/team/overview?range= —— 团队运营概览（需 active team + analytics.team.view）。 */
  getTeamOverview(range: AnalyticsRange = '7d'): Promise<AnalyticsOverview> {
    return request<AnalyticsOverview>('GET', `/analytics/team/overview?range=${range}`, { teamScoped: true });
  },

  /** GET /api/v2/analytics/platform/overview?range= —— 平台运营概览（需 analytics.platform.view；不依赖 active team）。 */
  getPlatformOverview(range: AnalyticsRange = '7d'): Promise<AnalyticsOverview> {
    return request<AnalyticsOverview>('GET', `/analytics/platform/overview?range=${range}`, { teamScoped: false });
  },

  /**
   * GET /api/v2/users/me —— 取 analytics 能力投影（authoritative permission source）。
   * 用于前端入口可见性 + 作用域判定；绝不依赖 analytics 端点的 403 探测。
   * 返回 { team_view, platform_view }；团队权限按"角色持有"解析（忽略 active team），
   * 以便区分「持有团队权限但未选团队」与「无团队权限」。
   */
  getCapabilities(): Promise<AnalyticsCapabilities> {
    return request<{ analytics_capabilities?: AnalyticsCapabilities }>('GET', `/users/me`, { teamScoped: false })
      .then((data) => {
        const c = (data && data.analytics_capabilities) || { team_view: false, platform_view: false };
        return { team_view: !!c.team_view, platform_view: !!c.platform_view };
      });
  },
};

export default analyticsApi;
