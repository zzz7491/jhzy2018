// pages/admin/activity-create-flow/basic.ts
// P31-P1B：迁移核心创建流程到 POST /api/v2/activities（P31-P1A 真实 schema）。
// 仅发送 Beta 必需字段 + 嵌套 occurrences[]（按后端真实 contract）。
// 旧 PHP 字段（category/cover/location/contact/certificate/recurrence）不再提交 v2。

import adminApi from '../../../utils/adminApi';

Page({
  data: {
    formData: {
      title: '',
      description: '',
      activity_date: '',
      start_time: '',
      end_time: '',
      max_participants: '',
    },
    currentDate: '',
    loading: false,
    submitting: false,
  },

  onLoad(options: Record<string, string>) {
    this.checkAdminLogin();
    this.initDates();
    if (options && options.copy_id) {
      this.loadActivityTemplate(options.copy_id);
    }
  },

  checkAdminLogin() {
    const token = wx.getStorageSync('access_token');
    const activeTeamId = wx.getStorageSync('activeTeamPublicId');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'error' });
      setTimeout(() => wx.redirectTo({ url: '/pages/login-unified/index?role=admin' }), 1500);
      return false;
    }
    if (!activeTeamId) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      wx.redirectTo({ url: '/pages/teams/select/select' });
      return false;
    }
    return true;
  },

  initDates() {
    const now = new Date();
    const today = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    this.setData({ currentDate: today, 'formData.activity_date': today });
  },

  /** 复制模板：v2 GET /activities/:id → 回填可映射字段。 */
  loadActivityTemplate(publicId: string) {
    wx.showLoading({ title: '加载模板中...', mask: true });
    adminApi
      .getActivity(publicId)
      .then((res) => {
        wx.hideLoading();
        const a = res.activity;
        if (!a) return;
        const start = new Date(a.start_time * 1000);
        const end = new Date(a.end_time * 1000);
        const pad = (n: number) => n.toString().padStart(2, '0');
        this.setData({
          'formData.title': a.title + ' (复制)',
          'formData.description': a.summary || '',
          'formData.activity_date': `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
          'formData.start_time': `${pad(start.getHours())}:${pad(start.getMinutes())}`,
          'formData.end_time': `${pad(end.getHours())}:${pad(end.getMinutes())}`,
          'formData.max_participants': a.quota ? String(a.quota) : '',
        });
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '模板加载失败', icon: 'none' });
      });
  },

  onInput(e: any) {
    this.setData({ [`formData.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onDateChange(e: any) {
    this.setData({ 'formData.activity_date': e.detail.value });
  },

  onStartTimeChange(e: any) {
    this.setData({ 'formData.start_time': e.detail.value });
  },

  onEndTimeChange(e: any) {
    this.setData({ 'formData.end_time': e.detail.value });
  },

  /** 把 "YYYY-MM-DD HH:mm" 转 epoch 秒。 */
  toEpoch(dateStr: string, timeStr: string): number {
    const s = `${dateStr} ${timeStr}:00`.replace(/-/g, '/');
    const t = new Date(s).getTime();
    return isNaN(t) ? 0 : Math.floor(t / 1000);
  },

  /** 构造 POST /activities 的 v2 payload（P31-P1A CreateActivityCommand）。 */
  buildPayload() {
    const d = this.data.formData;
    const startTime = this.toEpoch(d.activity_date, d.start_time);
    const endTime = this.toEpoch(d.activity_date, d.end_time);
    const quota = d.max_participants ? parseInt(d.max_participants, 10) : 0;
    return {
      title: d.title.trim(),
      summary: d.description.trim() ? d.description.trim() : null,
      start_time: startTime,
      end_time: endTime,
      quota: quota > 0 ? quota : 0,
      status: 0, // 草稿 → 创建成功后走 publish（0→1）
      occurrences: [{ start_time: startTime, end_time: endTime, positions: [], slots: [] }],
    };
  },

  onSubmit() {
    const d = this.data.formData;
    if (!this.checkAdminLogin()) return;

    if (!d.title) return wx.showToast({ title: '请输入标题', icon: 'none' });
    if (!d.activity_date) return wx.showToast({ title: '请选择活动日期', icon: 'none' });
    if (!d.start_time || !d.end_time) return wx.showToast({ title: '请选择完整时间', icon: 'none' });

    const payload = this.buildPayload();
    if (payload.start_time >= payload.end_time) {
      return wx.showToast({ title: '结束时间必须晚于开始时间', icon: 'none' });
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '创建中...', mask: true });

    adminApi
      .createActivity(payload)
      .then((res) => {
        const publicId = res && res.activity ? res.activity.public_id : null;
        if (!publicId) throw new Error('创建失败');
        // 创建成功（草稿 status=0）→ 发布（0→1）
        return adminApi.publishActivity(publicId).then(() => {
          wx.hideLoading();
          wx.showToast({ title: '创建并发布成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1500);
        });
      })
      .catch((err: any) => {
        wx.hideLoading();
        const msg = (err && err.message) || '创建失败';
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') {
          wx.showModal({
            title: '请先选择团队',
            content: '当前未选择团队，无法创建活动',
            confirmText: '去选择',
            cancelText: '取消',
            success: (r: any) => {
              if (r.confirm) wx.navigateTo({ url: '/pages/teams/select/select' });
            },
          });
          return;
        }
        wx.showToast({ title: msg, icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  },
});