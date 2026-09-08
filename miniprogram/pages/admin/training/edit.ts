// pages/admin/training/edit.ts — 课程新建/编辑 + 章节管理
// P32-P4：training.course.manage。public_id 寻址；不发送 numeric id。

import adminApi, { type LessonAdminRow } from '../../../utils/adminApi';

Page({
  data: {
    mode: 'create' as 'create' | 'edit',
    coursePublicId: '',
    title: '',
    summary: '',
    required: 0 as number, // 0 选修 / 1 必修
    requiredMinutes: 0 as number,
    sort: 0 as number,
    statusIndex: 0 as number, // 0=已发布(1) / 1=草稿(2)
    statusOptions: ['已发布', '草稿'],
    saving: false,
    lessons: [] as LessonAdminRow[],
    loadingLessons: false,
  },

  onLoad(query: any) {
    const publicId = query && query.publicId ? query.publicId : '';
    if (publicId) {
      this.setData({ mode: 'edit', coursePublicId: publicId });
      this.loadCourse(publicId);
    }
  },

  async loadCourse(publicId: string) {
    try {
      const res = await adminApi.getTrainingCourse(publicId);
      const c = res.course || {};
      this.setData({
        title: c.title || '',
        summary: c.summary || '',
        required: c.required || 0,
        requiredMinutes: c.required_minutes || 0,
        sort: c.sort || 0,
        statusIndex: c.status === 2 ? 1 : 0,
        lessons: res.lessons || [],
      });
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  onTitleInput(e: any) {
    this.setData({ title: e.detail.value });
  },
  onSummaryInput(e: any) {
    this.setData({ summary: e.detail.value });
  },
  onRequiredSwitch(e: any) {
    this.setData({ required: e.detail.value ? 1 : 0 });
  },
  onMinutesInput(e: any) {
    this.setData({ requiredMinutes: Number(e.detail.value) || 0 });
  },
  onSortInput(e: any) {
    this.setData({ sort: Number(e.detail.value) || 0 });
  },
  onStatusChange(e: any) {
    this.setData({ statusIndex: Number(e.detail.value) });
  },

  async onSave() {
    const { title, summary, required, requiredMinutes, sort, statusIndex, mode, coursePublicId } = this.data;
    if (!title || !title.trim()) {
      wx.showToast({ title: '请填写课程标题', icon: 'none' });
      return;
    }
    const cmd = {
      title: title.trim(),
      summary: summary || null,
      required,
      required_minutes: requiredMinutes,
      sort,
      status: statusIndex === 1 ? 2 : 1,
    };
    this.setData({ saving: true });
    try {
      if (mode === 'create') {
        const r = await adminApi.createTrainingCourse(cmd);
        wx.showToast({ title: '创建成功', icon: 'success' });
        const id = r.public_id;
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/admin/training/edit?publicId=${id}` });
        }, 600);
      } else {
        await adminApi.updateTrainingCourse(coursePublicId, cmd);
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      }
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onAddLesson() {
    wx.navigateTo({ url: `/pages/admin/training/lesson?coursePublicId=${this.data.coursePublicId}` });
  },

  onEditLesson(e: any) {
    const lessonPublicId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/admin/training/lesson?coursePublicId=${this.data.coursePublicId}&lessonPublicId=${lessonPublicId}`,
    });
  },
});
