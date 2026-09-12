// teams.ts
import activityApi from '../../utils/activityApi';

Page({
  data: {
    teams: [],
    activities: [],
    loading: true,
    currentTab: 0,
    tabs: ['我的团队', '团队活动'],
    canCreateTeam: false,  // 是否有创建团队的权限
    // N0-E5B：团队公开业务联系人（TEAM_PUBLIC_CONTACT）编辑态。
    activeTeamId: '',
    activeTeamName: '',
    contactEditable: false,   // 仅当当前用户对所选团队具备 team.settings.update 时显示
    contactLoading: false,
    contactSaving: false,
    contactName: '',
    contactPhone: ''
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
    const name = e.currentTarget.dataset.name || '';
    wx.setStorageSync('activeTeamPublicId', id);
    this.setData({ activeTeamId: id, activeTeamName: name, contactEditable: false });
    wx.showToast({ title: '已切换团队', icon: 'success', duration: 1200 });
    this.loadPublicContact(id);
    this.loadTeamActivities();
  },

  // N0-E5B：读取所选团队的公开业务联系人。
  // 仅具备 team.settings.update（team_admin / team_owner）者可读；403/404 时静默隐藏编辑区，
  // 不打扰普通成员（不泄露团队是否存在 / 是否有权限）。
  loadPublicContact(teamId: string) {
    this.setData({ contactLoading: true, contactEditable: false });
    activityApi
      .getTeamPublicContact(teamId)
      .then((res: any) => {
        const c = (res && res.public_contact) || {};
        this.setData({
          contactName: c.public_contact_name || '',
          contactPhone: c.public_contact_phone || '',
          contactLoading: false,
          contactEditable: true
        });
      })
      .catch((err: any) => {
        // 403（无权限 / 平台上下文）与 404（跨团队 / 不存在）都不展示编辑区，仅提示其他错误。
        const silent = err && (err.status === 403 || err.status === 404);
        this.setData({ contactLoading: false, contactEditable: false, contactName: '', contactPhone: '' });
        if (!silent) {
          wx.showToast({ title: (err && err.message) || '加载联系人失败', icon: 'none' });
        }
      });
  },

  onContactNameInput(e: any) {
    this.setData({ contactName: e.detail.value });
  },

  onContactPhoneInput(e: any) {
    this.setData({ contactPhone: e.detail.value });
  },

  // N0-E5B：保存团队公开业务联系人（窄写，仅两个公开字段；空白将在服务端归一为 NULL）。
  savePublicContact() {
    const teamId = this.data.activeTeamId;
    if (!teamId || this.data.contactSaving) return;
    this.setData({ contactSaving: true });
    activityApi
      .updateTeamPublicContact(teamId, {
        public_contact_name: this.data.contactName,
        public_contact_phone: this.data.contactPhone
      })
      .then((res: any) => {
        const c = (res && res.public_contact) || {};
        this.setData({
          contactName: c.public_contact_name || '',
          contactPhone: c.public_contact_phone || '',
          contactSaving: false
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      })
      .catch((err: any) => {
        this.setData({ contactSaving: false });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
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