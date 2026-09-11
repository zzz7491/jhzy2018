const app = getApp();
import checkinService from '../../services/checkinService';
import activityApi from '../../utils/activityApi';
import phoneApi from '../../utils/phoneApi';
import qualificationApi, { VolunteerQualification } from '../../utils/qualificationApi';

Page({
  data: {
    userInfo: null,
    isLoggedIn: false,
    isSeniorMode: false,
    loading: true,
    refreshing: false,
    membershipDuration: '',
    userIdentity: '',
    dashboardModules: [], // 动态功能卡片数据
    unreadCount: 0, // 未读消息数量
    
    // 统计数据
    stats: {
      currentPoints: 0,
      totalActivities: 0,
      totalHours: 0
    },
    
    // 头像上传相关
    isUploadingAvatar: false,
    previewAvatar: '',
    avatarError: '',
    
    // 进行中的签到（只保留状态，不显示操作）
    activeAttendance: null,

    // 微信可信手机号绑定状态（P0-B；wechatPhoneMask 非空=已绑定脱敏号码；
    // wechatPhoneBound: null=未知/未查询, true=已绑定, false=权威未绑定）
    wechatPhoneMask: '',
    wechatPhoneBound: null as boolean | null,

    // 志愿者资格状态（P0-C；仅消费后端投影，null=未加载/失败，前端绝不自算）
    volunteerQualification: null as VolunteerQualification | null
  },

  pollingTimer: null, // 轮询定时器

  onLoad() {
    console.log('我的页面加载');
    this.initPage();
  },

  onShow() {
    console.log('我的页面显示');
    // 强制修正头像URL
    const userInfo = this.data.userInfo;
    if (userInfo && userInfo.avatar && typeof userInfo.avatar === 'string' && !userInfo.avatar.startsWith('http')) {
      let avatar = userInfo.avatar;
      if (avatar.startsWith('/')) {
        avatar = 'https://api.jhzyfw.com/api' + avatar;
      } else {
        avatar = 'https://api.jhzyfw.com/api/' + avatar;
      }
      this.setData({ 'userInfo.avatar': avatar });
      // 同时更新缓存
      const cachedInfo = wx.getStorageSync('userInfo');
      if (cachedInfo) {
        cachedInfo.avatar = avatar;
        wx.setStorageSync('userInfo', cachedInfo);
      }
    }
    this.refreshData();
    // 开始轮询未读消息
    this.startUnreadPolling();
    // 更新tabBar红点
    this.updateTabBarBadge();
  },

  onHide() {
    // 停止轮询
    this.stopUnreadPolling();
  },

  onUnload() {
    // 页面卸载时停止定时器
    checkinService.stopLocationTimer();
    this.stopUnreadPolling();
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 更新tabBar红点
  updateTabBarBadge() {
    const unreadCount = this.data.unreadCount;
    if (unreadCount > 0) {
      wx.setTabBarBadge({
        index: 3,
        text: unreadCount > 99 ? '99+' : String(unreadCount)
      });
    } else {
      wx.removeTabBarBadge({
        index: 3
      });
    }
  },

  // 初始化页面
  async initPage() {
    this.initDisplayMode();
    await this.checkLoginStatus();
    if (this.data.isLoggedIn) {
      await this.getCurrentLocation();
      await this.loadUserData();
      await this.loadDashboardModules();
      this.loadUnreadCount();
      this.loadVolunteerQualification();
      this.loadWechatPhoneStatus();
      this.calculateMembershipDuration();
    }
    this.setData({ loading: false });
  },

  // 加载未读消息数量
  loadUnreadCount() {
    console.log('loadUnreadCount 开始执行');
    if (!this.data.isLoggedIn) {
      console.log('未登录');
      return;
    }
    const userId = this.data.userInfo?.id;
    if (!userId) {
      console.log('无userId');
      return;
    }
    const that = this;
    wx.request({
      url: 'https://api.jhzyfw.com/api/get_unread_count.php',
      data: { user_id: userId },
      success: (res) => {
        console.log('请求成功', res.data);
        if (res.data && res.data.success) {
          const unreadCount = res.data.unread_count || 0;
          that.setData({ unreadCount });
          that.updateTabBarBadge();
        }
      },
      fail: (err) => {
        console.log('请求失败', err);
      }
    });
  },

  // 开始轮询未读消息
  startUnreadPolling() {
    this.stopUnreadPolling();
    this.pollingTimer = setInterval(() => {
      this.loadUnreadCount();
    }, 30000); // 30秒轮询一次
  },

  // 停止轮询
  stopUnreadPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  },

  // 前往消息页面
  goToMessage() {
    wx.navigateTo({ url: '/pages/message/message' });
  },

  // 前往订阅设置页面
  goToSubscribe() {
    wx.navigateTo({ url: '/pages/subscribe/subscribe' });
  },

  // P0-B：前往微信可信手机号绑定页
  goToPhoneBind() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    wx.navigateTo({ url: '/pages/phone-bind/phone-bind' });
  },

  // P0-C：加载志愿者资格状态（仅消费后端投影，不自算）。
  loadVolunteerQualification() {
    try {
      const token = wx.getStorageSync('v2_access_token');
      const expire = Number(wx.getStorageSync('v2_token_expire') || 0);
      if (!token || expire < Date.now() + 30000) return; // 无有效 V2 会话则不强求
      qualificationApi
        .getStatus()
        .then((q) => {
          this.setData({ volunteerQualification: q });
        })
        .catch(() => { /* 忽略：资格状态读取失败不影响其它功能 */ });
    } catch (e) { /* 忽略 */ }
  },

  // P0-B：刷新微信可信手机号绑定状态（仅在已有有效 V2 会话时；不强制 wx.login）。
  // 无会话/读取失败一律保持「未知」，绝不把失败当作权威「未绑定」。
  loadWechatPhoneStatus() {
    try {
      const token = wx.getStorageSync('v2_access_token');
      const expire = Number(wx.getStorageSync('v2_token_expire') || 0);
      if (!token || expire < Date.now() + 30000) return; // 无有效 V2 会话 → 保持未知
      phoneApi
        .getStatus()
        .then((st) => {
          this.setData({
            wechatPhoneBound: !!st.bound,
            wechatPhoneMask: st.bound && st.phone_mask ? st.phone_mask : '',
          });
        })
        .catch(() => {
          /* 忽略：读取失败不改变既有状态（不把失败当已绑定/未绑定） */
        });
    } catch (e) {
      /* 忽略 */
    }
  },

  // 加载动态功能卡片
  async loadDashboardModules() {
    try {
      const token = wx.getStorageSync('access_token') || wx.getStorageSync('token');
      if (!token) {
        console.log('没有token，不加载动态卡片');
        return;
      }
      
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://api.jhzyfw.com/api/user_dashboard.php?token=' + token,
          method: 'GET',
          success: (res) => resolve(res.data),
          fail: reject
        });
      });
      
      console.log('动态卡片数据:', res);
      
      if (res && res.code === 0 && res.data && res.data.modules) {
        const modules = res.data.modules.sort((a, b) => (a.sort || 0) - (b.sort || 0));
        this.setData({ dashboardModules: modules });
      }
    } catch (error) {
      console.error('加载动态卡片失败:', error);
    }
  },

  // 动态卡片点击跳转
  goToDynamicPage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    
    const tabBarPages = [
      '/pages/quick-action/quick-action',
      '/pages/index/index',
      '/pages/activities/activities',
      '/pages/mall/mall',
      '/pages/mine/mine'
    ];
    
    if (tabBarPages.includes(url)) {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },

  // 计算会员时长
  calculateMembershipDuration() {
    const userInfo = this.data.userInfo;
    if (!userInfo || !userInfo.create_time) return;
    
    try {
      const dateStr = userInfo.create_time.replace(' ', 'T');
      const createDate = new Date(dateStr);
      const now = new Date();
      const diffMonths = (now.getFullYear() - createDate.getFullYear()) * 12 +  
                        (now.getMonth() - createDate.getMonth());
      
      if (diffMonths < 1) {
        const diffDays = Math.floor((now.getTime() - createDate.getTime()) / (1000 * 60 * 60 * 24));
        this.setData({ membershipDuration: `已加入${diffDays}天` });
      } else if (diffMonths < 12) {
       this.setData({ membershipDuration: `已加入${diffMonths}个月` });
      } else {
        const years = Math.floor(diffMonths / 12);
        this.setData({ membershipDuration: `已加入${years}年` });
      }
    } catch (error) {
      console.error('计算会员时长失败:', error);
    }
  },

  // 上传头像
  async uploadAvatar() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    
    if (this.data.isUploadingAvatar) {
      return;
    }
    
    try {
      console.log('开始上传头像...');
      this.setData({ 
        isUploadingAvatar: true, 
        avatarError: '',
        previewAvatar: ''
      });
      
      const res = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: (err) => {
            if (err.errMsg && err.errMsg.includes('cancel')) {
              reject(new Error('已取消选择'));
            } else {
              reject(new Error('选择图片失败: ' + (err.errMsg || '未知错误')));
            }
          }
        });
      });
      
      if (!res.tempFilePaths || !res.tempFilePaths[0]) {
        throw new Error('未选择图片');
      }
      
      const tempFilePath = res.tempFilePaths[0];
      this.setData({ previewAvatar: tempFilePath });
      
      const confirmRes = await new Promise((resolve, reject) => {
        wx.showModal({
          title: '上传头像',
          content: '确认使用这张图片作为头像吗？',
          success: resolve,
          fail: reject
        });
      });
      
      if (!confirmRes.confirm) {
        this.setData({ isUploadingAvatar: false, previewAvatar: '' });
        return;
      }
      
      wx.showLoading({ title: '上传中...', mask: true });
      
      const userInfo = this.data.userInfo;
      const token = wx.getStorageSync('access_token');
      
      if (!token) {
        throw new Error('登录信息失效，请重新登录');
      }
      
      const uploadRes = await new Promise((resolve, reject) => {
        wx.uploadFile({
          url: 'https://api.jhzyfw.com/api/upload_avatar.php',
          filePath: tempFilePath,
          name: 'avatar',
          formData: {
            user_id: userInfo.id,
            token: token
          },
          header: { 'Authorization': `Bearer ${token}` },
          success: (res) => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(res.data));
              } catch (e) {
                reject(new Error('服务器响应格式错误'));
              }
            } else {
              reject(new Error(`上传失败，服务器响应: ${res.statusCode}`));
            }
          },
          fail: (err) => {
            reject(new Error(`上传失败: ${err.errMsg || '网络错误'}`));
          }
        });
      });
      
      wx.hideLoading();
      
      if (uploadRes && uploadRes.code === 0 && uploadRes.data) {
        const avatarData = uploadRes.data;
        // 修正头像URL
        let newAvatar = avatarData.full_url || avatarData.avatar_url || '';
        if (newAvatar && !newAvatar.startsWith('http')) {
          if (newAvatar.startsWith('/')) {
            newAvatar = 'https://api.jhzyfw.com/api' + newAvatar;
          } else {
            newAvatar = 'https://api.jhzyfw.com/api/' + newAvatar;
          }
        }
        const updatedUserInfo = {
          ...userInfo,
          avatar: newAvatar
        };
        
        this.setData({ userInfo: updatedUserInfo, previewAvatar: '', avatarError: '' });
        wx.setStorageSync('userInfo', updatedUserInfo);
        
        wx.showToast({ title: '头像上传成功', icon: 'success', duration: 2000 });
      } else {
        throw new Error(uploadRes?.msg || '上传失败');
      }
      
    } catch (error) {
      console.error('上传头像错误:', error);
      wx.hideLoading();
      
      let errorMsg = error.message || '上传失败';
      this.setData({ avatarError: errorMsg, previewAvatar: '' });
      wx.showToast({ title: errorMsg, icon: 'none', duration: 3000 });
      
    } finally {
      this.setData({ isUploadingAvatar: false });
    }
  },

  // 刷新数据
  async refreshData() {
    this.setData({ refreshing: true });
    await this.checkLoginStatus();
    if (this.data.isLoggedIn) {
      await this.getCurrentLocation();
      await this.loadUserData();
      await this.loadDashboardModules();
      this.loadUnreadCount();
      this.loadVolunteerQualification();
      this.loadWechatPhoneStatus();
    }
    this.setData({ refreshing: false });
  },

  // 获取当前位置
  async getCurrentLocation(forceRefresh = false) {
    try {
      const location = await checkinService.getCurrentLocation();
      this.setData({ currentLocation: location });
      return true;
    } catch (error) {
      console.warn('获取位置失败:', error);
      return false;
    }
  },

  // 初始化显示模式
  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    this.setData({ isSeniorMode: displayMode === 'senior' });
  },

  // 检查登录状态
  async checkLoginStatus() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const token = wx.getStorageSync('access_token');
      const isLoggedIn = wx.getStorageSync('isLoggedIn');
      
      // 验证 token 是否过期
      let tokenValid = true;
      if (token) {
        const tokenExpire = wx.getStorageSync('token_expire');
        if (tokenExpire && tokenExpire < Date.now()) {
          console.log('token已过期');
          tokenValid = false;
        }
      }
      
      const isValidLogin = isLoggedIn === true && token && tokenValid && userInfo && (userInfo.id || userInfo.user_id);
      
      if (isValidLogin) {
        // 确保 userInfo 中有 id
        if (!userInfo.id && userInfo.user_id) {
          userInfo.id = userInfo.user_id;
        }
        
        // 修正头像URL - 添加类型检查
        if (userInfo.avatar && typeof userInfo.avatar === 'string' && !userInfo.avatar.startsWith('http')) {
          if (userInfo.avatar.startsWith('/')) {   
            userInfo.avatar = 'https://api.jhzyfw.com/api' + userInfo.avatar;
          } else {
            userInfo.avatar = 'https://api.jhzyfw.com/api/' + userInfo.avatar;
          }
        }

        this.setData({
          userInfo: userInfo,
          isLoggedIn: true,
          stats: {
            currentPoints: userInfo.total_points || 0,
            totalActivities: userInfo.activity_count || 0,
            totalHours: userInfo.service_hours || 0
          }
        });

        return true;
      } else {
        // 清除无效缓存
        wx.removeStorageSync('userInfo');
        wx.removeStorageSync('isLoggedIn');
        
        this.setData({
          userInfo: null,
          isLoggedIn: false,
          stats: { currentPoints: 0, totalActivities: 0, totalHours: 0 }
        });
        return false;
      }
    } catch (error) {
      console.error('检查登录状态失败:', error);
      return false;
    }
  },

  // 加载成长数据（v2：积分账户 + 本人服务记录）
  async loadUserData() {
    try {
      const [acct, recs] = await Promise.all([
        activityApi.getPointsAccount(),
        activityApi.getServiceRecordsMine(),
      ]);

      const records = (recs && recs.records) || [];
      const totalMinutes = records.reduce(
        (sum: number, r: any) => sum + Number(r.effective_minutes || r.minutes || 0),
        0,
      );
      const totalHours = Math.round((totalMinutes / 60) * 10) / 10;

      this.setData({
        stats: {
          currentPoints: (acct && acct.balance_units) || 0,
          totalActivities: records.length,
          totalHours,
        },
      });

      this.calculateMembershipDuration();
    } catch (error) {
      console.error('加载成长数据失败:', error);
    }
  },

  // 切换显示模式
  toggleDisplayMode() {
    const currentMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = currentMode === 'normal' ? 'senior' : 'normal';
    wx.setStorageSync('displayMode', newMode);
    this.setData({ isSeniorMode: newMode === 'senior' });
    
    wx.vibrateShort();
    wx.showToast({
      title: `已切换到${newMode === 'senior' ? '大字版' : '普通版'}`,
      icon: 'success'
    });
  },

  // 【核心修改1】：修正前往登录的跳转方式和真实路径，确保不假死
  goToLogin() {
    console.log('准备跳转到登录页...');
    // 使用从 app.json 中查找到的真实统一登录页路径
    wx.reLaunch({ 
      url: '/pages/login-unified/index', 
      fail: (err) => {
        console.warn('跳转统一登录页失败，尝试另一个真实路径...', err);
        wx.reLaunch({ 
          url: '/pages/login/index', // app.json 中的第二个备用登录页
          fail: (err2) => {
            console.error('彻底跳转失败！', err2);
          }
        });
      }
    });
  },

  // 前往积分中心
  goToPointsCenter() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    wx.navigateTo({ url: '/pages/points/points' });
  },

  // 前往积分兑换（导航整合：原独立「积分」tab 并入个人中心）
  goToPointsExchange() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    wx.navigateTo({ url: '/pages/mall/mall' });
  },

  // 查看等级记录
  goToLevelRecords() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    const userInfo = this.data.userInfo;
    wx.showModal({
      title: '我的等级',
      content: `当前积分：${userInfo.current_points || 0}分`,
      showCancel: false
    });
  },

  // 前往个人中心
  goToProfileEdit() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    wx.navigateTo({ url: '/pages/profile/edit/edit' });
  },

  // 前往帮助中心
  goToHelpCenter() {
    wx.navigateTo({ url: '/pages/help/help' });
  },

  // 前往意见反馈
  goToFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' });
  },

  // 查看签到历史
  goToAttendanceHistory() {
    if (!this.data.isLoggedIn) {
      this.showLoginModal();
      return;
    }
    wx.navigateTo({ url: '/pages/attendance/history/history' });
  },

  // 【核心修改2】：退出登录时，彻底清空全局变量，并自动跳回登录页
  handleLogout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          checkinService.stopLocationTimer();
          
          // 清除所有缓存，最稳妥
          wx.clearStorageSync(); 
          
          // 彻底重置全局状态
          if (app.globalData) {
            app.globalData.isLoggedIn = false;
            app.globalData.userInfo = null;
          }
          
          this.setData({
            isLoggedIn: false,
            userInfo: null,
            stats: { currentPoints: 0, totalActivities: 0, totalHours: 0 },
            activeAttendance: null,
            dashboardModules: []
          });
          
          wx.showToast({ title: '退出成功', icon: 'success' });

          // 退出后自动跳回登录页
          setTimeout(() => {
            this.goToLogin();
          }, 1000);
        }
      }
    });
  },

  // 显示登录模态框
  showLoginModal() {
    wx.showModal({
      title: '需要登录',
      content: '此功能需要先登录志愿者账号',
      confirmText: '去登录',
      success: (res) => {
        if (res.confirm) {
          this.goToLogin();
        }
      }
    });
  }
});