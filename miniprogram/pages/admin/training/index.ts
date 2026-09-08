// pages/admin/training/index.ts — 培训课程管理（列表 + 新建入口）
// P32-P4：training.course.manage。仅使用 public_id，不暴露 numeric id。

import adminApi, { type CourseAdminRow } from '../../../utils/adminApi';

Page({
  data: {
    courses: [] as CourseAdminRow[],
    loading: true,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
  },

  onLoad() {
    this.loadCourses(true);
  },

  onPullDownRefresh() {
    this.loadCourses(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadCourses(false);
    }
  },

  async loadCourses(reset: boolean) {
    this.setData({ loading: true });
    const page = reset ? 1 : this.data.page + 1;
    try {
      const res = await adminApi.listTrainingCourses(page, this.data.pageSize);
      const items = res.items || [];
      const merged = reset ? items : this.data.courses.concat(items);
      this.setData({
        courses: merged,
        page,
        total: res.pagination ? res.pagination.total : merged.length,
        hasMore: merged.length < (res.pagination ? res.pagination.total : merged.length),
        loading: false,
      });
    } catch (e: any) {
      this.setData({ loading: false });
      wx.showToast({ title: e && e.message ? e.message : '加载失败', icon: 'none' });
    }
  },

  onTapCourse(e: any) {
    const publicId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/admin/training/edit?publicId=${publicId}` });
  },

  onAddCourse() {
    wx.navigateTo({ url: `/pages/admin/training/edit` });
  },

  statusText(status: number): string {
    if (status === 1) return '已发布';
    if (status === 2) return '草稿';
    return '未知';
  },
});
