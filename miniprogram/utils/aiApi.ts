// utils/aiApi.ts
// 嘉禾 AI V1 志愿者端前端客户端（P36-C4）。
// 仅对接已冻结的 4 个 /api/v2/ai 端点；绝不新增 endpoint / 绝不修改后端契约。
// 设计严格对齐 utils/activityApi.ts（同一 V2 base / Bearer / X-Team-Id / 信封 / 无自动重试）。
//
// 冻结边界（P36-C3A / C3 设计）：
// - ACTIVE_TEAM_REQUIRED：X-Team-Id 缺省时后端返回 403 TEAM_SCOPE_REQUIRED，前端在调用前也做前置检查。
// - CLIENT_BODY_POLICY：POST body 永远只有 { message }；绝不发送 history / provider / model / context / tools 等。
// - CLIENT_HISTORY_FORBIDDEN：前端只发送当前这一条 message；历史完全由服务端从 ai_conversations.messages 重建。
// - 不自动重试（POST create / POST message 均不自动重试），避免一次用户操作产生多次 provider call。
// - 不暴露 provider / model / token / 内部 id / system prompt / raw context。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

/** 前端最大消息长度（与后端 normalizeUserInput 上限保持一致）。 */
export const AI_MAX_MESSAGE_LENGTH = 2000;

/** provider / model 始终对前端不可见。 */
export const AI_PROVIDER_MODEL_VISIBLE = false;

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 assistant message 携带；来自服务端冻结白名单。 */
  source_labels?: string[];
}

export interface ConversationListItem {
  public_id: string;
  title: string | null;
  updated_at: number | null;
  created_at: number;
}

export interface ConversationDetail {
  public_id: string;
  title: string | null;
  messages: AiMessage[];
  created_at: number;
  updated_at: number | null;
}

export interface ConversationPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface ConversationListResult {
  items: ConversationListItem[];
  pagination: ConversationPagination;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function getActiveTeamId(): string {
  return wx.getStorageSync('activeTeamPublicId') || '';
}

/** 当前是否已选择 active team（与 teams 页「选择团队」写入的 key 一致）。 */
export function hasActiveTeam(): boolean {
  return getActiveTeamId().length > 0;
}

export type MessageValidation = { ok: true; value: string } | { ok: false; reason: 'empty' | 'too_long' };

/**
 * 前端输入校验（§9/§11）：trim → 非空 → 长度 <= 2000。
 * 不在此处生成任何 AI 上下文 / 不附加额外字段。
 */
export function validateMessageInput(raw: string): MessageValidation {
  const v = (raw ?? '').trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (v.length > AI_MAX_MESSAGE_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, value: v };
}

function buildHeaders(): Record<string, string> {
  const header: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) header['Authorization'] = `Bearer ${token}`;
  const teamId = getActiveTeamId();
  if (teamId) header['X-Team-Id'] = teamId;
  return header;
}

function buildError(status: number, body: any, isNetwork: boolean): ApiError {
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : isNetwork ? 'NETWORK' : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : '请求失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

type RequestMethod = 'GET' | 'POST';

// 与 wx.request method 枚举一致（string 无法赋值给该枚举）。
function request<T>(method: RequestMethod, path: string, data?: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: V2_BASE + path,
      method,
      data,
      header: buildHeaders(),
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
        // 网络层失败：结果未知，交由调用方决定后续（不自动重试）。
        reject(buildError(0, null, true));
      },
    });
  });
}

/**
 * 将后端错误映射为对用户友好的文案（§13）。
 * 绝不透传 raw error / stack / endpoint / provider 信息。
 */
export function friendlyMessage(err: ApiError): string {
  switch (err.status) {
    case 400:
      return '输入内容无效，请检查后重试';
    case 401:
      return '登录已过期，请重新登录';
    case 403:
      if (err.code === 'TEAM_SCOPE_REQUIRED') return '请先在「我的」中选择一个服务团队';
      return '当前账号暂无嘉禾 AI 使用权限';
    case 404:
      return '会话不存在或无可访问权限';
    case 409:
      return '会话已更新，请重新加载后再试';
    case 429:
      return '请求过于频繁，请稍后再试';
    case 503:
      return '嘉禾 AI 暂时不可用，请稍后再试';
    default:
      if (err.isNetwork) return '网络异常，请重试';
      return '服务异常，请稍后再试';
  }
}

export const aiApi = {
  /** GET /ai/conversations —— 本人 + 本团队列表（分页）。 */
  listConversations(page = 1, pageSize = 20): Promise<ConversationListResult> {
    return request<ConversationListResult>('GET', `/ai/conversations?page=${page}&page_size=${pageSize}`);
  },

  /** GET /ai/conversations/:publicId —— 详情。 */
  getConversation(publicId: string): Promise<ConversationDetail> {
    return request<ConversationDetail>('GET', `/ai/conversations/${publicId}`);
  },

  /**
   * POST /ai/conversations —— 新建会话 + 首轮问答。
   * body 严格只有 { message }；createConversation 内部不发送任何其它字段。
   */
  createConversation(message: string): Promise<ConversationDetail> {
    return request<ConversationDetail>('POST', `/ai/conversations`, { message });
  },

  /**
   * POST /ai/conversations/:publicId/messages —— 下一轮问答。
   * body 严格只有 { message }；历史完全由服务端重建，前端绝不发送 history。
   */
  sendMessage(publicId: string, message: string): Promise<ConversationDetail> {
    return request<ConversationDetail>('POST', `/ai/conversations/${publicId}/messages`, { message });
  },
};

export default aiApi;
