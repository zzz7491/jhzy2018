// pages/profile/profile.js
const auth = require('../../utils/auth.js');

Page({
  data: {
    userInfo: null,
    stats: {
      hoursCount: 0,
      activitiesCount: 0,
      examsCount: 0
    },
    loading: true,
    menuItems: [
      {
        id: 'verification',
        icon: '🔒',
        title: '实名认证',
        desc: '查看认证状态',
        url: '/pages/profile/verification/verification',
        requireVerified: false
      },
      {
        id: 'exams',
        icon: '📝',
        title: '我的考试',
        desc: '查看考试成绩和证书',
        url: '/pages/exams/my-results/my-results',
        requireVerified: true
      },
      {
        id: 'activities',
        icon: '📅',
        title: '我的活动',
        desc: '查看参与的活动记录',
        url: '/pages/activities/my-activities/my-activities',
        requireVerified: true
      },
      {
        id: 'training',
        icon: '🎓',
        title: '我的学习',
        desc: '查看培训课程进度',
        url: '/pages/training/my-learning/my-learning',
        requireVerified: true
      },
      {
        id: 'settings',
        icon: '⚙️',
        title: '设置',
        desc: '修改个人信息',
        url: '/pages/profile/settings/settings',
        requireVerified: false
      }
    ]
  },

  onLoad: function() {
    this.loadUserInfo();
  },

  onShow: function() {
    // 页面显示时重新加载用户信息
    this.loadUserInfo();
  },

  // 加载用户信息
  loadUserInfo: function() {
    const that = this;
    that.setData({ loading: true });
    
    auth.getUserInfo().then((userInfo) => {
      if (!userInfo) {
        // 未登录，跳转到登录页面
        wx.redirectTo({
          url: '/pages/login/login?returnUrl=/pages/profile/profile',
        });
        return;
      }
      
      that.setData({
        userInfo: userInfo,
        loading: false
      });
      
      // 加载统计数据
      that.loadUserStats();
    }).catch(() => {
      that.setData({ loading: false });
    });
  },

  // 加载用户统计数据
  loadUserStats: function() {
    // 模拟统计数据
    setTimeout(() => {
      this.setData({
        'stats.hoursCount': 28.5,
        'stats.activitiesCount': 12,
        'stats.examsCount': 3
      });
    }, 500);
  },

  // 菜单项点击
  onMenuItemClick: function(e) {
    const index = e.currentTarget.dataset.index;
    const menuItem = this.data.menuItems[index];
    
    // 检查是否需要认证
    if (menuItem.requireVerified && !this.data.userInfo.is_verified) {
      wx.showModal({
        title: '需要实名认证',
        content: '该功能需要先完成实名认证',
        confirmText: '去认证',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({
              url: `/pages/profile/verification/verification?returnUrl=${menuItem.url}`
            });
          }
        }
      });
      return;
    }
    
    // 跳转到对应页面
    wx.navigateTo({
      url: menuItem.url,
    });
  },

  // 退出登录
  onLogout: function() {
    const that = this;
    
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          auth.logout().then(() => {
            wx.showToast({
              title: '已退出登录',
              icon: 'success',
              duration: 1500,
              success: () => {
                // 跳转到登录页面
                wx.redirectTo({
                  url: '/pages/login/login',
                });
              }
            });
          }).catch(() => {
            wx.showToast({
              title: '退出失败',
              icon: 'error'
            });
          });
        }
      }
    });
  },

  // 刷新数据
  onRefresh: function() {
    this.loadUserInfo();
    wx.showToast({
      title: '刷新成功',
      icon: 'success'
    });
  }
})