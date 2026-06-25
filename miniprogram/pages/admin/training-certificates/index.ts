Page({
  data: {
    list: [] as any[],
    loading: false,
    total: 0,
    page: 1,
    limit: 20,
    hasMore: false,
    search: '',
    scoreMin: 0,
    scoreMax: 100,
    scoreText: '',
    scoreOptions: ['全部', '90-100分', '90-94分', '95-100分']
  },

  onLoad() {
    this.loadData();
  },

  onSearchInput(e: any) {
    this.setData({ search: e.detail.value, page: 1, list: [] });
  },

  onScoreChange(e: any) {
    const index = e.detail.value;
    let scoreMin = 0, scoreMax = 100, scoreText = '';
    
    if (index === 0) {
      scoreMin = 0;
      scoreMax = 100;
      scoreText = '';
    } else if (index === 1) {
      scoreMin = 90;
      scoreMax = 100;
      scoreText = '90-100分';
    } else if (index === 2) {
      scoreMin = 90;
      scoreMax = 94;
      scoreText = '90-94分';
    } else if (index === 3) {
      scoreMin = 95;
      scoreMax = 100;
      scoreText = '95-100分';
    }
    
    this.setData({ scoreMin, scoreMax, scoreText, page: 1, list: [] });
    this.loadData();
  },

  search() {
    this.setData({ page: 1, list: [] });
    this.loadData();
  },

  async loadData() {
    if (this.data.loading) return;
    
    this.setData({ loading: true });
    
    const token = wx.getStorageSync('access_token');
    if (!token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      }, 1500);
      return;
    }
    
    const params: any = {
      page: this.data.page,
      limit: this.data.limit
    };
    
    if (this.data.search) params.search = this.data.search;
    if (this.data.scoreMin > 0) params.score_min = this.data.scoreMin;
    if (this.data.scoreMax < 100) params.score_max = this.data.scoreMax;
    
    const queryString = Object.keys(params).map(k => `${k}=${params[k]}`).join('&');
    
    wx.request({
      url: `https://api.jhzyfw.com/api/admin_training_certificates.php?${queryString}`,
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      success: (res: any) => {
        if (res.data && res.data.code === 0) {
          const newList = this.data.page === 1 
            ? res.data.data.list 
            : [...this.data.list, ...res.data.data.list];
          
          this.setData({
            list: newList,
            total: res.data.data.total,
            hasMore: res.data.data.has_more,
            loading: false
          });
        } else {
          wx.showToast({ title: res.data?.msg || '加载失败', icon: 'none' });
          this.setData({ loading: false });
        }
      },
      fail: () => {
        wx.showToast({ title: '网络错误', icon: 'none' });
        this.setData({ loading: false });
      }
    });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadData();
  },

  viewDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '该用户未注册', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/admin/volunteer-detail/index?id=${id}`
    });
  },

  onPullDownRefresh() {
    this.setData({ page: 1, list: [] });
    this.loadData();
    wx.stopPullDownRefresh();
  }
});