const app = getApp()
Page({
  data: {
    currentRole: 'volunteer',
    account: '',
    password: '',
    loading: false,
    isDev: false,
    isAgree: false,
    isRedirecting: false
  },

  onLoad() {
    this.setData({ isDev: app.globalData.debugMode || false })
    this.getUserOpenid()
  },

  onShow() {
    this.setData({ loading: false });
    if (app.globalData.isLoggedIn && !this.data.isRedirecting) {
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo) {
        this.setData({ isRedirecting: true });
        if (userInfo.is_admin) {
          // 管理员根据角色跳转
          const adminInfo = wx.getStorageSync('adminInfo');
          if (adminInfo && adminInfo.role === 'verifier') {
            wx.redirectTo({ url: '/pages/admin/qrVerify/qrVerify' });
          } else {
            wx.redirectTo({ url: '/pages/adminPanel/adminPanel' });
          }
        } else {
          wx.switchTab({ url: '/pages/index/index' });
        }
      }
    }
  },

  getUserOpenid() {
    wx.login({
      success: (res) => {
        if (res.code) {
          wx.request({
            url: 'https://api.jhzyfw.com/api/get_openid.php',
            method: 'POST',
            data: { code: res.code },
            success: (resp) => {
              if (resp.data && resp.data.openid) {
                this.setData({ openid: resp.data.openid })
              }
            }
          })
        }
      }
    })
  },

  onPrivacyChange(e) {
    this.setData({ isAgree: e.detail.value.length > 0 });
  },

  gotoServiceProtocol() { wx.navigateTo({ url: '/pages/settings/terms/terms' }); },
  gotoPrivacyPolicy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },

  switchRole(e) {
    this.setData({ currentRole: e.currentTarget.dataset.role, account: '', password: '' })
  },

  onAccountInput(e) { this.setData({ account: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },

  quickLogin(e) {
    if (!this.data.isAgree) { wx.showToast({ title: '请先勾选同意协议', icon: 'none' }); return; }
    const { account, password } = e.currentTarget.dataset
    this.setData({ account, password }, () => { this.doLogin() })
  },

  onSubmit(e) {
    if (!this.data.isAgree) { wx.showToast({ title: '请先勾选同意协议', icon: 'none' }); return; }
    const { account, password } = e.detail.value
    this.setData({ account, password }, () => { this.doLogin() })
  },

  async doLogin() {
    const { account, password, currentRole, openid } = this.data
    this.setData({ loading: true })
    try {
      if (currentRole === 'volunteer') {
        await this.volunteerLogin(account, password, openid)
      } else {
        await this.adminLogin(account, password)
      }
    } catch (error) {
      wx.showToast({ title: typeof error === 'string' ? error : '登录失败', icon: 'error' })
      this.setData({ loading: false, isRedirecting: false })
    }
  },

  volunteerLogin(phone, password, openid) {
    return new Promise((resolve, reject) => {
      let postData = `account=${encodeURIComponent(phone)}&password=${encodeURIComponent(password)}`
      if (openid && !openid.startsWith('ADMIN_')) { postData += `&openid=${encodeURIComponent(openid)}` }
      
      wx.request({
        url: 'https://api.jhzyfw.com/api/login.php',
        method: 'POST',
        header: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: postData,
        success: (res) => {
          if (res.data.code === 0) {
            const token = res.data.token || res.data.data?.token;
            const userInfoData = res.data.data?.user_info || res.data.user_info;
            
            wx.setStorageSync('access_token', token);
            wx.setStorageSync('token', token); 
            
            const userInfo = {
              id: userInfoData?.id,
              username: userInfoData?.real_name || userInfoData?.username,
              real_name: userInfoData?.real_name,
              phone: userInfoData?.phone,
              openid: userInfoData?.openid || openid,
              points: userInfoData?.current_points || 0,
              volunteer_id: userInfoData?.volunteer_id,
              activity_count: userInfoData?.activity_count || 0,
              service_hours: userInfoData?.service_hours || 0,
              current_points: userInfoData?.current_points || 0,
              total_points: userInfoData?.total_points || 0
            };
            
            wx.setStorageSync('userInfo', userInfo);
            wx.setStorageSync('isLoggedIn', true);
            wx.setStorageSync('token_expire', Date.now() + 30 * 24 * 60 * 60 * 1000);
            
            app.globalData.isLoggedIn = true;
            app.globalData.userInfo = userInfo;
            
            wx.showToast({ title: '登录成功', icon: 'success' });
            setTimeout(() => { wx.switchTab({ url: '/pages/index/index' }); resolve(); }, 1500);
          } else {
            reject(res.data.msg || '登录失败');
          }
        },
        fail: () => reject('网络错误')
      });
    });
  },

  adminLogin(account, password) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: 'https://api.jhzyfw.com/api/admin_login.php',
        method: 'POST',
        data: { username: account, password: password },
        success: (res) => {
          if (res.data.success === true) {
            const adminData = res.data.data;
            const adminRole = adminData.role;
            
            wx.setStorageSync('access_token', adminData.token || '');
            wx.setStorageSync('token', adminData.token || '');
            wx.setStorageSync('adminInfo', {
              id: adminData.id,
              name: adminData.real_name,
              username: adminData.username,
              role: adminRole,
              email: adminData.email
            });
            
            const userInfo = {
              id: adminData.id,
              real_name: adminData.real_name,
              username: adminData.username,
              email: adminData.email,
              role: adminRole,
              is_admin: true
            };
            
            wx.setStorageSync('userInfo', userInfo);
            wx.setStorageSync('isLoggedIn', true);
            wx.setStorageSync('token_expire', Date.now() + 30 * 24 * 60 * 60 * 1000);
            
            app.globalData.isLoggedIn = true;
            app.globalData.userInfo = userInfo;

            wx.showToast({ title: '管理员登录成功', icon: 'success' });
            
            // 根据角色跳转不同页面
            setTimeout(() => {
              if (adminRole === 'verifier') {
                // 核销员：直接跳转到核销页面
                wx.redirectTo({ url: '/pages/admin/qrVerify/qrVerify' });
              } else {
                // 超级管理员、管理员、审核员：跳转到管理面板
                wx.redirectTo({ url: '/pages/adminPanel/adminPanel' });
              }
              resolve();
            }, 1500);
          } else {
            reject(res.data.message || '登录失败');
            this.setData({ isRedirecting: false });
          }
        },
        fail: () => {
          reject('网络错误');
          this.setData({ isRedirecting: false });
        }
      });
    })
  },

  gotoRegister() { wx.navigateTo({ url: '/pages/register/register' }) }
})