// pages/activity/detail/detail.js - 简化版适配当前系统，保留保险功能

// 引入订阅消息工具
const subscribe = require('../../utils/subscribe')
import activityApi from '../../utils/activityApi';

Page({
  data: {
    activity: null,
    buttonText: "立即报名",
    buttonBgColor: "#07c160",
    isLoggedIn: false,
    hasJoined: false,
    signupStatus: 0, // 0:未报名, 1:已报名待审核, 2:已通过, 3:已参与
    userInfo: null,
    token: null,
    activityId: null,
    contactPerson: '',
    contactPhone: '',
    loading: true,
    errorMsg: '',
    activityStatus: {
      isFull: false,
      remainingSlots: 0,
      totalParticipants: 0
    },
    // 保险相关（平台引导，无伪造二维码 / 硬编码联系人）
    showInsuranceModal: false,
    // 签到相关
    isCheckinActive: false,
    // M4：真实服务记录完成态（来自后端 /service-records/mine，非本地伪造）
    attendanceCompleted: false,
    serviceRecord: null as any,
    // 重复活动相关
    recurrenceInfo: null
  },

  onLoad(options) {
    console.log('页面加载，接收到的参数:', options);

    if (options && options.id) {
      const activityId = options.id;
      this.setData({ activityId });
      
      this.checkLoginStatus();
      this.loadActivityDetail();
    } else {
      wx.showToast({
        title: '活动不存在',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  onShow() {
    this.checkLoginStatus();
    if (this.data.activityId) {
      this.checkSignupStatus();
      this.checkActiveCheckin();
    }
  },

  // 检查登录状态
  checkLoginStatus() {
    const token = wx.getStorageSync('access_token');
    const userInfo = wx.getStorageSync('userInfo');

    if (token && userInfo) {
      this.setData({
        isLoggedIn: true,
        userInfo,
        token
      });
      return true;
    } else {
      this.setData({
        isLoggedIn: false,
        userInfo: null,
        token: null
      });
      return false;
    }
  },

  // M4：真实考勤完成态来自后端 /service-records/mine；详情页据此刷新按钮，绝不本地伪造。
  // 前端无法独立判定「签到中」瞬时态（无 SELF 签到状态 GET），该态交由 sign 页在签到 API 成功后呈现。
  checkActiveCheckin() {
    this.loadAttendanceStatus();
  },

  // M4：根据真实后端状态更新底部按钮（绝不本地伪造签到/签退态）
  updateButtonByStatus() {
    const { signupStatus, attendanceCompleted } = this.data;

    let buttonText = "立即报名";
    let buttonBgColor = "#07c160";

    if (attendanceCompleted) {
      // 后端已生成服务记录（签到+签退完成）→ 真实「已参与」态，不可再操作
      buttonText = "已参与";
      buttonBgColor = "#9e9e9e";
    } else if (signupStatus === 1) {
      buttonText = "待审核";
      buttonBgColor = "#ff9800";
    } else if (signupStatus === 2) {
      // APPROVED 但未完成服务：引导签到（真实签到/签退态由 sign 页依据后端响应呈现）
      buttonText = "立即签到";
      buttonBgColor = "#07c160";
    } else if (signupStatus === 4) {
      buttonText = "报名未通过";
      buttonBgColor = "#9e9e9e";
    } else if (signupStatus === 3) {
      buttonText = "已参与";
      buttonBgColor = "#9e9e9e";
    }

    this.setData({ buttonText, buttonBgColor });
  },

  // 加载活动详情（v2：GET /activities/:id）
  loadActivityDetail() {
    const activityId = this.data.activityId;
    if (!activityId) return;

    this.setData({ loading: true, errorMsg: '' });

    activityApi
      .getActivity(activityId)
      .then((res) => {
        const a: any = (res && res.activity) || {};
        const activity: any = {
          ...a,
          public_id: a.public_id,
          title: a.title || '',
          start_time: a.start_time || '',
          end_time: a.end_time || '',
          summary: a.summary || '',
          quota: a.quota || 0,
          signed_count: a.signed_count || 0,
          status: a.status,
          current_participants: a.signed_count || 0,
          max_participants: a.quota || 0,
          points_reward: 0,
          description: a.summary || '',
          cover_image: '',
          // N0-E5A：读取 V2 正式「活动主地址」（activities.address，经 GET /activities/:id 下发）。
          // 为空时 '待定' 仅为展示 fallback，不代表真实数据。
          address: typeof a.address === 'string' && a.address.trim() ? a.address.trim() : '待定',
          // P1-B3：报名截止（真实后端字段 signup_deadline，epoch 秒；无值不伪造）
          signup_deadline: a.signup_deadline || null,
          signupDeadlineText: a.signup_deadline ? this.formatDateTime(a.signup_deadline) : '',
          // P1-B3：生命周期状态（权威 enum：1 报名中 / 2 进行中 / 3 已结束 / 4 已取消）
          lifecycleStatusText: this.mapLifecycleStatus(a.status),
          signin_radius: 300,
        };
        activity.display_time = this.formatDisplayTime(activity.start_time, activity.end_time);

        const maxParticipants = activity.max_participants || 0;
        const currentParticipants = activity.current_participants || 0;
        const remainingSlots = Math.max(0, maxParticipants - currentParticipants);

        this.setData({
          activity,
          contactPerson: '',
          contactPhone: '',
          activityStatus: {
            isFull: maxParticipants > 0 && remainingSlots <= 0,
            remainingSlots,
            totalParticipants: currentParticipants,
          },
          loading: false,
        });

        if (this.data.isLoggedIn) {
          this.fetchSignupForm();
          this.checkSignupStatus();
          this.loadAttendanceStatus();
        }
      })
      .catch((err: any) => {
        console.error('加载活动详情失败:', err);
        let msg = '网络错误';
        if (err && err.code === 'TEAM_SCOPE_REQUIRED') msg = '请先在「我的团队」中选择团队';
        else if (err && err.status === 404) msg = '活动不存在';
        else if (err && err.message) msg = err.message;
        this.setData({ errorMsg: msg, loading: false });
      });
  },

  // 处理活动数据
  processActivityData(activity) {
    if (!activity) return;

    if (activity.start_time) {
      activity.display_time = this.formatDisplayTime(activity.start_time, activity.end_time);
    }

    // N0-E5A：活动主地址为 activity.address（V2 已不存在 legacy activity.location）。
    activity.address = activity.address || '待定';
    activity.current_participants = activity.current_participants || 0;
    activity.max_participants = activity.max_participants || 0;
    activity.points_reward = activity.points_reward || 0;
  },

  // 处理重复活动信息
  processRecurrenceInfo(activity) {
    if (!activity) return;
    
    if (activity.recurrence_pattern && activity.recurrence_pattern !== 'once' && activity.recurrence_pattern !== '') {
      let recurrenceText = '';
      let recurrenceDetail = '';
      
      switch(activity.recurrence_pattern) {
        case 'daily': 
          recurrenceText = '每天'; 
          recurrenceDetail = '每日重复';
          break;
        case 'weekly': 
          recurrenceText = '每周'; 
          recurrenceDetail = '每周重复';
          break;
        case 'monthly': 
          recurrenceText = '每月'; 
          recurrenceDetail = '每月重复';
          break;
        default: 
          recurrenceText = activity.recurrence_pattern;
          recurrenceDetail = activity.recurrence_pattern;
      }
      
      if (activity.recurrence_days) {
        let days = [];
        if (typeof activity.recurrence_days === 'string') {
          days = activity.recurrence_days.split(',').filter(d => d.trim() !== '');
        } else if (Array.isArray(activity.recurrence_days)) {
          days = activity.recurrence_days;
        }
        
        if (days.length > 0) {
          recurrenceText += ' (';
          
          if (activity.recurrence_pattern === 'weekly') {
            const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            recurrenceText += days.map(d => {
              const dayNum = parseInt(d);
              return weekdays[dayNum] || d;
            }).join('、');
          } else {
            recurrenceText += days.join('、') + '日';
          }
          
          recurrenceText += ')';
        }
      }
      
      if (activity.recurrence_start_date && activity.recurrence_end_date) {
        const startDate = this.formatDate(activity.recurrence_start_date);
        const endDate = this.formatDate(activity.recurrence_end_date);
        recurrenceDetail = `${recurrenceText} · ${startDate} 至 ${endDate}`;
      } else {
        recurrenceDetail = recurrenceText;
      }
      
      this.setData({
        recurrenceInfo: {
          text: recurrenceText,
          detail: recurrenceDetail,
          pattern: activity.recurrence_pattern,
          days: activity.recurrence_days,
          startDate: activity.recurrence_start_date,
          endDate: activity.recurrence_end_date
        }
      });
      
      console.log('重复活动信息:', this.data.recurrenceInfo);
    } else {
      this.setData({ recurrenceInfo: null });
    }
  },

  // 格式化日期显示
  formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr.replace(/-/g, '/'));
      if (isNaN(date.getTime())) return dateStr;
      
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${year}.${month}.${day}`;
    } catch (error) {
      return dateStr;
    }
  },

  // 格式化显示时间
  formatDisplayTime(startTime, endTime) {
    if (!startTime) return '';
    
    try {
      const start = new Date(startTime.replace(/-/g, '/'));
      const end = endTime ? new Date(endTime.replace(/-/g, '/')) : null;
      
      const month = start.getMonth() + 1;
      const day = start.getDate();
      const startHours = start.getHours().toString().padStart(2, '0');
      const startMinutes = start.getMinutes().toString().padStart(2, '0');
      
      if (end) {
        const endHours = end.getHours().toString().padStart(2, '0');
        const endMinutes = end.getMinutes().toString().padStart(2, '0');
        return `${month}月${day}日 ${startHours}:${startMinutes}-${endHours}:${endMinutes}`;
      }
      
      return `${month}月${day}日 ${startHours}:${startMinutes}`;
    } catch (error) {
      return startTime;
    }
  },

  /** P1-B3：活动生命周期状态 → 权威展示文本（与 workers repository ACTIVITY_STATUS 对齐：1 报名中 / 2 进行中 / 3 已结束 / 4 已取消）。 */
  mapLifecycleStatus(status: number): string {
    switch (status) {
      case 1: return '报名中';
      case 2: return '进行中';
      case 3: return '已结束';
      case 4: return '已取消';
      default: return '';
    }
  },

  // 检查报名状态（v2：GET /activities/:id/signups/me）
  checkSignupStatus() {
    const activityId = this.data.activityId;
    if (!activityId || !this.data.isLoggedIn) return;

    activityApi
      .getSignupMe(activityId)
      .then((res) => {
        const outer = (res && res.signup) || null;
        // SignupReadView: { activity_public_id, user_public_id, signup:{ review_status, status, ... } }
        const inner = outer && outer.signup ? outer.signup : outer;
        let status = 0;
        if (inner && inner.status === 1) {
          // status=1(REGISTERED)；review_status=1(APPROVED) 才可签到
          status = inner.review_status === 1 ? 2 : 1;
        }
        this.setData({ hasJoined: status > 0, signupStatus: status });
        this.updateButtonByStatus();
      })
      .catch(() => {
        // 未报名或无权限查看：保持未报名态，绝不回退 legacy PHP
        this.setData({ hasJoined: false, signupStatus: 0 });
      });
  },

  // M4：真实考勤完成态刷新（后端 /service-records/mine，SELF）。
  // 仅当存在本活动的服务记录时，才判定为「已参与」；绝不本地伪造签到/签退态。
  loadAttendanceStatus() {
    const activity = this.data.activity;
    if (!this.data.isLoggedIn || !activity || !activity.public_id) return;
    activityApi
      .getServiceRecordsMine(50)
      .then((res: any) => {
        const records = (res && res.records) || [];
        const rec = records.find((r: any) => r.activity_public_id === activity.public_id);
        if (rec) {
          this.setData({ attendanceCompleted: true, serviceRecord: rec });
        } else {
          this.setData({ attendanceCompleted: false, serviceRecord: null });
        }
        this.updateButtonByStatus();
      })
      .catch(() => {
        // 网络/权限失败：保持现状，绝不回退 legacy PHP 或伪造状态
      });
  },

  // 获取报名状态文本
  getSignupStatusText(status) {
    switch (status) {
      case 1: return '您的报名正在审核中';
      case 2: return '您已通过审核，可以签到';
      case 3: return '您已参与此活动';
      default: return '您已报名此活动';
    }
  },

  // 主按钮点击处理
  handleMainButtonClick() {
    const { signupStatus, attendanceCompleted } = this.data;

    if (attendanceCompleted) {
      wx.showToast({ title: '您已完成此活动的志愿服务', icon: 'none' });
      return;
    }
    if (signupStatus === 2) {
      // 已通过审核：进入「参与准备 → 签到」闭环
      this.proceedToCheckin();
    } else if (signupStatus === 1) {
      wx.showToast({ title: '您的报名正在审核中', icon: 'none' });
    } else if (signupStatus === 3) {
      wx.showToast({ title: '您已参与此活动', icon: 'none' });
    } else if (signupStatus === 4) {
      wx.showToast({ title: '报名未通过，无法参与', icon: 'none' });
    } else {
      this.handleJoinClick();
    }
  },

  // 点击报名按钮
  handleJoinClick() {
    if (this.data.hasJoined) {
      wx.showToast({
        title: this.getSignupStatusText(this.data.signupStatus),
        icon: 'none'
      });
      return;
    }

    if (!this.data.isLoggedIn) {
      wx.navigateTo({
        url: '/pages/login-unified/index'
      });
      return;
    }

    if (this.data.activityStatus.isFull) {
      wx.showToast({
        title: '活动名额已满',
        icon: 'none'
      });
      return;
    }

    this.showConfirmDialog();
  },

  // 显示确认报名弹窗
  showConfirmDialog() {
    const activityName = this.data.activity ? this.data.activity.title : '活动';
    const activity = this.data.activity;
    
    wx.showModal({
      title: '确认报名',
      content: `确认报名「${activityName}」吗？\n\n活动前建议购买保险保障安全`,
      confirmText: '确认报名',
      cancelText: '购买保险',
      success: (res) => {
        if (res.confirm) {
          this.processJoin()
        } else if (res.cancel) {
          this.onBuyInsurance();
        }
      }
    });
  },

  // 处理报名入口（v2：POST /activities/:id/signups）—— M3：真实状态以后端为准，绝不本地伪造。
  processJoin() {
    if (this.data.hasJoined) {
      wx.showToast({ title: this.getSignupStatusText(this.data.signupStatus), icon: 'none' });
      return;
    }
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login-unified/index' });
      return;
    }
    if (this.data.activityStatus.isFull) {
      wx.showToast({ title: '活动名额已满', icon: 'none' });
      return;
    }
    // M3 P20：活动绑定了报名动态表单且尚未提交 → 先弹出表单，提交后再报名
    if (this.data.signupForm && !this.data.formSubmissionPublicId) {
      this.setData({ showFormModal: true, formError: '', formAnswers: {} });
      return;
    }
    this.doSignup(this.data.formSubmissionPublicId || undefined);
  },

  /** 真正发起报名；报名结果（review_status）一律以后端返回为准。 */
  doSignup(formSubmissionPublicId?: string) {
    const activityId = this.data.activityId;
    wx.showLoading({ title: '报名中...', mask: true });

    activityApi
      .signup(activityId, formSubmissionPublicId)
      .then((res: any) => {
        wx.hideLoading();
        const inner = res && res.signup ? res.signup : null;
        let status = 0;
        if (inner && inner.status === 1) {
          // review_status: 1=APPROVED, 2=REJECTED, 0=PENDING
          if (inner.review_status === 1) status = 2;
          else if (inner.review_status === 2) status = 4;
          else status = 1;
        }
        this.setData({
          hasJoined: status > 0,
          signupStatus: status,
          qualificationBlocked: false,
          qualificationReasons: [],
        });
        this.updateButtonByStatus();

        subscribe.subscribeAfterSignup().catch(() => {});
        if (status === 2) {
          wx.showToast({ title: '审核已通过，请前往签到', icon: 'success', duration: 1500 });
          this.proceedToCheckin();
        } else if (status === 4) {
          wx.showToast({ title: '报名未通过审核', icon: 'none', duration: 2000 });
        } else {
          wx.showToast({ title: '报名已提交，等待审核', icon: 'none', duration: 1500 });
        }
      })
      .catch((err: any) => {
        wx.hideLoading();
        const code = err && err.code ? String(err.code).toUpperCase() : '';
        if (code === 'QUALIFICATION_REQUIRED') {
          // B5：资格门由后端统一 enforcement；前端仅展示引导，绝不绕过
          const reasons = (err.details && err.details.reasons ? String(err.details.reasons) : '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
          this.setData({ qualificationBlocked: true, qualificationReasons: reasons });
          wx.showModal({
            title: '尚不具备报名资格',
            content: this.qualificationGuidance(reasons),
            showCancel: false,
            confirmText: '我知道了',
          });
          return;
        }
        if (code === 'SIGNUP_ALREADY_EXISTS' || code === 'CONFLICT') {
          // 不伪造状态：回源后端真实报名状态
          this.checkSignupStatus();
          return;
        }
        if (code === 'SIGNUP_FORM_REQUIRED') {
          wx.showToast({ title: '请先填写报名表单', icon: 'none' });
          if (this.data.signupForm) this.setData({ showFormModal: true });
          return;
        }
        if (code === 'ACTIVITY_SIGNUP_CLOSED') {
          wx.showToast({ title: '活动报名已关闭', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '报名失败', icon: 'none' });
      });
  },

  /** 资格引导文案（reasons token → 人话）。 */
  qualificationGuidance(reasons: string[]): string {
    const map: Record<string, string> = {
      IDENTITY_REQUIRED: '完成实名认证',
      PHONE_REQUIRED: '绑定手机号',
      TRAINING_EXAM_REQUIRED: '通过初始培训与考试',
    };
    if (!reasons || reasons.length === 0) {
      return '请先完成志愿者资格认证（实名、绑手机、初始培训考试）。';
    }
    return '请先完成：' + reasons.map((r) => map[r] || r).join('、') + '。';
  },

  // ========== M3：P20 报名动态表单消费（前端 consumer） ==========
  /** 拉取本活动的报名动态表单（若无绑定 → 404 → 普通报名）。 */
  fetchSignupForm() {
    const activityId = this.data.activityId;
    if (!activityId || !this.data.isLoggedIn) return;
    activityApi
      .getSignupForm(activityId)
      .then((view: any) => {
        if (view && Array.isArray(view.fields) && view.fields.length > 0) {
          const fields = view.fields.slice().sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
          this.setData({ signupForm: { ...view, fields } as any, formAnswers: {} });
        } else {
          this.setData({ signupForm: null });
        }
      })
      .catch(() => {
        // 404 / 无绑定表单 → 普通报名，不阻塞
        this.setData({ signupForm: null });
      });
  },

  openFormModal() {
    this.setData({ showFormModal: true, formError: '', formAnswers: {} });
  },

  closeFormModal() {
    this.setData({ showFormModal: false });
  },

  onFormInput(e: any) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`formAnswers.${key}`]: e.detail.value });
  },

  onFormSwitch(e: any) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`formAnswers.${key}`]: e.detail.value === true });
  },

  onFormRadio(e: any) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`formAnswers.${key}`]: e.detail.value });
  },

  onFormMulti(e: any) {
    // checkbox-group bindchange 直接给已选数组；存为 { [value]: true } 便于 WXML 成员访问渲染勾选态
    const key = e.currentTarget.dataset.key;
    const arr: string[] = e.detail.value || [];
    const obj: Record<string, boolean> = {};
    for (const v of arr) obj[v] = true;
    this.setData({ [`formAnswers.${key}`]: obj });
  },

  /** 提交报名表单 → 拿到 submission public_id → 再发起报名。 */
  submitSignupForm() {
    const form = this.data.signupForm;
    if (!form) return;
    // 必填校验（与后端 strictRequired 对齐）
    for (const f of form.fields) {
      if (f.required) {
        const v = this.data.formAnswers[f.key];
        let empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
        if (!empty && f.type === 'multi_select') {
          const isObj = v && typeof v === 'object' && !Array.isArray(v);
          empty = isObj ? Object.keys(v).length === 0 : Array.isArray(v) ? v.length === 0 : true;
        }
        if (empty) {
          this.setData({ formError: `请填写「${f.label}」` });
          return;
        }
      }
    }
    // 构造后端 answers：multi_select 由对象转为数组
    const answers: Record<string, unknown> = {};
    for (const f of form.fields) {
      const v = this.data.formAnswers[f.key];
      if (v === undefined) continue;
      if (f.type === 'multi_select' && v && typeof v === 'object' && !Array.isArray(v)) {
        answers[f.key] = Object.keys(v).filter((k: string) => v[k]);
      } else {
        answers[f.key] = v;
      }
    }
    this.setData({ formError: '', formSubmitting: true });
    const newPublicId = generateUlid();
    activityApi
      .submitFormSubmission({
        consumerType: 'activity.signup',
        consumerPublicId: this.data.activityId,
        versionPublicId: form.version_public_id,
        newPublicId,
        answers,
      })
      .then((res: any) => {
        const subId = res && res.submission ? res.submission.public_id : newPublicId;
        this.setData({ formSubmitting: false, showFormModal: false, formSubmissionPublicId: subId });
        this.doSignup(subId);
      })
      .catch((err: any) => {
        this.setData({ formSubmitting: false });
        wx.showToast({ title: (err && err.message) || '表单提交失败', icon: 'none' });
      });
  },

  /**
   * 参与准备（v2）：GET setup → 找到可确定性物化的 occurrence → POST ensure 拿到 participation_public_id，
   * 然后跳转具体活动考勤执行页（/pages/sign/activity/index）完成签到 / 签退闭环。
   * 注：pages/sign/sign 已升为 tabBar 中心 Hub，navigateTo 不可跳转 tabBar 页、
   *     switchTab 又不支持 query，故带参执行流改由 NON-TAB 执行页承接。
   * 若活动尚未通过审核 / 需人工排班（无 can_ensure 的 occurrence），则仅提示，不强制跳转。
   */
  proceedToCheckin() {
    const activityId = this.data.activityId;
    const activity = this.data.activity || ({} as any);

    activityApi
      .getParticipationSetup(activityId)
      .then((setup) => {
        const occurrences = (setup && setup.occurrences) || [];
        const occ = occurrences.find((o: any) => o.can_ensure === true);
        if (!occ) {
          wx.showToast({
            title: '报名已提交，审核/排班后可在「签到」页签到',
            icon: 'none',
            duration: 2000,
          });
          return Promise.resolve(null);
        }
        return activityApi
          .ensureParticipation(activityId, occ.public_id)
          .then((res) => {
            const ppid = res && res.participation && res.participation.public_id;
            if (!ppid) {
              wx.showToast({ title: '报名已提交，可在「签到」页签到', icon: 'none', duration: 2000 });
              return null;
            }
            const title = encodeURIComponent(activity.title || '志愿活动');
            const points = activity.points_reward || 10;
            const radius = activity.signin_radius || 300;
            const status = activity.status === 1 || activity.status === 2 ? 'ongoing' : 'ended';
            wx.navigateTo({
              url: `/pages/sign/activity/index?activityId=${activityId}&participationId=${ppid}&activityName=${title}&points=${points}&radius=${radius}&status=${status}`,
            });
            return ppid;
          });
      })
      .catch((err: any) => {
        console.error('参与准备失败', err);
        wx.showToast({ title: '报名已提交，稍后可在「签到」页签到', icon: 'none', duration: 2000 });
      });
  },

  // ========== 保险购买功能 ==========
  onBuyInsurance() {
    this.setData({
      showInsuranceModal: true
    });
  },

  closeInsuranceModal() {
    this.setData({
      showInsuranceModal: false
    });
  },

  // P1-B3：已移除 saveInsuranceQRCode（伪造保险二维码下载）。保险购买改为平台引导，无伪造二维码。

  // ========== 辅助函数 ==========
  goBack() {
    wx.navigateBack();
  },

  formatDateTime(isoString) {
    if (!isoString) return '';

    try {
      const date = new Date(isoString.replace(/-/g, '/'));
      if (isNaN(date.getTime())) return isoString;

      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');

      return `${year}-${month}-${day} ${hours}:${minutes}`;
    } catch (error) {
      return isoString;
    }
  },

  onShareAppMessage() {
    const title = this.data.activity ? `${this.data.activity.title} - 志愿者活动` : '志愿者活动';
    return {
      title,
      path: `pages/detail/detail?id=${this.data.activityId}`
    };
  }
});