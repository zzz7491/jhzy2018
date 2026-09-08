import { trainingApi, hasTeamContext, type MyProgressItem, type CertificateView, type CourseView } from '../../utils/trainingApi';

// pages/trainings/trainings.ts（P32-P3 / P32-P3A 遗留考试交接页）
// 旧版：依赖外部 exam.jhzyfw.com（webview + PHP 接口 + PDF 下载）。
// 新版：100% 走 /api/v2，不再跳转外部考试站，改为进入内部考试页 /pages/exam/take/take，
//      合格证书改为进入内部证书详情页 /pages/certificates/detail/detail。
// P32-P3A：paperPublicId 由后端课程数据（GET /training/courses 的 exam 字段）权威下发，
//          不再依赖任何本地 storage key（如 trainingExamPaperPublicId）。
Page({
  data: {
    loading: true,
    isLoggedIn: false,
    teamMissing: false,

    // 派生状态
    examEligible: false,
    certificate: null as CertificateView | null,
    // paperPublicId 由后端课程数据权威下发（P32-P3A）；不再依赖任何本地 storage key。
    examPaperPublicId: '' as string,

    // 兼容旧 WXML 字段（保留供过渡）
    hasExam: false,
    isPassed: false
  },

  onLoad() {
    this.checkLogin();
    if (this.data.isLoggedIn) {
      this.loadStatus();
    } else {
      this.setData({ loading: false });
    }
  },

  onShow() {
    if (this.data.isLoggedIn) {
      this.loadStatus();
    }
  },

  checkLogin() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const token = wx.getStorageSync('access_token');
      const isLoggedIn = wx.getStorageSync('isLoggedIn');
      const valid = isLoggedIn && token && userInfo && userInfo.id;
      this.setData({ isLoggedIn: !!valid });
      return !!valid;
    } catch (e) {
      this.setData({ isLoggedIn: false });
      return false;
    }
  },

  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  // 加载培训状态：考试资格（my-progress）+ 是否已有培训证书（certificates/mine）
  // + 后端课程数据派生的可参加 exam paper（P32-P3A，取代本地 storage key）。
  async loadStatus() {
    if (!this.ensureTeam()) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true, teamMissing: false });
    try {
      const [progressRes, certRes, coursesRes] = await Promise.all([
        trainingApi.myProgress(),
        trainingApi.listMyCertificates(),
        trainingApi.listCourses(1, 100)
      ]);

      // 考试资格：必修全部完成 且 至少一门选修完成
      const items: MyProgressItem[] = progressRes.items || [];
      const required = items.filter((i) => i.required === 1);
      const elective = items.filter((i) => i.required === 0);
      const requiredCompleted = required.length > 0 && required.every((i) => i.completed);
      const electiveCompleted = elective.length > 0 && elective.some((i) => i.completed);
      const progressEligible = requiredCompleted && electiveCompleted;

      // 培训证书：cert_type === 'training' 视为考试合格凭证
      const certs: CertificateView[] = certRes.certificates || [];
      const certificate = certs.find((c) => c.cert_type === 'training') || null;

      // 志愿者考试发现（P32-P3A）：从后端课程数据取首个「有 paper 且 eligible」的课程。
      const courses: CourseView[] = coursesRes.items || [];
      const eligibleCourse = courses.find((c) => c.exam && c.exam.paper_public_id && c.exam.eligible);
      const examPaperPublicId = eligibleCourse?.exam?.paper_public_id || '';

      // 最终考试资格：进度满足 且 后端确实下发了可参加的 paper。
      const examEligible = progressEligible && !!examPaperPublicId;

      this.setData({
        examEligible,
        certificate,
        examPaperPublicId,
        hasExam: true,
        isPassed: !!certificate,
        loading: false
      });
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载培训状态失败');
    }
  },

  // 我要考试 / 重新考试 → 内部考试页（绝不跳转外部站）
  goToExam() {
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login-unified/index' });
      return;
    }
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      setTimeout(() => this.goToSelectTeam(), 800);
      return;
    }
    // paperPublicId 完全来自后端课程数据（P32-P3A），不再读取任何本地 storage key。
    const paperPublicId = this.data.examPaperPublicId;
    if (!paperPublicId) {
      wx.showToast({ title: '暂无可参加的考试，请先完成课程', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/exam/take/take?paperPublicId=${paperPublicId}`
    });
  },

  // 查看证书 → 内部证书详情页
  viewCertificate() {
    const cert = this.data.certificate;
    if (cert && cert.public_id) {
      wx.navigateTo({ url: `/pages/certificates/detail/detail?certificatePublicId=${cert.public_id}` });
    } else {
      wx.showToast({ title: '证书暂不可用', icon: 'none' });
    }
  },

  goToLearning() {
    wx.navigateTo({ url: '/pages/training/training' });
  },

  goToCertificates() {
    wx.navigateTo({ url: '/pages/certificates/certificates' });
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  goToLogin() {
    wx.navigateTo({ url: '/pages/login-unified/index' });
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
