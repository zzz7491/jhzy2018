import { trainingApi, hasTeamContext, type ExamAttempt } from '../../utils/trainingApi';

// pages/exam/take.ts（P32-P3）
// 内部考试页：开始 / 恢复 / 提交。仅使用 /api/v2/exams，绝不跳转外部 exam.jhzyfw.com。
// 客户端只持有 sessionPublicId / questionPublicId；不持有 numeric id，不读取答案，不本地算分。
Page({
  data: {
    paperPublicId: '' as string,
    sessionPublicId: '' as string,
    loading: true,
    submitting: false,
    teamMissing: false,
    errorMsg: '' as string,
    attempt: null as ExamAttempt | null,
    answers: {} as Record<string, string>,
    answeredCount: 0
  },

  onLoad(options: any) {
    const paperPublicId = options.paperPublicId || '';
    const sessionPublicId = options.sessionPublicId || '';
    if (paperPublicId) wx.setStorageSync('examLastPaperPublicId', paperPublicId);
    this.setData({ paperPublicId, sessionPublicId });
    this.initExam(paperPublicId, sessionPublicId);
  },

  ensureTeam(): boolean {
    if (!hasTeamContext()) {
      this.setData({ teamMissing: true, loading: false });
      return false;
    }
    this.setData({ teamMissing: false });
    return true;
  },

  async initExam(paperPublicId: string, sessionPublicId: string) {
    if (!this.ensureTeam()) {
      wx.showToast({ title: '请先选择团队', icon: 'none' });
      return;
    }
    this.setData({ loading: true, errorMsg: '' });

    // 恢复：若从考试入口进入（仅 paperPublicId）且本地有进行中的会话，则恢复
    let resumeSession = sessionPublicId;
    if (!resumeSession && paperPublicId) {
      const saved = wx.getStorageSync(`examSession:${paperPublicId}`);
      if (saved && saved.sessionPublicId) {
        resumeSession = saved.sessionPublicId;
        if (saved.answers) this.setData({ answers: saved.answers });
      }
    }

    try {
      let attempt: ExamAttempt;
      if (resumeSession) {
        const res = await trainingApi.getExamSession(resumeSession);
        attempt = res.attempt;
      } else if (paperPublicId) {
        const res = await trainingApi.startExam(paperPublicId);
        attempt = res.attempt;
      } else {
        this.setData({ loading: false, errorMsg: '缺少考试参数（paperPublicId）' });
        return;
      }

      this.setData({ attempt, sessionPublicId: attempt.session_public_id, loading: false });
      this.persistSession();

      // 已提交（COMPLETED）则直接跳转结果
      if (attempt.status === 3) {
        wx.redirectTo({ url: `/pages/exam/result/result?sessionPublicId=${attempt.session_public_id}` });
      }
    } catch (err: any) {
      this.setData({ loading: false });
      this.handleApiError(err, '开始考试失败');
    }
  },

  persistSession() {
    const { paperPublicId, sessionPublicId, answers } = this.data;
    if (paperPublicId && sessionPublicId) {
      wx.setStorageSync(`examSession:${paperPublicId}`, { sessionPublicId, answers, savedAt: Date.now() });
    }
  },

  clearSession() {
    const { paperPublicId } = this.data;
    if (paperPublicId) wx.removeStorageSync(`examSession:${paperPublicId}`);
  },

  selectOption(e: any) {
    const questionPublicId = e.currentTarget.dataset.qid;
    const key = e.currentTarget.dataset.key;
    const answers: Record<string, string> = { ...this.data.answers, [questionPublicId]: key };
    const answeredCount = Object.values(answers).filter((v) => !!v).length;
    this.setData({ answers, answeredCount });
    this.persistSession();
  },

  async submit() {
    const attempt = this.data.attempt;
    const answers = this.data.answers as Record<string, string>;
    if (!attempt) return;
    if (this.data.submitting) return;
    if (this.data.answeredCount < attempt.questions.length) {
      wx.showToast({ title: `还有 ${attempt.questions.length - this.data.answeredCount} 题未作答`, icon: 'none' });
      return;
    }

    const submitAnswers = attempt.questions.map((q) => ({
      questionPublicId: q.question_public_id,
      selected: answers[q.question_public_id]
    }));

    this.setData({ submitting: true });
    try {
      const res = await trainingApi.submitExam(attempt.session_public_id, submitAnswers);
      this.clearSession();
      const result = res.result;
      wx.redirectTo({
        url: `/pages/exam/result/result?sessionPublicId=${result.session_public_id}`
      });
    } catch (err: any) {
      this.setData({ submitting: false });
      // 已提交（重复提交冲突）→ 直接去结果页
      if (err && (err.code === 'EXAM_ALREADY_SUBMITTED' || (err.status === 409 && err.details && err.details.reason === 'exam_already_submitted'))) {
        this.clearSession();
        wx.redirectTo({ url: `/pages/exam/result/result?sessionPublicId=${this.data.sessionPublicId}` });
        return;
      }
      this.handleApiError(err, '提交失败');
    }
  },

  goToSelectTeam() {
    wx.navigateTo({ url: '/pages/teams/select/select' });
  },

  goBack() {
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
    if (err.status === 409) {
      wx.showToast({ title: '考试状态冲突，请重新进入', icon: 'none' });
      return;
    }
    wx.showToast({ title: err.message || fallback, icon: 'none' });
  }
});
