import { trainingApi, hasTeamContext, type ExamResult } from '../../utils/trainingApi';

// pages/exam/result.ts（P32-P3）
// 考试结果页：仅展示服务端权威 score / passed / certificate，绝不本地算分、绝不展示答案或正确答案。
Page({
  data: {
    sessionPublicId: '' as string,
    loading: true,
    teamMissing: false,
    errorMsg: '' as string,
    result: null as ExamResult | null,
    passed: false,
    hasCertificate: false
  },

  onLoad(options: any) {
    const sessionPublicId = options.sessionPublicId || '';
    this.setData({ sessionPublicId });
    if (!sessionPublicId) {
      this.setData({ loading: false, errorMsg: '缺少考试会话参数' });
      return;
    }
    this.loadResult();
  },

  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true, loading: false });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  async loadResult() {
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    this.setData({ loading: true, errorMsg: '' });
    try {
      const res = await trainingApi.getExamResult(this.data.sessionPublicId);
      const result = res.result;
      this.setData({
        result,
        passed: !!result.passed,
        hasCertificate: !!result.certificate,
        loading: false
      });
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载结果失败');
    }
  },

  viewCertificate() {
    const cert = this.data.result && this.data.result.certificate;
    if (cert && cert.public_id) {
      wx.navigateTo({ url: `/pages/certificates/detail/detail?certificatePublicId=${cert.public_id}` });
    } else {
      wx.showToast({ title: '证书暂不可用', icon: 'none' });
    }
  },

  retryExam() {
    const paperPublicId = wx.getStorageSync('examLastPaperPublicId') || '';
    if (paperPublicId) {
      wx.redirectTo({ url: `/pages/exam/take/take?paperPublicId=${paperPublicId}` });
    } else {
      wx.showToast({ title: '请重新从考试中心进入', icon: 'none' });
    }
  },

  goToCertificates() {
    wx.navigateTo({ url: '/pages/certificates/certificates' });
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
