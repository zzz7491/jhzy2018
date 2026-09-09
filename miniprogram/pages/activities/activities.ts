// pages/activities/activities.js
import activityApi from '../../utils/activityApi';

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
    // v2 暂未提供分类端点；保留「全部」单选，不回退 legacy PHP。
    this.setData({ categories: [{ id: 'all', name: '全部' }] });
  },

  loadActivities() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });

    const page = this.data.page;
    const limit = this.data.limit;

    return activityApi
      .getActivities(page, limit)
      .then((res) => {
        const list = (res && res.items) || [];
        const total = (res && res.pagination && res.pagination.total) || 0;

        const formatted = list.map((a) => this.formatActivityData(a));

        let filtered = formatted;
        if (this.data.status === 'upcoming') {
          filtered = formatted.filter((a) => !a.isEnded);
        } else if (this.data.status === 'ended') {
          filtered = formatted.filter((a) => a.isEnded);
        }

        const newActivities = page === 1 ? filtered : this.data.activities.concat(filtered);

        this.setData(
          {
            activities: newActivities,
            hasMore: newActivities.length < total,
            page: page + 1,
            loading: false,
          },
          () => {
            this.updateActivitiesSignupStatus();
          },
        );
      })
      .catch((err: any) => {
        this.setData({ loading: false });
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') {
          wx.showToast({ title: '请先在「我的团队」选择团队', icon: 'none' });
          this.setData({ activities: [], hasMore: false });
        } else {
          wx.showToast({
            title: (err && err.message) || '加载失败',
            icon: 'none'
          });
        }
      });
  },

  formatActivityData(activity: any) {
    const now = new Date();
    const endTime = activity.end_time || activity.endTime;
    let isEnded = false;

    if (endTime) {
      try {
        const endDate = new Date(String(endTime).replace(/-/g, '/'));
        isEnded = now > endDate;
      } catch (error) {
        isEnded = activity.status === 3 || activity.status === 4 || activity.status === 5;
      }
    } else {
      isEnded = activity.status === 3 || activity.status === 4 || activity.status === 5;
    }

    return {
      ...activity,
      id: activity.public_id || activity.id,
      description: activity.summary || activity.description || '',
      isEnded,
      hasJoined: false,
      displayStatus: isEnded ? '已结束' : '立即报名',
      displayTime: this.formatDisplayTime(activity.start_time, activity.end_time),
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

  toggleFavorite() {
    // v2 收藏端点尚未接入；不回退 legacy PHP，给出明确提示。
    wx.showToast({ title: '收藏功能即将上线', icon: 'none' });
  },

  onShareAppMessage() {
    return { title: '志愿者活动', path: 'pages/activities/activities' };
  },

  // 前往「随手公益」（导航整合：原独立 tab 并入活动页入口）
  goToQuickAction() {
    wx.navigateTo({ url: '/pages/quick-action/quick-action' });
  }
});