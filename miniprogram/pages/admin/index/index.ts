// pages/admin/index/index.ts - 最小入口迁移（P31-P1B）
// 仅保留既有 WXML 所需 handler 的兼容实现（证书类导航 → OUT_OF_SCOPE / TECH_DEBT，
// 不作任何证书功能开发），并加入 P31 核心入口所需的 TEAM context 校验。
// v2 活动/报名/考勤/服务记录入口统一由 adminPanel 提供（activity-abc / today-checkins / service-records）。

Page({
  data: {
    userInfo: {} as any,
    roleText: '',
    stats: {
      total_certificates: 0,
      monthly_certificates: 0,
      total_admins: 0,
    },
    recentCertificates: [] as any[],
  },

  onLoad() {
    this.checkTeamContext();
    const userInfo = wx.getStorageSync('userInfo') || {};
    const adminInfo = wx.getStorageSync('adminInfo') || {};
    this.setData({
      userInfo: userInfo,
      roleText: adminInfo.role === 'super_admin' ? '系统超级管理员' : '管理员',
    });
  },

  /** P31 核心：TEAM context 校验，未选择团队 → 明确提示。 */
  checkTeamContext() {
    if (!wx.getStorageSync('activeTeamPublicId')) {
      wx.showModal({
        title: '请先选择团队',
        content: '管理端操作需先选择团队',
        confirmText: '去选择',
        cancelText: '取消',
        success: (r: any) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/teams/select/select' });
        },
      });
    }
  },

  // ===== 以下为既有 admin/index WXML 依赖的 handler（OUT_OF_SCOPE / TECH_DEBT）=====
  // 仅保证 handler existence 与原有导航行为兼容；不开发证书功能。
  goToCertificates() {
    wx.navigateTo({ url: '/pages/admin/training-certificates/index' });
  },

  goToCertificateVerify() {
    wx.showToast({ title: '证书验证暂未接入 v2（OUT_OF_SCOPE）', icon: 'none' });
  },

  goToGenerate() {
    wx.showToast({ title: '证书生成暂未接入 v2（OUT_OF_SCOPE）', icon: 'none' });
  },

  onLogout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出管理员登录吗？',
      success: (res: any) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.removeStorageSync('access_token');
          wx.redirectTo({ url: '/pages/login-unified/index' });
        }
      },
    });
  },

  formatTime(epoch: number) {
    if (!epoch) return '-';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
});