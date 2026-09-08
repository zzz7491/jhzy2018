import { trainingApi, hasTeamContext, type LessonView } from '../../../utils/trainingApi';

// pages/training/chapter/chapter.ts（P32-P3）
// 课程详情 + 章节学习：对接 /api/v2/training，使用 coursePublicId + lessonPublicId，绝不调用 legacy PHP。
Page({
  data: {
    coursePublicId: '' as string,
    courseTitle: '',
    lessons: [] as LessonView[],
    currentLesson: null as (LessonView & { content?: string; lesson_type?: string; duration_min?: number }) | null,
    currentLessonIndex: 0,
    loading: true,
    teamMissing: false,
    // P32-P3A：后端下发的课程关联考试（含 paper_public_id）；用于结课后引导考试。
    courseExam: null as any,
    startTime: 0,
    elapsedSeconds: 0,
    timer: null as any
  },

  onLoad(options: any) {
    if (options.coursePublicId) {
      this.setData({ coursePublicId: options.coursePublicId });
      this.loadCourse();
    } else {
      wx.showToast({ title: '缺少课程参数', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    }
  },

  onShow() {
    this.setData({ startTime: Date.now(), elapsedSeconds: 0 });
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
    this.recordProgress(false);
  },

  onUnload() {
    this.stopTimer();
    this.recordProgress(false);
  },

  startTimer() {
    if (this.data.timer) return;
    this.data.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.data.startTime) / 1000);
      this.setData({ elapsedSeconds: elapsed });
    }, 1000);
  },

  stopTimer() {
    if (this.data.timer) {
      clearInterval(this.data.timer);
      this.data.timer = null;
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

  async loadCourse() {
    if (!this.ensureTeam()) {
      this.setData({ loading: false });
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const res = await trainingApi.getCourse(this.data.coursePublicId);
      const lessons: LessonView[] = res.lessons || [];
      this.setData({ courseTitle: res.course.title, lessons, courseExam: (res.course as any).exam || null, loading: false });
      const firstUncompleted = lessons.find((l) => !l.completed);
      const idx = firstUncompleted ? lessons.findIndex((l) => l.public_id === firstUncompleted.public_id) : lessons.length > 0 ? 0 : -1;
      if (idx >= 0) {
        this.loadLesson(lessons[idx].public_id, idx);
      }
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '加载课程失败');
      setTimeout(() => wx.navigateBack(), 1500);
    }
  },

  async loadLesson(lessonPublicId: string, index: number) {
    try {
      const lesson = await trainingApi.getLesson(this.data.coursePublicId, lessonPublicId);
      this.setData({
        currentLesson: lesson as any,
        currentLessonIndex: index,
        startTime: Date.now(),
        elapsedSeconds: 0
      });
    } catch (err: any) {
      this.handleApiError(err, '加载章节失败');
    }
  },

  selectLesson(e: any) {
    const publicId = e.currentTarget.dataset.publicId;
    const index = e.currentTarget.dataset.index;
    this.recordProgress(false);
    this.loadLesson(publicId, index);
  },

  async recordProgress(completed: boolean) {
    if (!this.data.currentLesson || !this.data.coursePublicId) return;
    if (!hasTeamContext()) return;
    const learnedSeconds = Math.floor((Date.now() - this.data.startTime) / 1000);
    try {
      await trainingApi.reportProgress(this.data.coursePublicId, this.data.currentLesson.public_id, {
        learned_seconds: Math.max(0, learnedSeconds),
        completed
      });
    } catch (err: any) {
      // 进度上报失败不阻断用户；记录日志即可
      console.error('进度上报失败:', err);
    }
  },

  async completeAndNext() {
    if (!this.data.currentLesson) return;
    this.stopTimer();
    await this.recordProgress(true);
    const nextIndex = this.data.currentLessonIndex + 1;
    if (nextIndex < this.data.lessons.length) {
      const next = this.data.lessons[nextIndex];
      this.loadLesson(next.public_id, nextIndex);
    } else {
      const exam = this.data.courseExam;
      if (exam && exam.eligible && exam.paper_public_id) {
        // 本课程完成后、后端确认存在可参加的考试 → 引导进入内部考试页（paper 来自后端，不依赖 storage）。
        wx.showModal({
          title: '恭喜',
          content: '您已完成本课程所有章节，是否前往参加考试？',
          confirmText: '去考试',
          cancelText: '稍后',
          success: (r: any) => {
            if (r.confirm) {
              wx.redirectTo({ url: `/pages/exam/take/take?paperPublicId=${exam.paper_public_id}` });
            } else {
              wx.navigateBack();
            }
          }
        });
      } else {
        wx.showModal({
          title: '恭喜',
          content: '您已完成本课程所有章节！',
          showCancel: false,
          success: () => {
            wx.navigateBack();
          }
        });
      }
    }
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  goBack() {
    this.recordProgress(false);
    wx.navigateBack();
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
