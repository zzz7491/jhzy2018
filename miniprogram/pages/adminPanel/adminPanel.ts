// pages/adminPanel/adminPanel.ts
const app = getApp();

Page({
  data: {
    // 管理员信息
    adminId: 0,
    adminName: '管理员',
    adminRole: '',
    adminEmail: '',
    currentTime: '',
    isSuperAdmin: false,

    // 统计数据
    stats: {
      volunteers: 0,
      activities: 0,
      checkins: 0,
      pending_activity: 0,
      pending_volunteer: 0,
      pending_quick: 0,
      today_signups: 0,
      today_new_volunteers: [] as any[]
    },

    loading: true,
    refreshing: false,

    // 管理员专属数据
    adminStats: {
      totalVolunteers: 0,
      todaySignups: 0,
      pendingReviews: 0,
      activeActivities: 0
    }
  },

  onLoad() {
    // 检查管理员登录状态
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');
    
    if (!adminInfo || !token) {
      wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      return;
    }
    
    // 核销员不能进入管理面板，跳转到核销页面
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
      // 检查今日是否已查看注册提醒
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const viewedDate = wx.getStorageSync('register_reminder_viewed');
      if (viewedDate === dateStr) {
        this.setData({
          'stats.today_signups': 0
        });
      }
      this.refreshData();
    }
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 更新时间
  updateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const timeStr = `${year}-${month}-${day} ${hours}:${minutes}`;
    this.setData({ currentTime: timeStr });
  },

  // 检查登录状态
  checkAndLogin() {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');

    if (!adminInfo || !token) {
      wx.redirectTo({
        url: '/pages/login-unified/index'
      });
      return;
    }

    this.setData({
      adminId: adminInfo.id,
      adminName: adminInfo.name || adminInfo.real_name || '管理员',
      adminRole: adminInfo.role,
      adminEmail: adminInfo.email,
      isSuperAdmin: adminInfo.role === 'super_admin'
    });

    this.refreshData();
  },

  // 刷新数据
  async refreshData() {
    this.setData({ loading: true, refreshing: true });

    try {
      await this.loadAdminStats();
      this.setData({ loading: false, refreshing: false });
    } catch (error) {
      console.error('刷新数据失败:', error);
      this.setData({ loading: false, refreshing: false });
    }
  },

  // 加载管理统计数据
  async loadAdminStats() {
    return new Promise((resolve) => {
      const token = wx.getStorageSync('access_token');

      if (!token) {
        resolve();
        return;
      }

      wx.request({
        url: 'https://api.jhzyfw.com/api/admin_get_stats.php',
        method: 'GET',
        header: {
          'Authorization': `Bearer ${token}`
        },
        success: (res: any) => {
          if (res.data && res.data.success === true) {
            const statsData = res.data.data || {};
            // 检查今日是否已查看注册提醒
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            const viewedDate = wx.getStorageSync('register_reminder_viewed');
            const todaySignups = (viewedDate === dateStr) ? 0 : (statsData.today_signups || 0);
            
            this.setData({
              stats: {
                volunteers: statsData.total_volunteers || 0,
                activities: statsData.active_activities || 0,
                checkins: statsData.today_signins || 0,
                pending_activity: statsData.pending_reviews || 0,
                pending_volunteer: statsData.pending_volunteer_reviews || 0,
                pending_quick: statsData.pending_quick_reviews || 0,
                today_signups: todaySignups,
                today_new_volunteers: statsData.today_new_volunteers || []
              },
              adminStats: {
                totalVolunteers: statsData.total_volunteers || 0,
                todaySignups: statsData.today_signups || 0,
                pendingReviews: statsData.pending_reviews || 0,
                activeActivities: statsData.active_activities || 0
              }
            });
          }
          resolve();
        },
        fail: () => {
          resolve();
        }
      });
    });
  },

  // 跳转到积分管理
  goToPointsManager() {
    wx.navigateTo({
      url: '/pages/admin/points-manager/index'
    });
  },

  // 跳转到商品管理
  goToProductsManage() {
    wx.navigateTo({
      url: '/pages/admin/products-manage/index'
    });
  },

  // 跳转到兑换记录管理
  goToExchangeManage() {
    wx.navigateTo({
      url: '/pages/admin/exchange-manage/index'
    });
  },

  // 跳转到培训证书管理
  gotoTrainingCertificates() {
    wx.navigateTo({
      url: '/pages/admin/training-certificates/index'
    });
  },

  // 查看今日签到详情
  viewTodayCheckins() {
    wx.navigateTo({
      url: '/pages/admin/today-checkins/today-checkins'
    });
  },

  // 点击注册提醒后清除红点
  goToRegisterReminder(e: any) {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    wx.setStorageSync('register_reminder_viewed', dateStr);
    this.setData({
      'stats.today_signups': 0
    });
    wx.navigateTo({
      url: '/pages/admin/volunteer-manage/index'
    });
  },

  // 通用页面跳转
  gotoPage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (url) {
      wx.navigateTo({
        url: url
      });
    }
  },

  changePassword() {
    wx.navigateTo({
      url: '/pages/admin/change-password/change-password'
    });
  },

  goToSubscribe() {
    wx.navigateTo({
      url: '/pages/subscribe/subscribe'
    });
  },

  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出管理员登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.removeStorageSync('access_token');
          wx.redirectTo({
            url: '/pages/login-unified/index'
          });
        }
      }
    });
  },

  refreshDataButton() {
    this.refreshData();
    wx.showToast({
      title: '刷新中...',
      icon: 'loading'
    });
  },

  viewFeatureGuide() {
    wx.showModal({
      title: '管理面板功能说明',
      content: '1. 审核中心：处理活动报名和随手公益审核\n2. 快速操作：常用管理功能快速入口\n3. 数据统计：查看系统关键指标\n4. 应急功能：紧急情况下使用',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  viewPermissions() {
    const roleName = this.data.isSuperAdmin ? '系统超级管理员' : '普通管理员';
    const permissions = this.data.isSuperAdmin ?
      '✅ 所有功能权限\n✅ 用户管理\n✅ 活动管理\n✅ 审核管理\n✅ 系统设置' :
      '✅ 活动审核\n✅ 扫码核销\n✅ 志愿者管理\n❌ 系统设置';

    wx.showModal({
      title: `权限说明 - ${roleName}`,
      content: `您的角色：${roleName}\n\n权限范围：\n${permissions}`,
      showCancel: false,
      confirmText: '知道了'
    });
  }
});