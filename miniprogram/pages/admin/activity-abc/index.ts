// pages/admin/activity-abc/index.ts
// P31-P1B：迁移管理端活动视图到 /api/v2/activities（list / detail / update）。
// - 列表：GET /api/v2/activities（public_id）
// - 详情：GET /api/v2/activities/:id
// - 编辑：PUT /api/v2/activities/:id（v1 仅标量；不重配置 nested occurrence/position/slot）
// - 删除：v2 无删除端点 → 保留入口但安全提示，不调用不存在 API / 不回退 PHP。
//
// P34-C4：发布审批接入（旧「直接发布」流程已废弃）。
// - 旧端点 POST /api/v2/activities/:id/publish 已由后端移除，前端不再有直接发布入口。
// - 发布唯一正式路径 = 提交审核 → 审核通过：
//     POST /:id/submit（草稿/已驳回 → 待审核）
//     POST /:id/approve（待审核 → 已通过 + status 报名开放）
//     POST /:id/reject（待审核 → 已驳回，需填原因）
// - 创建恒为草稿；已通过活动编辑保存后后端统一回草稿，需重新提交审核。

import adminApi, {
  type ActivityRow,
  ACTIVITY_AUDIT,
  ACTIVITY_REJECT_REASON_MAX,
  getActivityAuditLabel,
} from '../../../utils/adminApi';

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

    // ===== P34-C4：发布审批 UI 状态 =====
    /** 驳回原因输入弹窗。 */
    showRejectModal: false,
    rejectReason: '',
    rejectTargetId: '',
    /**
     * 是否展示审核（通过/驳回）按钮。
     * 前端无 capability API（见报告 §13）：此处按现有 admin role 做最小判定；
     * 后端仍是最终权威——越权/自审一律由后端 403 兜底，前端不实现安全。
     */
    canReview: false,
  },

  onLoad() {
    this.checkLogin();
    this.setData({ canReview: this.computeCanReview() });
  },

  /**
   * P34-C4 §13：审核能力的最小前端判定。
   * 本项目前端没有 capability/permission API（无 /me、无 permissions 端点），
   * 故按现有 admin architecture（本地 adminInfo.role）做最小判定，仅用于减少无效按钮。
   * 不做全局 RBAC 前端重构；后端 requirePermission('activity.activity.review') 才是最终权威，
   * 越权与自审一律由后端 403 兜底。
   */
  computeCanReview(): boolean {
    const adminInfo = wx.getStorageSync('adminInfo');
    const role = adminInfo && adminInfo.role;
    return role === 'super_admin' || role === 'admin';
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

  /** ActivityRow → 视图（WXML 兼容字段 + public_id 主键 + P34-C4 审批态）。 */
  toListView(a: ActivityRow) {
    const status = V2_STATUS_TO_FILTER[a.status] || 'upcoming';
    const audit = a.audit_status;
    return {
      id: a.public_id,
      title: a.title,
      status: status,
      activity_date: this.formatDate(a.start_time),
      start_time: this.formatTime(a.start_time),
      end_time: this.formatTime(a.end_time),
      location: a.address || '',
      current_participants: a.signed_count,
      max_participants: a.quota,
      points_reward: 0,

      // P34-C4 §5：审批态与生命周期状态严格分离显示。
      audit_status: audit,
      audit_label: getActivityAuditLabel(audit),
      reject_reason: a.reject_reason || '',
      // P34-C4 §6 按钮矩阵。audit_status 缺失/未知时不臆造，一律不显示审批按钮（避免误操作）。
      canSubmit: audit === ACTIVITY_AUDIT.DRAFT || audit === ACTIVITY_AUDIT.REJECTED,
      canApprove: audit === ACTIVITY_AUDIT.PENDING && this.data.canReview,
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
            // N0-E5A-R1：回填活动主地址到「活动地点」输入（此前恒为空串 → 编辑缺口）。
            location: a.address || '',
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

        // P34-C4 §11：已通过活动进入编辑 → 提示"修改后需重新提交审核"。
        // （backend 已冻结：approved/pending/rejected 编辑后统一回 DRAFT。）
        if (a.audit_status === ACTIVITY_AUDIT.APPROVED) {
          wx.showModal({
            title: '修改后需重新审核',
            content: '该活动已审核通过并公开。保存修改后将回到草稿，需重新提交审核；审核期间活动会暂时停止对志愿者公开。',
            showCancel: false,
            confirmText: '我知道了',
          });
        }
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
      // N0-E5A-R1：发送活动主地址（「活动地点」输入）；空 / 空白 → null（服务端再做归一收口）。
      address: form.location && form.location.trim() ? form.location.trim() : null,
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

  /**
   * P34-C4 §7：审批类错误文案。
   * 后端是最终权威；自审（职责分离）403 与"无审核权限"403 必须区分，不能都显示"操作失败"。
   */
  describeApprovalError(err: any): string {
    const status = err && err.status;
    const message: string = (err && err.message) || '';
    if (status === 403) {
      // 后端自审拒绝文案含"职责分离"（activity-admin-service.assertNotSelfReview）。
      if (message.indexOf('职责分离') >= 0) return '不能审核自己创建或提交的活动';
      return '无审核权限';
    }
    if (status === 409) return '状态已变化，请刷新后重试';
    if (status === 404) return '活动不存在或已不可访问';
    return message || '操作失败';
  },

  /** P34-C4 §9：提交审核。成功后以 backend 为准刷新，不本地臆造状态。 */
  submitForReview(e: any) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    wx.showLoading({ title: '提交中...', mask: true });
    adminApi
      .submitActivity(id)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已提交审核', icon: 'success' });
        self.loadActivityList(self.data.pagination.current_page);
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showToast({ title: self.describeApprovalError(err), icon: 'none' });
      });
  },

  /** P34-C4 §10：审核通过。成功后 backend 返回 audit_status=APPROVED + status=SIGNUP_OPEN。 */
  approveActivity(e: any) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    wx.showModal({
      title: '确认审核通过',
      content: '通过后活动将立即对志愿者公开（报名开放）。',
      success(r: any) {
        if (!r.confirm) return;
        wx.showLoading({ title: '处理中...', mask: true });
        adminApi
          .approveActivity(id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '审核通过', icon: 'success' });
            self.loadActivityList(self.data.pagination.current_page);
          })
          .catch((err: any) => {
            wx.hideLoading();
            wx.showToast({ title: self.describeApprovalError(err), icon: 'none' });
          });
      },
    });
  },

  /** P34-C4 §8：驳回必须填写原因 → 打开输入弹窗。 */
  openRejectModal(e: any) {
    const id = e.currentTarget.dataset.id;
    this.setData({ showRejectModal: true, rejectTargetId: id, rejectReason: '' });
  },

  closeRejectModal() {
    this.setData({ showRejectModal: false, rejectReason: '', rejectTargetId: '' });
  },

  onRejectInput(e: any) {
    this.setData({ rejectReason: e.detail.value || '' });
  },

  /** P34-C4 §8：校验（trim 后非空、≤500 字）→ 提交驳回 → 刷新。 */
  confirmReject() {
    const reason = (this.data.rejectReason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请填写驳回原因', icon: 'none' });
      return;
    }
    if (reason.length > ACTIVITY_REJECT_REASON_MAX) {
      wx.showToast({ title: `驳回原因不能超过${ACTIVITY_REJECT_REASON_MAX}字`, icon: 'none' });
      return;
    }
    const id = this.data.rejectTargetId;
    const self = this;
    wx.showLoading({ title: '提交中...', mask: true });
    adminApi
      .rejectActivity(id, reason)
      .then(() => {
        wx.hideLoading();
        self.setData({ showRejectModal: false, rejectReason: '', rejectTargetId: '' });
        wx.showToast({ title: '已驳回', icon: 'success' });
        self.loadActivityList(self.data.pagination.current_page);
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showToast({ title: self.describeApprovalError(err), icon: 'none' });
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