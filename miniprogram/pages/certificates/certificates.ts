// certificates.ts
Page({
  data: {
    certificates: [],
    loading: true
  },

  onLoad() {
    this.loadCertificates();
  },

  loadCertificates() {
    const token = wx.getStorageSync('access_token') || wx.getStorageSync('token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/user_certificates.php?token=' + token,
      method: 'GET',
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            certificates: res.data.data || [],
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

  // 跳转到证书详情页
  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    console.log('点击证书ID:', id);
    console.log('跳转路径:', `/pages/certificates/detail/detail?id=${id}`);
    
    wx.navigateTo({
      url: `/pages/certificates/detail/detail?id=${id}`,
      success: () => {
        console.log('跳转成功');
      },
      fail: (err) => {
        console.error('跳转失败:', err);
        wx.showToast({
          title: '页面不存在',
          icon: 'none'
        });
      }
    });
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadCertificates();
    wx.stopPullDownRefresh();
  }
});