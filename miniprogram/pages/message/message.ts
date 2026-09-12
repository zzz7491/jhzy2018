// pages/message/message.ts
// N0-B 站内信前端（IN_APP）：V2 /notifications 列表 + 详情 + 标记已读。
//
// 纪律：
// - 不调用任何 legacy PHP（get_notifications.php / mark_notification_read.php）。
// - 所有请求经 notificationApi（内部 ensureV2Session + Bearer）。
// - 仅展示后端安全 DTO；不展示 idempotency_key / 内部 id / deleted_at / payload。

import notificationApi from '../../utils/notificationApi';
import type { NotificationListItem, NotificationDetail } from '../../utils/notificationApi';

const PAGE_SIZE = 20;

// 与项目既有约定一致（exchange-records / attendance / community）：epoch 秒 → YYYY-MM-DD HH:mm
function formatTime(sec: number): string {
  if (!sec || typeof sec !== 'number') return '';
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// target_page 导航：N0-E2 启用（IN_APP）。
// 安全模型：EXACT_PATHNAME_ALLOWLIST_PLUS_PARAM_VALIDATION。
// - 数据源只能用 notification.target_page（payload 不向前端暴露；
//   business_entity_id = activity_signup.id ≠ activity.public_id，不可作路由 id）。
// - 仅对已冻结的业务事件导航；其余一律回退 N0-B 详情浮层（不得强制导航）。
// - pathname 精确匹配白名单（禁前缀 / 包含 / 正则模糊匹配）；拒绝协议头 / `//` / `..` / 其他页面。
// - id 必须为 26 位 Crockford ULID；最终 URL 重新构造，绝不透传服务端原始字符串。

// 已支持并验证的 IN_APP 业务事件（仅这两个；不为未来事件提前扩展 router）。
const SUPPORTED_NAV_EVENTS: string[] = ['ACTIVITY_SIGNUP_APPROVED', 'ACTIVITY_SIGNUP_REJECTED'];

// 唯一允许的跳转目标页（app.json 已注册；非 tabBar 页 → wx.navigateTo）。
const ALLOWED_TARGET_PATHNAME = 'pages/detail/detail';

// 与后端 workers/src/utils/validation.ts::ULID_RE 保持一致的 Crockford Base32（排除 I/L/O/U）。
const NAV_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// 读取 query 中指定参数（仅精确 key 匹配；不做 URL 解码 → 更严格，杜绝编码绕过）。
function readQueryParam(query: string, name: string): string | null {
  if (!query) return null;
  const parts = query.split('&');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key === name) return eq === -1 ? '' : part.slice(eq + 1);
  }
  return null;
}

// 纯函数（零 wx.* 依赖）：根据通知项解析「安全导航 URL」；任何不合法一律返回 null（→ 回退详情浮层）。
// 合法返回形如 /pages/detail/detail?id=<validated-ulid>，绝不包含原始 query 中其他参数。
function resolveNotificationTarget(item: NotificationListItem | null | undefined): string | null {
  if (!item) return null;
  // A. 事件必须严格属于已支持集合
  if (SUPPORTED_NAV_EVENTS.indexOf(item.event_type) === -1) return null;
  // B. target_page 必须为非空 string
  const raw = item.target_page;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // C. 以首个 '?' 拆分 pathname / query
  const qIdx = raw.indexOf('?');
  const rawPath = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : raw.slice(qIdx + 1);
  // 允许有/无最前面的 '/'，规范化后必须 exact match 白名单（拒绝 //、..、协议头、plugin://、其他页面）
  const pathname = rawPath.charAt(0) === '/' ? rawPath : '/' + rawPath;
  if (pathname !== '/' + ALLOWED_TARGET_PATHNAME) return null;
  // D. query 只读 id，且必须为合法 ULID
  const id = readQueryParam(rawQuery, 'id');
  if (!id || !NAV_ULID_RE.test(id)) return null;
  // E. 用校验后的 pathname + id 重新构造 URL（不透传原始 target_page，丢弃其他 query 参数）
  return '/' + ALLOWED_TARGET_PATHNAME + '?id=' + id;
}

