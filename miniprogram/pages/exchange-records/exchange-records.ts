// pages/exchange-records/exchange-records.js
Page({
  data: {
    records: [],
    loading: false,
    hasMore: true,
    page: 1,
    pageSize: 10,
    total: 0,
    completedCount: 0,
    pendingCount: 0,
    userInfo: null,
    showFilter: false,
    filterStatus: 'all',
    statusOptions: [
      { value: 'all', label: '全部' },
      { value: 'completed', label: '已完成' },
      { value: 'pending', label: '待处理' },
      { value: 'cancelled', label: '已取消' }
    ]
  },

  onLoad() {
    this.checkLogin();
  },

  onShow() {
    this.checkLogin();
  },

  // 检查登录状态
  checkLogin() {
    const userInfo = wx.getStorageSync('userInfo');
    const token = wx.getStorageSync('access_token');
    const isLoggedIn = wx.getStorageSync('isLoggedIn');
    
    if (isLoggedIn && token && userInfo && userInfo.id) {
      this.setData({
        userInfo: userInfo
      });
      this.loadRecords(true);
    } else {
      wx.showToast({
        title: '请先登录',
        icon: 'error'
      });
      setTimeout(() => {
        this.goBack();
      }, 1500);
    }
  },

  // 加载兑换记录
  loadRecords(reset = false) {
    if (this.data.loading) return;
    
    const currentPage = reset ? 1 : this.data.page;
    const token = wx.getStorageSync('access_token');
    
    this.setData({ loading: true });
    
    // 构建状态参数
    let statusParam = '';
    if (this.data.filterStatus !== 'all') {
      if (this.data.filterStatus === 'pending') statusParam = 'pending';
      else if (this.data.filterStatus === 'completed') statusParam = 'completed';
      else if (this.data.filterStatus === 'cancelled') statusParam = 'cancelled';
    }
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/exchange_records.php',
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`
      },
      data: {
        user_id: this.data.userInfo.id,
        page: currentPage,
        limit: this.data.pageSize,
        status: statusParam
      },
      success: (res) => {
        console.log('兑换记录API响应:', res);
        
        if (res.statusCode === 200 && res.data.code === 200) {
          const newRecords = res.data.data.records || [];
          const total = res.data.data.total || 0;
          
          let records;
          if (reset) {
            records = newRecords;
          } else {
            records = [...this.data.records, ...newRecords];
          }
          
          // 格式化记录数据
          const formattedRecords = records.map(record => ({
            id: record.id || record.exchange_id,
            goods_id: record.goods_id,
            goods_name: record.goods_name || '未知商品',
            points_spent: record.points_spent || 0,
            exchange_code: record.exchange_code || '',
            qrcode_url: record.qrcode_url || '',
            status: record.status || 'pending',
            created_at: record.created_at,
            completed_at: record.completed_at
          }));
          
          // 计算统计信息
          const completedCount = formattedRecords.filter(record => record.status === 'completed').length;
          const pendingCount = formattedRecords.filter(record => record.status === 'pending').length;
          
          this.setData({
            records: formattedRecords,
            total: total,
            completedCount: completedCount,
            pendingCount: pendingCount,
            page: currentPage,
            hasMore: newRecords.length >= this.data.pageSize,
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data.msg || '加载失败',
            icon: 'error'
          });
          this.setData({ loading: false });
        }
      },
      fail: (err) => {
        console.error('加载兑换记录失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'error'
        });
        this.setData({ loading: false });
      }
    });
  },

  // 切换状态筛选（与 WXML 绑定对应）
  switchStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.setData({
      filterStatus: status,
      page: 1,
      records: []
    });
    this.loadRecords(true);
  },

  // 复制兑换码
  copyCode(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    
    wx.setClipboardData({
      data: code,
      success: () => {
        wx.showToast({
          title: '兑换码已复制',
          icon: 'success'
        });
      }
    });
  },

  // 查看商品详情
  viewGoodsDetail(e) {
    const goodsId = e.currentTarget.dataset.id;
    if (goodsId) {
      wx.navigateTo({
        url: `/pages/goods-detail/goods-detail?id=${goodsId}`
      });
    }
  },

  // 联系客服
  contactService() {
    wx.makePhoneCall({
      phoneNumber: '0573-82099982'
    });
  },

  // 刷新记录
  refreshRecords() {
    this.loadRecords(true);
  },

  // 加载更多
  loadMore() {
    if (!this.data.loading && this.data.hasMore) {
      this.setData({
        page: this.data.page + 1
      });
      this.loadRecords();
    }
  },

  // 格式化时间（修复版）
  formatTime(timeStr) {
    if (!timeStr) return '暂无';
    // 如果已经是 YYYY-MM-DD HH:MM:SS 格式，直接返回
    if (typeof timeStr === 'string' && timeStr.includes('-') && timeStr.includes(':')) {
      return timeStr;
    }
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return timeStr;
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours().toString().padStart(2, '0');
    const minute = date.getMinutes().toString().padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
  },

  // 获取状态文本
  getStatusText(status) {
    const statusMap = {
      'pending': '待处理',
      'completed': '已完成',
      'cancelled': '已取消'
    };
    return statusMap[status] || '未知状态';
  },

  // 获取状态颜色
  getStatusColor(status) {
    const colorMap = {
      'pending': '#fa8c16',
      'completed': '#52c41a',
      'cancelled': '#ff4d4f'
    };
    return colorMap[status] || '#999';
  },

  // 页面上拉加载更多
  onReachBottom() {
    if (!this.data.loading && this.data.hasMore) {
      this.setData({
        page: this.data.page + 1
      });
      this.loadRecords();
    }
  },

  // 页面下拉刷新
  onPullDownRefresh() {
    this.loadRecords(true);
    wx.stopPullDownRefresh();
  },

  // 返回上一页
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: (err) => {
          console.error('返回失败:', err);
          wx.switchTab({
            url: '/pages/mall/mall'
          });
        }
      });
    } else {
      wx.switchTab({
        url: '/pages/mall/mall'
      });
    }
  },

  // 去积分商城
  goToMall() {
    wx.switchTab({
      url: '/pages/mall/mall'
    });
  }
});