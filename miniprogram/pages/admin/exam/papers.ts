// pages/admin/exam/papers.ts — 试卷管理（列表 + 新建/编辑）
// P32-P4：exam.paper.manage。冻结规则：pass_score=90；pick_rule=random 20 题（后端抽题，前端不生成）。
// 课程关联使用 course_public_id（ULID），绝不发送 numeric course id。

import adminApi, { type PaperAdminRow, type CourseAdminRow } from '../../../utils/adminApi';

// 冻结的抽题规则：随机抽取 20 题。
const FROZEN_PICK_RULE = { strategy: 'random', count: 20 };
const FROZEN_PASS_SCORE = 90;
const STATUS_OPTIONS = ['已发布', '草稿'];

Page({
  data: {
    mode: 'list' as 'list' | 'edit',
    editId: '',
    list: [] as PaperAdminRow[],
    loading: true,

    // 表单
    title: '',
    courses: [] as CourseAdminRow[],
    courseIndex: -1 as number, // -1 = 不关联
    passScore: FROZEN_PASS_SCORE,
    maxAttempts: 3,
    durationMin: 60,
    statusIndex: 0,
    statusOptions: STATUS_OPTIONS,
    saving: false,
  },

  onLoad(query: any) {
    const editId = query && query.publicId ? query.publicId : '';
    if (editId) {
      this.setData({ mode: 'edit', editId });
      this.prepareForm();
    } else {
      this.loadList();
    }
  },

  onPullDownRefresh() {
    if (this.data.mode === 'list') {
      this.loadList().finally(() => wx.stopPullDownRefresh());
    }
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      const res = await adminApi.listPapers();
      this.setData({ list: res.papers || [], loading: false });
    } catch (e: any) {
      this.setData({ loading: false });
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  async prepareForm() {
    try {
      const [papers, coursesRes] = await Promise.all([
        adminApi.listPapers(),
        adminApi.listTrainingCourses(1, 200),
      ]);
      const item = (papers.papers || []).find((p: PaperAdminRow) => p.public_id === this.data.editId);
      const courses = coursesRes.items || [];
      const courseIndex = item && item.course_public_id
        ? Math.max(0, courses.findIndex((c: CourseAdminRow) => c.public_id === item.course_public_id))
        : -1;
      this.setData({
        title: item ? item.title : '',
        courses,
        courseIndex,
        passScore: FROZEN_PASS_SCORE,
        maxAttempts: item ? (item as any).max_attempts ?? 3 : 3,
        durationMin: item ? (item as any).duration_min ?? 60 : 60,
        statusIndex: item && (item as any).status === 2 ? 1 : 0,
      });
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  onAddPaper() {
    wx.navigateTo({ url: `/pages/admin/exam/papers?publicId=` });
  },

  onTapPaper(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/exam/papers?publicId=${id}` });
  },

  onTitleInput(e: any) {
    this.setData({ title: e.detail.value });
  },
  onCourseChange(e: any) {
    this.setData({ courseIndex: Number(e.detail.value) });
  },
  onMaxAttemptsInput(e: any) {
    this.setData({ maxAttempts: Number(e.detail.value) || 3 });
  },
  onDurationInput(e: any) {
    this.setData({ durationMin: Number(e.detail.value) || 60 });
  },
  onStatusChange(e: any) {
    this.setData({ statusIndex: Number(e.detail.value) });
  },

  async onSave() {
    const d = this.data;
    if (!d.title || !d.title.trim()) {
      wx.showToast({ title: '请填写试卷标题', icon: 'none' });
      return;
    }
    const coursePublicId =
      d.courseIndex >= 0 && d.courses[d.courseIndex] ? d.courses[d.courseIndex].public_id : null;
    const cmd = {
      title: d.title.trim(),
      course_public_id: coursePublicId,
      pick_rule: FROZEN_PICK_RULE,
      total_score: 100,
      pass_score: FROZEN_PASS_SCORE,
      duration_min: d.durationMin,
      max_attempts: d.maxAttempts,
      status: d.statusIndex === 1 ? 2 : 1,
    };
    this.setData({ saving: true });
    try {
      if (d.mode === 'edit' && d.editId) {
        await adminApi.updatePaper(d.editId, cmd);
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        await adminApi.createPaper(cmd);
        wx.showToast({ title: '创建成功', icon: 'success' });
      }
      setTimeout(() => {
        if (d.mode === 'edit') wx.navigateBack();
        else wx.redirectTo({ url: `/pages/admin/exam/papers` });
      }, 600);
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
