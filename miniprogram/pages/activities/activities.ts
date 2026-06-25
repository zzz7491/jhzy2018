// pages/activities/activities.js
const API_BASE = 'https://api.jhzyfw.com/api';

Page({
  data: {
    categories: [],
    activeCategory: 'all',
    activities: [],
    page: 1,
    limit: 10,
    hasMore: true,
    loading: false,
    status: 'published',
    banners: [
      'https://api.jhzyfw.com/api/uploads/banners/banner1.jpg',
      'https://api.jhzyfw.com/api/uploads/banners/banner2.jpg'
    ],
    isLoggedIn: false,
    // 【新增】：控制是否展开显示的开关
    isExpanded: false 
  },

  onLoad() {
    this.checkLoginStatus();
    this.loadCategories();
    this.loadActivities();
  },

  onShow() {
    this.checkLoginStatus();
    if (this.data.isLoggedIn && this.data.activities.length > 0) {
      this.updateActivitiesSignupStatus();
    }
  },

  onPullDownRefresh() {
    // 下拉刷新时重置所有状态
    this.setData({ 
      page: 1, 
      activities: [], 
      hasMore: true,
      isExpanded: false 
    });
    this.loadActivities().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadActivities();
    }
  },

  /**
   * 【新增】：点击展开/收起按钮的处理函数
   */
  onToggleExpand() {
    this.setData({
      isExpanded: !this.data.isExpanded
    });
    wx.vibrateShort();
  },

  checkLoginStatus() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const token = wx.getStorageSync('access_token');
      const isLoggedIn = wx.getStorageSync('isLoggedIn');
      const isValidLogin = isLoggedIn && token && userInfo && userInfo.id;
      
      this.setData({ isLoggedIn: !!isValidLogin });
      return !!isValidLogin;
    } catch (error) {
      console.error('检查登录状态失败:', error);
      this.setData({ isLoggedIn: false });
      return false;
    }
  },

  updateActivitiesSignupStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.id) return;
    
    const userSignups = wx.getStorageSync('userSignups') || {};
    const userActivities = userSignups[userInfo.id] || [];
    
    const updatedActivities = this.data.activities.map(activity => {
      const hasJoined = userActivities.includes(activity.id.toString());
      return {
        ...activity,
        hasJoined: hasJoined,
        displayStatus: hasJoined ? '已报名 ✓' : (activity.isEnded ? '已结束' : '立即报名')
      };
    });
    
    this.setData({ activities: updatedActivities });
  },

  showLoginModal() {
    wx.showModal({
      title: '需要登录',
      content: '此功能需要登录后才能使用，是否立即登录？',
      confirmText: '去登录',
      cancelText: '再看看',
      success: (res) => {
        if (res.confirm) this.goToLogin();
      }
    });
  },

  goToLogin() {
    wx.navigateTo({ url: '/pages/login-unified/index' });
  },

  loadCategories() {
    wx.request({
      url: `${API_BASE}/get_activity_categories.php`,
      method: 'GET',
      success: (res) => {
        if (res.data && res.data.success) {
          const categories = res.data.data || [];
          this.setData({
            categories: [{ id: 'all', name: '全部' }, ...categories]
          });
        } else {
          this.setData({ categories: [{ id: 'all', name: '全部' }] });
        }
      }
    });
  },

  loadActivities() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });
    
    return new Promise((resolve) => {
      const params = {
        action: 'list',
        page: this.data.page,
        limit: this.data.limit
      };
      
      if (this.data.activeCategory !== 'all') {
        params.category = this.data.activeCategory;
      }
      
      const queryString = Object.keys(params)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
      
      wx.request({
        url: `${API_BASE}/activities.php?${queryString}`,
        method: 'GET',
        header: {
          'Authorization': this.data.isLoggedIn ? `Bearer ${wx.getStorageSync('access_token')}` : ''
        },
        success: (res) => {
          if (res.statusCode === 200) {
            let activitiesList = [];
            let total = 0;
            
            if (res.data && res.data.code === 0 && res.data.data) {
              activitiesList = res.data.data.list || [];
              total = res.data.data.total || 0;
            } 
            else if (res.data && res.data.success && res.data.data) {
              activitiesList = res.data.data.list || res.data.data.activities || [];
              total = res.data.data.total || 0;
            }
            
            // 格式化活动数据
            const formattedActivities = activitiesList.map(activity => this.formatActivityData(activity));
            
            // 前端状态筛选（因为后端不支持status参数）
            let filteredActivities = formattedActivities;
            if (this.data.status === 'upcoming') {
              filteredActivities = formattedActivities.filter(activity => !activity.isEnded);
            } else if (this.data.status === 'ended') {
              filteredActivities = formattedActivities.filter(activity => activity.isEnded);
            }
            
            const newActivities = this.data.page === 1 ? filteredActivities : [...this.data.activities, ...filteredActivities];
            
            this.setData({
              activities: newActivities,
              hasMore: newActivities.length < total,
              page: this.data.page + 1,
              loading: false
            }, () => {
              this.updateActivitiesSignupStatus();
            });
          } else {
            this.setData({ loading: false });
          }
          resolve();
        },
        fail: () => {
          this.setData({ loading: false });
          resolve();
        }
      });
    });
  },

  formatActivityData(activity) {
    const now = new Date();
    const endTime = activity.end_time || activity.endTime;
    let isEnded = false;
    
    if (endTime) {
      try {
        const formattedEndTime = endTime.replace(/-/g, '/');
        const endDate = new Date(formattedEndTime);
        isEnded = now > endDate;
      } catch (error) {
        isEnded = activity.status === 'ended' || activity.status === 'finished';
      }
    }
    
    return {
      ...activity,
      isEnded: isEnded,
      hasJoined: false,
      displayStatus: isEnded ? '已结束' : '立即报名',
      displayTime: this.formatDisplayTime(activity.start_time, activity.end_time)
    };
  },

  formatDisplayTime(startTime, endTime) {
    if (!startTime) return '';
    try {
      const start = new Date(startTime.replace(/-/g, '/'));
      const end = endTime ? new Date(endTime.replace(/-/g, '/')) : null;
      
      const startMonth = start.getMonth() + 1;
      const startDay = start.getDate();
      
      // 判断是否为多天活动（开始日期和结束日期不同）
      if (end && (start.toDateString() !== end.toDateString())) {
        const endMonth = end.getMonth() + 1;
        const endDay = end.getDate();
        // 跨月显示：5月8日-5月17日
        if (startMonth === endMonth) {
          return `${startMonth}月${startDay}日-${endDay}日`;
        } else {
          // 跨月显示：5月8日-6月10日
          return `${startMonth}月${startDay}日-${endMonth}月${endDay}日`;
        }
      }
      
      // 同一天活动，显示具体时间
      const startHours = start.getHours().toString().padStart(2, '0');
      const startMinutes = start.getMinutes().toString().padStart(2, '0');
      if (end) {
        const endHours = end.getHours().toString().padStart(2, '0');
        const endMinutes = end.getMinutes().toString().padStart(2, '0');
        return `${startMonth}月${startDay}日 ${startHours}:${startMinutes}-${endHours}:${endMinutes}`;
      }
      return `${startMonth}月${startDay}日 ${startHours}:${startMinutes}`;
    } catch (error) {
      return startTime;
    }
  },

  onCategoryChange(e) {
    const categoryId = e.currentTarget.dataset.id;
    // 【核心修复】：切换分类时重置 isExpanded 为 false
    this.setData({
      activeCategory: categoryId,
      page: 1,
      activities: [],
      hasMore: true,
      isExpanded: false 
    });
    this.loadActivities();
  },

  onStatusChange(e) {
    const status = e.currentTarget.dataset.status;
    // 【核心修复】：切换状态时重置 isExpanded 为 false
    this.setData({
      status: status,
      page: 1,
      activities: [],
      hasMore: true,
      isExpanded: false 
    });
    this.loadActivities();
  },

  goToDetail(e) {
    if (!this.checkLoginStatus()) {
      this.showLoginModal();
      return;
    }
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  toggleFavorite(e) {
    if (!this.checkLoginStatus()) {
      this.showLoginModal();
      return;
    }
    const id = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    const userInfo = wx.getStorageSync('userInfo');
    const activity = this.data.activities[index];
    const isFavorite = activity.is_favorite;
    
    wx.request({
      url: `${API_BASE}/activities/${id}/favorite`,
      method: isFavorite ? 'DELETE' : 'POST',
      header: {
        'Authorization': `Bearer ${userInfo.token}`,
        'Content-Type': 'application/json'
      },
      success: (res) => {
        if (res.statusCode === 200 && res.data.success) {
          const activities = [...this.data.activities];
          activities[index].is_favorite = !isFavorite;
          this.setData({ activities });
        }
      }
    });
  },

  onShareAppMessage() {
    return { title: '志愿者活动', path: 'pages/activities/activities' };
  }
});