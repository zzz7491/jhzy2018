// pages/teams/create/create.ts
// P3-D：创建团队 —— 经 Team 域唯一接入层 utils/teamApi。
//
// 纪律（用户决策 2=A）：
// - 页面禁止 wx.request / 手拼 token；一律经 teamApi.createTeam。
// - V2 无创建团队端点（NO V2 IMPLEMENTATION），底层仍为 Legacy create_group.php；不伪造 V2 语义。
// - 错误一律经 classifyTeamError 归一。

import { classifyTeamError, createTeam } from '../../../utils/teamApi';

interface InputEvent {
  detail: { value: string };
}

interface DatasetEvent<T> {
  currentTarget: { dataset: T };
}

Page({
  data: {
    formData: {
      name: '',
      description: '',
      color: '#1890ff'
    }
  },

  onNameInput(e: InputEvent) {
    this.setData({
      'formData.name': e.detail.value
    });
  },

  onDescInput(e: InputEvent) {
    this.setData({
      'formData.description': e.detail.value
    });
  },

  selectColor(e: DatasetEvent<{ color: string }>) {
    const color = e.currentTarget.dataset.color;
    this.setData({
      'formData.color': color
    });
  },

  async submitForm() {
    const { name, description, color } = this.data.formData;

    if (!name) {
      wx.showToast({
        title: '请输入团队名称',
        icon: 'none'
      });
      return;
    }

    try {
      await createTeam({ name, description, color });
      wx.showToast({ title: '创建成功', icon: 'success' });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    } catch (e) {
      const err = classifyTeamError(e);
      wx.showToast({ title: err.message, icon: 'none' });
    }
  }
});
