// pages/admin/activity-abc/index.ts
// P31-P1B：迁移管理端活动视图到 /api/v2/activities（list / detail / update / publish）。
// - 列表：GET /api/v2/activities（public_id）
// - 详情：GET /api/v2/activities/:id
// - 编辑：PUT /api/v2/activities/:id（v1 仅标量；不重配置 nested occurrence/position/slot）
// - 发布：POST /api/v2/activities/:id/publish（草稿 0 → 报名开放 1）
// - 删除：v2 无删除端点 → 保留入口但安全提示，不调用不存在 API / 不回退 PHP。

import adminApi, { type ActivityRow } from '../../../utils/adminApi';

// v2 activities.status: 0=草稿 1=报名开放 2=进行中 3=已结束 4=已取消 5=已下架
const V2_STATUS_TO_FILTER: Record<number, string> = {
  0: 'upcoming',
  1: 'upcoming',
  2: 'ongoing',
  3: 'completed',
  4: 'cancelled',
  5: 'cancelled',
};

/** 当前页原始列表缓存（v2 GET /activities 无 status/search filter，客户端仅按页过滤展示）。 */
let _pageCache: any[] = [];

Page({
  data: {
    loading: true,
    activityList: [] as any[],
    pagination: {
      current_page: 1,
      per_page: 10,
      total: 0,
      total_pages: 1,
    },
    searchKeyword: '',
    filterStatus: '',
    statusOptions: [
      { label: '全部状态', value: 'all' },
      { label: '未开始', value: 'upcoming' },
      { label: '进行中', value: 'ongoing' },
      { label: '已结束', value: 'completed' },
      { label: '已取消', value: 'cancelled' },
    ],
    filterStatusIndex: 0,
    currentActivity: null as any,
    showEditModal: false,
    showDeleteConfirm: false,
    editForm: {
      id: '',
      title: '',
      description: '',
      location: '',
      activity_date: '',
      start_time: '',
      end_time: '',
      max_participants: 10,
      points_reward: 10,
      status: 'upcoming',
      category: '普通活动',
      contact_info: '',
      cover_image: [] as any[],
      enable_certificate: false,
    },
    editFormStatusIndex: 0,
    es: 0,
  },

  onLoad() {
    this.checkLogin();
  },

  onShow() {
    this.loadActivityList(this.data.pagination.current_page);
  },

  checkLogin() {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');

    if (!adminInfo || !adminInfo.id || !token) {
      wx.showToast({ title: '请先登录', icon: 'error', duration: 2000 });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/login-unified/index?role=admin' });
      }, 800);
      return false;
    }

    if (!['super_admin', 'admin'].includes(adminInfo.role)) {
      wx.showToast({ title: '无管理权限', icon: 'error', duration: 2000 });
      setTimeout(() => {
        wx.navigateBack();
      }, 800);
      return false;
    }

    return true;
  },

  /** GET /api/v2/activities —— 本团队活动列表。 */
  loadActivityList(page = 1) {
    if (!this.checkLogin()) return;

    this.setData({ loading: true });
    adminApi
      .listActivities(page, this.data.pagination.per_page)
      .then((res: any) => {
        const raw = (res && Array.isArray(res.items) ? res.items : []) as ActivityRow[];
        _pageCache = raw.map((a) => this.toListView(a));
        const total = (res && res.pagination && res.pagination.total) || 0;
        const total_pages = (res && res.pagination && res.pagination.total_pages) || 1;
        this.setData({
          activityList: _pageCache,
          pagination: {
            current_page: page,
            per_page: this.data.pagination.per_page,
            total: total,
            total_pages: total_pages,
          },
        });
      })
      .catch((err: any) => {
        const code = err && err.code;
        if (code === 'TEAM_SCOPE_REQUIRED') {
          wx.showModal({
            title: '请先选择团队',
            content: '未选择团队，无法查看活动',
            confirmText: '去选择',
            cancelText: '取消',
            success: (r: any) => {
              if (r.confirm) wx.navigateTo({ url: '/pages/teams/select/select' });
            },
          });
        } else if (code === 'FORBIDDEN' || (err && err.status === 403)) {
          wx.showToast({ title: '无权限查看活动', icon: 'none' });
        } else {
          wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
        }
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  /** ActivityRow → 视图（WXML 兼容字段 + public_id 主键）。 */
  toListView(a: ActivityRow) {
    const status = V2_STATUS_TO_FILTER[a.status] || 'upcoming';
    return {
      id: a.public_id,
      title: a.title,
      status: status,
      activity_date: this.formatDate(a.start_time),
      start_time: this.formatTime(a.start_time),
      end_time: this.formatTime(a.end_time),
      location: '',
      current_participants: a.signed_count,
      max_participants: a.quota,
      points_reward: 0,
    };
  },

  handleSearch(e: any) {
    this.setData({ searchKeyword: e.detail.value });
    this.applyClientFilter();
  },

  handleStatusChange(e: any) {
    const index = e.detail.value;
    const selected = this.data.statusOptions[index];
    this.setData({ filterStatus: selected.value, filterStatusIndex: index });
    this.applyClientFilter();
  },

  /** v2 GET /activities 无 status filter → 客户端过滤展示（display only，不伪造后端过滤）。 */
  applyClientFilter() {
    const keyword = (this.data.searchKeyword || '').trim();
    const status = this.data.filterStatus;
    const raw = _pageCache;
    let list = raw;
    if (status && status !== 'all') {
      list = list.filter((a: any) => a.status === status);
    }
    if (keyword) {
      list = list.filter((a: any) => (a.title || '').indexOf(keyword) >= 0);
    }
    this.setData({ activityList: list });
  },

  loadPrevPage() {
    if (this.data.pagination.current_page > 1) {
      this.loadActivityList(this.data.pagination.current_page - 1);
    }
  },

  loadNextPage() {
    if (this.data.pagination.current_page < this.data.pagination.total_pages) {
      this.loadActivityList(this.data.pagination.current_page + 1);
    }
  },

  refreshData() {
    this.loadActivityList(this.data.pagination.current_page);
  },

  /** GET /api/v2/activities/:id → 回填编辑表单。 */
  loadActivityDetail(publicId: string) {
    adminApi
      .getActivity(publicId)
      .then((res: any) => {
        if (!res || !res.activity) throw new Error('empty');
        const a: ActivityRow = res.activity;
        const status = V2_STATUS_TO_FILTER[a.status] || 'upcoming';
        const statusIndex = this.data.statusOptions.findIndex((o) => o.value === status) || 0;
        this.setData({
          currentActivity: a,
          showEditModal: true,
          editFormStatusIndex: statusIndex,
          editForm: {
            id: a.public_id,
            title: a.title,
            description: a.summary || '',
            location: '',
            activity_date: this.formatDate(a.start_time),
            start_time: this.formatTime(a.start_time),
            end_time: this.formatTime(a.end_time),
            max_participants: a.quota,
            points_reward: 0,
            status: status,
            category: '普通活动',
            contact_info: '',
            cover_image: [],
            enable_certificate: false,
          },
        });
      })
      .catch((err: any) => {
        wx.showToast({ title: (err && err.message) || '加载活动详情失败', icon: 'none' });
      });
  },

  goToEdit(e: any) {
    const id = e.currentTarget.dataset.id;
    this.loadActivityDetail(id);
  },

  onCertificateChange(e: any) {
    this.setData({ 'editForm.enable_certificate': e.detail.value });
  },

  handleEditInput(e: any) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({ [`editForm.${field}`]: value });
  },

  handleStatusPickerChange(e: any) {
    const index = e.detail.value;
    const selected = this.data.statusOptions[index];
    this.setData({ 'editForm.status': selected.value, editFormStatusIndex: index });
  },

  getStatusLabel(status: string) {
    if (!status || status === 'all') return '全部状态';
    const option = this.data.statusOptions.find((s) => s.value === status);
    return option ? option.label : '全部状态';
  },

  getStatusText(status: string) {
    const map: Record<string, string> = {
      upcoming: '未开始',
      ongoing: '进行中',
      completed: '已结束',
      cancelled: '已取消',
    };
    return map[status] || status;
  },

  /** PUT /api/v2/activities/:id —— v1 仅标量；nested occurrence/position/slot 重配置在服务端显式拒绝。 */
  saveActivityEdit() {
    const form = this.data.editForm;

    if (!form.title.trim()) {
      wx.showToast({ title: '请输入活动标题', icon: 'error' });
      return;
    }
    if (!form.activity_date) {
      wx.showToast({ title: '请选择活动日期', icon: 'error' });
      return;
    }

    const startTime = this.toEpoch(form.activity_date, form.start_time);
    const endTime = this.toEpoch(form.activity_date, form.end_time);
    if (startTime >= endTime) {
      wx.showToast({ title: '结束时间必须晚于开始时间', icon: 'error' });
      return;
    }

    const patch: any = {
      title: form.title.trim(),
      summary: form.description ? form.description.trim() : null,
      start_time: startTime,
      end_time: endTime,
      quota: Number(form.max_participants) || 0,
    };

    adminApi
      .updateActivity(form.id, patch)
      .then(() => {
        wx.showToast({ title: '修改成功', icon: 'success' });
        this.setData({ showEditModal: false });
        this.loadActivityList(this.data.pagination.current_page);
      })
      .catch((err: any) => {
        const code = err && err.code;
        if (code === 'INVALID_PARAM' || (err && err.status === 400)) {
          wx.showToast({ title: '仅支持基础字段修改（版本/场次/岗位不可在此调整）', icon: 'none' });
        } else {
          wx.showToast({ title: (err && err.message) || '修改失败', icon: 'none' });
        }
      });
  },

  closeEditModal() {
    this.setData({ showEditModal: false });
  },

  showDeleteDialog(e: any) {
    const id = e.currentTarget.dataset.id;
    const activity = this.data.activityList.find((item: any) => item.id === id);
    if (activity) {
      this.setData({ currentActivity: activity, showDeleteConfirm: true });
    }
  },

  /** v2 无删除端点（P31-P1A 冻结范围：create/update/publish）。安全提示，不调用不存在 API。 */
  confirmDelete() {
    this.setData({ showDeleteConfirm: false });
    wx.showModal({
      title: '当前版本不支持删除',
      content: 'v2 后端未提供活动删除接口，请在网页管理端处理。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  cancelDelete() {
    this.setData({ showDeleteConfirm: false });
  },

  /** 查看报名 —— 报名入口（session 列表）。 */
  goToDetail(e: any) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || '';
    wx.navigateTo({
      url: `/pages/admin/activity-signups/activity-signups?id=${id}&title=${encodeURIComponent(title)}`,
    });
  },

  goToCreate() {
    wx.navigateTo({ url: '/pages/admin/activity-create-flow/basic' });
  },

  copyActivity(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.showToast({ title: '正在准备模板...', icon: 'loading', duration: 800 });
    setTimeout(() => {
      wx.navigateTo({ url: `/pages/admin/activity-create-flow/basic?copy_id=${id}` });
    }, 500);
  },

  goBack() {
    wx.navigateBack();
  },

  // ===== helpers =====
  toEpoch(dateStr: string, timeStr: string): number {
    if (!timeStr) timeStr = '00:00';
    const s = `${dateStr} ${timeStr}:00`.replace(/-/g, '/');
    const t = new Date(s).getTime();
    return isNaN(t) ? 0 : Math.floor(t / 1000);
  },

  formatDate(epoch: number) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  formatTime(epoch: number) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
});