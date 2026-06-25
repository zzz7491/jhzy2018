// pages/index/index.ts - 重构版（集成随手公益 + 排行榜）
const app = getApp();

Page({
  data: {
    // 协议弹窗
    showProtocolModal: false,
    
    // 用户信息
    userInfo: null as any,
    isLoggedIn: false,
    
    // 显示模式
    isSeniorMode: false,
    
    // 动态滚动横幅（新增）
    feedList: [] as any[],
    feedTimer: null as any,
    
    // 日期和时间
    today: '',
    greeting: '',
    
    // 统计数据
    stats: {
      currentPoints: 0,
      totalPoints: 0,
      totalActivities: 0,
      totalHours: 0
    },
    
    // 主轮播图
    mainBanners: [] as any[],
    bannersLoading: false,
    
    // 热点活动
    hotActivities: [] as any[],
    hotActivitiesLoading: false,
    
    // 志愿者排行榜
    rankings: [] as any[],
    rankingsLoading: false,
    showAllRankings: false,
    topRankings: [] as any[],
    otherRankings: [] as any[],
    
    // 热门兑换物品
    exchangeItems: [] as any[],
    exchangeLoading: false,
    
    // 随手公益数据
    casualWelfareStats: {
      totalCompleted: 0,
      totalPending: 0,
      totalPoints: 0
    },
    approvedCasualWelfare: [] as any[],
    casualWelfareLoading: false,
    
    // 加载状态
    loading: true,
    refreshing: false
  },

  onLoad() {
    console.log('首页加载');
    // 检查协议状态
    this.checkProtocol();
    this.initPage();
    // 新增：加载动态横幅
    this.loadFeeds();
    // 新增：每30秒刷新一次
    this.data.feedTimer = setInterval(() => {
      this.loadFeeds();
    }, 30000);
  },

  // 新增：页面卸载时清理定时器
  onUnload() {
    if (this.data.feedTimer) {
      clearInterval(this.data.feedTimer);
    }
  },

  onShow() {
    console.log('首页显示');
    // 每次显示都同步storage中的登录状态
    this.syncLoginStatus();
    this.refreshData();
  },

  onPullDownRefresh() {
    console.log('下拉刷新');
    this.refreshData(true).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 新增：加载动态滚动横幅
  loadFeeds() {
    wx.request({
      url: 'https://api.jhzyfw.com/api/activity_feeds.php',
      method: 'GET',
      success: (res: any) => {
        if (res.data.code === 0 && res.data.data) {
          this.setData({ feedList: res.data.data });
        }
      },
      fail: (err: any) => {
        console.error('加载动态横幅失败:', err);
      }
    });
  },

  // 新增：检查协议状态
  checkProtocol() {
    const hasAgreedProtocol = wx.getStorageSync('hasAgreedProtocol');
    const hasAgreedPrivacy = wx.getStorageSync('hasAgreedPrivacy');
    
    if (!hasAgreedProtocol || !hasAgreedPrivacy) {
      this.setData({ showProtocolModal: true });
    }
  },

  // 新增：同意协议
  agreeProtocol() {
    wx.setStorageSync('hasAgreedProtocol', true);
    wx.setStorageSync('hasAgreedPrivacy', true);
    this.setData({ showProtocolModal: false });
    wx.showToast({
      title: '感谢您的同意',
      icon: 'success'
    });
  },

  // 新增：拒绝协议
  rejectProtocol() {
    wx.showModal({
      title: '提示',
      content: '您拒绝了用户协议，无法继续使用小程序',
      showCancel: false,
      success: () => {
        wx.exitMiniProgram();
      }
    });
  },

  // 同步登录状态
  syncLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');
    console.log('syncLoginStatus userInfo.total_points:', userInfo?.total_points);
    const token = wx.getStorageSync('access_token');
    const isLoggedIn = wx.getStorageSync('isLoggedIn');
    
    const isValidLogin = isLoggedIn === true && token && token.length > 0 && userInfo && userInfo.id;
    
    console.log('syncLoginStatus:', { isValidLogin, userInfo, token, isLoggedIn });
    
    if (isValidLogin) {
      this.setData({
        userInfo: userInfo,
        isLoggedIn: true,
        stats: {
          totalActivities: userInfo.activity_count || 0,
          totalHours: userInfo.service_hours || 0,
          currentPoints: userInfo.total_points || 0,
          totalPoints: userInfo.total_points || 0
        }
      });
      console.log('syncLoginStatus 设置的 stats:', this.data.stats);
    } else {
      this.setData({
        userInfo: null,
        isLoggedIn: false,
        stats: {
          totalActivities: 0,
          totalHours: 0,
          currentPoints: 0,
          totalPoints: 0
        }
      });
    }
  },

  initPage() {
    try {
      this.setGreetingAndDate();
      this.initDisplayMode();
      this.syncLoginStatus();
      if (this.data.isLoggedIn) {
        this.loadAllData();
      } else {
        this.loadPublicData();
      }
    } catch (error) {
      console.error('初始化页面失败:', error);
      this.setData({ loading: false });
    }
  },

  refreshData(force = false): Promise<void> {
    if (this.data.refreshing && !force) return Promise.resolve();
    
    this.setData({ refreshing: true });
    
    this.syncLoginStatus();
    
    if (this.data.isLoggedIn) {
      return this.loadAllData().then(() => {
        this.setData({ refreshing: false });
      }).catch(() => {
        this.setData({ refreshing: false });
      });
    } else {
      return this.loadPublicData().then(() => {
        this.setData({ refreshing: false });
      }).catch(() => {
        this.setData({ refreshing: false });
      });
    }
  },

  setGreetingAndDate() {
    const now = new Date();
    const hour = now.getHours();
    let greeting = '';
    
    if (hour < 6) greeting = '凌晨好';
    else if (hour < 9) greeting = '早上好';
    else if (hour < 12) greeting = '上午好';
    else if (hour < 14) greeting = '中午好';
    else if (hour < 18) greeting = '下午好';
    else greeting = '晚上好';
    
    const today = now.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    });
    
    this.setData({
      greeting: greeting,
      today: today
    });
  },

  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    const isSeniorMode = displayMode === 'senior';
    
    this.setData({
      isSeniorMode: isSeniorMode
    });
  },

  checkLoginStatus(): Promise<boolean> {
    console.log('checkLoginStatus 执行了');
    console.log('storage中的值:', {
      userInfo: wx.getStorageSync('userInfo'),
      token: wx.getStorageSync('access_token'),
      isLoggedIn: wx.getStorageSync('isLoggedIn')
    });
    
    return new Promise((resolve) => {
      try {
        const userInfo = wx.getStorageSync('userInfo');
        const token = wx.getStorageSync('access_token');
        const isLoggedIn = wx.getStorageSync('isLoggedIn');
        
        // 判断是否有效登录
        const isValidLogin = isLoggedIn === true && token && token.length > 0 && userInfo && userInfo.id;
        
        console.log('判断结果:', { isValidLogin, hasUserInfo: !!userInfo, hasToken: !!token, hasId: !!(userInfo?.id) });
        
        if (isValidLogin) {
          this.setData({
            userInfo: userInfo,
            isLoggedIn: true,
            stats: {
              totalActivities: userInfo.activity_count || 0,
              totalHours: userInfo.service_hours || 0,
              currentPoints: userInfo.total_points || 0,
              totalPoints: userInfo.total_points || 0
            }
          });
          resolve(true);
        } else {
          this.setData({
            userInfo: null,
            isLoggedIn: false,
            stats: {
              totalActivities: 0,
              totalHours: 0,
              currentPoints: 0,
              totalPoints: 0
            }
          });
          resolve(false);
        }
      } catch (error) {
        console.error('检查登录状态失败:', error);
        resolve(false);
      }
    });
  },

  loadAllData(): Promise<void> {
    this.setData({ loading: true });
    
    return Promise.all([
      this.loadMainBanners(),
      this.loadHotActivities(),
      this.loadRankings(),
      // loadUserStats 已移除，积分由 syncLoginStatus 设置
      this.loadExchangeItems(),
      this.loadCasualWelfareData()
    ]).catch((error: any) => {
      console.error('加载数据失败:', error);
      return this.loadPublicData();
    }).then(() => {
      this.setData({ loading: false });
    });
  },

  loadPublicData(): Promise<void> {
    return Promise.all([
      this.loadMainBanners(),
      this.loadHotActivities(),
      this.loadRankings(),
      this.loadExchangeItems()
    ]).catch((error: any) => {
      console.error('加载公开数据失败:', error);
    }).then(() => {
      this.setData({ loading: false });
    });
  },

  // ========== 修改后的轮播图加载方法 ==========
  loadMainBanners(): Promise<void> {
    this.setData({ bannersLoading: true });
    
    return new Promise((resolve) => {
      // 改为从新接口获取轮播图
      wx.request({
        url: 'https://exam.jhzyfw.com/api_get_carousel.php',
        method: 'GET',
        success: (res: any) => {
          console.log('轮播图接口返回:', res.data);
          
          if (res.data.code === 0 && res.data.data && res.data.data.length > 0) {
            // 转换新接口数据格式为原有格式
            const banners = res.data.data.map((item: any) => ({
              id: item.id,
              image: item.image_url,
              title: item.title || '',
              description: item.title || '',
              link: item.link_url,
              type: item.link_url ? 'link' : 'static'
            }));
            this.setData({ mainBanners: banners });
          } else {
            // 如果新接口无数据，使用活动作为备选
            this.loadBannersFromActivities();
          }
          resolve();
        },
        fail: (err: any) => {
          console.error('加载轮播图失败:', err);
          // 失败时使用活动作为备选
          this.loadBannersFromActivities();
          resolve();
        },
        complete: () => {
          this.setData({ bannersLoading: false });
        }
      });
    });
  },

  loadBannersFromActivities() {
    wx.request({
      url: 'https://api.jhzyfw.com/api/activities.php',
      method: 'GET',
      data: {
        page: 1,
        limit: 6,
        sort: 'hot',
        status: 'open'
      },
      success: (res: any) => {
        if (res.data.code === 0 && res.data.data && res.data.data.activities) {
          const activities = res.data.data.activities;
          let banners = activities
            .filter((activity: any) => activity.cover_image)
            .slice(0, 5)
            .map((activity: any) => ({
              id: activity.id,
              image: this.formatImageUrl(activity.cover_image),
              title: activity.title,
              description: activity.location || '志愿活动',
              type: 'activity',
              link: '/pages/detail/detail?id=' + activity.id
            }));
          
          if (banners.length < 5) {
            const defaultBanners = this.getStaticBanners().slice(0, 5 - banners.length);
            banners = banners.concat(defaultBanners);
          }
          
          this.setData({ mainBanners: banners });
        } else {
          this.setData({ mainBanners: this.getStaticBanners() });
        }
      },
      fail: () => {
        this.setData({ mainBanners: this.getStaticBanners() });
      }
    });
  },

  getStaticBanners() {
    return [
      {
        id: 1,
        image: 'https://api.jhzyfw.com/api/uploads/banners/banner1.jpg',
        title: '志愿服务，传递爱心',
        description: '人人参与，共创美好社会',
        type: 'static'
      },
      {
        id: 2,
        image: 'https://api.jhzyfw.com/api/uploads/banners/banner2.jpg',
        title: '积分激励，回馈志愿',
        description: '志愿服务可兑换精美礼品',
        type: 'static'
      },
      {
        id: 3,
        image: 'https://api.jhzyfw.com/api/uploads/banners/banner3.jpg',
        title: '随手公益，点滴爱心',
        description: '随时随地参与公益活动',
        type: 'static'
      },
      {
        id: 4,
        image: 'https://api.jhzyfw.com/api/uploads/banners/banner4.jpg',
        title: '社区服务，共建和谐',
        description: '关爱社区，服务邻里',
        type: 'static'
      },
      {
        id: 5,
        image: 'https://api.jhzyfw.com/api/uploads/banners/banner5.jpg',
        title: '环保志愿，绿色家园',
        description: '保护环境，从我做起',
        type: 'static'
      }
    ];
  },
  // ========== 轮播图修改结束 ==========

  loadHotActivities() {
    return new Promise<void>((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/activities.php',
        method: 'GET',
        data: {
          page: 1,
          limit: 6,
          sort: 'hot',
          status: 'open'
        },
        success: (res: any) => {
          if (res.data.code === 0 && res.data.data && res.data.data.activities) {
            const hotActivities = res.data.data.activities.slice(0, 5).map((item: any) => ({
              id: item.id,
              title: item.title,
              coverImage: this.formatImageUrl(item.cover_image),
              time: this.formatActivityTime(item.start_time) + '-' + this.formatActivityTime(item.end_time),
              location: item.location || '待定',
              points: item.points_reward || 0,
              status: this.getActivityStatus(item),
              statusText: this.getActivityStatusText(item)
            }));
            
            this.setData({ hotActivities: hotActivities });
          }
          resolve();
        },
        fail: (error: any) => {
          console.error('加载热点活动失败:', error);
          resolve();
        }
      });
    });
  },

  /**
   * 加载志愿者排行榜 - 修复头像显示问题
   */
  loadRankings() {
    this.setData({ rankingsLoading: true });
    
    return new Promise<void>((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/rankings.php',
        method: 'GET',
        data: {
          type: 'points',
          limit: 10
        },
        success: (res: any) => {
          console.log('排行榜API响应:', res.data);
          
          let rankings = [];
          
          if (res.data && res.data.code === 0 && res.data.data) {
            if (Array.isArray(res.data.data)) {
              rankings = res.data.data;
            } else if (res.data.data.rankings && Array.isArray(res.data.data.rankings)) {
              rankings = res.data.data.rankings;
            }
          }
          
          console.log('排行榜原始数据:', rankings);
          console.log('第一个用户数据:', rankings[0]);
          
          const formattedRankings = rankings.map((item: any, index: number) => {
             // 修复头像URL
             let avatarUrl = item.avatar || '';
             
             // 如果头像URL存在且不是完整的HTTP地址，需要修正
             if (avatarUrl && !avatarUrl.startsWith('http')) {
               if (avatarUrl.startsWith('/')) {
                 // 如果以斜杠开头，直接拼接到域名后
                 avatarUrl = 'https://api.jhzyfw.com' + avatarUrl;
               } else {
                 // 否则，手动添加 /api/ 前缀
                 avatarUrl = 'https://api.jhzyfw.com/api/' + avatarUrl;
               }
             } else if (!avatarUrl) {
               // 如果没有头像，使用默认图片
               avatarUrl = '/images/default-avatar.png';
             }
             
             console.log('用户头像URL:', avatarUrl);
             
             return {
                 id: item.user_id || item.id || index + 1,
                 real_name: item.real_name || item.nickname || item.name || '',
                 avatar: avatarUrl,
                 total_points: item.total_points || item.points || 0,
                 points: item.total_points || item.points || 0,
                 total_hours: item.total_hours || item.hours || 0
             };
          });
          
          this.setData({ 
            rankings: formattedRankings,
            topRankings: formattedRankings.slice(0, 3),
            otherRankings: formattedRankings.slice(3)
          });
          
          resolve();
        },
        fail: (error: any) => {
          console.error('加载排行榜失败:', error);
          this.setData({ 
            rankings: [],
            topRankings: [],
            otherRankings: []
          });
          resolve();
        },
        complete: () => {
          this.setData({ rankingsLoading: false });
        }
      });
    });
  },

  // loadUserStats 已移除，积分由 syncLoginStatus 设置

  loadExchangeItems() {
    this.setData({ exchangeLoading: true });
    
    return new Promise<void>((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/mall_products.php',
        method: 'GET',
        data: {
          page: 1,
          limit: 6,
          status: 'available'
        },
        success: (res: any) => {
          console.log('兑换物品API响应:', res.data);
          
          if (res.data.code === 0 && res.data.data && res.data.data.products) {
            const exchangeItems = res.data.data.products.map((item: any) => ({
              id: item.product_id,
              name: item.product_name,
              description: item.description || '',
              image: item.image_url ? this.formatImageUrl(item.image_url) : '',
              points: item.points_required,
              value: item.value || Math.round(item.points_required / 3),
              stock: item.stock,
              source: item.source || '',
              status: item.status
            }));
            
            this.setData({ exchangeItems: exchangeItems });
          } else {
            console.warn('兑换物品API返回数据格式异常:', res.data);
            this.setData({ exchangeItems: [] });
          }
          resolve();
        },
        fail: (error: any) => {
          console.error('加载兑换物品失败:', error);
          this.setData({ exchangeItems: [] });
          resolve();
        },
        complete: () => {
          this.setData({ exchangeLoading: false });
        }
      });
    });
  },

  loadCasualWelfareData() {
    if (!this.data.userInfo) {
      return Promise.resolve();
    }
    
    this.setData({ casualWelfareLoading: true });
    
    return new Promise<void>((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/quick_actions.php',
        method: 'GET',
        header: {
          'Authorization': 'Bearer ' + wx.getStorageSync('access_token')
        },
        data: {
          action: 'stats'
        },
        success: (res: any) => {
          console.log('随手公益统计响应:', res.data);
          
          if (res.data.code === 0 && res.data.data) {
            this.setData({
              casualWelfareStats: {
                totalCompleted: res.data.data.completed_count || 0,
                totalPending: res.data.data.pending_count || 0,
                totalPoints: res.data.data.total_points || 0
              }
            });
          } else {
            this.setData({
              casualWelfareStats: {
                totalCompleted: 0,
                totalPending: 0,
                totalPoints: 0
              }
            });
          }
          
          this.loadApprovedCasualWelfare().then(() => {
            resolve();
          }).catch(() => {
            resolve();
          });
        },
        fail: (error: any) => {
          console.error('加载随手公益统计失败:', error);
          this.setData({
            casualWelfareStats: {
              totalCompleted: 0,
              totalPending: 0,
              totalPoints: 0
            }
          });
          this.loadApprovedCasualWelfare().then(() => {
            resolve();
          }).catch(() => {
            resolve();
          });
        },
        complete: () => {
          this.setData({ casualWelfareLoading: false });
        }
      });
    });
  },

  loadApprovedCasualWelfare(): Promise<void> {
    return new Promise((resolve) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/quick_actions.php',
        method: 'GET',
        header: {
          'Authorization': 'Bearer ' + wx.getStorageSync('access_token')
        },
        data: {
          action: 'list',
          status: 'approved',
          limit: 5
        },
        success: (res: any) => {
          console.log('已审核随手公益响应:', res.data);
          
          if (res.data.code === 0 && res.data.data && res.data.data.records) {
            const approvedRecords = res.data.data.records.map((record: any) => ({
              id: record.id,
              title: record.action_title || '随手公益',
              description: record.action_description || '',
              icon: this.getCasualWelfareIcon(record.action_type),
              points_reward: parseInt(record.points) || 0,
              created_at: record.created_at,
              status: record.status
            }));
            
            this.setData({ approvedCasualWelfare: approvedRecords });
          } else {
            this.setData({ approvedCasualWelfare: [] });
          }
          resolve();
        },
        fail: (error: any) => {
          console.error('加载已审核随手公益失败:', error);
          this.setData({ approvedCasualWelfare: [] });
          resolve();
        }
      });
    });
  },

  getCasualWelfareIcon(actionType: string): string {
    const iconMap: {[key: string]: string} = {
      'environmental': '🌱',
      'community': '🏘️',
      'elderly': '👴',
      'children': '👶',
      'education': '📚',
      'health': '⚕️',
      'culture': '🎭',
      'sports': '⚽',
      'other': '🌟'
    };
    
    return iconMap[actionType] || '🌟';
  },

  formatImageUrl(imageUrl: string): string {
    if (!imageUrl) return '';
    
    if (imageUrl.startsWith('http') || imageUrl.startsWith('https') || imageUrl.startsWith('data:image')) {
      return imageUrl;
    }
    
    if (imageUrl.startsWith('/uploads/')) {
      return 'https://api.jhzyfw.com/api' + imageUrl;
    }
    
    if (imageUrl.includes('uploads/')) {
      return 'https://api.jhzyfw.com/api/' + imageUrl;
    }
    
    return 'https://api.jhzyfw.com/api/uploads/' + imageUrl;
  },

  formatActivityTime(timeString: string): string {
    if (!timeString) return '待定';
    
    try {
      const match = timeString.match(/(\d{1,2}):(\d{1,2})/);
      if (match) {
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2]);
        return (hour < 10 ? '0' + hour : hour) + ':' + (minute < 10 ? '0' + minute : minute);
      }
      
      const date = new Date(timeString);
      if (!isNaN(date.getTime())) {
        const hours = date.getHours();
        const minutes = date.getMinutes();
        return (hours < 10 ? '0' + hours : hours) + ':' + (minutes < 10 ? '0' + minutes : minutes);
      }
      
      return '待定';
    } catch (error) {
      console.error('格式化时间失败:', error, timeString);
      return '待定';
    }
  },

  formatDate(dateString: string): string {
    if (!dateString) return '';
    
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString;
      
      const now = new Date();
      const diffTime = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays === 0) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `今天 ${hours}:${minutes}`;
      } else if (diffDays === 1) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `昨天 ${hours}:${minutes}`;
      } else if (diffDays < 7) {
        return `${diffDays}天前`;
      } else {
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        return `${month}-${day}`;
      }
    } catch (error) {
      console.error('格式化日期失败:', error);
      return dateString;
    }
  },

  getActivityStatus(activity: any): string {
    if (!activity) return 'available';
    
    if (activity.is_signed) {
      return 'signed';
    }
    
    if (activity.signup_status === 'closed') {
      return 'full';
    } else if (activity.signup_status === 'pending') {
      return 'pending';
    } else if (activity.signup_status === 'rejected') {
      return 'rejected';
    }
    
    const maxParticipants = activity.max_participants || 0;
    const currentParticipants = activity.current_participants || 0;
    const availableSlots = activity.available_slots || (maxParticipants - currentParticipants);
    
    if (availableSlots <= 0) {
      return 'full';
    }
    
    return 'available';
  },

  getActivityStatusText(activity: any): string {
    const status = this.getActivityStatus(activity);
    
    const statusMap: {[key: string]: string} = {
      'available': '可报名',
      'full': '已满员',
      'signed': '已报名',
      'pending': '审核中',
      'rejected': '已拒绝'
    };
    
    return statusMap[status] || '可报名';
  },

  toggleDisplayMode() {
    const currentMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = currentMode === 'normal' ? 'senior' : 'normal';
    
    wx.setStorageSync('displayMode', newMode);
    
    this.setData({
      isSeniorMode: newMode === 'senior'
    });
    
    wx.vibrateShort();
    
    wx.showToast({
      title: '已切换到' + (newMode === 'senior' ? '大字版' : '普通版'),
      icon: 'success',
      duration: 1500
    });
  },

  toggleRankingsExpand() {
    this.setData({
      showAllRankings: !this.data.showAllRankings
    });
  },

  onMainSwiperTap(e: any) {
    const index = e.currentTarget.dataset.index;
    const banner = this.data.mainBanners[index];
    
    if (!banner) return;
    
    wx.vibrateShort();
    
    if (banner.type === 'activity' && banner.id) {
      if (!this.data.userInfo) {
        this.showLoginModal('查看活动');
        return;
      }
      
      wx.navigateTo({
        url: '/pages/detail/detail?id=' + banner.id
      });
    } else if (banner.link) {
      wx.navigateTo({
        url: banner.link
      });
    }
  },

  viewVolunteerRank(e: any) {
    const index = e.currentTarget.dataset.index;
    const volunteer = this.data.rankings[index];
    
    if (!volunteer || !this.data.userInfo) {
      return;
    }
    
    wx.navigateTo({
      url: '/pages/rankings/rankings'
    });
  },

  viewAllRankings() {
    if (!this.data.userInfo) {
      this.showLoginModal('查看排行榜');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/rankings/rankings'
    });
  },

  viewCasualWelfareDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    
    if (!this.data.userInfo) {
      this.showLoginModal('查看随手公益');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/quick-action/detail/detail?id=' + id
    });
  },

  goToQuickAction() {
    if (!this.data.userInfo) {
      this.showLoginModal('随手公益');
      return;
    }
    
    wx.switchTab({
      url: '/pages/quick-action/quick-action'
    });
  },

  goToPointsMall() {
    if (!this.data.userInfo) {
      this.showLoginModal('积分激励');
      return;
    }
    
    wx.switchTab({
      url: '/pages/mall/mall'
    });
  },

  goToMyActivities() {
    if (!this.data.userInfo) {
      this.showLoginModal('我的活动');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/activities/my/my'
    });
  },

  goToMyProfile() {
    if (!this.data.userInfo) {
      this.showLoginModal('我的志愿');
      return;
    }
    
    wx.switchTab({
      url: '/pages/mine/mine'
    });
  },

  goToActivityDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    
    if (!this.data.userInfo) {
      this.showLoginModal('查看活动详情');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id
    });
  },

  goToExchangeDetail(e: any) {
    const itemId = e.currentTarget.dataset.id;
    
    if (!this.data.userInfo) {
      this.showLoginModal('查看兑换物品');
      return;
    }
    
    wx.navigateTo({
      url: `/pages/points/detail/detail?id=${itemId}`
    });
  },

  exchangeItem(e: any) {
    e.stopPropagation();
    const itemId = e.currentTarget.dataset.id;
    const item = this.data.exchangeItems.find((item: any) => item.id == itemId);
    
    if (!item) return;
    
    if (!this.data.userInfo) {
      this.showLoginModal('兑换物品');
      return;
    }
    
    wx.showModal({
      title: '确认兑换',
      content: `确定要兑换【${item.name}】吗？\n需要消耗 ${item.points} 积分`,
      success: (res) => {
        if (res.confirm) {
          console.log('兑换物品:', itemId);
          
          wx.showLoading({ title: '兑换中...' });
          
          wx.request({
            url: 'https://api.jhzyfw.com/api/mall/exchange.php',
            method: 'POST',
            header: {
              'Authorization': 'Bearer ' + wx.getStorageSync('access_token')
            },
            data: {
              product_id: itemId
            },
            success: (exchangeRes: any) => {
              wx.hideLoading();
              if (exchangeRes.data.code === 0) {
                wx.showToast({
                  title: '兑换成功',
                  icon: 'success',
                  duration: 2000
                });
                this.refreshData();
              } else {
                wx.showToast({
                  title: exchangeRes.data.message || '兑换失败',
                  icon: 'error',
                  duration: 2000
                });
              }
            },
            fail: () => {
              wx.hideLoading();
              wx.showToast({
                title: '网络错误',
                icon: 'error',
                duration: 2000
              });
            }
          });
        }
      }
    });
  },

  goToAllActivities() {
    if (!this.data.userInfo) {
      this.showLoginModal('查看活动');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/activities/activities'
    });
  },

  showLoginModal(action: string) {
    wx.showModal({
      title: '需要登录',
      content: action + '需要先登录',
      confirmText: '去登录',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({
            url: '/pages/login/index'
          });
        }
      }
    });
  },

  goToLogin() {
    this.showLoginModal('使用该功能');
  },

  // 查看用户协议
  viewUserProtocol() {
    wx.navigateTo({
      url: '/pages/settings/terms/terms'
    });
  },

  // 查看隐私政策
  viewPrivacyPolicy() {
    wx.navigateTo({
      url: '/pages/privacy/privacy'
    });
  }
});