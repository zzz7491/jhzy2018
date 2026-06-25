// pages/points/points.js
const app = getApp();

Page({
  data: {
    pointsData: {
      current_points: 0,
      total_points: 0,
      level: '',
      next_level_points: 0,
      progress: 0
    },
    pointsStats: {
      total_income: 0,
      total_expense: 0,
      income_count: 0,
      expense_count: 0
    },
    allRecords: [],
    filteredRecords: [],
    showRules: false,
    showFilter: false,
    currentFilter: 'all',
    hasMore: true,
    page: 1,
    pageSize: 10,
    isSeniorMode: false,
    isLoggedIn: false,
    userInfo: null,
    displayName: '志愿者',
    loading: false,
    
    todayCasual: {
      count: 0,
      max: 5,
      remaining: 5
    },
    exchangeLimit: {
      imported_max_per_year: 200,
      imported_exchanged: 0,
      imported_remaining: 200
    },
    pointsSummary: {
      points_activity: 0,
      points_casual: 0,
      points_manual_special: 0,
      points_manual_honor: 0,
      points_manual_import: 0,
      points_exchange: 0
    }
  },

  onLoad() {
    console.log('我的积分页面加载');
    this.checkLoginStatus();
  },

  onShow() {
    console.log('我的积分页面显示');
    this.initDisplayMode();
    if (this.data.isLoggedIn) {
      this.loadUserPoints();
      this.loadPointsRecords();
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreRecords();
    }
  },

  onPullDownRefresh() {
    this.onRefresh();
  },

  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    const token = wx.getStorageSync('access_token');
    const isLoggedIn = !!(userInfo && token);
    
    this.setData({ isLoggedIn: isLoggedIn });
    
    if (!isLoggedIn) {
      wx.showModal({
        title: '需要登录',
        content: '请先登录，才能查看积分信息',
        confirmText: '去登录',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({
              url: '/pages/profile/login/login'
            });
          } else {
            wx.switchTab({
              url: '/pages/mine/mine'
            });
          }
        }
      });
      return;
    }
    
    this.setData({ 
      userInfo: userInfo,
      displayName: userInfo?.real_name || userInfo?.realname || '志愿者'
    });
    
    this.initDisplayMode();
    this.loadUserPoints();
    this.loadPointsRecords();
  },

  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    const isSeniorMode = displayMode === 'senior';
    this.setData({ isSeniorMode: isSeniorMode });
  },

  loadUserPoints() {
    if (!this.data.isLoggedIn) return;
    
    const that = this;
    const userInfo = wx.getStorageSync('userInfo');
    
    wx.request({
      url: wx.$baseUrl + 'user_info.php',
      method: 'GET',
      header: {
        'Authorization': 'Bearer ' + wx.getStorageSync('access_token')
      },
      success(res) {
        if (res.data.code === 0 || res.data.code === 200) {
          const userData = res.data.data || {};
          const updatedUserInfo = { ...userInfo, ...userData };
          wx.setStorageSync('userInfo', updatedUserInfo);
          
          that.setData({
            pointsData: {
              ...that.data.pointsData,
              current_points: userData.current_points || 0,
              total_points: userData.total_points || 0,
              level: userData.level || '初级志愿者',
              next_level_points: userData.next_level_points || 100,
              progress: userData.progress || 0
            },
            userInfo: updatedUserInfo
          });
        }
      }
    });
  },

  loadPointsRecords() {
    if (!this.data.isLoggedIn) return;
    
    const that = this;
    this.setData({ loading: true });
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/points_query.php',
      method: 'GET',
      header: {
        'Authorization': 'Bearer ' + wx.getStorageSync('access_token')
      },
      success(res) {
        console.log('积分记录响应:', res.data);
        
        if (res.data.code === 0) {
          const data = res.data.data || {};
          const summary = data.summary || {};
          const logs = data.recent_logs || [];
          
          // 关键：直接使用 data.current_points
          const currentPoints = data.current_points || 0;
          const totalPoints = data.total_points || 0;
          
          console.log('当前积分:', currentPoints);
          
          const formattedRecords = logs.map(record => {
            const points = parseFloat(record.points) || 0;
            return {
              id: record.id,
              type: record.change_type || 'other',
              type_text: that.getTypeText(record.change_type),
              points: points,
              points_display: points > 0 ? '+' + points.toFixed(2) : points.toFixed(2),
              description: record.description || '积分变更',
              time: that.formatTime(record.time || record.created_at),
              is_income: points > 0,
              status: 'completed'
            };
          });
          
          const total_income = formattedRecords
            .filter(r => r.is_income)
            .reduce((sum, r) => sum + r.points, 0);
          const total_expense = formattedRecords
            .filter(r => !r.is_income)
            .reduce((sum, r) => sum + Math.abs(r.points), 0);
          
          that.setData({
            allRecords: formattedRecords,
            filteredRecords: formattedRecords,
            pointsStats: {
              total_income: total_income,
              total_expense: total_expense,
              income_count: formattedRecords.filter(r => r.is_income).length,
              expense_count: formattedRecords.filter(r => !r.is_income).length
            },
            pointsData: {
              ...that.data.pointsData,
              current_points: currentPoints,
              total_points: totalPoints
            },
            pointsSummary: {
              points_activity: parseFloat(summary.points_activity) || 0,
              points_casual: parseFloat(summary.points_casual) || 0,
              points_manual_special: parseFloat(summary.points_manual_special) || 0,
              points_manual_honor: parseFloat(summary.points_manual_honor) || 0,
              points_manual_import: parseFloat(summary.points_manual_import) || 0,
              points_exchange: parseFloat(summary.points_exchange) || 0
            },
            todayCasual: {
              count: data.today?.casual_count || 0,
              max: data.today?.casual_max || 5,
              remaining: data.today?.casual_remaining || 5
            },
            exchangeLimit: {
              imported_max_per_year: data.exchange_limit?.imported_max_per_year || 200,
              imported_exchanged: data.exchange_limit?.imported_exchanged || 0,
              imported_remaining: data.exchange_limit?.imported_remaining || 200
            },
            hasMore: false,
            loading: false
          });
          
          if (that.data.currentFilter !== 'all') {
            that.applyFilter();
          }
          
          wx.stopPullDownRefresh();
        } else {
          that.setData({ loading: false });
          wx.stopPullDownRefresh();
        }
      },
      fail(err) {
        console.error('积分记录请求失败:', err);
        that.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    });
  },

  onRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    
    this.setData({
      page: 1,
      allRecords: [],
      filteredRecords: [],
      hasMore: true
    });
    
    Promise.all([
      this.loadUserPoints(),
      this.loadPointsRecords()
    ]).finally(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '刷新成功', icon: 'success', duration: 1500 });
    });
  },

  goToMallDirect() {
    if (this.data.pointsData.current_points <= 0) {
      wx.showModal({
        title: '积分不足',
        content: '您当前没有可用积分，快去参加活动赚取积分吧！',
        confirmText: '去赚积分',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            wx.switchTab({ url: '/pages/activity/activity' });
          }
        }
      });
      return;
    }
    wx.navigateTo({ url: '/pages/mall/mall' });
  },

  goToQuickAction() {
    wx.switchTab({ url: '/pages/quick-action/quick-action' });
  },

  toggleRules() {
    const rulesContent = `📊 积分规则说明：

1️⃣ 积分获取方式
• 活动签到：每30分钟积1分（最少30分钟）
• 随手公益：每次1分（每日上限5分）
• 管理员导入：特殊贡献/荣誉/历史积分
• 积分兑换：消耗积分兑换物品

2️⃣ 积分使用
• 积分商城：兑换实物/虚拟物品
• 活动优先：高分志愿者优先参与热门活动
• 等级晋升：积分累计提升志愿者等级

3️⃣ 积分有效期
• 获取的积分永久有效
• 历史导入积分每年最多兑换200分

4️⃣ 注意事项
• 积分不能转让给他人
• 违规行为可能扣除积分
• 如有疑问请联系客服`;
    
    wx.showModal({
      title: '积分规则说明',
      content: rulesContent,
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#07c160'
    });
  },

  showFilter() {
    this.setData({ showFilter: !this.data.showFilter });
  },

  setFilter(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({
      currentFilter: type,
      showFilter: false
    });
    this.applyFilter();
  },
  
  applyFilter() {
    const type = this.data.currentFilter;
    if (type === 'all') {
      this.setData({ filteredRecords: this.data.allRecords });
    } else if (type === 'income') {
      this.setData({ filteredRecords: this.data.allRecords.filter(r => r.is_income) });
    } else if (type === 'expense') {
      this.setData({ filteredRecords: this.data.allRecords.filter(r => !r.is_income) });
    }
  },

  getTypeText(type) {
    const typeMap = {
      'activity': '活动积分',
      'casual': '随手公益',
      'manual': '管理员调整',
      'exchange': '积分兑换',
      'other': '其他'
    };
    return typeMap[type] || '积分变更';
  },

  formatTime(timeStr) {
    if (!timeStr) return '';
    try {
      if (timeStr.includes('今天') || timeStr.includes('昨天')) return timeStr;
      if (timeStr.includes(' ')) {
        const [datePart, timePart] = timeStr.split(' ');
        const today = new Date().toISOString().split('T')[0];
        if (datePart === today) return `今天 ${timePart.substring(0, 5)}`;
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        if (datePart === yesterday) return `昨天 ${timePart.substring(0, 5)}`;
        return `${datePart} ${timePart.substring(0, 5)}`;
      }
      return timeStr;
    } catch (e) {
      return timeStr;
    }
  },

  loadMoreRecords() {
    wx.showToast({ title: '没有更多记录', icon: 'none' });
  },

  switchDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = displayMode === 'normal' ? 'senior' : 'normal';
    wx.setStorageSync('displayMode', newMode);
    this.setData({ isSeniorMode: newMode === 'senior' });
    wx.showToast({
      title: newMode === 'senior' ? '已切换为老年版' : '已切换为普通版',
      icon: 'success',
      duration: 1500
    });
  },

  showErrorToast(message) {
    wx.showToast({ title: message, icon: 'none', duration: 2000 });
  }
});