// pages/admin/training-certificates/index.ts — 培训证书管理（v2 迁移，P32-P4）
// 仅对接 /api/v2/certificates/admin（certificate.certificate.view）。
// 仅展示安全字段：public_id / cert_no / holder / course / score / issued_at / status。
// 绝不展示 id_card / numeric id / verify_code / 内部 snapshot。

import adminApi, { type CertAdminRow } from '../../../utils/adminApi';

Page({
  data: {
    list: [] as CertAdminRow[],
    loading: false,
    page: 1,
    pageSize: 50,
    total: 0,
    hasMore: false,
  },

  onLoad() {
    this.loadData(true);
  },

  onPullDownRefresh() {
    this.loadData(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadData(false);
    }
  },

  async loadData(reset: boolean) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    const page = reset ? 1 : this.data.page + 1;
    try {
      const res = await adminApi.listTrainingCertificates(page, this.data.pageSize);
      const items = (res.certificates || []).map((c) => ({
        ...c,
        issued_at_text: this.formatTime(c.issued_at),
      }));
      const merged = reset ? items : this.data.list.concat(items);
      this.setData({
        list: merged,
        page,
        total: res.pagination ? res.pagination.total : merged.length,
        hasMore: merged.length < (res.pagination ? res.pagination.total : merged.length),
        loading: false,
      });
    } catch (e: any) {
      this.setData({ loading: false });
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  formatTime(epoch: number): string {
    if (!epoch) return '-';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '-';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  statusText(status: number): string {
    return status === 1 ? '有效' : '已作废';
  },
});
