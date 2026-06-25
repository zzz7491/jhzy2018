// app.js
App({
  onLaunch() {
    console.log('小程序启动 - 嘉禾志愿');
    
    // ========== 强制版本更新 ==========
    const updateManager = wx.getUpdateManager();
    updateManager.onCheckForUpdate(function(res) {
      console.log('检查更新结果:', res.hasUpdate);
      if (res.hasUpdate) {
        updateManager.onUpdateReady(function() {
          wx.showModal({
            title: '更新提示',
            content: '新版本已准备好，是否重启应用？',
            success: function(res) {
              if (res.confirm) {
                updateManager.applyUpdate();
              }
            }
          });
        });
        updateManager.onUpdateFailed(function() {
          wx.showModal({
            title: '更新失败',
            content: '新版本下载失败，请删除小程序后重新搜索进入',
            showCancel: false
          });
        });
      }
    });
    
    wx.$baseUrl = this.globalData.apiBaseUrl;
    
    // 屏蔽图片404错误
    const originalConsoleError = console.error;
    console.error = function(...args) {
      const errorStr = JSON.stringify(args);
      if (errorStr && (
          errorStr.indexOf('Failed to load image') > -1 ||
          errorStr.indexOf('渲染层网络层错误') > -1 ||
          errorStr.indexOf('404') > -1
        )) {
        return;
      }
      originalConsoleError.apply(console, args);
    };
    
    // 检查协议同意状态
    this.checkProtocolStatus();
    
    // 获取系统信息
    this.getSystemInfo();
    
    // 检查并恢复登录状态
    this.checkLoginStatus();
  },

  // 页面不存在时的处理（修复分享链接错误）
  onPageNotFound(res) {
    console.log('页面不存在:', res.path, res.query);
    
    // 修复活动详情页路径错误
    let newPath = res.path;
    if (res.path === 'pages/activity/detail/detail') {
      newPath = 'pages/detail/detail';
    }
    
    // 修复商品详情页路径错误
    if (res.path === 'pages/goods-detail/detail' || res.path === 'pages/goods-detail/goods-detail') {
      newPath = 'pages/goods-detail/goods-detail';
    }
    
    // 修复证书详情页路径错误
    if (res.path === 'pages/certificates/detail/detail') {
      newPath = 'pages/certificates/detail/detail';
    }
    
    // 构建查询参数字符串
    let queryString = '';
    if (res.query) {
      queryString = Object.keys(res.query).map(key => key + '=' + encodeURIComponent(res.query[key])).join('&');
    }
    
    // 跳转到正确路径
    wx.redirectTo({
      url: '/' + newPath + (queryString ? '?' + queryString : ''),
      fail: () => {
        console.error('重定向失败，跳转首页');
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  },

  globalData: {
    colors: {
      elderly: '#FF9800',
      disabled: '#4CAF50',
      child: '#2196F3',
      parentChild: '#2196F3',
      publicWelfare: '#F44336'
    },
    apiBaseUrl: 'https://api.jhzyfw.com/api/',
    debugMode: false,
    userInfo: null,
    isLoggedIn: false,
    pendingApproval: false,
    systemInfo: {},
    displayMode: 'normal'
  },

  // 检查登录状态（增强版）
  checkLoginStatus() {
    console.log('检查登录状态');
    
    // 从缓存中恢复登录状态
    const token = wx.getStorageSync('access_token') || wx.getStorageSync('token');
    let userInfo = wx.getStorageSync('userInfo');
    let isLoggedIn = wx.getStorageSync('isLoggedIn');
    
    console.log('缓存中的登录状态:', { 
      hasToken: !!token, 
      hasUserInfo: !!userInfo, 
      isLoggedIn,
      userId: userInfo?.id
    });
    
    // 验证 token 是否过期
    let tokenValid = true;
    if (token) {
      const tokenExpire = wx.getStorageSync('token_expire');
      if (tokenExpire && tokenExpire < Date.now()) {
        console.log('token已过期');
        tokenValid = false;
      }
    }
    
    // 判断登录是否有效
    const isValidLogin = token && tokenValid && userInfo && (userInfo.id || userInfo.user_id) && isLoggedIn === true;
    
    if (isValidLogin) {
      // 确保 userInfo 中有 id 字段
      if (!userInfo.id && userInfo.user_id) {
        userInfo.id = userInfo.user_id;
      }
      if (!userInfo.id && userInfo.uid) {
        userInfo.id = userInfo.uid;
      }
      
      // 恢复登录状态
      this.globalData.userInfo = userInfo;
      this.globalData.isLoggedIn = true;
      
      // 重新存储确保数据完整
      wx.setStorageSync('userInfo', userInfo);
      
      console.log('已恢复登录状态:', userInfo);
    } else {
      console.log('未找到有效的登录状态，清除缓存');
      // 清除无效的登录缓存
      wx.removeStorageSync('userInfo');
      wx.removeStorageSync('isLoggedIn');
      wx.removeStorageSync('access_token');
      wx.removeStorageSync('token');
      wx.removeStorageSync('token_expire');
      
      this.globalData.userInfo = null;
      this.globalData.isLoggedIn = false;
    }
  },

  // 修改：只检查协议状态，不自动跳转
  checkProtocolStatus() {
    console.log('检查协议状态');
    
    // 检查是否已经同意过协议
    const hasAgreedProtocol = wx.getStorageSync('hasAgreedProtocol');
    const hasAgreedPrivacy = wx.getStorageSync('hasAgreedPrivacy');
    
    console.log('协议状态:', hasAgreedProtocol, hasAgreedPrivacy);
    
    // 如果未同意，在全局数据中标记，但不自动跳转
    if (!hasAgreedProtocol || !hasAgreedPrivacy) {
      this.globalData.needAgreeProtocol = true;
      console.log('需要同意协议，由首页处理显示');
    } else {
      this.globalData.needAgreeProtocol = false;
    }
  },

  // 新增：在首页调用的协议弹窗方法
  showProtocolModal(page) {
    if (!page) return;
    
    wx.showModal({
      title: '用户协议与隐私政策',
      content: '感谢您使用嘉禾志愿。在您使用我们的服务前，请仔细阅读并同意《用户协议》和《隐私政策》。',
      confirmText: '同意',
      cancelText: '拒绝',
      success: (res) => {
        if (res.confirm) {
          // 用户同意
          wx.setStorageSync('hasAgreedProtocol', true);
          wx.setStorageSync('hasAgreedPrivacy', true);
          this.globalData.needAgreeProtocol = false;
          wx.showToast({
            title: '感谢您的同意',
            icon: 'success'
          });
        } else {
          // 用户拒绝 - 退出小程序
          wx.showModal({
            title: '提示',
            content: '您拒绝了用户协议，无法继续使用小程序',
            showCancel: false,
            success: () => {
              wx.exitMiniProgram();
            }
          });
        }
      },
      fail: () => {
        // 弹窗失败时，给用户一个提示
        wx.showToast({
          title: '协议加载失败',
          icon: 'none'
        });
      }
    });
  },

  // 获取系统信息
  getSystemInfo() {
    try {
      const systemInfo = wx.getSystemInfoSync();
      this.globalData.systemInfo = systemInfo;
      console.log('系统信息:', systemInfo);
    } catch (e) {
      console.error('获取系统信息失败:', e);
    }
  },

  // 生产环境登录（志愿者）
  userLogin(phone, password, successCallback, failCallback) {
    const url = this.globalData.apiBaseUrl + 'login.php';
    wx.request({
      url: url,
      method: 'POST',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: `account=${encodeURIComponent(phone)}&password=${encodeURIComponent(password)}`,
      success: (res) => {
        if (res.data.code === 0) {
          console.log('登录返回 total_points:', res.data.data.user_info.total_points);
          const userInfo = {
            id: res.data.data.user_info.id,
            username: res.data.data.user_info.real_name,
            name: res.data.data.user_info.real_name,
            phone: res.data.data.user_info.phone,
            volunteer_id: res.data.data.user_info.volunteer_id,
            current_points: res.data.data.user_info.current_points || 0,
            total_points: res.data.data.user_info.total_points || 0,
            activity_count: res.data.data.user_info.activity_count || 0,
            service_hours: res.data.data.user_info.service_hours || 0
          };
          
          const token = res.data.data.user_info.token;
          
          wx.setStorageSync('access_token', token);
          wx.setStorageSync('token', token);
          wx.setStorageSync('userInfo', userInfo);
          wx.setStorageSync('isLoggedIn', true);
          
          // 设置 token 过期时间（7天后）
          const expireTime = Date.now() + 7 * 24 * 60 * 60 * 1000;
          wx.setStorageSync('token_expire', expireTime);
          
          // 更新globalData
          this.globalData.userInfo = userInfo;
          this.globalData.isLoggedIn = true;
          
          successCallback && successCallback(res.data);
        } else {
          failCallback && failCallback(res.data);
        }
      },
      fail: (err) => {
        failCallback && failCallback(err);
      }
    });
  },

  // 生产环境管理员登录
  adminLogin(username, password, successCallback, failCallback) {
    const url = this.globalData.apiBaseUrl + 'admin_login.php';
    wx.request({
      url: url,
      method: 'POST',
      data: { username: username, password: password },
      success: (res) => {
        if (res.data.status === 'success') {
          const adminInfo = {
            id: res.data.data.admin.id,
            name: res.data.data.admin.name,
            role: res.data.data.admin.role,
            email: res.data.data.admin.email
          };
          
          wx.setStorageSync('access_token', res.data.data.token);
          wx.setStorageSync('token', res.data.data.token);
          wx.setStorageSync('adminInfo', adminInfo);
          wx.setStorageSync('userInfo', adminInfo);
          wx.setStorageSync('isLoggedIn', true);
          
          // 设置 token 过期时间（30天后）
          const expireTime = Date.now() + 30 * 24 * 60 * 60 * 1000;
          wx.setStorageSync('token_expire', expireTime);
          
          // 更新globalData
          this.globalData.userInfo = adminInfo;
          this.globalData.isLoggedIn = true;
          
          successCallback && successCallback(res.data);
        } else {
          failCallback && failCallback(res.data);
        }
      },
      fail: (err) => {
        failCallback && failCallback(err);
      }
    });
  },

  // 设置显示模式
  setDisplayMode(mode) {
    if (mode === 'senior' || mode === 'normal') {
      this.globalData.displayMode = mode;
      wx.setStorageSync('displayMode', mode);
      
      // 通知所有页面更新模式
      const pages = getCurrentPages();
      pages.forEach(page => {
        if (page.onDisplayModeChange) {
          page.onDisplayModeChange(mode);
        }
      });
    }
  },

  // 用户退出登录
  logout() {
    this.globalData.userInfo = null;
    this.globalData.isLoggedIn = false;
    this.globalData.pendingApproval = false;
    
    // 清除存储
    wx.removeStorageSync('userInfo');
    wx.removeStorageSync('isLoggedIn');
    wx.removeStorageSync('access_token');
    wx.removeStorageSync('token');
    wx.removeStorageSync('token_expire');
    wx.removeStorageSync('pendingApproval');
    wx.removeStorageSync('adminInfo');
  },

  // 显示登录注册弹窗的统一方法
  showLoginRegisterModal(action = '使用此功能', targetUrl = '', extraData = {}) {
    wx.showModal({
      title: '需要登录',
      content: `您需要登录后才能${action}`,
      confirmText: '去登录',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          if (targetUrl) {
            wx.setStorageSync('loginRedirect', {
              url: targetUrl,
              data: extraData
            });
          }
          wx.navigateTo({
            url: '/pages/login-unified/index'
          });
        }
      }
    });
  },

  // 显示加载提示
  showLoading(title = '加载中') {
    wx.showLoading({
      title: title,
      mask: true
    });
  },

  // 隐藏加载提示
  hideLoading() {
    wx.hideLoading();
  },

  // 显示提示信息
  showToast(title, icon = 'none') {
    wx.showToast({
      title: title,
      icon: icon,
      duration: 2000
    });
  }
});