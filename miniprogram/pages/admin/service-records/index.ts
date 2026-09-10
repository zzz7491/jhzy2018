// pages/admin/service-records/index.ts
// P35-C3：服务时长人工调整「申请 → 双人审批」管理端 UI（对接 P35-C2 冻结后端）。
//
// 纪律：
// - 只做管理端展示/交互；后端为最终权威（权限、快照、并发、原子落地全部由后端裁决）。
// - 旧 direct adjust（POST /service-records/:id/adjust）已在 P35-C2 移除，前端绝不调用。
// - UI 语义（§4）：主时长恒为「当前有效时长」；PENDING 的「申请调整为」只出现在待审核区，
//   绝不写回主时长；approve 成功后以后端为准刷新，主时长才更新（无 optimistic UI）。
// - 不暴露 numeric 内部 ID：一律使用 public_id。
// - P35-C3B：P35 权限【一律】来自后端 capabilities 投影（真实 permission 求值），
//   前端不再按 legacy role 猜测 adjust/review 能力；legacy role 仅用于「能否进入管理台」。

import adminApi, {
  ADJUSTMENT_MINUTES_MAX,
  ADJUSTMENT_REJECT_REASON_MAX,
  ADJUSTMENT_STATUS,
  AdjustmentCapabilities,
  AdjustmentRequestView,
  ServiceRecordView,
  getAdjustmentStatusLabel,
} from '../../../utils/adminApi';

/** 服务记录列表行视图（仅 public_id + 业务字段）。 */
interface ServiceRecordRowView {
  public_id: string;
  minutes: number;
  points_awarded_units: number;
  settlement_status: number;
  business_service_date: string;
  user_public_id: string;
  activity_public_id: string;
  display_date: string;
}

