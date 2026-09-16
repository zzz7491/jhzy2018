// teams.ts
// P3-D：我的团队 / 团队活动 / 团队公开联系人。
//
// 纪律（用户决策 1=A / 2=A）：
// - Team 域能力一律经 Team 域唯一接入层 utils/teamApi（不再经 activityApi 的 team 方法）。
// - 活动仍属 Activity 域，继续经 activityApi（禁止跨域）。
// - active team 的写入一律经 teamApi.selectActiveTeam（Session Manager 唯一出入口），页面禁止 wx.setStorageSync。
// - 错误一律经 classifyTeamError 归一（Backend / Network / Unauthorized / Session Expired / Permission Denied）。

import activityApi, { ActivityRow } from '../../utils/activityApi';
import * as teamApi from '../../utils/teamApi';
import { classifyTeamError, selectActiveTeam } from '../../utils/teamApi';
import { TeamPublicContact, TeamView } from '../../utils/teamApi';

interface TabEvent {
  currentTarget: { dataset: { index: number } };
}

interface InputEvent {
  detail: { value: string };
}

interface TeamTapEvent {
  currentTarget: { dataset: { id: string; name?: string } };
}

interface ActivityTapEvent {
  currentTarget: { dataset: { id: string } };
}

interface TeamCardRow {
  id: string;
  name: string;
  role: string;
  members: number;
  activity_count: number;
  avatar: string;
}

interface ActivityCardRow {
  id: string;
  title: string;
  team: string;
  date: string;
  status: string;
}

Page({
  data: {
    teams: [] as TeamCardRow[],
    activities: [] as ActivityCardRow[],
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
    // adminInfo 为管理端登录态；Session Manager 当前未暴露 adminInfo getter，
    // 本阶段禁止改 session.ts（越界），故保持既有读取路径与判定语义不变。
    const adminInfo = wx.getStorageSync('adminInfo');

    // 如果有adminInfo说明是管理员登录
    const isAdmin = !!adminInfo && adminInfo.role === 'admin';

    this.setData({
      canCreateTeam: isAdmin  // 只有管理员可以创建团队
    });

    console.log('创建团队权限:', isAdmin ? '允许' : '仅管理员可创建');
  },

  switchTab(e: TabEvent) {
    const index = e.currentTarget.dataset.index;
    this.setData({ currentTab: index, loading: true });
    if (index === 0) {
      this.loadTeams();
    } else {
      this.loadTeamActivities();
    }
  },

  async loadTeams() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await teamApi.getMyTeams();
      const teams = ((res && res.teams) || []).map((t: TeamView): TeamCardRow => ({
        id: t.public_id,
        name: t.name,
        role: '成员',
        members: 0,
        activity_count: 0,
        avatar: '',
      }));
      wx.hideLoading();
      this.setData({ teams, loading: false });
    } catch (e) {
      wx.hideLoading();
      const err = classifyTeamError(e);
      wx.showToast({
        title: err.message,
        icon: 'none'
      });
      this.setData({ loading: false });
    }
  },

  async loadTeamActivities() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await activityApi.getActivities(1, 20);
      const list = (res && res.items) || [];
      const activities = list.map((a: ActivityRow): ActivityCardRow => {
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
    } catch (e) {
      wx.hideLoading();
      const err = classifyTeamError(e);
      if (err.code === 'TEAM_SCOPE_REQUIRED') {
        wx.showToast({ title: '请先选择团队', icon: 'none' });
      } else {
        wx.showToast({
          title: err.message,
          icon: 'none'
        });
      }
      this.setData({ loading: false });
    }
  },

  // 选择团队：写入团队上下文（供 API wrapper 注入 X-Team-Id），并刷新本团队活动。
  // 此即核心闭环「选择团队」动作；加入团队由 /pages/teams/select 完成。
  onSelectTeam(e: TeamTapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const name = e.currentTarget.dataset.name || '';
    selectActiveTeam(id);
    this.setData({ activeTeamId: id, activeTeamName: name, contactEditable: false });
    wx.showToast({ title: '已切换团队', icon: 'success', duration: 1200 });
    this.loadPublicContact(id);
    this.loadTeamActivities();
  },

  // N0-E5B：读取所选团队的公开业务联系人。
  // 仅具备 team.settings.update（team_admin / team_owner）者可读；403/404 时静默隐藏编辑区，
  // 不打扰普通成员（不泄露团队是否存在 / 是否有权限）。
  async loadPublicContact(teamId: string) {
    this.setData({ contactLoading: true, contactEditable: false });
    try {
      const res = await teamApi.getPublicContact(teamId);
      const c = (res && res.public_contact) || ({} as TeamPublicContact);
      this.setData({
        contactName: c.public_contact_name || '',
        contactPhone: c.public_contact_phone || '',
        contactLoading: false,
        contactEditable: true
      });
    } catch (e) {
      const err = classifyTeamError(e);
      // 403（无权限 / 平台上下文）与 404（跨团队 / 不存在）都不展示编辑区，仅提示其他错误。
      const silent = err.status === 403 || err.status === 404;
      this.setData({ contactLoading: false, contactEditable: false, contactName: '', contactPhone: '' });
      if (!silent) {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    }
  },

  onContactNameInput(e: InputEvent) {
    this.setData({ contactName: e.detail.value });
  },

  onContactPhoneInput(e: InputEvent) {
    this.setData({ contactPhone: e.detail.value });
  },

  // N0-E5B：保存团队公开业务联系人（窄写，仅两个公开字段；空白将在服务端归一为 NULL）。
  async savePublicContact() {
    const teamId = this.data.activeTeamId;
    if (!teamId || this.data.contactSaving) return;
    this.setData({ contactSaving: true });
    try {
      const res = await teamApi.updatePublicContact(teamId, {
        public_contact_name: this.data.contactName,
        public_contact_phone: this.data.contactPhone
      });
      const c = (res && res.public_contact) || ({} as TeamPublicContact);
      this.setData({
        contactName: c.public_contact_name || '',
        contactPhone: c.public_contact_phone || '',
        contactSaving: false
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      const err = classifyTeamError(e);
      this.setData({ contactSaving: false });
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  goToActivityDetail(e: ActivityTapEvent) {
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
