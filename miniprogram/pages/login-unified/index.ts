import authApi from '../../utils/authApi'

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
      success: (res: { code?: string; errMsg?: string }) => {
        if (res.code) {
          authApi.legacyGetOpenid(res.code, 'login')
            .then((openid) => { this.setData({ openid }); })
            .catch(() => { /* openid 获取失败不阻断登录流程 */ });
        }
      }
    });
  },

  onPrivacyChange(e: { detail: { value: string[] } }) {
    this.setData({ isAgree: e.detail.value.length > 0 });
  },

  gotoServiceProtocol() { wx.navigateTo({ url: '/pages/settings/terms/terms' }); },
  gotoPrivacyPolicy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },

  switchRole(e: { currentTarget: { dataset: Record<string, string> } }) {
    this.setData({ currentRole: e.currentTarget.dataset.role, account: '', password: '' })
  },

  onAccountInput(e: { detail: { value: string } }) { this.setData({ account: e.detail.value }) },
  onPasswordInput(e: { detail: { value: string } }) { this.setData({ password: e.detail.value }) },

  quickLogin(e: { currentTarget: { dataset: Record<string, string> } }) {
    if (!this.data.isAgree) { wx.showToast({ title: '请先勾选同意协议', icon: 'none' }); return; }
    const { account, password } = e.currentTarget.dataset
    this.setData({ account, password }, () => { this.doLogin() })
  },

  onSubmit(e: { detail: { value: { account: string; password: string } } }) {
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

  volunteerLogin(phone: string, password: string, openid: string) {
    return authApi.legacyVolunteerLogin(phone, password, openid).then(({ userInfo }) => {
      app.globalData.isLoggedIn = true;
      app.globalData.userInfo = userInfo;
      wx.showToast({ title: '登录成功', icon: 'success' });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' });
          resolve();
        }, 1500);
      });
    });
  },

  adminLogin(account: string, password: string) {
    return authApi.legacyAdminLogin(account, password).then(({ userInfo, adminInfo }) => {
      app.globalData.isLoggedIn = true;
      app.globalData.userInfo = userInfo;
      wx.showToast({ title: '管理员登录成功', icon: 'success' });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (adminInfo.role === 'verifier') {
            // 核销员：直接跳转到核销页面
            wx.redirectTo({ url: '/pages/admin/qrVerify/qrVerify' });
          } else {
            // 超级管理员、管理员、审核员：跳转到管理面板
            wx.redirectTo({ url: '/pages/adminPanel/adminPanel' });
          }
          resolve();
        }, 1500);
      });
    }).catch((err) => {
      this.setData({ isRedirecting: false });
      throw err;
    });
  },

  gotoRegister() { wx.navigateTo({ url: '/pages/register/register' }) }
})