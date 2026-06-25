// teams.ts
Page({
  data: {
    teams: [],
    activities: [],
    loading: true,
    currentTab: 0,
    tabs: ['我的团队', '团队活动'],
    canCreateTeam: false  // 是否有创建团队的权限
  },

  onLoad() {
    this.checkCreatePermission();
    this.loadTeams();
  },

  // 检查是否有创建团队的权限
  checkCreatePermission() {
    // 从缓存中获取用户信息
    const adminInfo = wx.getStorageSync('adminInfo');
    const userInfo = wx.getStorageSync('userInfo');
    
    // 如果有adminInfo说明是管理员登录
    const isAdmin = adminInfo && adminInfo.role === 'admin';
    
    this.setData({ 
      canCreateTeam: isAdmin  // 只有管理员可以创建团队
    });
    
    console.log('创建团队权限:', isAdmin ? '允许' : '仅管理员可创建');
  },

  switchTab(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ currentTab: index, loading: true });
    if (index === 0) {
      this.loadTeams();
    } else {
      this.loadTeamActivities();
    }
  },

  loadTeams() {
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/my_groups.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            teams: res.data.data || [],
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data?.msg || '加载失败',
            icon: 'none'
          });
          this.setData({ loading: false });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
        this.setData({ loading: false });
      }
    });
  },

  loadTeamActivities() {
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/team_activities.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            activities: res.data.data || [],
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data?.msg || '加载失败',
            icon: 'none'
          });
          this.setData({ loading: false });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
        this.setData({ loading: false });
      }
    });
  },

  goToTeamDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/teams/detail?id=${id}`
    });
  },

  goToActivityDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/activities/detail?id=${id}`
    });
  },

  // 加入团队 - 跳转到团队列表页面
  joinTeam() {
    console.log('joinTeam clicked');
    wx.navigateTo({
      url: '/pages/teams/select/select'
    });
  },

  // 创建团队 - 跳转到创建页面（仅管理员可见）
  createTeam() {
    console.log('createTeam clicked');
    if (!this.data.canCreateTeam) {
      wx.showToast({
        title: '仅管理员可创建团队',
        icon: 'none'
      });
      return;
    }
    wx.navigateTo({
      url: '/pages/teams/create'
    });
  }
})