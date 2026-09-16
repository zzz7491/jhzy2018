// utils/contentApi.ts
// 嘉禾志愿 2.0 公益社区志愿者端客户端（P33-R2B 只读化）。
// 仅对接 /api/v2/content 的两个只读端点与 /api/v2/files（图片展示由页面层 downloadFile 完成）；
// 社区已改为只读资料/内容查看中心，普通志愿者不再拥有发布/编辑/评论/点赞/举报能力。
// 绝不调用 legacy PHP 端点、绝不调用后台管理内容路由（审核 / 发布 / 删除等）。
//
// 复用 activityApi 的范式：V2 base / Bearer / X-Team-Id / success envelope / backend error / network error。
// content 全部为团队作用域（默认注入 X-Team-Id）。

import { send } from './transport';
import { getLegacyToken } from './session';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

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

export interface FeedPage {
  items: FeedArticleItem[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

// 与 wx.request 的 method 枚举保持一致
type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, data?: any): Promise<T> {
  // P2-B：token 取自 Session Manager；Header 拼装 / 信封解包 / 错误归一统一交 transport。
  // content 全部为团队作用域（固定注入 X-Team-Id）。
  return send<T>(method, V2_BASE + path, data, { token: getLegacyToken(), teamScoped: true });
}

export const contentApi = {
  // ===================== Feed / 文章（只读，团队作用域） =====================
  /** GET /content/feed —— 本团队已发布+已审核文章分页。 */
  getFeed(page = 1, pageSize = 10): Promise<FeedPage> {
    return request<FeedPage>('GET', `/content/feed?page=${page}&page_size=${pageSize}`);
  },

  /** GET /content/articles/:id —— 本团队单篇文章（任意状态，含本人草稿；跨团队→404）。 */
  getArticle(articlePublicId: string): Promise<FeedArticleItem> {
    return request<FeedArticleItem>('GET', `/content/articles/${encodeURIComponent(articlePublicId)}`);
  },
};

export default contentApi;