Page({
  data: {
    items: [] as NotificationListItem[],
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    hasMore: true,
    loading: false,
    error: false,
    hasUnread: false,
    // 详情浮层
    detail: null as NotificationDetail | null,
    detailLoading: false,
  },

  onLoad() {
    this.loadFirstPage();
  },

  onShow() {
    // 每次显示时刷新列表（标记已读 / 返回后反映最新状态）
    this.loadFirstPage();
  },

  onUnload() {
    // 页面卸载时刷新个人页未读数
    this.refreshMineUnread();
  },

  onReachBottom() {
    this.loadMore();
  },

  // ===== 列表加载 =====
  loadFirstPage() {
    this.setData({ items: [], page: 1, hasMore: true, error: false, hasUnread: false });
    this.loadMore();
  },

  async loadMore() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true, error: false });
    const page = this.data.page;
    try {
      const res = await notificationApi.list(page, this.data.pageSize);
      const items = page === 1 ? res.items : [...this.data.items, ...res.items];
      const total = res.pagination.total;
      const hasUnread = items.some((i) => !i.read);
      this.setData({
        items,
        total,
        hasMore: items.length < total,
        hasUnread,
        page: page + 1,
      });
    } catch (e) {
      // 失败不伪装 empty；首屏失败显示错误态，非首屏保留已有列表
      if (page === 1) {
        this.setData({ error: true, items: [], hasMore: false, hasUnread: false });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // ===== 详情 + 标记已读 =====
  async onTapItem(e: any) {
    const publicId: string = e.currentTarget.dataset.id;
    const index: number = e.currentTarget.dataset.index;
    const item = this.data.items[index];
    if (!item) return;

    // N0-E2：已支持业务事件 + 合法 target → best-effort 标记已读后跳转活动详情（不再打开浮层）。
    const safeTarget = resolveNotificationTarget(item);
    if (safeTarget) {
      await this.markItemReadBestEffort(index, item);
      wx.navigateTo({
        url: safeTarget,
        fail: () => {
          wx.showToast({ title: '页面打开失败', icon: 'none' });
        },
      });
      return;
    }

    // 其余（不支持事件 / target 缺失或非法 / 历史 null）→ 保持 N0-B 详情浮层行为。
    this.setData({ detailLoading: true, detail: null });
    try {
      const detail = await notificationApi.getDetail(publicId);
      this.setData({ detail, detailLoading: false });

      // 打开未读项 → 调用真实 mark-read 端点（幂等）；成功后更新本地 + Mine 未读
      if (!item.read) {
        await this.markItemReadBestEffort(index, item, detail.read_at);
      }
    } catch (e) {
      this.setData({ detailLoading: false, detail: null });
      wx.showToast({ title: '加载详情失败', icon: 'none' });
    }
  },

  // 最佳努力标记已读：失败不伪装已读、不 toast、不阻断后续导航 / 详情展示。
  // 抽此 helper 以消除「已支持分支」与「回退分支」的重复，避免同一次点击 markRead 两次。
  async markItemReadBestEffort(index: number, item: NotificationListItem, readAt?: number | null): Promise<void> {
    if (!item || item.read) return;
    try {
      await notificationApi.markRead(item.id);
      const items = this.data.items.slice();
      if (items[index]) {
        items[index] = {
          ...items[index],
          read: true,
          read_at: readAt ?? items[index].read_at,
        };
      }
      this.setData({ items, hasUnread: items.some((i) => !i.read) });
      this.refreshMineUnread();
    } catch (e2) {
      // 标记失败不伪装已读：保持本地未读态，详情 / 导航仍正常
    }
  },

  closeDetail() {
    this.setData({ detail: null });
  },

  noop() {
    // 阻断浮层内容区的冒泡关闭
  },

  // ===== 全部已读（backend 已存在；UI 不拥挤时提供）=====
  async onMarkAllRead() {
    try {
      await notificationApi.markAllRead();
      const items = this.data.items.map((it) => ({ ...it, read: true }));
      this.setData({ items, hasUnread: false });
      this.refreshMineUnread();
      wx.showToast({ title: '已全部标记为已读', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  refreshMineUnread() {
    const pages = getCurrentPages();
    const minePage = pages.find((p) => p.route === 'pages/mine/mine');
    if (minePage && (minePage as any).loadUnreadCount) {
      (minePage as any).loadUnreadCount();
    }
  },

  formatTime,
});
