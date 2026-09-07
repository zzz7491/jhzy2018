// pages/mall/mall.js - 志愿服务积分激励版（清理版）
const app = getApp();
import jhzyRequest from '../../utils/request';
import { mallApi, formatExchangeCode, formatPoints, generateOrderNo } from '../../utils/mallApi';

Page({
  data: {
    userInfo: null,
    userPoints: 0,
    isLoggedIn: false,
    
    // 显示模式
    isSeniorMode: false,
    
    // 激励物品数据
    goodsList: [],
    activeCategory: 0,
    loading: false,
    hasMore: true,
    page: 1,
    
    // 弹窗状态
    showLoginModal: false,
    showExchangeModal: false,
    selectedGoods: {},

    // P26-P1B：兑换闭环状态
    pendingOrderNo: '',            // 仅存页面内存，按次 attempt，不按 (user,product) 长期绑定
    successExchangeCode: '',       // raw 12 位领取码（复制用）
    successExchangeCodeDisplay: '', // 分组显示 XXXX-XXXX-XXXX
    showSuccessModal: false,
    showRetryModal: false,
    
    // 返回按钮控制
    showBackButton: false
  },

  onLoad() {
    console.log('积分激励页面加载');
    this.initPage();
    this.checkNeedBackButton();
  },

  onShow() {
    console.log('积分激励页面显示');
    this.refreshData();
  },

  onPullDownRefresh() {
    this.refreshData().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreGoods();
    }
  },

  // 初始化页面 - 修复：改为异步方法并立即加载数据
  async initPage() {
    this.initDisplayMode();
    
    // 检查登录状态并等待结果
    const isLoggedIn = await this.checkLoginStatus();
    
    // 如果已登录，立即加载商品数据（不等待用户操作）
    if (isLoggedIn) {
      await this.loadUserPoints();
      await this.loadGoods();
    } else {
      // 未登录时清空数据
      this.setData({ 
        goodsList: [],
        userPoints: 0,
        loading: false
      });
    }
  },

  // 检查是否需要显示返回按钮
  checkNeedBackButton() {
    // 获取页面栈
    const pages = getCurrentPages();
    // 如果页面栈大于1，说明是从其他页面跳转过来的，显示返回按钮
    const needBackButton = pages.length > 1;
    this.setData({
      showBackButton: needBackButton
    });
  },

  // 返回上一页
  goBack() {
    wx.navigateBack();
  },

  // 刷新数据
  async refreshData() {
    this.setData({
      page: 1,
      goodsList: [],
      hasMore: true,
      loading: true
    });
    
    // 先检查登录状态，获取结果
    const isLoggedIn = await this.checkLoginStatus();
    
    // 使用返回的结果
    if (isLoggedIn) {
      await this.loadUserPoints();
      await this.loadGoods();
    } else {
      // 未登录时清空数据
      this.setData({ 
        goodsList: [],
        userPoints: 0 
      });
    }
    
    this.setData({ loading: false });
  },

  // 加载更多
  loadMoreGoods() {
    if (!this.data.hasMore || this.data.loading) return;
    
    this.setData({
      page: this.data.page + 1,
      loading: true
    });
    
    this.loadGoods();
  },

  // 初始化显示模式
  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    const isSeniorMode = displayMode === 'senior';
    
    this.setData({
      isSeniorMode: isSeniorMode
    });
  },

  // 检查登录状态 - 使用本地存储检查
  async checkLoginStatus() {
    try {
      console.log('开始检查登录状态...');
      
      // 检查本地存储中的登录状态
      const token = wx.getStorageSync('access_token');
      const userInfo = wx.getStorageSync('userInfo');
      const isLoggedInStorage = wx.getStorageSync('isLoggedIn');
      
      console.log('登录检查详细信息:');
      console.log('1. token存在:', !!token);
      console.log('2. userInfo存在:', !!userInfo);
      console.log('3. isLoggedInStorage:', isLoggedInStorage);
      
      // 综合判断登录状态
      const isLoggedIn = !!(token && userInfo && isLoggedInStorage);
      
      console.log('最终登录状态判断:', isLoggedIn);
      
      if (isLoggedIn) {
        this.setData({
          userInfo: userInfo,
          isLoggedIn: true,
          showLoginModal: false
        });
        return true;
      } else {
        this.setData({
          userInfo: null,
          isLoggedIn: false,
          userPoints: 0
        });
        return false;
      }
      
    } catch (error) {
      console.error('检查登录状态失败:', error);
      this.setData({ isLoggedIn: false });
      return false;
    }
  },

  // 加载用户积分 - 从接口获取最新积分
  async loadUserPoints() {
    try {
      const token = wx.getStorageSync('access_token');
      if (!token) {
        this.setData({ userPoints: 0 });
        return;
      }

      const account = await mallApi.getPointsAccount();
      const balance = (account && typeof account.balance_units === 'number') ? account.balance_units : 0;
      this.setData({ userPoints: Number(formatPoints(balance)) });

      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo) {
        userInfo.current_points = balance;
        wx.setStorageSync('userInfo', userInfo);
      }
    } catch (error) {
      // 降级容错：沿用本地 userInfo.current_points 缓存
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo && userInfo.current_points !== undefined) {
        this.setData({ userPoints: Number(formatPoints(userInfo.current_points)) });
      }
    }
  },

  // 加载激励物品（P26-P1B：切换到 v2 /products，字段来自真实 v2 投影）
  async loadGoods(isRefresh = false) {
    try {
      const pageSize = 10;
      const res = await mallApi.getProducts(this.data.page, pageSize);

      if (res && res.items) {
        const goodsData = res.items;
        const pagination = res.pagination || { page: this.data.page, total_pages: 1 };

        let newGoods = goodsData.map((item: any) => ({
          id: item.public_id || '',
          publicId: item.public_id || '',
          name: item.title || '志愿服务激励物品',
          description: item.detail || '用志愿服务积分兑换爱心物品',
          image: '/images/default-goods.png',
          points_required: item.points_price_units || 0,
          stock: item.in_stock ? 1 : 0,
          inStock: !!item.in_stock,
          source: '',
          category_id: 0,
          is_hot: false,
          status: item.in_stock ? 'available' : 'sold_out'
        }));

        const combinedGoods = (this.data.page === 1 || isRefresh)
          ? newGoods
          : [...this.data.goodsList, ...newGoods];

        this.setData({
          goodsList: combinedGoods,
          hasMore: this.data.page < (pagination.total_pages || 1),
          loading: false
        });

      } else {
        this.setData({
          hasMore: false,
          loading: false
        });

        // 如果是第一页就没数据，清空列表
        if (this.data.page === 1) {
          this.setData({ goodsList: [] });
        }
      }

    } catch (error) {
      this.setData({
        hasMore: false,
        loading: false
      });

      if (this.data.page === 1) {
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      }
    }
  },

  // ========== 事件处理 ==========

  // 切换显示模式
  toggleDisplayMode() {
    const currentMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = currentMode === 'normal' ? 'senior' : 'normal';
    
    wx.setStorageSync('displayMode', newMode);
    
    this.setData({
      isSeniorMode: newMode === 'senior'
    });
    
    wx.vibrateShort();
    
    wx.showToast({
      title: `已切换到${newMode === 'senior' ? '大字版' : '普通版'}`,
      icon: 'success',
      duration: 1500
    });
  },

  // 切换分类
  switchCategory(e) {
    const category = parseInt(e.currentTarget.dataset.category);
    
    if (this.data.activeCategory === category) return;
    
    // 切换分类时，重置所有分页状态
    this.setData({
      activeCategory: category,
      page: 1,
      goodsList: [],
      hasMore: true,
      loading: true
    });

    this.loadGoods(true);
  },

  // 查看物品详情
  viewGoodsDetail(e) {
    const goodsId = e.currentTarget.dataset.id;
    const goodsItem = this.data.goodsList.find(item => item.id == goodsId);
    
    if (!goodsItem) return;
    
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('查看物品详情', `/pages/goods-detail/goods-detail`, { product_public_id: goodsId });
      return;
    }
    
    wx.navigateTo({
      url: `/pages/goods-detail/goods-detail?product_public_id=${goodsId}`
    });
  },

  // 兑换物品
  exchangeGoods(e) {
    e.stopPropagation();
    
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('兑换物品');
      return;
    }
    
    const goodsId = e.currentTarget.dataset.id;
    const goodsItem = this.data.goodsList.find(item => item.id == goodsId);
    
    if (!goodsItem || !this.canExchange(goodsItem)) return;
    
    this.setData({
      selectedGoods: goodsItem,
      showExchangeModal: true
    });
  },

  // 判断是否可以兑换
  canExchange(goodsItem) {
    if (!this.data.isLoggedIn) return false;
    if (goodsItem.stock <= 0) return false;
    if (this.data.userPoints < goodsItem.points_required) return false;
    return true;
  },

  // 获取兑换按钮文本
  getExchangeBtnText(goodsItem) {
    if (!this.data.isLoggedIn) return '请登录';
    if (goodsItem.stock <= 0) return '已兑完';
    if (this.data.userPoints < goodsItem.points_required) return '积分不足';
    return '立即兑换';
  },

  // 确认兑换请求（P26-P1B：v2 POST /orders，order_no 生命周期与 P1A 一致）
  async confirmExchange() {
    if (!this.data.isLoggedIn || !this.data.selectedGoods.publicId) return;

    const goodsItem = this.data.selectedGoods;

    // 重试复用同一 order_no；新主动兑换生成新码（不按 user,product 长期绑定）
    let orderNo = this.data.pendingOrderNo;
    if (!orderNo) {
      orderNo = generateOrderNo();
      this.setData({ pendingOrderNo: orderNo });
    }

    try {
      wx.showLoading({ title: '兑换中...', mask: true });

      const res: any = await mallApi.createOrder(goodsItem.publicId, orderNo);
      wx.hideLoading();

      // 成功（201 created / 200 existing 均返回 exchangeCode）
      const rawCode = (res && res.exchangeCode) || '';
      this.setData({
        pendingOrderNo: '',
        showExchangeModal: false,
        successExchangeCode: rawCode,
        successExchangeCodeDisplay: formatExchangeCode(rawCode),
        showSuccessModal: true,
        selectedGoods: {}
      });

      // 积分以服务端为准，刷新一次
      this.loadUserPoints();

      // 乐观更新本地库存显示
      const updatedGoodsList = this.data.goodsList.map(item => {
        if (item.publicId === goodsItem.publicId) {
          return { ...item, stock: 0, inStock: false };
        }
        return item;
      });
      this.setData({ goodsList: updatedGoodsList });

    } catch (err: any) {
      wx.hideLoading();
      if (err && err.isNetwork) {
        // 网络结果未知：保留 pendingOrderNo，提供“重试本次兑换”
        this.setData({ showRetryModal: true });
        wx.showToast({ title: '网络异常，兑换结果未知', icon: 'none', duration: 2000 });
      } else {
        // 明确 4xx / 业务错误：清除 pending
        this.setData({ pendingOrderNo: '' });
        const message = (err && err.message) ? err.message : '兑换失败，请稍后重试';
        wx.showToast({ title: message, icon: 'none', duration: 3000 });
      }
    }
  },

  // 关闭兑换确认弹窗（仅 UI 操作，不发起任何后端请求）
  cancelExchange() {
    this.setData({
      showExchangeModal: false,
      selectedGoods: {}
    });
  },

  // 重试本次兑换（复用同一 order_no）
  retryExchange() {
    this.setData({ showRetryModal: false });
    this.confirmExchange();
  },

  // 取消重试：放弃本次 attempt，清除 pending
  closeRetryModal() {
    this.setData({ showRetryModal: false, pendingOrderNo: '' });
  },

  // 复制 raw 12 位领取码
  copyExchangeCode() {
    const raw = this.data.successExchangeCode || '';
    if (!raw) return;
    wx.setClipboardData({
      data: raw,
      success: () => wx.showToast({ title: '领取码已复制', icon: 'none' })
    });
  },

  // 关闭兑换成功弹窗
  closeSuccessModal() {
    this.setData({
      showSuccessModal: false,
      successExchangeCode: '',
      successExchangeCodeDisplay: ''
    });
  },

  // 跳转到积分明细
  goToPointsDetail() {
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('查看积分明细', '/pages/points/points');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/points/points'
    });
  },

  // 跳转到兑换记录
  goToExchangeRecords() {
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('查看兑换记录', '/pages/exchange-records/exchange-records');
      return;
    }
    
    wx.navigateTo({
      url: '/pages/exchange-records/exchange-records'
    });
  },

  // 跳转到登录
  goToLogin() {
    // 使用统一的弹窗方法
    app.showLoginRegisterModal('使用积分商城功能');
  },

  // 刷新商品列表
  refreshGoodsList() {
    this.refreshData();
  },

  // 显示登录提示 - 完全使用统一弹窗方法
  showLoginModal(action) {
    const pendingApproval = wx.getStorageSync('pendingApproval');
    const userInfo = wx.getStorageSync('userInfo');
    
    // 如果用户处于审核中状态，显示审核中提示
    if (pendingApproval === true || (userInfo && (userInfo.status === 'pending' || userInfo.status === 0))) {
      wx.showModal({
        title: '账号审核中',
        content: '您的账号正在等待管理员审核。审核通过后，您将可以：\n• 兑换积分物品\n• 积累服务时长\n• 获取志愿者证书\n\n审核通常需要1-3个工作日，请耐心等待。',
        showCancel: false,
        confirmText: '我知道了',
        confirmColor: '#07c160'
      });
    } else {
      // 其他情况使用统一的弹窗方法
      app.showLoginRegisterModal(action);
    }
  },

  // 隐藏登录提示（保留但基本不用）
  hideLoginModal() {
    this.setData({ showLoginModal: false });
  }
});