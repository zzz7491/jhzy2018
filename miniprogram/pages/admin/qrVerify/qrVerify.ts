// pages/admin/qrVerify/qrVerify.ts
Page({
  data: {
    adminName: '',
    adminRole: '',
    currentTime: '',
    showManualInput: false,
    manualCode: '',
    isLoading: false,
    showResultModal: false,
    verifySuccess: false,
    verifyMessage: '',
    // 核销员统计
    todayCount: 0,
    todayPoints: 0,
    historyList: [] as any[]
  },

  onLoad() {
    this.checkLogin();
    this.getAdminInfo();
    this.loadStats();
    this.startTimeUpdate();
  },

  onShow() {
    this.loadStats();
  },

  // 检查登录状态（不限制角色，所有管理员都可进入）
  checkLogin() {
    const token = wx.getStorageSync('access_token');
    const adminInfo = wx.getStorageSync('adminInfo');
    
    if (!token || !adminInfo) {
      wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      return;
    }
  },

  getAdminInfo() {
    const adminInfo = wx.getStorageSync('adminInfo');
    if (adminInfo) {
      this.setData({
        adminName: adminInfo.real_name || adminInfo.username || '管理员',
        adminRole: adminInfo.role || ''
      });
    }
  },

  startTimeUpdate() {
    this.updateCurrentTime();
    setInterval(() => { this.updateCurrentTime(); }, 1000);
  },

  updateCurrentTime() {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    this.setData({ currentTime: timeStr });
  },

  // 加载统计（如果是核销员，显示自己的统计；如果是其他管理员，显示所有统计）
  async loadStats() {
    const token = wx.getStorageSync('access_token');
    const adminInfo = wx.getStorageSync('adminInfo');
    
    // 根据角色决定请求参数
    let url = 'https://api.jhzyfw.com/api/verifier_stats.php';
    if (adminInfo.role !== 'verifier') {
      // 超级管理员或普通管理员，可以查看所有核销统计
      url = 'https://api.jhzyfw.com/api/admin_stats.php?type=redeem';
    }
    
    wx.request({
      url: url,
      method: 'GET',
      header: { 'Authorization': `Bearer ${token}` },
      success: (res: any) => {
        if (res.data.code === 200 && res.data.success) {
          const data = res.data.data;
          this.setData({
            todayCount: data.today?.count || 0,
            todayPoints: data.today?.points || 0,
            historyList: data.history?.map((item: any) => ({
              id: item.id,
              goods_name: item.goods_name,
              points_spent: item.points_spent,
              volunteer_name: item.volunteer_name,
              completed_at: item.completed_at,
              exchange_code: item.exchange_code
            })) || []
          });
        }
      },
      fail: () => {
        console.error('加载统计失败');
      }
    });
  },

  toggleManualInput() {
    this.setData({ showManualInput: !this.data.showManualInput, manualCode: '' });
  },

  onManualInput(e: any) {
    this.setData({ manualCode: e.detail.value });
  },

  startScan() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => { this.doRedeem(res.result); },
      fail: () => { wx.showToast({ title: '扫码失败', icon: 'none' }); }
    });
  },

  verifyManualCode() {
    const code = this.data.manualCode.trim();
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'error' });
      return;
    }
    this.doRedeem(code);
    this.setData({ manualCode: '' });
  },

  async doRedeem(exchangeCode: string) {
    this.setData({ isLoading: true });
    
    const token = wx.getStorageSync('access_token');
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/redeem.php',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: { exchange_code: exchangeCode },
      success: (res: any) => {
        this.setData({ isLoading: false });
        
        if (res.data.code === 200 && res.data.success === true) {
          const data = res.data.data;
          const now = new Date();
          const timeStr = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
          
          this.setData({
            showResultModal: true,
            verifySuccess: true,
            verifyMessage: `核销成功！\n志愿者：${data.volunteer_name || '未知'}\n兑换物品：${data.goods_name || '商品'}\n扣除积分：${data.points_spent || 0}分\n核销时间：${timeStr}`
          });
          
          // 刷新统计
          this.loadStats();
        } else {
          this.setData({
            showResultModal: true,
            verifySuccess: false,
            verifyMessage: res.data.message || '核销失败'
          });
        }
      },
      fail: () => {
        this.setData({ isLoading: false });
        this.setData({
          showResultModal: true,
          verifySuccess: false,
          verifyMessage: '网络错误，请重试'
        });
      }
    });
  },

  closeResultModal() {
    this.setData({ showResultModal: false });
  },

  formatTime(timeStr: string): string {
    if (!timeStr) return '';
    const date = new Date(timeStr);
    return `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${date.getMinutes()}`;
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.removeStorageSync('access_token');
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('isLoggedIn');
          wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
        }
      }
    });
  }
});