// pages/teams/create.js
Page({
  data: {
    formData: {
      name: '',
      description: '',
      color: '#1890ff'
    }
  },

  onNameInput(e) {
    this.setData({
      'formData.name': e.detail.value
    });
  },

  onDescInput(e) {
    this.setData({
      'formData.description': e.detail.value
    });
  },

  selectColor(e) {
    const color = e.currentTarget.dataset.color;
    this.setData({
      'formData.color': color
    });
  },

  submitForm() {
    const token = wx.getStorageSync('access_token');
    const { name, description, color } = this.data.formData;

    if (!name) {
      wx.showToast({
        title: '请输入团队名称',
        icon: 'none'
      });
      return;
    }

    wx.request({
      url: 'https://api.jhzyfw.com/api/create_group.php',
      method: 'POST',
      data: {
        token: token,
        name: name,
        description: description,
        color: color
      },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          wx.showToast({
            title: '创建成功',
            icon: 'success'
          });
          setTimeout(() => {
            wx.navigateBack();
          }, 1500);
        } else {
          wx.showToast({
            title: res.data?.msg || '创建失败',
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