/** 调整申请行视图（仅 public_id + 业务字段，禁 numeric requester/reviewer/team/id）。 */
interface AdjustmentRowView {
  public_id: string;
  status: number;
  status_label: string;
  requested_minutes: number;
  old_minutes_snapshot: number;
  reason: string;
  request_time: string;
  /** P35-C3B：申请人安全显示身份（display_name 优先，回退 public_id；绝不回退 numeric id）。 */
  requester_label: string;
  is_pending: boolean;
  can_approve: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ===== legacy 管理台「进入门」角色集合（P35-C3B：仅用于能否进入管理台） =====
//
// 只读审计结论（见 FINAL REPORT · REAL_FRONTEND_ROLE_MODEL）：
//   - adminInfo.role 仅由 legacy 管理端登录写入，真实取值集合 = { super_admin, admin, verifier, auditor }；
//   - 本项目前端【没有】v2 capability / permission API 调用入口（页面侧），
//     也不含任何 v2 RBAC 角色码（platform_super_admin / team_owner / team_admin / team_auditor ...）。
//
// 【本集合只决定「能否进入本管理台」，绝不用于推断 service.record.adjust / service.record.review】：
//   - verifier（核销员）不属于本审批台，一律在 checkLogin 拦截；
//   - P35 的 submit / review 能力全部来自后端 capabilities（见 loadAdjustments）。
const CONSOLE_ENTRY_ROLES: string[] = ['super_admin', 'admin', 'auditor'];

/** 读取当前管理端角色（缺失时返回空串）。 */
function readAdminRole(): string {
  const adminInfo = wx.getStorageSync('adminInfo');
  return (adminInfo && adminInfo.role) || '';
}

Page({
  data: {
    loading: false,
    hasTeam: true,

    records: [] as ServiceRecordRowView[],
    selected: null as ServiceRecordRowView | null,
    /** 主时长：恒为「当前有效时长」，绝不被 PENDING 请求的申请值覆盖。 */
    currentMinutes: 0,

    adjustments: [] as AdjustmentRowView[],
    /** 当前是否存在 PENDING（用于禁用重复提交 + 待审核区展示）。 */
    pendingAdjustment: null as AdjustmentRowView | null,

    // 申请表单
    requestMinutes: '',
    requestReason: '',
    submitting: false,

    // P35-C3B：能力来自后端 capabilities 投影（真实 permission），非 legacy role 推断。
    canReview: false,
    canRequest: false,
    /** 是否已从后端拿到 capabilities（未拿到前不显示"仅可审核"提示，避免误判）。 */
    capabilitiesLoaded: false,

    // 拒绝原因弹窗
    showRejectModal: false,
    rejectReason: '',
    rejectTargetId: '',
    busyId: '',
  },

  onLoad() {
    this.checkLogin();
  },

  onShow() {
    if (this.checkLogin()) {
      this.loadRecords();
    }
  },

  onPullDownRefresh() {
    this.loadRecords().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * P35-C3B：进入门。仅校验登录态 + 是否属于管理台（legacy role）。
   * 【P35 的 submit / review 能力不在此判定】——一律以后端 capabilities 为准。
   * 后端 requirePermission 仍是最终权威（越权/自审由后端 403 兜底）。
   */
  checkLogin(): boolean {
    const adminInfo = wx.getStorageSync('adminInfo');
    const token = wx.getStorageSync('access_token');
    if (!adminInfo || !adminInfo.id || !token) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return false;
    }
    // 非本管理台角色（verifier 核销员 / 未知角色）一律拦截；后端 requirePermission 仍是最终权威。
    if (CONSOLE_ENTRY_ROLES.indexOf(readAdminRole()) < 0) {
      wx.showToast({ title: '无管理权限', icon: 'none' });
      return false;
    }
    return true;
  },

  /** GET /service-records —— 当前团队服务记录列表。 */
  loadRecords(): Promise<void> {
    this.setData({ loading: true });
    return adminApi
      .listServiceRecords(50)
      .then((res: any) => {
        const raw = (res && Array.isArray(res.records) ? res.records : []) as ServiceRecordView[];
        const records = raw.map((r) => this.toRecordView(r));
        const selectedPub = this.data.selected ? this.data.selected.public_id : '';
        const selected = records.find((r) => r.public_id === selectedPub) || null;
        this.setData({
          hasTeam: true,
          records,
          selected,
          currentMinutes: selected ? selected.minutes : 0,
        });
        if (selected) {
          return this.loadAdjustments(selected.public_id);
        }
        this.setData({ adjustments: [], pendingAdjustment: null });
        return undefined;
      })
      .catch((err: any) => {
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') {
          this.setData({ hasTeam: false });
        }
        wx.showToast({ title: this.describeAdjustmentError(err), icon: 'none' });
      });
  },

  toRecordView(r: ServiceRecordView): ServiceRecordRowView {
    return {
      public_id: r.public_id,
      minutes: r.minutes,
      points_awarded_units: r.points_awarded_units,
      settlement_status: r.settlement_status,
      business_service_date: r.business_service_date || '',
      user_public_id: r.user_public_id,
      activity_public_id: r.activity_public_id,
      display_date: r.business_service_date || formatTime(r.created_at),
    };
  },

  /** 选择某条服务记录 → 展示其当前有效时长 + 调整历史。 */
  selectRecord(e: any) {
    const pub = e.currentTarget.dataset.id;
    const selected = this.data.records.find((r) => r.public_id === pub) || null;
    this.setData({
      selected,
      currentMinutes: selected ? selected.minutes : 0,
      requestMinutes: '',
      requestReason: '',
    });
    if (selected) this.loadAdjustments(selected.public_id);
  },

  /**
   * GET /service-records/:id/adjustments —— 某服务记录的申请历史（newest first）。
   * P35-C3B：同响应携带后端 capabilities（真实 permission 求值结果），据此设置
   * canRequest / canReview —— 前端不再按 legacy role 推断 P35 权限。
   */
  loadAdjustments(serviceRecordPublicId: string): Promise<void> {
    return adminApi
      .listServiceRecordAdjustments(serviceRecordPublicId)
      .then((res: any) => {
        const raw = (res && Array.isArray(res.adjustments) ? res.adjustments : []) as AdjustmentRequestView[];
        const caps = (res && res.capabilities ? res.capabilities : null) as AdjustmentCapabilities | null;
        const canReview = caps ? !!caps.can_review_adjustment : this.data.canReview;
        const adjustments = raw.map((a) => this.toAdjustmentView(a, canReview));
        const pending = adjustments.find((a) => a.is_pending) || null;
        const patch: any = { adjustments, pendingAdjustment: pending };
        if (caps) {
          patch.canReview = !!caps.can_review_adjustment;
          patch.canRequest = !!caps.can_submit_adjustment;
          patch.capabilitiesLoaded = true;
        }
        this.setData(patch);
      })
      .catch((err: any) => {
        wx.showToast({ title: this.describeAdjustmentError(err), icon: 'none' });
      });
  },

  toAdjustmentView(a: AdjustmentRequestView, canReview: boolean): AdjustmentRowView {
    const isPending = a.status === ADJUSTMENT_STATUS.PENDING;
    return {
      public_id: a.public_id,
      status: a.status,
      status_label: getAdjustmentStatusLabel(a.status),
      requested_minutes: a.requested_minutes,
      old_minutes_snapshot: a.old_minutes_snapshot,
      reason: a.reason,
      request_time: formatTime(a.requested_at),
      // P35-C3B：申请人安全显示身份 —— display_name 优先，回退 public_id（ULID）；
      // 绝不回退 numeric requester_id（后端投影亦不提供）。
      requester_label: a.requester ? a.requester.display_name || a.requester.public_id : '',
      is_pending: isPending,
      // §2E/G：仅具备审核能力 且 处于 PENDING 才展示审核操作；申请人自审由后端 403 兜底。
      can_approve: isPending && canReview,
    };
  },

  onRequestMinutesInput(e: any) {
    this.setData({ requestMinutes: e.detail.value || '' });
  },

  onRequestReasonInput(e: any) {
    this.setData({ requestReason: e.detail.value || '' });
  },

  /**
   * §8：提交调整申请。
   * - 分钟数：整数、0–525600；原因：trim 后 1–500。
   * - 成功后清空输入 + 刷新 history；【不】改变主时长（不假装时长已变更）。
   * - 已存在 PENDING → 前端拦截重复提交；后端 409 ADJUSTMENT_PENDING_EXISTS 仍是最终权威。
   */
  submitAdjustment() {
    const selected = this.data.selected;
    if (!selected) {
      wx.showToast({ title: '请先选择服务记录', icon: 'none' });
      return;
    }
    // P35-C3B：提交能力来自后端 capabilities（非 legacy role）。后端 403 仍是最终权威。
    if (!this.data.canRequest) {
      wx.showToast({ title: '当前角色不可发起调整申请', icon: 'none' });
      return;
    }
    if (this.data.pendingAdjustment) {
      wx.showToast({ title: '该服务记录已有待审核申请', icon: 'none' });
      return;
    }
    const rawMinutes = (this.data.requestMinutes || '').trim();
    const minutes = Number(rawMinutes);
    if (rawMinutes === '' || !Number.isInteger(minutes)) {
      wx.showToast({ title: '请输入整数分钟数', icon: 'none' });
      return;
    }
    if (minutes < 0 || minutes > ADJUSTMENT_MINUTES_MAX) {
      wx.showToast({ title: `分钟数需在 0–${ADJUSTMENT_MINUTES_MAX} 之间`, icon: 'none' });
      return;
    }
    const reason = (this.data.requestReason || '').trim();
    if (reason === '') {
      wx.showToast({ title: '请填写调整原因', icon: 'none' });
      return;
    }
    if (reason.length > ADJUSTMENT_REJECT_REASON_MAX) {
      wx.showToast({ title: `调整原因不能超过${ADJUSTMENT_REJECT_REASON_MAX}字`, icon: 'none' });
      return;
    }

    const self = this;
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });
    adminApi
      .requestServiceRecordAdjustment(selected.public_id, { requested_minutes: minutes, reason })
      .then(() => {
        wx.hideLoading();
        // 清空输入；仅刷新 history（不改变主时长）。
        self.setData({ submitting: false, requestMinutes: '', requestReason: '' });
        wx.showToast({ title: '已提交申请，待审核', icon: 'success' });
        self.loadAdjustments(selected.public_id);
      })
      .catch((err: any) => {
        wx.hideLoading();
        self.setData({ submitting: false });
        // §7 STALE / PENDING_EXISTS 显式 UX。
        if (err && err.status === 409 && self.reasonOf(err) === 'adjustment_stale') {
          self.showStaleNotice();
          return;
        }
        wx.showToast({ title: self.describeAdjustmentError(err), icon: 'none' });
      });
  },

  /**
   * §9：审批通过。先确认动作；成功后以后端为准刷新 service record + history。
   * 不做 optimistic UI；主时长由后端响应刷新后才更新。
   */
  approveAdjustment(e: any) {
    const id = e.currentTarget.dataset.id;
    const selected = this.data.selected;
    if (!selected) return;
    const self = this;
    wx.showModal({
      title: '确认审批通过',
      content: '通过后该服务记录的有效时长将立即更新为新分钟数，并写入审计。',
      success(r: any) {
        if (!r.confirm) return;
        wx.showLoading({ title: '处理中...', mask: true });
        adminApi
          .approveServiceRecordAdjustment(id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已批准', icon: 'success' });
            // 刷新 service record（主时长）+ history，全部以后端为准。
            self.loadRecords().then(() => self.loadAdjustments(selected.public_id));
          })
          .catch((err: any) => {
            wx.hideLoading();
            if (err && err.status === 409 && self.reasonOf(err) === 'adjustment_stale') {
              self.showStaleNotice();
              self.loadRecords().then(() => self.loadAdjustments(selected.public_id));
              return;
            }
            wx.showToast({ title: self.describeAdjustmentError(err), icon: 'none' });
          });
      },
    });
  },

  /** §10：拒绝 —— 必须先输入 review reason。 */
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

  /** §10：校验（trim 后 1–500）→ 提交拒绝 → 刷新 history（主时长不变）。 */
  confirmReject() {
    const reason = (this.data.rejectReason || '').trim();
    if (reason === '') {
      wx.showToast({ title: '请填写拒绝原因', icon: 'none' });
      return;
    }
    if (reason.length > ADJUSTMENT_REJECT_REASON_MAX) {
      wx.showToast({ title: `拒绝原因不能超过${ADJUSTMENT_REJECT_REASON_MAX}字`, icon: 'none' });
      return;
    }
    const id = this.data.rejectTargetId;
    const selected = this.data.selected;
    const self = this;
    wx.showLoading({ title: '提交中...', mask: true });
    adminApi
      .rejectServiceRecordAdjustment(id, reason)
      .then(() => {
        wx.hideLoading();
        self.setData({ showRejectModal: false, rejectReason: '', rejectTargetId: '' });
        wx.showToast({ title: '已拒绝', icon: 'success' });
        // 仅刷新 history（主时长保持不变）。
        if (selected) self.loadAdjustments(selected.public_id);
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showToast({ title: self.describeAdjustmentError(err), icon: 'none' });
      });
  },

  /** 读取后端 conflict token（error.details.reason）。 */
  reasonOf(err: any): string {
    return (err && err.details && err.details.reason) || '';
  },

  /**
   * §7：STALE_REQUEST 显式 UX —— 明确提示需重新提交新的调整申请。
   * 【不】自动 retry，【不】自动刷新 snapshot 后 approve。
   */
  showStaleNotice() {
    wx.showModal({
      title: '记录已发生变化',
      content: '该服务记录已被其他操作修改，当前申请已失效。需要重新提交新的调整申请。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /** 统一错误文案（区分 400 / 403 / 404 / 409 各稳定 token）。 */
  describeAdjustmentError(err: any): string {
    const status = err && err.status;
    const code = err && err.code;
    const reason = this.reasonOf(err);
    if (code === 'TEAM_SCOPE_REQUIRED') return '请先选择团队';
    if (status === 400 || code === 'INVALID_PARAM') return '输入不合法：请检查分钟数与原因';
    if (status === 403) return '无权限，或不能审批自己提交的申请';
    if (status === 404) return '服务记录或申请不存在（或不属于当前团队）';
    if (status === 409) {
      if (reason === 'adjustment_stale') return '记录已发生变化，需要重新提交新的调整申请';
      if (reason === 'adjustment_pending_exists') return '该服务记录已有待审核申请，请先处理';
      if (reason === 'adjustment_invalid_transition') return '该申请状态已变化，请刷新后重试';
      if (reason === 'adjustment_not_allowable') return '当前服务记录状态不可发起调整';
      return '状态冲突，请刷新后重试';
    }
    if (err && err.isNetwork) return '网络异常，请重试';
    return (err && err.message) || '操作失败';
  },

  goBack() {
    wx.navigateBack();
  },
});
