// pages/admin/activity-signups/activity-signups.ts
// P31-P1B：迁移报名列表到 GET /activities/:activityId/signups（v2 TEAM 投影）。
// v2 默认投影不含 answers/schema/legacy form_data（signup.signup.review 权限），
// 仅暴露 public 字段：user_public_id + signup.review_status/status/created_at。
// 不迁移 approve/reject（backend 模型为自动 READY，P31 明确不增加审批链）。

import adminApi from '../../../utils/adminApi';

Page({
  data: {
    fixedActivityId: null as string | null,
    fixedActivityTitle: '',
    activity: null as any,
    signups: [] as any[],
    loading: false,
    loadingSignups: false,
  },

  onLoad(options: Record<string, string>) {
    if (options && options.id) {
      const activityTitle = decodeURIComponent(options.title || '活动');
      this.setData({
        fixedActivityId: options.id,
        fixedActivityTitle: activityTitle,
        activity: { id: options.id, title: activityTitle },
      });
      wx.setNavigationBarTitle({ title: `${activityTitle} - 报名列表` });
      this.loadSignups(options.id);
    } else if (this.checkAdminLogin()) {
      wx.showToast({ title: '缺少活动参数', icon: 'none' });
    }
  },

  checkAdminLogin() {
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => wx.redirectTo({ url: '/pages/login-unified/index?role=admin' }), 1500);
      return false;
    }
    return true;
  },

  /** GET /activities/:activityId/signups */
  loadSignups(activityId: string) {
    this.setData({ loadingSignups: true });
    adminApi
      .listSignups(activityId)
      .then((res: any) => {
        const signups = res && Array.isArray(res.signups) ? res.signups : [];
        signups.forEach((s: any) => {
          s.user_public_id = s.user_public_id || '';
          s.review_status = s.signup ? s.signup.review_status : null;
          s.signup_status = s.signup ? s.signup.status : null;
          s.created_at = s.signup ? s.signup.created_at : null;
        });
        this.setData({ signups, loadingSignups: false });
      })
      .catch((err: any) => {
        const code = err && err.code;
        if (code === 'TEAM_SCOPE_REQUIRED') {
          wx.showToast({ title: '请先选择团队', icon: 'none' });
        } else if (code === 'FORBIDDEN' || (err && err.status === 403)) {
          wx.showToast({ title: '无权限查看报名', icon: 'none' });
        } else {
          wx.showToast({ title: (err && err.message) || '加载报名列表失败', icon: 'none' });
        }
        this.setData({ loadingSignups: false });
      });
  },

  refresh() {
    if (this.data.fixedActivityId) {
      this.loadSignups(this.data.fixedActivityId);
    }
  },

  // review_status: 0=待审核 1=已通过 2=已拒绝
  getReviewStatusText(status: number | null) {
    const map: Record<number, string> = { 0: '待审核', 1: '已通过', 2: '已拒绝' };
    return status === null || status === undefined ? '未知' : map[status] || '未知';
  },

  // signup.status: 1=已报名 2=已取消 3=已签到 4=已完成
  getStatusText(status: number | null) {
    const map: Record<number, string> = { 1: '已报名', 2: '已取消', 3: '已签到', 4: '已完成' };
    return status === null || status === undefined ? '未知' : map[status] || '未知';
  },

  getStatusClass(status: number | null) {
    const map: Record<number, string> = { 1: 'approved', 2: 'cancelled', 3: 'checked', 4: 'completed' };
    return status === null || status === undefined ? 'pending' : map[status] || 'pending';
  },

  formatTime(epoch: number | null) {
    if (!epoch) return '-';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  copyText(e: any) {
    const text = e.currentTarget.dataset.text;
    if (text) {
      wx.setClipboardData({ data: String(text), success: () => wx.showToast({ title: '复制成功', icon: 'success' }) });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});