Page({
  data: {
    searchText: '',
    volunteer: null as any,
    inputPoints: '',
    inputReason: '' // 新增理由字段
  },

  onInputSearch(e: any) { this.setData({ searchText: e.detail.value }); },
  onInputPoints(e: any) { this.setData({ inputPoints: e.detail.value }); },
  onInputReason(e: any) { this.setData({ inputReason: e.detail.value }); },

  searchVolunteer() {
    const token = wx.getStorageSync('access_token');
    wx.showLoading({ title: '查找中...' });
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_search_volunteer_points.php',
      data: { keyword: this.data.searchText },
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        const list = res.data.data || [];
        if (list.length > 0) {
          this.setData({ volunteer: list[0], inputPoints: '', inputReason: '' });
        } else {
          this.setData({ volunteer: null });
          wx.showToast({ title: '未找到用户', icon: 'none' });
        }
      },
      complete: () => wx.hideLoading()
    });
  },

  submitPoints() {
    const points = parseInt(this.data.inputPoints);
    const reason = this.data.inputReason;
    if (!this.data.volunteer) return;
    if (isNaN(points) || points === 0) {
      wx.showToast({ title: '请输入分值', icon: 'none' });
      return;
    }
    if (!reason) {
      wx.showToast({ title: '请输入修改理由', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '存入确认',
      content: `理由：${reason}\n分值：${points > 0 ? '+' : ''}${points}`,
      success: (res) => {
        if (res.confirm) this.doUpdate(points, reason);
      }
    });
  },

  doUpdate(points: number, reason: string) {
    const token = wx.getStorageSync('access_token');
    wx.request({
      url: 'https://api.jhzyfw.com/api/admin_add_points.php',
      method: 'POST',
      header: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: {
        volunteer_id: this.data.volunteer.volunteer_id,
        points: points,
        reason: reason // 传理由给后端
      },
      success: (res: any) => {
        if (res.data.success) {
          wx.showToast({ title: '已存入流水表' });
          this.searchVolunteer(); // 刷新显示
        }
      }
    });
  }
});