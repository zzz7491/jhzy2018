// pages/admin/exam/results.ts — 考试结果 / 会话列表（管理端查看）
// P32-P4：exam.paper.manage。仅安全字段（public_id）；绝不暴露 numeric session/paper/user id 或答案。

import adminApi, { type SessionAdminRow } from '../../../utils/adminApi';

Page({
  data: {
    sessions: [] as SessionAdminRow[],
    loading: true,
    page: 1,
    pageSize: 50,
    total: 0,
    hasMore: false,
  },

  onLoad() {
    this.loadSessions(true);
  },

  onPullDownRefresh() {
    this.loadSessions(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadSessions(false);
    }
  },

  async loadSessions(reset: boolean) {
    this.setData({ loading: true });
    const page = reset ? 1 : this.data.page + 1;
    try {
      const res = await adminApi.listExamSessions(page, this.data.pageSize);
      const items = res.sessions || [];
      const merged = reset ? items : this.data.sessions.concat(items);
      this.setData({
        sessions: merged,
        page,
        total: res.pagination ? res.pagination.total : merged.length,
        hasMore: merged.length < (res.pagination ? res.pagination.total : merged.length),
        loading: false,
      });
    } catch (e: any) {
      this.setData({ loading: false });
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  statusText(status: number): string {
    if (status === 3) return '已完成';
    if (status === 1) return '进行中';
    return '未知';
  },
});
