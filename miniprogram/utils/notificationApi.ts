// utils/notificationApi.ts
// N0-B 站内信前端客户端（仅对接 /api/v2/notifications/* 的 IN_APP 闭环）。
//
// 纪律：
// - 仅 IN_APP；绝不调用 legacy PHP（get_notifications.php / get_unread_count.php /
//   mark_notification_read.php）。
// - 所有请求经 ensureV2Session() 取得 Bearer token，基线 V2_BASE。
// - 仅消费后端安全 DTO（NotificationListItem / NotificationDetail）；不解析
//   payload_json / idempotency_key / 内部 id / deleted_at。

import { ensureV2Session } from './auth-v2';

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export type NotificationCategory =
  | 'system'
  | 'activity'
  | 'team'
  | 'training'
  | 'exam'
  | 'qualification'
  | 'points'
  | 'content';

/** 列表项 DTO（不含正文 / payload / 内部字段）。 */
export interface NotificationListItem {
  id: string; // public_id (Crockford ULID)
  event_type: string;
  category: NotificationCategory;
  title: string;
  summary: string | null;
  target_page: string | null;
  read: boolean;
  read_at: number | null;
  created_at: number; // epoch 秒
}

/** 详情 DTO（含完整安全正文）。 */
export interface NotificationDetail extends NotificationListItem {
  body: string | null;
  business_entity_type: string | null;
  business_entity_id: number | null;
}

export interface NotificationListResult {
  items: NotificationListItem[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  isNetwork: boolean;
}

function buildError(status: number, body: any, isNetwork: boolean): ApiError {
  const e = body && body.error ? body.error : null;
  return {
    status,
    code: e ? e.code : '',
    message: e ? e.message : isNetwork ? '网络异常，请重试' : '请求失败',
    isNetwork,
  };
}

async function request<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
  const token = await ensureV2Session();
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: V2_BASE + path,
      method,
      data,
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // 成功信封：{ success:true, data, request_id }
          resolve((res.data && res.data.data !== undefined ? res.data.data : res.data) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message,details?} }
          reject(buildError(res.statusCode, res.data, false));
        }
      },
      fail: () => reject(buildError(0, null, true)),
    });
  });
}

export const notificationApi = {
  /** GET /api/v2/notifications?page=&page_size= → 当前用户通知列表（newest first）。 */
  list(page: number, pageSize = 20): Promise<NotificationListResult> {
    return request<NotificationListResult>('GET', `/notifications?page=${page}&page_size=${pageSize}`);
  },

  /** GET /api/v2/notifications/unread-count → { unread: number }。 */
  unreadCount(): Promise<{ unread: number }> {
    return request<{ unread: number }>('GET', '/notifications/unread-count');
  },

  /** GET /api/v2/notifications/:public_id → NotificationDetail。 */
  getDetail(publicId: string): Promise<NotificationDetail> {
    return request<NotificationDetail>('GET', `/notifications/${publicId}`);
  },

  /** POST /api/v2/notifications/:public_id/read → { id, read:true }（幂等）。 */
  markRead(publicId: string): Promise<{ id: string; read: true }> {
    return request<{ id: string; read: true }>('POST', `/notifications/${publicId}/read`);
  },

  /** POST /api/v2/notifications/read-all → { updated:number }（仅当前用户）。 */
  markAllRead(): Promise<{ updated: number }> {
    return request<{ updated: number }>('POST', '/notifications/read-all');
  },
};

export default notificationApi;
