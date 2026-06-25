// D:\开发\小程序\jhzy-2\miniprogram\pages\audit-center\audit-center.js
Page({
  data: {
    activeTab: 'all',
    auditItems: [],
    loading: false,
    summary: {
      total_pending: 0,
      user_verify: 0,
      activity_register: 0,
      exchange_order: 0
    },
    adminInfo: null,
    showAuditModal: false,
    currentItem: null,
    auditComment: '',
    auditResult: 'approved'
  },

  onLoad() {
    this.checkAdminAuth();
  },

  onShow() {
    this.checkAdminAuth();
  },

  // 检查管理员权限
  checkAdminAuth() {
    const adminInfo = wx.getStorageSync('adminInfo');
    if (!adminInfo || !adminInfo.is_admin) {
      wx.redirectTo({
        url: '/pages/admin-login/admin-login'
      });
      return false;
    }
    
    // 检查token是否过期
    if (adminInfo.token_expire && adminInfo.token_expire < Date.now() / 1000) {
      wx.showToast({
        title: '登录已过期，请重新登录',
        icon: 'none'
      });
      wx.removeStorageSync('adminInfo');
      wx.redirectTo({
        url: '/pages/admin-login/admin-login'
      });
      return false;
    }
    
    this.setData({ adminInfo });
    this.fetchAuditList(this.data.activeTab);
    return true;
  },

  // 切换标签页
  switchTab(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ activeTab: type });
    this.fetchAuditList(type);
  },

  // 获取待审核列表
  fetchAuditList(type) {
    if (!this.data.adminInfo) return;
    
    this.setData({ loading: true });
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/audit/list.php',
      method: 'GET',
      data: {
        admin_id: this.data.adminInfo.user_id,
        type: type,
        status: 'pending',
        page: 1,
        page_size: 20
      },
      success: (res) => {
        if (res.data.success) {
          this.setData({
            auditItems: res.data.data.audit_items,
            summary: res.data.data.summary,
            loading: false
          });
        } else {
          wx.showToast({
            title: res.data.message || '获取失败',
            icon: 'none'
          });
          this.setData({ loading: false });
        }
      },
      fail: (err) => {
        console.error('获取审核列表失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
        this.setData({ loading: false });
      }
    });
  },

  // 显示审核弹窗
  showAuditDialog(e) {
    const item = e.currentTarget.dataset.item;
    this.setData({
      showAuditModal: true,
      currentItem: item,
      auditComment: '',
      auditResult: 'approved'
    });
  },

  // 隐藏审核弹窗
  hideAuditDialog() {
    this.setData({
      showAuditModal: false,
      currentItem: null,
      auditComment: ''
    });
  },

  // 输入审核意见
  onCommentInput(e) {
    this.setData({
      auditComment: e.detail.value
    });
  },

  // 选择审核结果
  selectResult(e) {
    this.setData({
      auditResult: e.currentTarget.dataset.result
    });
  },

  // 提交审核
  submitAudit() {
    const { currentItem, auditResult, auditComment, adminInfo } = this.data;
    
    if (!currentItem || !adminInfo) return;
    
    wx.showLoading({
      title: '提交中...',
      mask: true
    });
    
    wx.request({
      url: 'https://api.jhzyfw.com/api/audit/submit.php',
      method: 'POST',
      data: {
        item_id: currentItem.item_id,
        audit_type: currentItem.audit_type,
        admin_id: adminInfo.user_id,
        audit_result: auditResult,
        audit_comment: auditComment || (auditResult === 'approved' ? '审核通过' : '审核不通过')
      },
      success: (res) => {
        wx.hideLoading();
        if (res.data.success) {
          wx.showToast({
            title: '审核完成',
            icon: 'success',
            duration: 1500
          });
          
          // 关闭弹窗
          this.hideAuditDialog();
          
          // 刷新列表
          setTimeout(() => {
            this.fetchAuditList(this.data.activeTab);
          }, 500);
          
        } else {
          wx.showToast({
            title: res.data.message || '审核失败',
            icon: 'none',
            duration: 3000
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('提交审核失败:', err);
        wx.showToast({
          title: '网络错误',
          icon: 'none'
        });
      }
    });
  },

  // 查看详情
  viewDetail(e) {
    const item = e.currentTarget.dataset.item;
    
    let content = '';
    switch(item.audit_type) {
      case 'user_verify':
        content = `👤 用户实名认证\n\n姓名：${item.real_name}\n手机：${item.phone}\n身份证：${item.id_card || '未提供'}\n申请时间：${item.apply_time}`;
        break;
      case 'activity_register':
        content = `🎯 活动报名\n\n活动：${item.activity_title}\n用户：${item.user_name}\n手机：${item.phone}\n报名时间：${item.apply_time}`;
        break;
      case 'exchange_order':
        content = `🛒 积分兑换\n\n商品：${item.product_name}\n用户：${item.user_name}\n积分：${item.points_used}\n申请时间：${item.apply_time}`;
        break;
    }
    
    wx.showModal({
      title: '审核详情',
      content: content,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 退出登录
  logout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出管理员账号吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('adminInfo');
          wx.redirectTo({
            url: '/pages/admin-login/admin-login'
          });
        }
      }
    });
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.fetchAuditList(this.data.activeTab);
    wx.stopPullDownRefresh();
  }
});