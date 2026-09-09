// pages/admin/content/index.ts
// 公益社区内容管理端 —— 列表 + 状态动作（审核/下架/删除/编辑）。
// 权限原则：BACKEND-AUTHORITATIVE。前端不做完整 RBAC 校验，后端 403 为最终权威。
// 冻结规则：创建者不能审核自己（后端 403 → "不能审核自己创建的内容"）。

import adminApi from '../../../utils/adminApi';

interface ContentListItem {
  article_public_id: string;
  title: string;
  author_nickname: string | null;
  status: number;
  audit_status: number;
  statusText: string;
  statusClass: string;
  created_at_text: string;
}

function statusInfo(status: number, audit: number): { text: string; cls: string } {
  if (status === 1 && audit === 1) return { text: '待审核', cls: 'st-pending' };
  if (status === 2 && audit === 2) return { text: '已发布', cls: 'st-published' };
  if (status === 1 && audit === 3) return { text: '已驳回', cls: 'st-rejected' };
  if (status === 3 && audit === 2) return { text: '已下架', cls: 'st-unpublished' };
  return { text: '未知', cls: 'st-unknown' };
}

function fmtTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    items: [] as ContentListItem[],
    loading: true,
    refreshing: false,
    hasTeam: true,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    busyId: '' as string,
  },

  onLoad() {
    this.checkTeam();
    this.loadList(1);
  },

  onShow() {
    this.checkTeam();
    if (!this.data.loading) this.loadList(1);
  },

  onPullDownRefresh() {
    this.loadList(1).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.busyId) {
      this.loadList(this.data.page + 1);
    }
  },

  checkTeam() {
    const teamId = wx.getStorageSync('activeTeamPublicId');
    this.setData({ hasTeam: !!teamId });
  },

  loadList(page: number): Promise<void> {
    if (!this.data.hasTeam) {
      this.setData({ loading: false, items: [], hasMore: false });
      return Promise.resolve();
    }
    this.setData({ loading: true });
    return adminApi
      .getContentArticles(page, this.data.pageSize)
      .then((res: any) => {
        const list: any[] = (res && res.items) || [];
        const mapped = list.map((it: any) => {
          const si = statusInfo(it.status, it.audit_status);
          return {
            article_public_id: it.article_public_id,
            title: it.title || '(无标题)',
            author_nickname: it.author_nickname || '未知作者',
            status: it.status,
            audit_status: it.audit_status,
            statusText: si.text,
            statusClass: si.cls,
            created_at_text: fmtTime(it.created_at),
          };
        });
        const items = page === 1 ? mapped : this.data.items.concat(mapped);
        const total = res && res.pagination ? res.pagination.total : items.length;
        const hasMore = items.length < total;
        this.setData({ items, page, total, hasMore, loading: false });
      })
      .catch((err: any) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  gotoCreate() {
    wx.navigateTo({ url: '/pages/admin/content/edit?mode=create' });
  },

  openItem(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/content/edit?mode=view&id=${id}` });
  },

  doApprove(e: any) {
    const id = e.currentTarget.dataset.id;
    this.actOnRaw(id, (i) => adminApi.approveContentArticle(i), '审核通过并发布');
  },

  doReject(e: any) {
    const id = e.currentTarget.dataset.id;
    this.actOnRaw(id, (i) => adminApi.rejectContentArticle(i), '已驳回');
  },

  doUnpublish(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '下架内容',
      content: '下架后志愿者将无法查看该内容，是否继续？',
      success: (r) => {
        if (r.confirm) this.actOnRaw(id, (i) => adminApi.unpublishContentArticle(i), '已下架');
      },
    });
  },

  doDelete(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除内容',
      content: '删除后该内容将不再显示，是否继续？',
      success: (r) => {
        if (r.confirm) this.actOnRaw(id, (i) => adminApi.deleteContentArticle(i), '已删除');
      },
    });
  },

  doEdit(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/content/edit?mode=edit&id=${id}` });
  },

  actOnRaw(id: string, fn: (id: string) => Promise<any>, okMsg: string) {
    if (this.data.busyId) return;
    this.setData({ busyId: id });
    fn(id)
      .then(() => {
        this.setData({ busyId: '' });
        wx.showToast({ title: okMsg, icon: 'success' });
        this.loadList(1);
      })
      .catch((err: any) => {
        this.setData({ busyId: '' });
        this.handleErr(err);
      });
  },

  handleErr(err: any) {
    const msg = (err && err.message) || '操作失败';
    if (err && err.status === 403) {
      if (/自己|职责分离|创建者/.test(msg)) {
        wx.showToast({ title: '不能审核自己创建的内容', icon: 'none' });
      } else {
        wx.showToast({ title: '当前账号没有此操作权限', icon: 'none' });
      }
    } else {
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  noop() {},
});
