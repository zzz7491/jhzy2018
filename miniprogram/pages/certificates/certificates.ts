import { trainingApi, hasTeamContext, type CertificateView } from '../../utils/trainingApi';

// pages/certificates/certificates.ts（P32-P3）
// 我的证书：对接 /api/v2/certificates/mine，绝不调用 legacy PHP。仅展示安全字段。
function formatDate(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Page({
  data: {
    certificates: [] as CertificateView[],
    loading: true,
    teamMissing: false
  },

  onLoad() {
    this.loadCertificates();
  },

  onPullDownRefresh() {
    this.loadCertificates();
    wx.stopPullDownRefresh();
  },

  onShow() {
    if (this.data.certificates.length === 0 && !this.data.loading) {
      this.loadCertificates();
    }
  },

  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true, loading: false });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  async loadCertificates() {
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const res = await trainingApi.listMyCertificates();
      const list = (res.certificates || []).map((c: CertificateView) => ({
        ...c,
        issuedAtText: formatDate(c.issued_at)
      }));
      this.setData({ certificates: list, loading: false });
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载证书失败');
    }
  },

  goToDetail(e: any) {
    const publicId = e.currentTarget.dataset.publicId;
    wx.navigateTo({ url: `/pages/certificates/detail/detail?certificatePublicId=${publicId}` });
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  handleApiError(err: any, fallback: string) {
    if (!err) {
      wx.showToast({ title: fallback, icon: 'none' });
      return;
    }
    if (err.isNetwork) {
      wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' });
      return;
    }
    if (err.status === 401) {
      wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
      return;
    }
    if (err.code === 'TEAM_SCOPE_REQUIRED' || err.status === 403) {
      this.setData({ teamMissing: true });
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    wx.showToast({ title: err.message || fallback, icon: 'none' });
  }
});
