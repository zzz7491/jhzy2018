// pages/exchange-records/exchange-records.ts
import { mallApi, formatExchangeCode } from '../../utils/mallApi';

Page({
  data: {
    records: [] as any[],       // 展示用（已格式化）
    allRecords: [] as any[],    // 已加载的原始映射
    loading: false,
    loadingMore: false,
    hasMore: true,
    page: 1,
    pageSize: 10,
    total: 0,
    pendingCount: 0,
    completedCount: 0,
    userInfo: null,
    filterStatus: 'all'
  },

  onLoad() {
    this.checkLogin();
  },

  onShow() {
    this.checkLogin();
  },

  checkLogin() {
    const userInfo = wx.getStorageSync('userInfo');
    const token = wx.getStorageSync('access_token');
    const isLoggedIn = wx.getStorageSync('isLoggedIn');
    if (isLoggedIn && token && userInfo && userInfo.id) {
      this.setData({ userInfo });
      this.loadRecords(true);
    } else {
      wx.showToast({ title: '请先登录', icon: 'error' });
      setTimeout(() => this.goBack(), 1500);
    }
  },

  loadRecords(reset = false) {
    if (this.data.loading || this.data.loadingMore) return;
    const currentPage = reset ? 1 : this.data.page;
    this.setData(reset ? { loading: true } : { loadingMore: true });

    mallApi.getMyOrders(currentPage, this.data.pageSize).then((res: any) => {
      const mapped = (res.items || []).map((r: any) => this.mapRecord(r));
      const all = reset ? mapped : this.data.allRecords.concat(mapped);
      this.setData({
        allRecords: all,
        records: this.applyFilter(all),
        total: res.pagination.total,
        page: currentPage,
        hasMore: currentPage < res.pagination.total_pages,
        pendingCount: all.filter((r: any) => r.status === 1).length,
        completedCount: all.filter((r: any) => r.status === 2).length,
        loading: false,
        loadingMore: false
      });
    }).catch(() => {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      this.setData({ loading: false, loadingMore: false });
    });
  },

  applyFilter(all: any[]): any[] {
    const f = this.data.filterStatus;
    if (f === 'all') return all;
    if (f === '1') return all.filter((r: any) => r.status === 1);
    if (f === '2') return all.filter((r: any) => r.status === 2);
    if (f === '34') return all.filter((r: any) => r.status === 3 || r.status === 4);
    return all;
  },

  mapRecord(r: any): any {
    return {
      order_no: r.order_no,
      exchange_code_raw: r.exchange_code || '',
      exchange_code: r.exchange_code ? formatExchangeCode(r.exchange_code) : '—',
      goods_name: r.product_title || '未知商品',
      points_spent: r.points_units || 0,
      status: r.status,
      statusText: this.statusText(r.status),
      statusClass: this.statusClass(r.status),
      created_at: this.formatTime(r.created_at),
      verified_at: r.verified_at ? this.formatTime(r.verified_at) : '',
      product_public_id: r.product_public_id
    };
  },

  statusText(status: number): string {
    if (status === 1) return '待领取';
    if (status === 2) return '已领取';
    return '已结束';
  },

  statusClass(status: number): string {
    if (status === 1) return 'pending';
    if (status === 2) return 'received';
    return 'archived';
  },

  switchStatus(e: any) {
    const status = e.currentTarget.dataset.status;
    this.setData({ filterStatus: status, page: 1, allRecords: [], records: [] });
    this.loadRecords(true);
  },

  copyCode(e: any) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '领取码已复制', icon: 'success' })
    });
  },

  viewGoodsDetail(e: any) {
    const pid = e.currentTarget.dataset.id;
    if (pid) {
      wx.navigateTo({ url: `/pages/goods-detail/goods-detail?product_public_id=${pid}` });
    }
  },

  contactService() {
    wx.makePhoneCall({ phoneNumber: '0573-82099982' });
  },

  refreshRecords() {
    this.loadRecords(true);
  },

  loadMore() {
    if (!this.data.loading && !this.data.loadingMore && this.data.hasMore) {
      this.setData({ page: this.data.page + 1 });
      this.loadRecords();
    }
  },

  formatTime(time: any): string {
    if (time === null || time === undefined || time === '') return '暂无';
    let date: Date;
    if (typeof time === 'number') {
      date = new Date(time);
    } else if (typeof time === 'string') {
      if (time.includes('-') && time.includes(':')) return time;
      date = new Date(time);
    } else {
      return '暂无';
    }
    if (isNaN(date.getTime())) return typeof time === 'string' ? time : '暂无';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  onReachBottom() {
    this.loadMore();
  },

  onPullDownRefresh() {
    this.loadRecords(true);
    wx.stopPullDownRefresh();
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => wx.switchTab({ url: '/pages/mall/mall' })
      });
    } else {
      wx.switchTab({ url: '/pages/mall/mall' });
    }
  },

  goToMall() {
    wx.switchTab({ url: '/pages/mall/mall' });
  }
});
