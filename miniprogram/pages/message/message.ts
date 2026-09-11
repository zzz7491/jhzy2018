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

// target_page 导航：N0-B 阶段 DEFERRED。
// 原因：当前 N0-A 未提供任何 business-event producer 真正写入 target_page，
// 且 notification 路由仅暴露读/已读接口，无 create 端点，target_page 实际恒为 null。
// 为避免「仅校验 /pages/ 前缀 + 依赖 navigateTo.fail」的弱校验（任意未注册内部页均可触发跳转），
// 本轮不显示、不执行 target-page 跳转。target_page 字段仍保留在 DTO 中供 N0-E 业务集成时启用。
// 届时将改为 app.json 已注册路由的精确白名单（exact pathname match + 保留 query）。

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

    this.setData({ detailLoading: true, detail: null });
    try {
      const detail = await notificationApi.getDetail(publicId);
      this.setData({ detail, detailLoading: false });

      // 打开未读项 → 调用真实 mark-read 端点（幂等）；成功后更新本地 + Mine 未读
      if (!item.read) {
        try {
          await notificationApi.markRead(publicId);
          const items = this.data.items.slice();
          items[index] = {
            ...items[index],
            read: true,
            read_at: detail.read_at ?? items[index].read_at,
          };
          this.setData({ items, hasUnread: items.some((i) => !i.read) });
          this.refreshMineUnread();
        } catch (e2) {
          // 标记失败不伪装已读：保持本地未读态，详情仍正常展示
        }
      }
    } catch (e) {
      this.setData({ detailLoading: false, detail: null });
      wx.showToast({ title: '加载详情失败', icon: 'none' });
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
