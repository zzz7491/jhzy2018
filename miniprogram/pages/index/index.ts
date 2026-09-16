// pages/index/index.ts - 重构版（集成随手公益 + 排行榜）
const app = getApp();
import { TAB_INDEX, syncTabSelected, refreshServiceActive } from '../../utils/tabbar';
// P0-B：复用既有 G1 client（GET /attendance-sessions/me）与 V2 会话门禁，绝不另写第二套 G1 client。
import activityApi, { hasV2Session } from '../../utils/activityApi';

Page({
  data: {
    // 协议弹窗
    showProtocolModal: false,
    
    // 用户信息
    userInfo: null as any,
    isLoggedIn: false,
    
    // 显示模式
    isSeniorMode: false,
    
    // 多团队身份展示槽（仅读已存在 storage.activeTeamName，不新增接口）
    teamName: '',
    teamInitial: '',
    
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
    
    // 热点活动（公开活动 discovery：数据源已迁移至 V2 canonical GET /api/v2/activities，见 loadHotActivities）
    hotActivities: [] as any[],
    hotActivitiesLoading: false,
    
    // 随手公益数据（仅保留「已审核」列表用于「公益故事」；stats 字段无 WXML 消费者，已移除避免冗余 V1 请求）
    approvedCasualWelfare: [] as any[],
    casualWelfareLoading: false,
    
    // 加载状态
    loading: true,
    refreshing: false,

    // P0-B：今日志愿服务智能状态卡（权威 G1 状态，首页最高优先级功能卡）
    // 冻结最小状态机：GUEST / LOADING / NO_ACTIVE / ACTIVE / ERROR
    // - 默认 LOADING 仅用于避免首屏误现 NO_ACTIVE 假状态（登录用户会在 onShow 立即刷新 G1）。
    // - Guest 不走 G1、不触发登录，由 loadServiceState 直接置 GUEST。
    serviceState: 'LOADING' as 'GUEST' | 'LOADING' | 'NO_ACTIVE' | 'ACTIVE' | 'ERROR',
    serviceActivityName: '',
    serviceCheckinText: '',
    serviceActivityPublicId: ''
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
    // P0-A：同步自定义 tabBar 选中态（0=首页）；不存在 custom tabBar 时静默跳过
    syncTabSelected(this, TAB_INDEX.HOME);
    // 每次显示都同步storage中的登录状态
    this.syncLoginStatus();
    // P1-A: 同步多团队身份（仅读已存在 storage，不新增接口）
    this.loadTeamIdentity();
    // P0-B：登录用户每次 onShow 拉取权威 G1 状态（无 timer / 无 polling / 无长期缓存）；
    // Guest 不请求、不强制登录，直接 GUEST。
    this.loadServiceState();
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
    
    console.log('syncLoginStatus:', { isValidLogin, hasUserInfo: !!userInfo, hasToken: !!token, isLoggedIn });
    
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
      this.loadHotActivities(),
      // 登录用户：仅拉取已审核随手公益列表（approvedCasualWelfare → 公益故事）；stats 已移除
      this.loadCasualWelfareData()
    ]).catch((error: any) => {
      console.error('加载数据失败:', error);
      return this.loadPublicData();
    }).then(() => {
      this.setData({ loading: false });
    });
  },

  loadPublicData(): Promise<void> {
    // 游客：仅拉取 V2 公开活动列表（公开活动 discovery）；不请求任何 V1/PHP 端点
    return Promise.all([
      this.loadHotActivities()
    ]).catch((error: any) => {
      console.error('加载公开数据失败:', error);
    }).then(() => {
      this.setData({ loading: false });
    });
  },

  // [P0-C] 主轮播图（mainBanners）已从首页移除：原 V1/PHP 轮播与静态 banner 图无 WXML 消费者，
  // 相关 wx.request 已删除；公开活动 discovery 改由 loadHotActivities（V2）承担。


  /**
   * 公开活动 discovery（P0-C）：数据源迁移至 V2 canonical API（GET /api/v2/activities）。
   * 复用既有 activityApi.getActivities（统一 V2 client，绝不调用 legacy PHP 端点）。
   * G2 后端按 auth 自动分支：Guest → listPublicVisible（publication predicate 收口）；
   * Authenticated → 团队作用域可见活动。前端只消费 G2 公开投影字段，不伪造封面/积分/报名态。
   */
  loadHotActivities(): Promise<void> {
    this.setData({ hotActivitiesLoading: true });
    return activityApi
      .getActivities(1, 6)
      .then((res: any) => {
        const items: any[] = (res && res.items) || [];
        const hotActivities = items.map((a: any) => ({
          id: a.public_id, // 导航至详情页用 public_id（详情页 getActivity 按 ULID 取公开活动）
          title: a.title || '',
          // coverImage：G2 公开投影不含封面，留空 → WXML 显示高质量占位（UI fallback，非伪造封面）
          time: this.formatActivityTime(a.start_time) + '-' + this.formatActivityTime(a.end_time),
          location: a.address || '待定', // G2 字段为 address（非 V1 location）
          // points：G2 公开合同不含 points_reward，不伪造 → WXML 按 item.points 条件隐藏
          status: this.activityLifecycleToken(a.status), // 'open' | 'ongoing' | 'ended'（生命周期，非报名态）
          statusText: this.activityLifecycleText(a.status)
        }));
        this.setData({ hotActivities: hotActivities });
      })
      .catch((error: any) => {
        console.error('加载公开活动失败:', error);
        this.setData({ hotActivities: [] });
      })
      .then(() => {
        this.setData({ hotActivitiesLoading: false });
      });
  },

  /**
   * 加载志愿者排行榜 - 修复头像显示问题
   */

  // loadUserStats 已移除，积分由 syncLoginStatus 设置


  /**
   * 随手公益「已审核」列表（公益故事区块）：保留 V1/PHP quick_actions.php(list) 调用，
   * 因其对应可见的「公益故事」UI 且无 V2 canonical 等价能力（DEFERRED_V2_GAP，不伪造 backend）。
   * 原先的 stats V1 请求已移除（对应的 casualWelfareStats 字段无 WXML 消费者）。
   */
  loadCasualWelfareData(): Promise<void> {
    if (!this.data.userInfo) {
      return Promise.resolve();
    }
    this.setData({ casualWelfareLoading: true });
    return this.loadApprovedCasualWelfare()
      .catch((err: any) => {
        console.error('加载随手公益失败:', err);
        this.setData({ approvedCasualWelfare: [] });
      })
      .then(() => {
        this.setData({ casualWelfareLoading: false });
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

  /**
   * 活动生命周期 token（P0-C）：仅映射 G2 公开投影的 status 枚举（1 SIGNUP_OPEN / 2 IN_PROGRESS / 3 ENDED / 4 CANCELLED）。
   * 这是真实可展示生命周期，绝非报名态（is_signed / signup_status 等 V1 字段 G2 不返回，亦不伪造）。
   */
  activityLifecycleToken(status: number): 'open' | 'ongoing' | 'ended' {
    if (status === 1) return 'open';
    if (status === 2) return 'ongoing';
    return 'ended'; // 3 ENDED / 4 CANCELLED 均在公开谓词内，统一展示为「已结束」
  },

  activityLifecycleText(status: number): string {
    if (status === 1) return '招募中';
    if (status === 2) return '进行中';
    return '已结束'; // 3 ENDED / 4 CANCELLED
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

  onMainSwiperTap(e: any) {
    const index = e.currentTarget.dataset.index;
    const banner = (this.data as any).mainBanners?.[index];
    
    if (!banner) return;
    
    wx.vibrateShort();
    
    if (banner.type === 'activity' && banner.id) {
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
    const volunteer = (this.data as any).rankings?.[index];
    
    if (!volunteer) {
      return;
    }
    
    wx.navigateTo({
      url: '/pages/rankings/rankings'
    });
  },

  viewAllRankings() {
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
    
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id
    });
  },



  goToAllActivities() {
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
            url: '/pages/login-unified/index'
          });
        }
      }
    });
  },

  goToCommunityFeed() {
    if (!this.data.userInfo) {
      this.showLoginModal('公益社区');
      return;
    }
    wx.navigateTo({
      url: '/pages/community/index/index'
    });
  },
  goToAi() {
    if (!this.data.userInfo) {
      this.showLoginModal('嘉禾 AI');
      return;
    }
    wx.navigateTo({
      url: '/pages/ai/index'
    });
  },

  // P1-A: 多团队身份（仅读 storage.activeTeamName，不新增接口、不硬编码团队名）
  loadTeamIdentity() {
    const name = wx.getStorageSync('activeTeamName') || '';
    this.setData({
      teamName: name,
      teamInitial: name ? name.charAt(0) : '嘉'
    });
  },

  // P0-B：今日志愿服务智能状态卡 —— 唯一真值 = GET /attendance-sessions/me（G1 authoritative）。
  // 纪律：
  // - Guest（无有效 V2 会话）【不发起任何请求】，直接 GUEST，不触发登录。
  // - 登录用户：先 LOADING（避免闪烁为 NO_ACTIVE），再请求权威态。
  // - ERROR 不得降级为 NO_ACTIVE；ACTIVE 不得因活动名读取失败而降级/伪造。
  // - 活动真实名称：best-effort 经 activityApi.getActivity(activity_public_id) 读取；失败留空（不伪造）。
  // - 同步 custom-tab-bar 中心按钮由 refreshServiceActive 内部 applyServiceActive 完成（不建第二套 store）。
  async loadServiceState(): Promise<void> {
    if (!hasV2Session()) {
      this.setData({ serviceState: 'GUEST', serviceActivityPublicId: '' });
      return;
    }

    this.setData({ serviceState: 'LOADING' });

    try {
      const state = await refreshServiceActive(this);

      if (state.kind === 'ACTIVE') {
        let name = '';
        try {
          const res = await activityApi.getActivity(state.activityPublicId);
          name = res && res.activity && res.activity.title ? res.activity.title : '';
        } catch (e) {
          // 读取失败：保持 ACTIVE，不得降级、不得伪造活动名。
          name = '';
        }
        this.setData({
          serviceState: 'ACTIVE',
          serviceActivityPublicId: state.activityPublicId,
          serviceActivityName: name,
          serviceCheckinText: state.checkinAt ? this.formatCheckinTime(state.checkinAt) : ''
        });
      } else if (state.kind === 'NO_ACTIVE') {
        this.setData({ serviceState: 'NO_ACTIVE', serviceActivityPublicId: '', serviceActivityName: '', serviceCheckinText: '' });
      } else if (state.kind === 'ERROR') {
        this.setData({ serviceState: 'ERROR' });
      } else {
        // GUEST（理论上 hasV2Session 已拦截，保险分支）
        this.setData({ serviceState: 'GUEST', serviceActivityPublicId: '' });
      }
    } catch (e) {
      this.setData({ serviceState: 'ERROR' });
    }
  },

  // 状态卡主按钮统一入口（按当前状态分流，复用既有合法页面入口）。
  onServicePrimary() {
    const s = this.data.serviceState;
    if (s === 'GUEST') {
      // 走现有合法登录入口（统一登录页），不绕过身份验证。
      wx.navigateTo({ url: '/pages/login-unified/index' });
    } else if (s === 'NO_ACTIVE') {
      // G2 未完成前首页无 authoritative eligible/checkin-ready activity，只引导发现活动。
      wx.switchTab({ url: '/pages/activities/activities' });
    } else if (s === 'ACTIVE') {
      // 复用 G1 已闭环 execution page（mode=active），首页只负责导航，不在首页调用 checkout API。
      const pid = this.data.serviceActivityPublicId;
      if (!pid) return;
      wx.navigateTo({ url: `/pages/sign/activity/index?activityId=${pid}&mode=active` });
    } else if (s === 'ERROR') {
      this.loadServiceState();
    }
    // LOADING：忽略点击，避免误触。
  },

  formatCheckinTime(ts: number): string {
    if (!ts) return '';
    let ms = Number(ts);
    if (!isNaN(ms) && ms > 0 && ms < 1e12) ms = ms * 1000; // 秒 → 毫秒
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => (n < 10 ? '0' + n : String(n));
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // P0-A: 核心行动 + 中心导航（全部指向真实已存在页面，由目标页自身执行登录/团队门禁）
  goToSign() {
    // 签到/签退已是 tabBar 页，navigateTo 不可跳转 tabBar 页，必须用 switchTab
    wx.switchTab({ url: '/pages/sign/sign' });
  },

  goToTrainings() {
    wx.navigateTo({ url: '/pages/trainings/trainings' });
  },

  goToTeams() {
    wx.navigateTo({ url: '/pages/teams/teams' });
  },

  goToGrowth() {
    wx.navigateTo({ url: '/pages/certificates/certificates' });
  },

  goToCollaboration() {
    wx.navigateTo({ url: '/pages/quick-action/quick-action' });
  },

  goToCommunity() {
    wx.navigateTo({ url: '/pages/community/index/index' });
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