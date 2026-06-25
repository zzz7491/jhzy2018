Page({
  data: {
    checkins: [] as any[],
    total: 0,
    date: '',
    loading: true
  },

  onLoad() {
    this.updateDate();
    this.loadTodayCheckins();
  },

  onPullDownRefresh() {
    this.loadTodayCheckins().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  updateDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    this.setData({
      date: `${year}-${month}-${day}`
    });
  },

  loadTodayCheckins(): Promise<void> {
    this.setData({ loading: true });

    return new Promise((resolve) => {
      const token = wx.getStorageSync('access_token');
      
      wx.request({
        url: 'https://api.jhzyfw.com/api/admin_today_checkins.php',
        method: 'GET',
        header: {
          'Authorization': `Bearer ${token}`
        },
        success: (res: any) => {
          if (res.data && res.data.success === true) {
            const checkins = res.data.data || [];
            this.setData({
              checkins: checkins,
              total: checkins.length
            });
          } else {
            this.setData({ checkins: [], total: 0 });
          }
          resolve();
        },
        fail: () => {
          wx.showToast({
            title: '加载失败',
            icon: 'none'
          });
          this.setData({ checkins: [], total: 0 });
          resolve();
        },
        complete: () => {
          this.setData({ loading: false });
        }
      });
    });
  }
});