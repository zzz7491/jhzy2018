// teams.ts
import activityApi from '../../utils/activityApi';

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
    wx.showLoading({ title: '加载中...' });
    activityApi
      .getTeamsMine()
      .then((res) => {
        const teams = ((res && res.teams) || []).map((t) => ({
          id: t.public_id,
          name: t.name,
          role: '成员',
          members: 0,
          activity_count: 0,
          avatar: '',
        }));
        wx.hideLoading();
        this.setData({ teams, loading: false });
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showToast({
          title: (err && err.message) || '加载失败',
          icon: 'none'
        });
        this.setData({ loading: false });
      });
  },

  loadTeamActivities() {
    wx.showLoading({ title: '加载中...' });
    activityApi
      .getActivities(1, 20)
      .then((res) => {
        const list = (res && res.items) || [];
        const activities = list.map((a) => {
          const start = a.start_time ? new Date(String(a.start_time).replace(/-/g, '/')) : null;
          const isEnded = a.status === 3 || a.status === 4 || a.status === 5;
          const date = start ? `${start.getMonth() + 1}月${start.getDate()}日` : '';
          return {
            id: a.public_id,
            title: a.title || '志愿活动',
            team: '本团队',
            date,
            status: isEnded ? '已结束' : '进行中',
          };
        });
        wx.hideLoading();
        this.setData({ activities, loading: false });
      })
      .catch((err: any) => {
        wx.hideLoading();
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') {
          wx.showToast({ title: '请先选择团队', icon: 'none' });
        } else {
          wx.showToast({
            title: (err && err.message) || '加载失败',
            icon: 'none'
          });
        }
        this.setData({ loading: false });
      });
  },

  // 选择团队：写入团队上下文（供 activityApi 注入 X-Team-Id），并刷新本团队活动。
  // 此即核心闭环「选择团队」动作；加入团队由 /pages/teams/select 完成。
  onSelectTeam(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.setStorageSync('activeTeamPublicId', id);
    this.setData({ activeTeamId: id });
    wx.showToast({ title: '已切换团队', icon: 'success', duration: 1200 });
    this.loadTeamActivities();
  },

  goToActivityDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
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