// utils/contentApi.ts
// 嘉禾志愿 2.0 公益社区志愿者端客户端（P33-P4B）。
// 仅对接 /api/v2/content 与 /api/v2/files（图片展示由页面层 downloadFile 完成）；
// 绝不调用 legacy PHP 端点、绝不调用后台管理内容路由（审核 / 发布 / 删除等）。
//
// 复用 activityApi 的范式：V2 base / Bearer / X-Team-Id / success envelope / backend error / network error。
// content 全部为团队作用域（默认注入 X-Team-Id）。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export const REPORT_REASONS = ['illegal', 'ad', 'infringe', 'fake', 'abuse', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  illegal: '违法违规',
  ad: '广告营销',
  infringe: '侵权',
  fake: '虚假信息',
  abuse: '辱骂攻击',
  other: '其他',
};

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface FeedAttachmentItem {
  file_public_id: string;
  mime_type: string;
  size_bytes: number;
}

export interface FeedArticleItem {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  author_public_id: string | null;
  author_nickname: string | null;
  attachments: FeedAttachmentItem[];
  comment_count: number;
  like_count: number;
  liked_by_me: boolean;
  published_at: string | null;
  created_at: string;
}

export interface CommentView {
  comment_public_id: string;
  content: string;
  user_public_id: string | null;
  user_nickname: string | null;
  created_at: number;
}

export interface FeedPage {
  items: FeedArticleItem[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface CreateArticleBody {
  title: string;
  body: string;
  attachment_file_public_ids?: string[];
}

export interface UpdateArticleBody {
  title?: string;
  body?: string;
  attachment_file_public_ids?: string[];
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

// 与 wx.request 的 method 枚举保持一致
type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, data?: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) header['Authorization'] = `Bearer ${token}`;
    const teamId = getActiveTeamId();
    if (teamId) header['X-Team-Id'] = teamId;

    wx.request({
      url: V2_BASE + path,
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
        reject(buildError(0, null, true));
      },
    });
  });
}

export const contentApi = {
  // ===================== Feed / 文章（团队作用域） =====================
  /** GET /content/feed —— 本团队已发布+已审核文章分页。 */
  getFeed(page = 1, pageSize = 10): Promise<FeedPage> {
    return request<FeedPage>('GET', `/content/feed?page=${page}&page_size=${pageSize}`);
  },

  /** GET /content/articles/:id —— 本团队单篇文章（任意状态，含本人草稿；跨团队→404）。 */
  getArticle(articlePublicId: string): Promise<FeedArticleItem> {
    return request<FeedArticleItem>('GET', `/content/articles/${encodeURIComponent(articlePublicId)}`);
  },

  /** POST /content/articles —— 志愿者 SELF 发布（返回 DRAFT/PENDING，不进 feed）。 */
  createArticle(body: CreateArticleBody): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('POST', '/content/articles', body);
  },

  /** PUT /content/articles/:id —— 志愿者 SELF 更新本人文章（ownership 由后端强制，他人→404）。 */
  updateArticle(articlePublicId: string, body: UpdateArticleBody): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('PUT', `/content/articles/${encodeURIComponent(articlePublicId)}`, body);
  },

  // ===================== 评论（团队作用域） =====================
  /** GET /content/articles/:id/comments —— 评论列表。 */
  getComments(articlePublicId: string): Promise<CommentView[]> {
    return request<CommentView[]>('GET', `/content/articles/${encodeURIComponent(articlePublicId)}/comments`);
  },

  /** POST /content/articles/:id/comments —— 发表评论（仅限已发布+已审核文章）。 */
  createComment(articlePublicId: string, content: string): Promise<{ comment_public_id: string }> {
    return request<{ comment_public_id: string }>('POST', `/content/articles/${encodeURIComponent(articlePublicId)}/comments`, {
      content,
    });
  },

  // ===================== 点赞（团队作用域，幂等） =====================
  /** POST /content/articles/:id/like —— 点赞。 */
  likeArticle(articlePublicId: string): Promise<{ liked: boolean; like_count: number }> {
    return request<{ liked: boolean; like_count: number }>('POST', `/content/articles/${encodeURIComponent(articlePublicId)}/like`);
  },

  /** DELETE /content/articles/:id/like —— 取消点赞。 */
  unlikeArticle(articlePublicId: string): Promise<{ liked: boolean; like_count: number }> {
    return request<{ liked: boolean; like_count: number }>('DELETE', `/content/articles/${encodeURIComponent(articlePublicId)}/like`);
  },

  // ===================== 举报（团队作用域） =====================
  /** POST /content/articles/:id/report —— 举报文章。 */
  reportArticle(articlePublicId: string, reason: ReportReason, detail?: string): Promise<{ ok: true }> {
    const body: { reason: string; detail?: string } = { reason };
    if (detail) body.detail = detail;
    return request<{ ok: true }>('POST', `/content/articles/${encodeURIComponent(articlePublicId)}/report`, body);
  },

  /** POST /content/comments/:cid/report —— 举报评论。 */
  reportComment(commentPublicId: string, reason: ReportReason, detail?: string): Promise<{ ok: true }> {
    const body: { reason: string; detail?: string } = { reason };
    if (detail) body.detail = detail;
    return request<{ ok: true }>('POST', `/content/comments/${encodeURIComponent(commentPublicId)}/report`, body);
  },
};

export default contentApi;
