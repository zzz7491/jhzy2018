// pages/goods-detail/goods-detail.ts
import { mallApi } from '../../utils/mallApi';

const DEFAULT_COVER = '/images/default-goods.png';
const MAX_PRODUCT_PAGES = 50;

Page({
  data: {
    productPublicId: '',
    goodsData: {
      public_id: '',
      name: '',
      description: '',
      points_cost: 0,
      inStock: false,
      cover: '',
      create_time: '',
      status: 'available'
    },
    goodsImages: [],
    userPoints: 0,
    showExchangeModal: false,
    showSuccessModal: false,
    exchangeCode: '', // raw 12-char，复制用
    formattedExchangeCode: '', // XXXX-XXXX-XXXX，展示用
    successMessage: '',
    currentTime: '',
    pendingOrderNo: '', // 当前 attempt 的 order_no（仅存内存，不持久化）
    showRetryModal: false,
    retryMessage: '',
    exchangeRules: [
      '兑换后积分将立即扣除',
      '实物商品需联系管理员领取，领取时间：工作日9:00-17:00',
      '电子商品领取码将在兑换后立即显示，请及时保存',
      '兑换记录可在个人中心查看',
      '如有问题，请及时联系客服'
    ]
  },

  onLoad(options: any) {
    const productPublicId = (options && (options.product_public_id || options.id)) || '';
    if (!productPublicId) {
      wx.showToast({ title: '参数错误', icon: 'error', duration: 2000 });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.setData({ productPublicId });
    this.loadProduct(productPublicId);
    this.loadUserPoints();
  },

  onShow() {},

  async loadProduct(productPublicId: string) {
    wx.showLoading({ title: '加载中...', mask: true });
    try {
      const product = await this.findProductByPublicId(productPublicId);
      if (!product) {
        wx.hideLoading();
        wx.showToast({ title: '商品不存在或已下架', icon: 'none', duration: 2000 });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      this.setData({
        goodsData: {
          public_id: product.public_id,
          name: product.title,
          description: product.detail || '暂无描述',
          points_cost: product.points_price_units,
          inStock: product.in_stock,
          cover: DEFAULT_COVER,
          create_time: this.formatTime(product.created_at),
          status: 'available'
        },
        goodsImages: [DEFAULT_COVER]
      });
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请重试', icon: 'none', duration: 2000 });
    }
  },

  // 无单品端点：分页向后查找 product_public_id，命中或耗尽或达 MAX_PAGES 终止
  async findProductByPublicId(publicId: string): Promise<any> {
    for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
      const res = await mallApi.getProducts(page, 20);
      const hit = res.items.find((p: any) => p.public_id === publicId);
      if (hit) return hit;
      if (page >= res.pagination.total_pages) return null;
    }
    return null;
  },

  // 加载用户积分（P27：迁移到 v2 SELF /points/account，以服务端 balance_units 为唯一事实源）
  async loadUserPoints() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.current_points !== undefined) {
      this.setData({ userPoints: userInfo.current_points || 0 });
      return;
    }
    const token = wx.getStorageSync('access_token');
    if (!token) return;
    try {
      const account = await mallApi.getPointsAccount();
      const balance = (account && typeof account.balance_units === 'number') ? account.balance_units : 0;
      this.setData({ userPoints: balance });
      const info = wx.getStorageSync('userInfo');
      if (info) {
        info.current_points = balance;
        wx.setStorageSync('userInfo', info);
      }
    } catch (err) {
      // 降级容错：沿用本地 userInfo.current_points 缓存
      const info = wx.getStorageSync('userInfo');
      if (info && info.current_points !== undefined) {
        this.setData({ userPoints: info.current_points || 0 });
      }
    }
  },

  previewImage(e: any) {
    const index = e.currentTarget.dataset.index;
    if (this.data.goodsImages.length > 0) {
      wx.previewImage({ current: this.data.goodsImages[index], urls: this.data.goodsImages });
    }
  },

  exchangeGoods() {
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');
    if (!token || !userInfo) {
      wx.showToast({ title: '请先登录', icon: 'error', duration: 1500 });
      setTimeout(() => wx.navigateTo({ url: '/pages/profile/login/login' }), 1500);
      return;
    }
    if (!this.data.goodsData.inStock) {
      wx.showToast({ title: '商品已兑完', icon: 'error', duration: 2000 });
      return;
    }
    if (this.data.userPoints < this.data.goodsData.points_cost) {
      wx.showToast({ title: '积分不足', icon: 'error', duration: 2000 });
      return;
    }
    this.setData({ showExchangeModal: true });
  },

  closeExchangeModal() {
    this.setData({ showExchangeModal: false });
  },

  // 确认兑换：每次主动点击生成新 order_no（除非处于重试态复用 pending）
  async confirmExchange() {
    let orderNo = this.data.pendingOrderNo;
    if (!orderNo) {
      orderNo = mallApi.generateOrderNo();
    }
    this.setData({ pendingOrderNo: orderNo, showExchangeModal: false });
    wx.showLoading({ title: '兑换中...', mask: true });
    try {
      const out = await mallApi.createOrder(this.data.productPublicId, orderNo);
      wx.hideLoading();
      const raw = out.exchangeCode || '';
      this.setData({
        pendingOrderNo: '', // 201/200 成功 → 清除
        showSuccessModal: true,
        exchangeCode: raw,
        formattedExchangeCode: mallApi.formatExchangeCode(raw),
        successMessage: '兑换成功！请保存领取码，凭码到管理员处领取。',
        currentTime: this.formatTime(Date.now())
      });
      // 积分以服务端为准，刷新一次（覆盖本地值，避免二次扣减/不一致）
      this.loadUserPoints();
    } catch (err) {
      wx.hideLoading();
      const e: any = err;
      if (e && e.isNetwork) {
        // 结果未知 → 保留 pendingOrderNo，提供重试
        this.setData({ showRetryModal: true, retryMessage: '网络异常，兑换结果未知。可重试本次兑换，不会重复扣积分。' });
      } else {
        // 明确 4xx / 业务错误 → 清除 pending
        this.setData({ pendingOrderNo: '' });
        wx.showToast({ title: this.mapExchangeError(e), icon: 'none', duration: 2500 });
      }
    }
  },

  mapExchangeError(e: any): string {
    if (!e) return '兑换失败，请重试';
    if (e.status === 401) return '登录已过期';
    if (e.status === 400) return '兑换请求格式错误';
    if (e.status === 403) return '无权限执行兑换';
    if (e.status === 404) return '商品不存在或已下架';
    if (e.status === 409) {
      const reason = e.details && e.details.reason;
      if (reason === 'mall_insufficient_balance') return '积分不足';
      if (reason === 'mall_out_of_stock') return '商品已兑完';
      return '当前订单不可兑换';
    }
    return '兑换失败，请重试';
  },

  retryExchange() {
    this.setData({ showRetryModal: false });
    this.confirmExchange(); // pendingOrderNo 仍保留 → 复用同一 order_no
  },

  cancelRetry() {
    this.setData({ showRetryModal: false, pendingOrderNo: '' });
  },

  closeSuccessModal() {
    this.setData({ showSuccessModal: false });
  },

  copyExchangeCode() {
    if (!this.data.exchangeCode) {
      wx.showToast({ title: '无领取码', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.exchangeCode, // 复制 raw 12-char，不复制分组后码
      success: () => wx.showToast({ title: '复制成功', icon: 'success' })
    });
  },

  viewExchangeRecords() {
    this.closeSuccessModal();
    wx.navigateTo({ url: '/pages/exchange-records/exchange-records' });
  },

  viewPointsDetail() {
    wx.navigateTo({ url: '/pages/points/points' });
  },

  contactService() {
    wx.showModal({
      title: '联系客服',
      content: '客服电话：18072213357\n服务时间：工作日9:00-17:00\n或前往嘉兴市嘉禾志愿服务中心咨询',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#07c160'
    });
  },

  formatTime(time: any): string {
    if (time === null || time === undefined || time === '') return '';
    let date: Date;
    if (typeof time === 'number') {
      date = new Date(time);
    } else if (typeof time === 'string') {
      if (time.includes('-') && time.includes(':')) return time;
      date = new Date(time);
    } else {
      return '';
    }
    if (isNaN(date.getTime())) return typeof time === 'string' ? time : '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  onShareAppMessage() {
    return {
      title: `嘉禾志愿 - ${this.data.goodsData.name}`,
      path: `/pages/goods-detail/goods-detail?product_public_id=${this.data.productPublicId}`,
      imageUrl: this.data.goodsImages.length > 0 ? this.data.goodsImages[0] : ''
    };
  },

  onShareTimeline() {
    return {
      title: `嘉禾志愿 - ${this.data.goodsData.name}`,
      query: `product_public_id=${this.data.productPublicId}`
    };
  }
});
