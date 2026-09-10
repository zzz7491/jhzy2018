// pages/adminPanel/adminPanel.ts
// P31-P1B：最小入口迁移 —— 当前 TEAM context + v2 活动/报名/考勤入口 + 服务记录摘要。
// - 未选择团队 → 明确提示，可跳转选择团队页；不回退 legacy。
// - 活动管理入口 → /pages/admin/activity-abc/index（v2 list / detail / update / publish）。
// - 考勤入口 → /pages/admin/today-checkins/today-checkins（v2 attendance-sessions）。
// - 服务记录摘要 → GET /api/v2/service-records（当前团队；只读摘要，不计算）。
// - 旧 dashboard stats（admin_get_stats.php）保留为 OUT_OF_SCOPE / TECH_DEBT，不作为 v2 失败回退。

import adminApi from '../../utils/adminApi';

Page({
  data: {
    adminId: 0,
    adminName: '管理员',
    adminRole: '',
    adminEmail: '',
    currentTime: '',
    isSuperAdmin: false,

    hasTeam: false,
    activeTeamName: '',

    stats: {
      volunteers: 0,
      activities: 0,
      checkins: 0,
      pending_activity: 0,
      pending_volunteer: 0,
      pending_quick: 0,
      today_signups: 0,
      today_new_volunteers: [] as any[],
    },

    loading: true,
    refreshing: false,

    adminStats: {
      totalVolunteers: 0,
      todaySignups: 0,
      pendingReviews: 0,
      activeActivities: 0,
    },
  },

  onLoad() {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');

    if (!adminInfo || !token) {
      wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      return;
    }

    if (adminInfo.role === 'verifier') {
      wx.redirectTo({ url: '/pages/admin/qrVerify/qrVerify' });
      return;
    }

    this.checkAndLogin();
    this.updateTime();
    setInterval(() => {
      this.updateTime();
    }, 60000);
  },

  onShow() {
    console.log('管理面板显示');
    if (this.data.adminId) {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const viewedDate = wx.getStorageSync('register_reminder_viewed');
      if (viewedDate === dateStr) {
        this.setData({ 'stats.today_signups': 0 });
      }
      this.refreshData();
    }
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  updateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    this.setData({ currentTime: `${year}-${month}-${day} ${hours}:${minutes}` });
  },

  checkAndLogin() {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');

    if (!adminInfo || !token) {
      wx.redirectTo({ url: '/pages/login-unified/index' });
      return;
    }

    this.setData({
      adminId: adminInfo.id,
      adminName: adminInfo.name || adminInfo.real_name || '管理员',
      adminRole: adminInfo.role,
      adminEmail: adminInfo.email,
      isSuperAdmin: adminInfo.role === 'super_admin',
    });

    this.checkTeamContext();
    this.refreshData();
  },

  /** TEAM context：management 端继续使用 activeTeamPublicId；未选择 → 明确提示。 */
  checkTeamContext() {
    const teamId = wx.getStorageSync('activeTeamPublicId');
    if (!teamId) {
      this.setData({ hasTeam: false, activeTeamName: '' });
      return;
    }
    this.setData({ hasTeam: true });
    adminApi
      .getTeamsMine()
      .then((res: any) => {
        const teams = (res && Array.isArray(res.teams) ? res.teams : []) || [];
        const cur = teams.find((t: any) => t.public_id === teamId);
        this.setData({ activeTeamName: cur ? cur.name : '' });
      })
      .catch(() => {
        // 仅刷新展示名；团队上下文仍以 storage 为准。
      });
  },

  refreshData() {
    this.setData({ loading: true, refreshing: true });

    const legacy = this.loadAdminStats(); // OUT_OF_SCOPE / TECH_DEBT（旧 dashboard）
    const v2 = this.loadV2Summary(); // P31 核心（真 v2）

    return Promise.all([legacy, v2]).then(
      () => {
        this.setData({ loading: false, refreshing: false });
      },
      () => {
        this.setData({ loading: false, refreshing: false });
      },
    );
  },

  /** P31 核心：v2 活动计数 + 服务记录摘要（只读，不计算）。 */
  loadV2Summary() {
    const activityP = adminApi
      .listActivities(1, 100)
      .then((res: any) => res && res.pagination ? res.pagination.total : 0)
      .catch(() => 0);

    const recordP = adminApi
      .listServiceRecords(20)
      .then((res: any) => (res && Array.isArray(res.records) ? res.records : []))
      .catch(() => []);

    return Promise.all([activityP, recordP]).then(([activities, records]) => {
      this.setData({
        'stats.activities': activities,
        adminStats: {
          ...this.data.adminStats,
          activeActivities: activities,
        },
      });
      // 服务记录摘要（当前团队）—— 数据就绪供入口使用；不计算时长/积分。
      (this as any)._serviceRecords = records;
    });
  },

  /** 旧的 dashboard 统计（OUT_OF_SCOPE / TECH_DEBT；保留对既有 WXML 的兼容）。 */
  loadAdminStats() {
    return new Promise((resolve) => {
      const token = wx.getStorageSync('access_token');
      if (!token) {
        resolve();
        return;
      }

      wx.request({
        url: 'https://api.jhzyfw.com/api/admin_get_stats.php',
        method: 'GET',
        header: { 'Authorization': `Bearer ${token}` },
        success: (res: any) => {
          if (res.data && res.data.success === true) {
            const statsData = res.data.data || {};
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            const viewedDate = wx.getStorageSync('register_reminder_viewed');
            const todaySignups = viewedDate === dateStr ? 0 : (statsData.today_signups || 0);
            this.setData({
              stats: {
                volunteers: statsData.total_volunteers || 0,
                // 活动数以 v2 为准（loadV2Summary 会覆盖）；此值仅为 legacy 兜底展示。
                activities: this.data.stats.activities || statsData.active_activities || 0,
                checkins: statsData.today_signins || 0,
                pending_activity: statsData.pending_reviews || 0,
                pending_volunteer: statsData.pending_volunteer_reviews || 0,
                pending_quick: statsData.pending_quick_reviews || 0,
                today_signups: todaySignups,
                today_new_volunteers: statsData.today_new_volunteers || [],
              },
              adminStats: {
                totalVolunteers: statsData.total_volunteers || 0,
                todaySignups: statsData.today_signups || 0,
                pendingReviews: statsData.pending_reviews || 0,
                activeActivities: this.data.adminStats.activeActivities || statsData.active_activities || 0,
              },
            });
          }
          resolve();
        },
        fail: () => {
          resolve();
        },
      });
    });
  },

  goToPointsManager() {
    wx.navigateTo({ url: '/pages/admin/points-manager/index' });
  },

  goToProductsManage() {
    wx.navigateTo({ url: '/pages/admin/products-manage/index' });
  },

  goToExchangeManage() {
    wx.navigateTo({ url: '/pages/admin/exchange-manage/index' });
  },

  gotoTrainingCertificates() {
    wx.navigateTo({ url: '/pages/admin/training-certificates/index' });
  },

  viewTodayCheckins() {
    wx.navigateTo({ url: '/pages/admin/today-checkins/today-checkins' });
  },

  /** v2 活动管理入口（对应 WXML 中 activity-abc 卡片）。 */
  goToActivityManage() {
    wx.navigateTo({ url: '/pages/admin/activity-abc/index' });
  },

  /**
   * v2 服务记录入口 → 服务时长调整审批页（P35-C3）。
   * 旧「摘要弹窗」升级为真实管理页（查看服务记录 / 发起调整申请 / 审批 / 拒绝）。
   */
  goToServiceRecords() {
    wx.navigateTo({ url: '/pages/admin/service-records/index' });
  },

  goToRegisterReminder(e: any) {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    wx.setStorageSync('register_reminder_viewed', dateStr);
    this.setData({ 'stats.today_signups': 0 });
    wx.navigateTo({ url: '/pages/admin/volunteer-manage/index' });
  },

  gotoPage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      wx.navigateTo({ url: url });
    }
  },

  changePassword() {
    wx.navigateTo({ url: '/pages/admin/change-password/change-password' });
  },

  goToSubscribe() {
    wx.navigateTo({ url: '/pages/subscribe/subscribe' });
  },

  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出管理员登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.removeStorageSync('access_token');
          wx.redirectTo({ url: '/pages/login-unified/index' });
        }
      },
    });
  },

  refreshDataButton() {
    this.refreshData();
    wx.showToast({ title: '刷新中...', icon: 'loading' });
  },

  viewFeatureGuide() {
    wx.showModal({
      title: '管理面板功能说明',
      content: '1. 活动管理：创建/编辑/发布（v2）\n2. 考勤管理：查看班组考勤\n3. 服务记录：当前团队服务记录摘要\n4. 应急功能：紧急情况下使用',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  viewPermissions() {
    const roleName = this.data.isSuperAdmin ? '系统超级管理员' : '普通管理员';
    const permissions = this.data.isSuperAdmin
      ? '✅ 所有功能权限\n✅ 用户管理\n✅ 活动管理\n✅ 审核管理\n✅ 系统设置'
      : '✅ 活动审核\n✅ 扫码核销\n✅ 志愿者管理\n❌ 系统设置';
    wx.showModal({
      title: `权限说明 - ${roleName}`,
      content: `您的角色：${roleName}\n\n权限范围：\n${permissions}`,
      showCancel: false,
      confirmText: '知道了',
    });
  },
});