import { trainingApi, hasTeamContext, type CertificateView } from '../../../utils/trainingApi';

// pages/certificates/detail/detail.ts（P32-P3）
// 证书详情：对接 /api/v2/certificates/:certificatePublicId。仅展示安全字段，绝不展示 id_card / numeric id / verify_code / PDF。
Page({
  data: {
    certificate: null as (CertificateView & { issuedAtText?: string }) | null,
    loading: true,
    teamMissing: false,
    errorMsg: '' as string
  },

  onLoad(options: any) {
    const publicId = options.certificatePublicId || options.id || '';
    if (!publicId) {
      this.setData({ loading: false, errorMsg: '缺少证书参数' });
      return;
    }
    this.loadDetail(publicId);
  },

  onPullDownRefresh() {
    const publicId = this.data.certificate?.public_id;
    if (publicId) this.loadDetail(publicId);
    wx.stopPullDownRefresh();
  },

  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true, loading: false });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  async loadDetail(publicId: string) {
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    this.setData({ loading: true, errorMsg: '' });
    try {
      const res = await trainingApi.getCertificate(publicId);
      const cert = res.certificate;
      this.setData({
        certificate: {
          ...cert,
          issuedAtText: formatDate(cert.issued_at)
        },
        loading: false
      });
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载证书详情失败');
    }
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  // PDF 不在 P32 范围内；后端当前未提供 PDF 服务，故不提供下载。
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
    if (err.status === 404) {
      this.setData({ errorMsg: '证书不存在或暂无查看权限' });
      return;
    }
    wx.showToast({ title: err.message || fallback, icon: 'none' });
  }
});

function formatDate(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
