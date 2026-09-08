import { trainingApi, hasTeamContext, type CourseView, type MyProgressItem } from '../../utils/trainingApi';

// pages/training/training.ts（P32-P3）
// 志愿者端学习培训列表：对接 /api/v2/training，绝不调用 legacy PHP。
Page({
  data: {
    isLoggedIn: false,
    isSeniorMode: false,
    userInfo: null as any,

    // 团队上下文
    teamMissing: false,

    // 课程数据
    categories: [
      { id: 0, name: '全部' },
      { id: 1, name: '必修课程' },
      { id: 2, name: '选修课程' }
    ],
    activeCategory: 0,
    courses: [] as CourseView[],
    filteredCourses: [] as CourseView[],
    currentCourse: null as CourseView | null,

    // 搜索和分页
    searchValue: '',
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,

    // 学习统计（服务端 my-progress 聚合）
    userPoints: 0,
    requiredCompleted: false,
    electiveCompleted: false,
    examEligible: false,
    // paperPublicId 由后端课程数据权威下发（P32-P3A）；不再依赖任何本地 storage key。
    examPaperPublicId: '' as string,
    learningStats: {
      enrolledCount: 0,
      completedCount: 0,
      inProgressCount: 0
    },

    // 模态框
    showCourseDetail: false,

    vibrationEnabled: true
  },

  onLoad() {
    this.initVibration();
    this.checkLoginStatus();
    this.initDisplayMode();
    this.loadData();
  },

  onShow() {
    if (this.data.isLoggedIn) {
      this.loadMyProgress();
    }
  },

  onPullDownRefresh() {
    this.refreshData();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMoreCourses();
    }
  },

  initVibration() {
    try {
      const setting = wx.getStorageSync('vibrationSetting');
      if (setting) {
        this.setData({ vibrationEnabled: setting.enabled !== false });
      }
    } catch (e) {
      console.log('震动设置初始化失败:', e);
    }
  },

  vibrate(_type = 'light') {
    if (!this.data.vibrationEnabled) return;
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: 'medium' });
    }
  },

  initDisplayMode() {
    const displayMode = wx.getStorageSync('displayMode') || 'normal';
    this.setData({ isSeniorMode: displayMode === 'senior' });
  },

  checkLoginStatus() {
    try {
      const userInfo = wx.getStorageSync('userInfo');
      const token = wx.getStorageSync('access_token');
      const isLoggedIn = wx.getStorageSync('isLoggedIn');
      const isValidLogin = isLoggedIn && token && userInfo && userInfo.id;
      this.setData({
        userInfo: userInfo || null,
        isLoggedIn: !!isValidLogin
      });
      return !!isValidLogin;
    } catch (error) {
      console.error('检查登录状态失败:', error);
      this.setData({ isLoggedIn: false });
      return false;
    }
  },

  loadData() {
    this.loadCourses(true);
    if (this.data.isLoggedIn) {
      this.loadMyProgress();
    }
  },

  refreshData() {
    this.setData({ page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
    if (this.data.isLoggedIn) {
      this.loadMyProgress();
    }
    setTimeout(() => {
      wx.stopPullDownRefresh();
    }, 500);
  },

  // 团队上下文检查：未选团队时提示
  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  async loadCourses(refresh = false) {
    if (this.data.loading) return;
    if (refresh) {
      this.setData({ page: 1, courses: [], hasMore: true });
    }
    this.setData({ loading: true });
    try {
      const res = await trainingApi.listCourses(this.data.page, this.data.pageSize);
      const items = res.items || [];
      const merged = this.data.page === 1 ? items : [...this.data.courses, ...items];
      // 志愿者考试发现（P32-P3A）：从后端课程数据推导可参加的 exam paper。
      // 一律以后端下发的 exam.paper_public_id 为准，绝不读取任何本地 storage key。
      const entry = this.deriveExamEntry(merged);
      this.setData({
        courses: merged,
        hasMore: items.length >= this.data.pageSize,
        loading: false,
        examEligible: entry.examEligible,
        examPaperPublicId: entry.examPaperPublicId
      });
      this.applyClientFilter();
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载课程失败');
    }
  },

  /** 从课程列表推导可参加的考试 paper（后端权威；取首个 eligible 且有 paper_public_id 的课程）。 */
  deriveExamEntry(courses: CourseView[]): { examEligible: boolean; examPaperPublicId: string } {
    const eligible = courses.find((c) => c.exam && c.exam.paper_public_id && c.exam.eligible);
    return {
      examEligible: !!eligible,
      examPaperPublicId: eligible?.exam?.paper_public_id || ''
    };
  },

  loadMoreCourses() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.loadCourses();
  },

  // 客户端筛洗（必修/选修 + 标题搜索）—— 后端返回本团队全部课程
  applyClientFilter() {
    let list = this.data.courses;
    if (this.data.activeCategory === 1) {
      list = list.filter((c) => c.required === 1);
    } else if (this.data.activeCategory === 2) {
      list = list.filter((c) => c.required === 0);
    }
    const kw = this.data.searchValue.trim();
    if (kw) {
      list = list.filter((c) => (c.title || '').includes(kw));
    }
    this.setData({ filteredCourses: list });
  },

  async loadMyProgress() {
    try {
      const res = await trainingApi.myProgress();
      const items: MyProgressItem[] = res.items || [];
      const required = items.filter((i) => i.required === 1);
      const elective = items.filter((i) => i.required === 0);
      const requiredCompleted = required.length > 0 && required.every((i) => i.completed);
      const electiveCompleted = elective.length > 0 && elective.some((i) => i.completed);
      const completedCount = items.filter((i) => i.completed).length;
      const inProgressCount = items.filter((i) => !i.completed).length;
      this.setData({
        learningStats: {
          enrolledCount: items.length,
          completedCount,
          inProgressCount
        },
        requiredCompleted,
        electiveCompleted
      });
    } catch (err: any) {
      this.handleApiError(err, '加载学习进度失败');
    }
  },

  goBack() {
    this.vibrate('light');
    wx.navigateBack();
  },

  switchDisplayMode() {
    const currentMode = wx.getStorageSync('displayMode') || 'normal';
    const newMode = currentMode === 'normal' ? 'senior' : 'normal';
    wx.setStorageSync('displayMode', newMode);
    this.setData({ isSeniorMode: newMode === 'senior' });
    this.vibrate('light');
    wx.showToast({ title: `已切换到${newMode === 'senior' ? '大字版' : '普通版'}`, icon: 'success' });
  },

  goToRegister() {
    wx.navigateTo({ url: '/pages/login-unified/index' });
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  onSearchInput(e: any) {
    this.setData({ searchValue: e.detail.value });
  },

  onSearchConfirm() {
    this.vibrate('light');
    this.setData({ page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
  },

  onClearSearch() {
    this.setData({ searchValue: '', page: 1, courses: [], hasMore: true });
    this.loadCourses(true);
  },

  onCategoryChange(e: any) {
    const categoryId = e.currentTarget.dataset.id;
    this.vibrate('light');
    this.setData({ activeCategory: categoryId });
    this.applyClientFilter();
  },

  goToCourseDetail(e: any) {
    const publicId = e.currentTarget.dataset.publicId;
    const course = this.data.courses.find((c) => c.public_id === publicId) || null;
    if (course) {
      this.vibrate('light');
      this.setData({ currentCourse: course, showCourseDetail: true });
    }
  },

  closeCourseDetail() {
    this.setData({ showCourseDetail: false });
  },

  handleCourseAction(e: any) {
    const course: CourseView = e.currentTarget.dataset.course || this.data.currentCourse;
    if (!course) return;
    this.vibrate('light');
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login-unified/index' });
      return;
    }
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      setTimeout(() => this.goToSelectTeam(), 800);
      return;
    }
    if (course.completed) {
      wx.showToast({ title: '已完成', icon: 'none' });
      return;
    }
    if (course.enrolled) {
      wx.navigateTo({ url: `/pages/training/chapter/chapter?coursePublicId=${course.public_id}` });
    } else {
      wx.showLoading({ title: '报名中...' });
      this.enrollCourse(course);
    }
  },

  async enrollCourse(course: CourseView) {
    try {
      await trainingApi.enroll(course.public_id);
      wx.hideLoading();
      wx.showToast({ title: '报名成功', icon: 'success' });
      this.setData({ page: 1, courses: [], hasMore: true });
      this.loadCourses(true);
      this.loadMyProgress();
    } catch (err: any) {
      wx.hideLoading();
      this.handleApiError(err, '报名失败');
    }
  },

  goToExamCenter() {
    this.vibrate('light');
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
    if (!this.data.examEligible) {
      wx.showToast({ title: '请先完成所有课程', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/exam/take/take?paperPublicId=${paperPublicId}`
    });
  },

  goToMyLearning() {
    this.vibrate('light');
    wx.navigateTo({ url: '/pages/training/my-learning/my-learning' });
  },

  goToCertificates() {
    this.vibrate('light');
    wx.navigateTo({ url: '/pages/certificates/certificates' });
  },

  viewTrainingRules() {
    this.vibrate('light');
    wx.showModal({
      title: '培训规则',
      content: '1. 新志愿者必须完成必修课程\n2. 需完成至少1门选修课程\n3. 完成所有课程后方可参加考试\n4. 考试合格（90分）获得证书\n5. 获得证书后方可报名活动\n6. 保险须通过机构指定服务商购买（联系工作号）\n7. 信用时长无法补录，属实情况可补录荣誉时长',
      showCancel: false
    });
  },

  shareCourse() {
    this.vibrate('light');
    wx.showToast({ title: '分享功能开发中', icon: 'none' });
  },

  refreshCourses() {
    this.refreshData();
  },

  viewMoreHotCourses() {
    this.setData({ activeCategory: 0 });
    this.applyClientFilter();
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
  },

  onShareAppMessage() {
    return { title: '志愿者培训学习', path: 'pages/training/training', imageUrl: '/images/share-default.jpg' };
  },

  onShareTimeline() {
    return { title: '志愿者培训学习', imageUrl: '/images/share-default.jpg' };
  }
});
