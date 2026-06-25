// pages/teams/select.js
Page({
  data: {
    groups: [],
    loading: true
  },

  onLoad() {
    this.loadGroups();
  },

  loadGroups() {
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/all_groups.php',
      method: 'GET',
      data: { token: token },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            groups: res.data.data || [],
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

  selectGroup(e) {
    const groupId = e.currentTarget.dataset.id;
    const token = wx.getStorageSync('access_token');
    
    wx.showModal({
      title: '确认加入',
      content: '确定要加入这个团队吗？',
      success: (res) => {
        if (res.confirm) {
          this.joinGroup(groupId, token);
        }
      }
    });
  },

  joinGroup(groupId, token) {
    wx.request({
      url: 'https://api.jhzyfw.com/api/join_group.php',
      method: 'POST',
      data: {
        token: token,
        group_id: groupId
      },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          wx.showToast({
            title: '加入成功',
            icon: 'success'
          });
          setTimeout(() => {
            wx.navigateBack();
          }, 1500);
        } else {
          wx.showToast({
            title: res.data?.msg || '加入失败',
            icon: 'none'
          });
        }
      },
      fail: () => {
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
      }
    });
  }
});