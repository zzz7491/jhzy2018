// pages/admin/training/lesson.ts — 章节新建/编辑
// P32-P4：training.course.manage。public_id 寻址；不发送 numeric id。

import adminApi from '../../../utils/adminApi';

const LESSON_TYPES = ['video', 'text', 'image', 'audio', 'document'];
const TYPE_LABELS = ['视频', '图文', '图片', '音频', '文档'];
const STATUS_OPTIONS = ['已发布', '草稿'];

Page({
  data: {
    mode: 'create' as 'create' | 'edit',
    coursePublicId: '',
    lessonPublicId: '',
    title: '',
    typeIndex: 0,
    content: '',
    durationMin: 0,
    sort: 0,
    isFree: 0,
    statusIndex: 0,
    typeLabels: TYPE_LABELS,
    statusOptions: STATUS_OPTIONS,
    saving: false,
  },

  onLoad(query: any) {
    const coursePublicId = (query && query.coursePublicId) || '';
    const lessonPublicId = (query && query.lessonPublicId) || '';
    this.setData({ coursePublicId, lessonPublicId });
    if (lessonPublicId) {
      this.setData({ mode: 'edit' });
      this.loadLesson(coursePublicId, lessonPublicId);
    }
  },

  async loadLesson(coursePublicId: string, lessonPublicId: string) {
    try {
      const res = await adminApi.getTrainingCourse(coursePublicId);
      const list = res.lessons || [];
      const item = list.find((l: any) => l.public_id === lessonPublicId);
      if (!item) {
        wx.showToast({ title: '章节不存在', icon: 'none' });
        return;
      }
      const typeIndex = Math.max(0, LESSON_TYPES.indexOf(item.lesson_type));
      this.setData({
        title: item.title || '',
        typeIndex,
        content: item.content || '',
        durationMin: item.duration_min || 0,
        sort: item.sort || 0,
        isFree: item.is_free || 0,
        statusIndex: item.status === 2 ? 1 : 0,
      });
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  onTitleInput(e: any) {
    this.setData({ title: e.detail.value });
  },
  onContentInput(e: any) {
    this.setData({ content: e.detail.value });
  },
  onTypeChange(e: any) {
    this.setData({ typeIndex: Number(e.detail.value) });
  },
  onStatusChange(e: any) {
    this.setData({ statusIndex: Number(e.detail.value) });
  },
  onDurationInput(e: any) {
    this.setData({ durationMin: Number(e.detail.value) || 0 });
  },
  onSortInput(e: any) {
    this.setData({ sort: Number(e.detail.value) || 0 });
  },
  onFreeSwitch(e: any) {
    this.setData({ isFree: e.detail.value ? 1 : 0 });
  },

  async onSave() {
    const d = this.data;
    if (!d.title || !d.title.trim()) {
      wx.showToast({ title: '请填写章节标题', icon: 'none' });
      return;
    }
    const cmd = {
      title: d.title.trim(),
      lesson_type: LESSON_TYPES[d.typeIndex],
      content: d.content || null,
      duration_min: d.durationMin,
      sort: d.sort,
      is_free: d.isFree,
      status: d.statusIndex === 1 ? 2 : 1,
    };
    this.setData({ saving: true });
    try {
      if (d.mode === 'create') {
        await adminApi.createLesson(d.coursePublicId, cmd);
        wx.showToast({ title: '创建成功', icon: 'success' });
      } else {
        await adminApi.updateLesson(d.coursePublicId, d.lessonPublicId, cmd);
        wx.showToast({ title: '已保存', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e: any) {
      wx.showToast({ title: e && e.message ? e.message : '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
