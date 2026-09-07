// pages/admin/today-checkins/today-checkins.ts
// P31-P1B：迁移考勤 roster 到 GET /api/v2/attendance-sessions（TEAM admin roster）。
// 展示：activity / volunteer / checkin_at / checkout_at / status / review state。
// 不在前端计算服务时长或积分（duration_hours/points 保持占位 '-'）。

import adminApi from '../../../utils/adminApi';

// attendance_sessions.status: 1=已签到 2=已签退
const STATUS_TEXT: Record<number, string> = { 1: '已签到', 2: '已签退' };
// review_status: 0=待审核 1=已通过 2=已拒绝
const REVIEW_TEXT: Record<number, string> = { 0: '待审核', 1: '已通过', 2: '已拒绝' };

Page({
  data: {
    checkins: [] as any[],
    total: 0,
    date: '',
    loading: true,
    hasTeam: false,
  },

  onLoad() {
    this.updateDate();
    this.checkTeamAndLoad();
  },

  onPullDownRefresh() {
    this.checkTeamAndLoad();
    wx.stopPullDownRefresh();
  },

  checkTeamAndLoad() {
    const teamId = wx.getStorageSync('activeTeamPublicId');
    if (!teamId) {
      this.setData({ loading: false, checkins: [], total: 0, hasTeam: false });
      wx.showModal({
        title: '请先选择团队',
        content: '未选择团队，无法查看考勤记录',
        confirmText: '去选择',
        cancelText: '取消',
        success: (r: any) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/teams/select/select' });
        },
      });
      return;
    }
    this.setData({ hasTeam: true });
    this.loadTodayCheckins();
  },

  updateDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    this.setData({ date: `${year}-${month}-${day}` });
  },

  loadTodayCheckins(): Promise<void> {
    this.setData({ loading: true });

    return new Promise((resolve) => {
      adminApi
        .listAttendanceSessions({ page: 1, pageSize: 100 })
        .then((res: any) => {
          const sessions = (res && Array.isArray(res.sessions) ? res.sessions : []).map((s: any) => ({
            id: s.session_id,
            real_name: s.volunteer_name || '未知',
            volunteer_id: s.volunteer_public_id || '',
            activity_title: s.activity_title || '',
            checkin_time: s.checkin_at ? this.formatTime(s.checkin_at) : null,
            checkout_time: s.checkout_at ? this.formatTime(s.checkout_at) : null,
            status: s.status,
            status_text: this.buildStatusText(s.status, s.review_status),
            duration_hours: '-',
            points: '-',
          }));
          this.setData({ checkins: sessions, total: sessions.length });
          resolve();
        })
        .catch((err: any) => {
          const code = err && err.code;
          if (code === 'TEAM_SCOPE_REQUIRED') {
            wx.showToast({ title: '请先选择团队', icon: 'none' });
          } else if (code === 'FORBIDDEN' || (err && err.status === 403)) {
            wx.showToast({ title: '无权限查看考勤', icon: 'none' });
          } else {
            wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
          }
          this.setData({ checkins: [], total: 0 });
          resolve();
        })
        .finally(() => {
          this.setData({ loading: false });
        });
    });
  },

  buildStatusText(status: number, reviewStatus: number) {
    const s = STATUS_TEXT[status] || '未知';
    const r = REVIEW_TEXT[reviewStatus];
    return r != null && r !== '待审核' ? `${s} · ${r}` : s;
  },

  formatTime(epoch: number) {
    if (!epoch) return null;
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return null;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
});