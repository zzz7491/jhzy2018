// pages/rankings/rankings.ts
Page({
  data: {
    // 排行榜数据
    rankings: [] as any[],
    
    // 分页参数
    page: 1,
    limit: 20, 
    hasMore: true,
    
    // 加载状态
    loading: true, // 全屏加载（会重置滚动条）
    isMoreLoading: false // 静默加载更多（不重置滚动条）
  },

  onLoad() {
    console.log('排行榜页面加载');
    this.loadRankings(true);
  },

  /**
   * 下拉刷新
   */
  onPullDownRefresh() {
    this.loadRankings(true).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 触底加载更多
   */
  loadMore() {
    // 如果正在加载或者没有更多数据了，直接返回
    if (this.data.isMoreLoading || !this.data.hasMore || this.data.loading) {
      return;
    }
    
    console.log('触底加载更多，当前页：', this.data.page);
    this.loadRankings(false);
  },

  /**
   * 加载排行榜数据核心逻辑
   * @param reset 是否重置列表（用于首次加载和下拉刷新）
   */
  loadRankings(reset = false): Promise<void> {
    if (reset) {
      this.setData({ loading: true, page: 1, hasMore: true });
    } else {
      this.setData({ isMoreLoading: true });
    }
    
    const currentPage = reset ? 1 : this.data.page;
    
    return new Promise((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/rankings.php',
        method: 'GET',
        data: {
          page: currentPage,
          limit: this.data.limit
        },
        success: (res: any) => {
          let rankingsData = [];
          if (res.data && res.data.code === 0) {
            rankingsData = Array.isArray(res.data.data) ? res.data.data : [];
          }
          
          const allRankings = reset ? rankingsData : [...this.data.rankings, ...rankingsData];
          
          this.setData({
            rankings: allRankings,
            // 如果返回的数据少于每页限制，说明后面没数据了
            hasMore: rankingsData.length === this.data.limit,
            page: currentPage + 1
          });
          
          resolve();
        },
        fail: (error: any) => {
          console.error('加载排行榜失败:', error);
          wx.showToast({ title: '网络请求失败', icon: 'none' });
          resolve();
        },
        complete: () => {
          // 无论成功失败，都关闭加载状态
          this.setData({ 
            loading: false,
            isMoreLoading: false
          });
        }
      });
    });
  },

  /**
   * 查看志愿者详情
   */
  viewVolunteerDetail(e: any) {
    const index = e.currentTarget.dataset.index;
    const volunteer = this.data.rankings[index];
    
    if (!volunteer) return;
    
    wx.vibrateShort();
    
    wx.showModal({
      title: volunteer.real_name,
      content: `志愿者ID: ${volunteer.volunteer_id}\n总积分: ${volunteer.total_points}\n服务时长: ${volunteer.total_hours}小时`,
      showCancel: false,
      confirmText: '知道了'
    });
  }
});