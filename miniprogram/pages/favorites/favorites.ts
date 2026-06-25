// favorites.ts
Page({
  data: {
    favorites: [],
    loading: true,
    currentTab: 0,
    tabs: ['活动', '资讯', '培训']
  },

  onLoad() {
    this.loadFavorites();
  },

  switchTab(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ currentTab: index, loading: true });
    this.loadFavorites(index);
  },

  loadFavorites(tabIndex = 0) {
    const token = wx.getStorageSync('access_token');
    const types = ['activity', 'news', 'training'];
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/user_favorites.php',
      method: 'GET',
      data: { 
        token: token,
        type: types[tabIndex]
      },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({
            favorites: res.data.data || [],
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

  goToDetail(e) {
    const item = e.currentTarget.dataset.item;
    let url = '';
    switch(item.type) {
      case 'activity':
        url = `/pages/activities/detail?id=${item.id}`;
        break;
      case 'news':
        url = `/pages/news/detail?id=${item.id}`;
        break;
      case 'training':
        url = `/pages/trainings/detail?id=${item.id}`;
        break;
    }
    wx.navigateTo({ url });
  },

  removeFavorite(e) {
    const item = e.currentTarget.dataset.item;
    wx.showModal({
      title: '提示',
      content: '确定取消收藏吗？',
      success: (res) => {
        if (res.confirm) {
          const token = wx.getStorageSync('access_token');
          wx.request({
            url: 'https://api.jhzyfw.com/api/favorite_remove.php',
            method: 'POST',
            data: {
              token: token,
              id: item.id,
              type: item.type
            },
            success: (res) => {
              if (res.data && res.data.code === 0) {
                wx.showToast({ title: '已取消收藏', icon: 'success' });
                this.loadFavorites(this.data.currentTab);
              } else {
                wx.showToast({
                  title: res.data?.msg || '操作失败',
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
      }
    });
  }
});