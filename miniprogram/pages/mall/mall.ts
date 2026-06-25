// pages/mall/mall.js - 志愿服务积分激励版（清理版）
const app = getApp();
import jhzyRequest from '../../utils/request';

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
      
      // 从接口获取最新积分
      const res = await jhzyRequest.get('points_query.php');
      console.log('获取积分响应:', res);
      
      if (res.code === 0 && res.data) {
        const points = res.data.current_points || 0;
        this.setData({ userPoints: points });
        
        // 同时更新本地存储
        const userInfo = wx.getStorageSync('userInfo');
        if (userInfo) {
          userInfo.current_points = points;
          wx.setStorageSync('userInfo', userInfo);
        }
      } else {
        // 降级使用本地存储
        const userInfo = wx.getStorageSync('userInfo');
        if (userInfo && userInfo.current_points !== undefined) {
          this.setData({ userPoints: userInfo.current_points || 0 });
        }
      }
    } catch (error) {
      console.error('加载用户积分失败:', error);
      // 降级使用本地存储
      const userInfo = wx.getStorageSync('userInfo');
      if (userInfo && userInfo.current_points !== undefined) {
        this.setData({ userPoints: userInfo.current_points || 0 });
      }
    }
  },

  // 加载激励物品
  async loadGoods() {
    try {
      const params = {
        page: this.data.page,
        limit: 10
      };
      
      // 注意：后端不支持category_id参数，所以不传递，改为前端筛选
      
      const res = await jhzyRequest.get('exchange_goods.php', params);
      
      console.log('激励物品API响应:', res);
      
      // 处理API响应
      let goodsData = [];
      
      if (res.code === 0 && res.data && res.data.products && Array.isArray(res.data.products)) {
        goodsData = res.data.products;
        console.log('成功解析商品数据:', goodsData.length);
      }
      
      if (goodsData.length > 0) {
        console.log('原始商品数据详情:', JSON.stringify(goodsData, null, 2));
        
        // 格式化商品数据
        let newGoods = goodsData.map(item => ({
          id: item.product_id || 0,
          name: item.product_name || '志愿服务激励物品',
          description: item.description || '用志愿服务积分兑换爱心物品',
          image: item.image_url || '/images/default-goods.png',
          points_required: item.points_required || 0,
          stock: item.stock || 0,
          source: item.source || '',
          category_id: item.category_id || 0,
          is_hot: item.is_hot || false,
          status: item.status || 'available'
        }));
        
        // 前端分类筛选（因为后端不支持category_id参数）
        if (this.data.activeCategory > 0) {
          newGoods = newGoods.filter(item => item.category_id === this.data.activeCategory);
        }
        
        const combinedGoods = this.data.page === 1 
          ? newGoods 
          : [...this.data.goodsList, ...newGoods];
        
        this.setData({
          goodsList: combinedGoods,
          hasMore: newGoods.length >= 10,
          loading: false
        });
        
        console.log('成功加载商品数据，数量:', combinedGoods.length);
        
      } else {
        console.log('暂无可用商品数据');
        this.setData({
          goodsList: [],
          hasMore: false,
          loading: false
        });
        
        wx.showToast({
          title: '暂无可用商品',
          icon: 'none',
          duration: 2000
        });
      }
      
    } catch (error) {
      console.error('加载激励物品异常:', error);
      this.setData({
        goodsList: [],
        hasMore: false,
        loading: false
      });
      
      wx.showToast({
        title: '加载失败，请稍后重试',
        icon: 'none',
        duration: 2000
      });
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
    
    this.setData({
      activeCategory: category,
      page: 1,
      goodsList: [],
      loading: true
    });
    
    this.loadGoods();
  },

  // 查看物品详情
  viewGoodsDetail(e) {
    const goodsId = e.currentTarget.dataset.id;
    const goodsItem = this.data.goodsList.find(item => item.id == goodsId);
    
    if (!goodsItem) return;
    
    if (!this.data.isLoggedIn) {
      // 使用统一的弹窗方法
      app.showLoginRegisterModal('查看物品详情', `/pages/goods-detail/goods-detail`, { id: goodsId });
      return;
    }
    
    wx.navigateTo({
      url: `/pages/goods-detail/goods-detail?id=${goodsId}`
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

  // 确认兑换（修复版）
  async confirmExchange() {
    if (!this.data.isLoggedIn || !this.data.selectedGoods.id) return;
    
    const goodsItem = this.data.selectedGoods;
    
    try {
      wx.showLoading({
        title: '兑换中...',
        mask: true
      });
      
      const token = wx.getStorageSync('access_token');
      const res = await jhzyRequest.post('exchange.php', {
        goods_id: goodsItem.id  // 只传 goods_id，不传 user_id（后端从token获取）
      });
      
      wx.hideLoading();
      
      console.log('兑换API响应:', res);
      
      // 修复：正确获取后端返回的 message 字段
      let success = false;
      let message = '兑换结果未知';
      
      if (res.code === 200) {
        success = true;
        // 优先取 data.message，其次取 res.message
        message = res.data?.message || res.message || '兑换成功！请凭兑换码联系管理员领取物品';
      } else {
        // 失败时同样正确获取错误信息
        message = res.data?.message || res.message || '兑换失败，请稍后重试';
        console.log('兑换失败详情:', res);
      }
      
      if (success) {
        // 兑换成功，更新数据
        const newPoints = this.data.userPoints - goodsItem.points_required;
        
        // 更新用户信息中的积分
        const userInfo = wx.getStorageSync('userInfo');
        if (userInfo) {
          userInfo.current_points = newPoints;
          wx.setStorageSync('userInfo', userInfo);
        }
        
        // 更新商品库存
        const updatedGoodsList = this.data.goodsList.map(item => {
          if (item.id === goodsItem.id) {
            return {
              ...item,
              stock: Math.max(0, item.stock - 1)
            };
          }
          return item;
        });
        
        this.setData({
          userPoints: newPoints,
          goodsList: updatedGoodsList,
          showExchangeModal: false,
          selectedGoods: {}
        });
        
        wx.showToast({
          title: '兑换成功！请查看兑换记录',
          icon: 'success',
          duration: 2000
        });
        
      } else {
        wx.showToast({
          title: message,
          icon: 'none',
          duration: 3000  // 延长显示时间，让老年人看清楚
        });
      }
      
    } catch (error) {
      wx.hideLoading();
      console.error('兑换失败:', error);
      
      wx.showToast({
        title: '网络错误，请重试',
        icon: 'none',
        duration: 3000
      });
    }
  },

  // 取消兑换
  cancelExchange() {
    this.setData({
      showExchangeModal: false,
      selectedGoods: {}
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