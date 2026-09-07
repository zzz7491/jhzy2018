// pages/points/points.js
const app = getApp();
import { mallApi } from '../../utils/mallApi';

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

  // 分页拉取积分流水（SELF scope，由后端 auth 决定；不传 user_id/team_id）
  loadPointsRecords() {
    if (!this.data.isLoggedIn) return;
    this.fetchTransactions(1, false);
  },

  fetchTransactions(page, append) {
    if (!this.data.isLoggedIn) return;
    const that = this;
    this.setData({ loading: true });

    mallApi.getPointsTransactions(page, this.data.pageSize)
      .then((pg) => {
        const mapped = pg.items.map((t) => that.mapTransaction(t));
        const all = append ? that.data.allRecords.concat(mapped) : mapped;
        const hasMore = page < pg.pagination.total_pages;

        that.setData({
          page: page,
          allRecords: all,
          filteredRecords: all,
          hasMore: hasMore,
          loading: false
        });

        that.recomputeStats();

        if (that.data.currentFilter !== 'all') {
          that.applyFilter();
        }

        wx.stopPullDownRefresh();
      })
      .catch((err) => {
        let msg = '加载失败，请稍后重试';
        if (err && err.status === 401) msg = '登录已失效，请重新登录';
        else if (err && err.status === 403) msg = '无权限查看积分记录';
        else if (err && err.isNetwork) msg = '网络异常，请检查网络连接';

        that.setData({ loading: false });
        wx.stopPullDownRefresh();
        wx.showToast({ title: msg, icon: 'none', duration: 2000 });
      });
  },

  // 单条流水 -> view model（仅依赖 v2 公开字段，不暴露内部 numeric id）
  mapTransaction(t) {
    const isIncome = t.direction === 1;
    const srcId = t.source_public_id || '';
    return {
      // 稳定 key（不使用内部 numeric id）
      id: `${t.created_at}-${t.type}-${t.amount_units}-${srcId}`,
      type: t.type,
      type_text: this.getTypeText(t.type),
      source_type: t.source_type,
      source_public_id: srcId || null,
      direction: t.direction,
      amount_units: t.amount_units,
      // 显示带符号：增加 +N / 扣减 -N（单位由 formatPoints 统一处理）
      pointsText: (isIncome ? '+' : '-') + mallApi.formatPoints(t.amount_units),
      is_income: isIncome,
      time: this.formatEpoch(t.created_at),
      description: ''
    };
  },

  recomputeStats() {
    const all = this.data.allRecords;
    let income = 0, expense = 0, incomeCount = 0, expenseCount = 0;
    for (const r of all) {
      if (r.is_income) {
        income += r.amount_units;
        incomeCount++;
      } else {
        expense += r.amount_units;
        expenseCount++;
      }
    }
    this.setData({
      pointsStats: {
        total_income: income,
        total_expense: expense,
        income_count: incomeCount,
        expense_count: expenseCount
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
      'service': '志愿服务',
      'exchange': '积分兑换',
      'training': '学习培训',
      'exam': '考试',
      'manual': '人工调整',
      'reward': '奖励',
      'activity': '活动'
    };
    return typeMap[type] || '其它';
  },

  formatEpoch(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts * 1000);
      const pad = (n) => (n < 10 ? '0' : '') + n;
      const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const y = new Date(Date.now() - 86400000);
      const yStr = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
      if (datePart === todayStr) return `今天 ${timePart}`;
      if (datePart === yStr) return `昨天 ${timePart}`;
      return `${datePart} ${timePart}`;
    } catch (e) {
      return '—';
    }
  },

  formatTime(timeStr) {
    if (!timeStr) return '';
    try {
      if (typeof timeStr !== 'string') return String(timeStr);
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
    if (!this.data.hasMore || this.data.loading) {
      wx.showToast({ title: '没有更多记录', icon: 'none' });
      return;
    }
    this.fetchTransactions(this.data.page + 1, true);
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
