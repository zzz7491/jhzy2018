// pages/teams/select/select.ts
// P3-D：加入团队（目录 + 加入）—— 全部经 Team 域唯一接入层 utils/teamApi。
//
// 纪律（用户决策 1=A / 2=A）：
// - 页面禁止 wx.request / 手拼 token / 手拼 URL；一律经 teamApi。
// - 目录返回 Legacy numeric group_id，加入必须同源于 Legacy（禁止 Legacy 列表 + V2 join 混用 ID 体系）。
// - 错误一律经 classifyTeamError 归一（Backend / Network / Unauthorized / Session Expired / Permission Denied）。

import { classifyTeamError, joinTeam, listJoinableTeams, JoinableTeamRow } from '../../../utils/teamApi';

interface DatasetEvent<T> {
  currentTarget: { dataset: T };
}

interface ShowModalResult {
  confirm: boolean;
  cancel: boolean;
}

Page({
  data: {
    groups: [] as JoinableTeamRow[],
    loading: true
  },

  onLoad() {
    this.loadGroups();
  },

  async loadGroups() {
    try {
      const groups = await listJoinableTeams();
      this.setData({ groups, loading: false });
    } catch (e) {
      const err = classifyTeamError(e);
      wx.showToast({ title: err.message, icon: 'none' });
      this.setData({ loading: false });
    }
  },

  selectGroup(e: DatasetEvent<{ id: number | string }>) {
    const groupId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认加入',
      content: '确定要加入这个团队吗？',
      success: (res: ShowModalResult) => {
        if (res.confirm) {
          this.joinGroup(groupId);
        }
      }
    });
  },

  async joinGroup(groupId: number | string) {
    try {
      await joinTeam(groupId);
      wx.showToast({ title: '加入成功', icon: 'success' });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    } catch (e) {
      const err = classifyTeamError(e);
      wx.showToast({ title: err.message, icon: 'none' });
    }
  }
});
