// pages/admin/exchange-manage/index.ts
import { mallApi, formatExchangeCode } from '../../../utils/mallApi';

Page({
  data: {
    records: [] as any[],
    page: 1,
    limit: 20,
    total: 0,
    hasMore: false,
    loading: false,
    currentStatus: '1',
    verifyCode: '',
    verifyResult: '',
    verifyResultType: '' // 'success' | 'error'
  },

  onLoad() {
    this.loadRecords();
  },

  filterStatus(e: any) {
    const status = e.currentTarget.dataset.status;
    this.setData({ currentStatus: status, records: [], page: 1 });
    this.loadRecords();
  },

  loadRecords() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    const status = this.data.currentStatus === '1' || this.data.currentStatus === '2'
      ? Number(this.data.currentStatus)
      : undefined;

    mallApi.adminListOrders(status, this.data.page, this.data.limit).then((res: any) => {
      const newRecords = this.data.page === 1
        ? res.items.map((r: any) => this.mapRecord(r))
        : this.data.records.concat(res.items.map((r: any) => this.mapRecord(r)));
      this.setData({
        records: newRecords,
        total: res.pagination.total,
        hasMore: res.pagination.page < res.pagination.total_pages,
        loading: false
      });
    }).catch(() => {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      this.setData({ loading: false });
    });
  },

  mapRecord(r: any): any {
    return {
      order_no: r.order_no,
      exchange_code_raw: r.exchange_code || '',
      exchange_code: r.exchange_code ? formatExchangeCode(r.exchange_code) : '—',
      goods_name: r.product_title || '未知商品',
      user_public_id: r.user_public_id || '—',
      points_spent: r.points_units || 0,
      status: r.status,
      statusText: r.status === 1 ? '待领取' : r.status === 2 ? '已领取' : '已结束',
      statusClass: r.status === 1 ? 'pending' : r.status === 2 ? 'received' : 'archived',
      created_at: this.formatTime(r.created_at),
      verified_at: r.verified_at ? this.formatTime(r.verified_at) : ''
    };
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadRecords();
  },

  onVerifyInput(e: any) {
    this.setData({ verifyCode: e.detail.value });
  },

  doVerify() {
    const code = (this.data.verifyCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入领取码', icon: 'none' });
      return;
    }
    this.setData({ verifyResult: '', verifyResultType: '' });
    wx.showLoading({ title: '核销中...', mask: true });
    mallApi.adminVerify(code).then((out: any) => {
      wx.hideLoading();
      const msg = out.status === 'verified' ? '核销成功' : '已核销';
      this.setData({ verifyResult: msg, verifyResultType: 'success' });
      this.setData({ records: [], page: 1 });
      this.loadRecords();
    }).catch((err: any) => {
      wx.hideLoading();
      this.setData({ verifyResult: this.mapVerifyError(err), verifyResultType: 'error' });
    });
  },

  mapVerifyError(e: any): string {
    if (!e) return '核销失败';
    if (e.status === 401) return '登录已过期';
    if (e.status === 400) return '领取码格式错误';
    if (e.status === 404) return '未找到可核销订单';
    if (e.status === 409 && e.details && e.details.reason === 'mall_order_not_verifiable') return '当前订单不可核销';
    if (e.status === 403 && e.code === 'TEAM_SCOPE_REQUIRED') return '请先进入团队上下文';
    if (e.status === 403) return '无权限执行核销';
    return '核销失败，请重试';
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
    if (isNaN(date.getTime())) return '暂无';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
});
