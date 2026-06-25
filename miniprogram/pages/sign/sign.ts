// pages/sign/sign.js
const app = getApp();

Page({
  data: {
    checkinRecords: [],
    loading: true,
    userInfo: null,
    page: 1,
    hasMore: true,
    totalCheckins: 0,      // 总签到次数
    totalPoints: 0,        // 总积分
    isLoggedIn: false,
    recentPoints: 0        // 最近获得的积分
  },

  onLoad() {
    console.log('签到页面加载');
    
    // 检查登录状态（实名注册）
    this.checkLoginStatus();
  },

  onShow() {
    // 页面显示时重新检查登录状态
    this.checkLoginStatus();
    
    // 如果已登录，加载数据
    if (this.data.isLoggedIn) {
      this.loadCheckinRecords();
      this.loadStatistics();
    }
  },

  // 检查登录状态
  checkLoginStatus() {
    const isLoggedIn = app.checkLoginStatus();
    this.setData({ isLoggedIn: isLoggedIn });
    
    if (!isLoggedIn) {
      // 未实名注册，显示提示并跳转
      wx.showModal({
        title: '需要实名注册',
        content: '请先完成志愿者实名注册，才能使用签到功能',
        confirmText: '去注册',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            // 跳转到实名注册页面
            app.navigateToRealNameRegister('/pages/sign/sign');
          } else {
            // 用户取消，返回上一页
            wx.navigateBack();
          }
        }
      });
      return;
    }
    
    // 已登录，加载用户信息
    this.loadUserInfo();
  },

  // 加载用户信息
  loadUserInfo() {
    const userInfo = wx.getStorageSync('userInfo');
    this.setData({
      userInfo: userInfo
    });
    
    // 加载签到记录和统计数据
    this.loadCheckinRecords();
    this.loadStatistics();
  },

  // 加载签到记录
  loadCheckinRecords() {
    const that = this;
    const userId = this.data.userInfo?.id;
    
    if (!userId) return;
    
    this.setData({ loading: true });
    
    // 使用新的API路径
    wx.request({
      url: wx.$baseUrl + 'user_checkin_records.php',
      method: 'GET',
      data: {
        user_id: userId,
        page: this.data.page,
        limit: 20
      },
      success(res) {
        that.setData({ loading: false });
        
        if (res.data.code === 200) {
          const records = res.data.data.records || [];
          const hasMore = records.length >= 20;
          
          // 格式化签到记录数据（淡化时间）
          const formattedRecords = records.map(record => ({
            id: record.id,
            activity_id: record.activity_id,
            activity_title: record.activity_title || '未命名活动',
            checkin_date: that.formatDate(record.checkin_time), // 只显示日期
            checkin_status: record.status || '已完成',
            points_earned: record.points_earned || 0,
            checkin_method: record.checkin_method || '手动签到',
            // 时间信息简化显示
            service_info: record.service_hours ? `时长 ${record.service_hours}小时` : '单次服务'
          }));
          
          that.setData({
            checkinRecords: that.data.page === 1 ? formattedRecords : that.data.checkinRecords.concat(formattedRecords),
            hasMore: hasMore
          });
          
        } else {
          // API返回错误，使用模拟数据
          console.log('API返回错误，使用模拟数据:', res.data.message);
          that.loadMockCheckinRecords();
        }
      },
      fail(err) {
        console.error('加载签到记录失败:', err);
        that.setData({ loading: false });
        
        // 网络失败，使用模拟数据
        that.loadMockCheckinRecords();
      }
    });
  },

  // 加载模拟签到记录（备用）
  loadMockCheckinRecords() {
    const mockRecords = [
      {
        id: 1,
        activity_title: '南湖游客引导志愿服务',
        checkin_date: '12-10',
        checkin_status: '已完成',
        points_earned: 50,
        checkin_method: '扫码签到',
        service_info: '时长 4小时'
      },
      {
        id: 2,
        activity_title: '社区环保清理活动',
        checkin_date: '12-08',
        checkin_status: '已完成',
        points_earned: 30,
        checkin_method: '手动签到',
        service_info: '单次服务'
      },
      {
        id: 3,
        activity_title: '敬老院慰问服务',
        checkin_date: '12-05',
        checkin_status: '已完成',
        points_earned: 35,
        checkin_method: '扫码签到',
        service_info: '时长 2.5小时'
      },
      {
        id: 4,
        activity_title: '线上公益讲座',
        checkin_date: '12-03',
        checkin_status: '已完成',
        points_earned: 20,
        checkin_method: '线上签到',
        service_info: '单次服务'
      },
      {
        id: 5,
        activity_title: '文明交通劝导',
        checkin_date: '11-28',
        checkin_status: '已完成',
        points_earned: 40,
        checkin_method: '扫码签到',
        service_info: '时长 3小时'
      },
      {
        id: 6,
        activity_title: '爱心物资分拣',
        checkin_date: '11-25',
        checkin_status: '已完成',
        points_earned: 25,
        checkin_method: '手动签到',
        service_info: '单次服务'
      }
    ];
    
    // 根据分页截取数据
    const startIndex = (this.data.page - 1) * 20;
    const endIndex = startIndex + 20;
    const pageRecords = mockRecords.slice(startIndex, endIndex);
    const hasMore = endIndex < mockRecords.length;
    
    this.setData({
      checkinRecords: this.data.page === 1 ? pageRecords : this.data.checkinRecords.concat(pageRecords),
      loading: false,
      hasMore: hasMore
    });
  },

  // 加载统计数据
  loadStatistics() {
    const that = this;
    const userId = this.data.userInfo?.id;
    
    if (!userId) return;
    
    wx.request({
      url: wx.$baseUrl + 'user_points_summary.php',
      method: 'GET',
      data: {
        user_id: userId
      },
      success(res) {
        if (res.data.code === 200) {
          that.setData({
            totalCheckins: res.data.data.total_checkins || 0,
            totalPoints: res.data.data.total_points || 0,
            recentPoints: res.data.data.recent_points || 0
          });
        } else {
          // 使用模拟统计数据（基于签到记录计算）
          console.log('使用模拟统计数据');
          const records = that.data.checkinRecords;
          const totalCheckins = records.length;
          const totalPoints = records.reduce((sum, record) => sum + (record.points_earned || 0), 0);
          const recentPoints = records.slice(0, 3).reduce((sum, record) => sum + (record.points_earned || 0), 0);
          
          that.setData({
            totalCheckins: totalCheckins,
            totalPoints: totalPoints,
            recentPoints: recentPoints
          });
        }
      },
      fail(err) {
        console.error('加载统计数据失败:', err);
        // 基于现有记录计算统计数据
        const records = that.data.checkinRecords;
        const totalCheckins = records.length;
        const totalPoints = records.reduce((sum, record) => sum + (record.points_earned || 0), 0);
        const recentPoints = records.slice(0, 3).reduce((sum, record) => sum + (record.points_earned || 0), 0);
        
        that.setData({
          totalCheckins: totalCheckins,
          totalPoints: totalPoints,
          recentPoints: recentPoints
        });
      }
    });
  },

  // 格式化日期（只显示月-日）
  formatDate(dateTimeStr) {
    if (!dateTimeStr) return '';
    
    try {
      const date = new Date(dateTimeStr);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      
      return `${month}-${day}`;
    } catch (e) {
      // 尝试直接截取
      if (dateTimeStr.length >= 10) {
        return dateTimeStr.substring(5, 10).replace('-', '-');
      }
      return dateTimeStr;
    }
  },

  // 点击签到按钮
  onCheckinTap() {
    // 检查是否已登录
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    // 跳转到活动列表，选择活动进行签到
    wx.switchTab({
      url: '/pages/activity_list/activity_list'
    });
  },

  // 点击扫描二维码签到
  onScanCodeTap() {
    // 检查是否已登录
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => {
        console.log('扫码结果:', res.result);
        
        // 解析二维码内容，假设包含活动ID
        try {
          const qrData = JSON.parse(res.result);
          if (qrData.activity_id) {
            // 跳转到活动签到页面
            wx.navigateTo({
              url: `/pages/activity_checkin/activity_checkin?id=${qrData.activity_id}`
            });
          } else {
            wx.showToast({
              title: '无效的签到二维码',
              icon: 'none'
            });
          }
        } catch (e) {
          wx.showToast({
            title: '二维码解析失败',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        if (err.errMsg !== 'scanCode:fail cancel') {
          wx.showToast({
            title: '扫码失败',
            icon: 'none'
          });
        }
      }
    });
  },

  // 点击手动签到
  onManualCheckinTap() {
    // 检查是否已登录
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    // 跳转到手动签到页面
    wx.navigateTo({
      url: '/pages/manual_checkin/manual_checkin'
    });
  },

  // 点击记录查看详情
  onRecordTap(e) {
    const recordId = e.currentTarget.dataset.id;
    const record = this.data.checkinRecords.find(item => item.id == recordId);
    
    if (record) {
      // 简化详情显示，突出积分
      const detailContent = `活动：${record.activity_title}\n签到方式：${record.checkin_method}\n签到日期：${record.checkin_date}\n获得积分：${record.points_earned}分`;
      
      wx.showModal({
        title: '签到详情',
        content: detailContent,
        showCancel: false,
        confirmText: '知道了'
      });
    }
  },

  // 点击查看积分详情
  onViewPointsDetail() {
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    wx.navigateTo({
      url: '/pages/points/points'
    });
  },

  // 点击查看签到统计
  onViewStatistics() {
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    const statsContent = `累计签到：${this.data.totalCheckins}次\n累计积分：${this.data.totalPoints}分\n最近获得：${this.data.recentPoints}分`;
    
    wx.showModal({
      title: '签到统计',
      content: statsContent,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 点击兑换积分
  onExchangePoints() {
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    wx.navigateTo({
      url: '/pages/mall/mall'
    });
  },

  // 上拉加载更多
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return;
    
    this.setData({
      page: this.data.page + 1
    });
    
    this.loadCheckinRecords();
  },

  // 下拉刷新
  onPullDownRefresh() {
    if (!this.data.isLoggedIn) {
      wx.stopPullDownRefresh();
      return;
    }
    
    this.setData({
      page: 1,
      loading: true
    });
    
    this.loadCheckinRecords();
    this.loadStatistics();
    
    setTimeout(() => {
      wx.stopPullDownRefresh();
    }, 1000);
  },

  // 分享
  onShareAppMessage() {
    if (!this.data.isLoggedIn) {
      return {
        title: '志愿者签到中心',
        path: 'pages/index/index'
      };
    }
    
    return {
      title: `我已累计签到${this.data.totalCheckins}次，获得${this.data.totalPoints}积分`,
      path: 'pages/sign/sign',
      imageUrl: '/images/share-checkin.png'
    };
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  },

  // 跳转到个人中心
  goToProfile() {
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    wx.switchTab({
      url: '/pages/mine/mine'
    });
  },

  // 刷新数据
  onRefresh() {
    if (!this.data.isLoggedIn) {
      this.checkLoginStatus();
      return;
    }
    
    this.setData({
      page: 1,
      loading: true
    });
    
    this.loadCheckinRecords();
    this.loadStatistics();
  }
});