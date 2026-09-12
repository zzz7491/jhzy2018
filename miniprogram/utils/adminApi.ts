// utils/adminApi.ts
// 嘉禾志愿 2.0 管理端统一 v2 client（P31-P1B）。
// 仅对接 /api/v2 后端；绝不调用 legacy PHP 端点。
// 复用与 activityApi 相同的 contract：Bearer / X-Team-Id / success envelope / backend error / network error。
//
// TEAM context：管理端同样使用 activeTeamPublicId（public_id ULID，不暴露 numeric team id）。
// 仅实现页面实际用到的方法；不建"万能 admin client"。
// P32-P4 放开：training（课程/章节）、exam（题库/试卷/结果）、certificate（培训证书列表）管理端方法。
// 仍严禁加入 community / AI / BI / mall / points-admin。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface TeamView {
  public_id: string;
  name: string;
}

export interface ActivityRow {
  public_id: string;
  title: string;
  summary: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  max_session_minutes: number | null;
  /**
   * N0-E5A：活动主地址（人类可读）。N0-E5A-R1 起：admin list/detail 后端投影已返回该字段，
   * 前端编辑弹窗的「活动地点」输入据此回填并保存（不再悬空）。NULL = 未填写。
   */
  address?: string | null;
  /**
   * P34-C4：审批态字段（P34-C1/C2 冻结）。
   * 标注为可选：截至 P34-C4，admin list/detail 的后端投影尚未返回这些字段（见 P34-C4 blocker 报告）；
   * 仅 submit / approve / reject 的响应（ActivityApprovalView）会返回。前端按"有则显示"处理，不臆造。
   */
  audit_status?: number;
  submitted_at?: number | null;
  reviewed_at?: number | null;
  reject_reason?: string | null;
}

/**
 * P34-C4：活动审批态（publication audit_status，与生命周期 status 严格分离）。
 * 0 DRAFT / 1 PENDING / 2 APPROVED / 3 REJECTED（P34-B 冻结）。
 */
export const ACTIVITY_AUDIT = {
  DRAFT: 0,
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
} as const;

/** P34-C4：审批态展示文案（必须覆盖 0/1/2/3）。 */
export const ACTIVITY_AUDIT_LABELS: Record<number, string> = {
  0: '草稿',
  1: '待审核',
  2: '已通过',
  3: '已驳回',
};

/** 审批态文案（未知值兜底为"未知"，不臆造为已通过）。 */
export function getActivityAuditLabel(auditStatus: number | null | undefined): string {
  if (auditStatus === null || auditStatus === undefined) return '未知';
  return ACTIVITY_AUDIT_LABELS[auditStatus] || '未知';
}

/**
 * P34-C4：审批操作返回的活动状态视图（对应后端 ActivityApprovalView）。
 * submit / approve / reject 成功后一律以此为准刷新 UI，禁止前端本地臆造审批态。
 */
export interface ActivityApprovalView {
  activity_public_id: string;
  status: number;
  audit_status: number;
  submitted_at: number | null;
  reviewed_at: number | null;
  reject_reason: string | null;
}

/** reject reason 长度上限（与后端一致：trim 后 1–500）。 */
export const ACTIVITY_REJECT_REASON_MAX = 500;

export interface ActivityScalarUpdate {
  title?: string;
  summary?: string | null;
  /** N0-E5A：活动主地址（optional；null / 空白 → 服务端归一为 NULL）。N0-E5A-R1 起前端编辑保存会发送。 */
  address?: string | null;
  start_time?: number;
  end_time?: number;
  signup_deadline?: number | null;
  quota?: number;
  max_session_minutes?: number | null;
}

export interface SlotInput {
  name: string;
  start_time: number;
  end_time: number;
  capacity?: number;
}

export interface PositionInput {
  name: string;
  description?: string | null;
  required_count?: number;
  slots?: SlotInput[];
}

export interface OccurrenceInput {
  start_time: number;
  end_time: number;
  positions?: PositionInput[];
  slots?: SlotInput[];
}

export interface CreateActivityCommand {
  title: string;
  summary?: string | null;
  start_time: number;
  end_time: number;
  signup_deadline?: number | null;
  quota?: number;
  /**
   * P34-C4：已移除 `status`。
   * 发布字段属服务端权威（P34-C2）：create 恒为草稿（status=0 / audit_status=0），
   * 客户端提交 status 会被后端以 INVALID_PARAM 400 拒绝。类型层面移除以防再次误传。
   */
  max_session_minutes?: number | null;
  occurrences?: OccurrenceInput[];
}

export interface SignupView {
  activity_public_id: string;
  user_public_id: string;
  signup: {
    review_status: number;
    status: number;
    cancel_count: number;
    created_at: number;
    updated_at: number | null;
  } | null;
  form_submission: { public_id: string; status: number; version_public_id: string | null } | null;
}

export interface AttendanceSessionView {
  session_id: number;
  activity_public_id: string;
  activity_title: string;
  volunteer_public_id: string;
  volunteer_name: string;
  checkin_at: number | null;
  checkout_at: number | null;
  status: number;
  review_status: number;
  created_at: number;
}

export interface ServiceRecordView {
  public_id: string;
  minutes: number;
  business_service_date: string | null;
  points_awarded_units: number;
  settlement_status: number;
  created_at: number;
  user_public_id: string;
  activity_public_id: string;
}

// ===== P35-C3：服务时长人工调整「申请 → 双人审批」类型（对接 P35-C2 后端） =====

/**
 * P35-C2 冻结的 adjustment request 状态（service_record_adjustment_requests.status）。
 * 0 PENDING / 1 APPROVED / 2 REJECTED / 3 CANCELLED。
 * 本阶段不实现 cancel action，仅正确显示 CANCELLED。
 */
export const ADJUSTMENT_STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  CANCELLED: 3,
} as const;

/** 申请状态展示文案（必须覆盖 0/1/2/3）。 */
export const ADJUSTMENT_STATUS_LABELS: Record<number, string> = {
  0: '待审核',
  1: '已批准',
  2: '已拒绝',
  3: '已取消',
};

/** 状态文案（未知值兜底为"未知"，绝不臆造为已批准）。 */
export function getAdjustmentStatusLabel(status: number | null | undefined): string {
  if (status === null || status === undefined) return '未知';
  return ADJUSTMENT_STATUS_LABELS[status] || '未知';
}

/** reject reason 长度上限（与后端一致：trim 后 1–500）。 */
export const ADJUSTMENT_REJECT_REASON_MAX = 500;
/** 申请时长上限（与后端一致：0–525600 = 1 年）。 */
export const ADJUSTMENT_MINUTES_MAX = 525600;

/**
 * P35-C2 后端 AdjustmentRequestView 的前端镜像（P35-C3B 增补 requester 安全身份）。
 * 仅含 public_id 与业务字段——绝不包含 numeric requester_id / reviewer_id / team_id / id。
 */
export interface AdjustmentRequestView {
  public_id: string;
  service_record_public_id: string;
  status: number;
  requested_minutes: number;
  reason: string;
  old_minutes_snapshot: number;
  old_points_awarded_units_snapshot: number;
  old_settlement_status_snapshot: number;
  requested_at: number;
  reviewed_at: number | null;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
  /**
   * P35-C3B：申请人「安全公开身份」（后端 LEFT JOIN users 投影）。
   * display_name 可为 null（users.nickname 可空）；缺失时不得回退到 numeric id。
   */
  requester: { public_id: string; display_name: string | null } | null;
}

/**
 * P35-C3B：当前 actor 在「服务时长调整」上的能力投影（后端真实 permission 求值结果）。
 * 仅供显示层使用；【不是】授权边界——写端点仍由后端 requirePermission 强制。
 */
export interface AdjustmentCapabilities {
  can_submit_adjustment: boolean;
  can_review_adjustment: boolean;
}

/** 提交调整申请的命令体（严格：后端会 400 拒绝任何额外字段）。 */
export interface AdjustmentRequestCommand {
  requested_minutes: number;
  reason: string;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

// ===== 公益社区内容管理类型（community admin） =====
export interface ContentAttachmentItem {
  file_public_id: string;
  mime_type: string;
  size_bytes: number;
}

export interface ContentArticleItem {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  author_public_id: string | null;
  author_nickname: string | null;
  status: number;
  audit_status: number;
  comment_count: number;
  like_count: number;
  report_count: number;
  created_at: number;
  published_at: number | null;
}

export interface ContentArticleDetail {
  article_public_id: string;
  content_type: string;
  title: string;
  body: string | null;
  status: number;
  audit_status: number;
  author_public_id: string | null;
  author_nickname: string | null;
  attachments: ContentAttachmentItem[];
  created_at: number;
  published_at: number | null;
}

// ===== P32-P4 培训/考试/证书管理类型 =====

export interface CourseAdminRow {
  public_id: string;
  title: string;
  summary: string | null;
  required: number;
  required_minutes: number;
  cover_url: string | null;
  status: number;
  lesson_count: number;
  enrolled: boolean;
  progress: number | null;
  completed: boolean;
  created_at: number;
}

export interface LessonAdminRow {
  public_id: string;
  title: string;
  lesson_type: string;
  content: string | null;
  duration_min: number;
  sort: number;
  is_free: number;
  status?: number;
  order: number;
  completed: boolean;
  progress: number;
}

export interface CourseAdminInput {
  title: string;
  summary?: string | null;
  detail?: string | null;
  required?: number;
  required_minutes?: number;
  sort?: number;
  status?: number;
}

export interface LessonAdminInput {
  title: string;
  lesson_type: string;
  content?: string | null;
  duration_min?: number;
  sort?: number;
  is_free?: number;
  status?: number;
}

export interface QuestionOption {
  key: string;
  text: string;
}

export interface QuestionAdminRow {
  public_id: string;
  question_type: string;
  stem: string;
  options: QuestionOption[];
  answer: string;
  analysis: string | null;
  difficulty: number;
  tags: string | null;
  status: number;
  created_at: number;
}

export interface QuestionAdminInput {
  question_type: string;
  stem: string;
  options: QuestionOption[];
  answer: string;
  analysis?: string | null;
  difficulty?: number;
  tags?: string | null;
  status?: number;
}

export interface PaperAdminRow {
  public_id: string;
  title: string;
  course_public_id: string | null;
  course_title: string | null;
  pick_rule: Record<string, unknown> | string;
  total_score: number;
  pass_score: number;
  duration_min: number;
  max_attempts: number;
  status: number;
  created_at: number;
}

export interface PaperAdminInput {
  title: string;
  /** 关联课程使用 public_id（后端解析 numeric id）；不发送 numeric course id。 */
  course_public_id?: string | null;
  pick_rule: Record<string, unknown>;
  total_score?: number;
  pass_score?: number;
  duration_min?: number;
  max_attempts?: number;
  status?: number;
}

export interface SessionAdminRow {
  session_public_id: string;
  paper_public_id: string | null;
  paper_title: string | null;
  user_public_id: string | null;
  user_nickname: string | null;
  status: number;
  attempt_no: number;
  score: number | null;
  passed: number | null;
  started_at: number;
  submitted_at: number | null;
}

export interface CertAdminRow {
  public_id: string;
  cert_no: string;
  cert_type: string;
  holder_name: string | null;
  holder_public_id: string | null;
  holder_nickname: string | null;
  issuer_name: string | null;
  issued_at: number;
  status: number;
  source_type: string | null;
  source_public_id: string | null;
  activity_public_id: string | null;
  course_public_id: string | null;
  score: number | null;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function getActiveTeamId(): string {
  return wx.getStorageSync('activeTeamPublicId') || '';
}

function buildError(status: number, body: any, isNetwork: boolean): ApiError {
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : '请求失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

interface RequestOpts {
  teamScoped?: boolean;
  base?: string;
}

type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, data?: any, opts: RequestOpts = {}): Promise<T> {
  const base = opts.base || V2_BASE;
  const teamScoped = opts.teamScoped !== false; // 默认团队作用域
  return new Promise<T>((resolve, reject) => {
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) header['Authorization'] = `Bearer ${token}`;
    if (teamScoped) {
      const teamId = getActiveTeamId();
      if (teamId) header['X-Team-Id'] = teamId;
    }

    wx.request({
      url: base + path,
      method: method,
      data,
      header,
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        const body = res.data;
        if (statusCode >= 200 && statusCode < 300) {
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        reject(buildError(0, null, true));
      },
    });
  });
}

export const adminApi = {
  // ===================== 团队上下文（非团队作用域） =====================
  /** GET /teams/mine —— 当前用户拥有 TEAM 作用域的团队列表。 */
  getTeamsMine(): Promise<{ teams: TeamView[] }> {
    return request<{ teams: TeamView[] }>('GET', '/teams/mine', undefined, { teamScoped: false });
  },

  // ===================== 活动管理（团队作用域） =====================
  /** POST /activities —— 创建活动（含嵌套 occurrence/position/slot；P31-P1A 真实 schema）。 */
  createActivity(cmd: CreateActivityCommand): Promise<{ activity: { public_id: string } }> {
    return request<{ activity: { public_id: string } }>('POST', '/activities', cmd);
  },

  /** PUT /activities/:id —— 仅标量字段更新（v1 不重配置嵌套）。 */
  updateActivity(publicId: string, patch: ActivityScalarUpdate): Promise<{ activity: { public_id: string } }> {
    return request<{ activity: { public_id: string } }>('PUT', `/activities/${publicId}`, patch);
  },

  /**
   * P34-C4：以下三个端点取代已移除的 POST /activities/:id/publish。
   * 发布唯一正式路径 = approve；创建恒为草稿，不再有"直接发布"。
   * 只用 activity public_id，禁止传 numeric DB id。
   */

  /** POST /activities/:id/submit —— 提交发布审核（DRAFT / REJECTED → PENDING）。 */
  submitActivity(publicId: string): Promise<{ activity: ActivityApprovalView }> {
    return request<{ activity: ActivityApprovalView }>('POST', `/activities/${publicId}/submit`, {});
  },

  /** POST /activities/:id/approve —— 审核通过并发布（PENDING → APPROVED + status SIGNUP_OPEN）。 */
  approveActivity(publicId: string): Promise<{ activity: ActivityApprovalView }> {
    return request<{ activity: ActivityApprovalView }>('POST', `/activities/${publicId}/approve`, {});
  },

  /** POST /activities/:id/reject —— 驳回（PENDING → REJECTED）。reason：trim 后 1–500 字符。 */
  rejectActivity(publicId: string, reason: string): Promise<{ activity: ActivityApprovalView }> {
    return request<{ activity: ActivityApprovalView }>('POST', `/activities/${publicId}/reject`, { reason });
  },

  /** GET /activities —— 本团队活动列表（分页）。 */
  listActivities(page = 1, pageSize = 20): Promise<{ items: ActivityRow[]; pagination: Pagination }> {
    return request<{ items: ActivityRow[]; pagination: Pagination }>(
      'GET',
      `/activities?page=${page}&page_size=${pageSize}`,
    );
  },

  /** GET /activities/:id —— 本团队单个活动详情。 */
  getActivity(publicId: string): Promise<{ activity: ActivityRow }> {
    return request<{ activity: ActivityRow }>('GET', `/activities/${publicId}`);
  },

  // ===================== 报名管理（团队作用域） =====================
  /** GET /activities/:activityId/signups —— 团队报名列表。 */
  listSignups(activityPublicId: string): Promise<{ signups: SignupView[] }> {
    return request<{ signups: SignupView[] }>('GET', `/activities/${activityPublicId}/signups`);
  },

  /** GET /activities/:activityId/signups/users/:userPublicId —— 指定志愿者报名详情。 */
  getSignupByUser(activityPublicId: string, userPublicId: string): Promise<{ signup: SignupView }> {
    return request<{ signup: SignupView }>(
      'GET',
      `/activities/${activityPublicId}/signups/users/${userPublicId}`,
    );
  },

  // ===================== 考勤管理（团队作用域） =====================
  /** GET /attendance-sessions —— 团队考勤 roster（可 filter activity_public_id / status）。 */
  listAttendanceSessions(query: {
    activityPublicId?: string;
    status?: number;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ sessions: AttendanceSessionView[]; pagination: Pagination }> {
    const q: string[] = [];
    if (query.activityPublicId) q.push(`activity_public_id=${query.activityPublicId}`);
    if (query.status !== undefined && query.status !== null) q.push(`status=${query.status}`);
    if (query.page) q.push(`page=${query.page}`);
    if (query.pageSize) q.push(`page_size=${query.pageSize}`);
    const qs = q.length > 0 ? `?${q.join('&')}` : '';
    return request<{ sessions: AttendanceSessionView[]; pagination: Pagination }>(
      'GET',
      `/attendance-sessions${qs}`,
    );
  },

  /** POST /attendance-sessions/:sessionId/review —— 审核会话（decision: approve | reject）。 */
  reviewAttendanceSession(
    sessionId: number,
    decision: 'approve' | 'reject',
    reason?: string,
  ): Promise<{ session: any }> {
    return request<{ session: any }>(
      'POST',
      `/attendance-sessions/${sessionId}/review`,
      { decision, reason: reason ?? '' },
    );
  },

  /** POST /attendance-sessions/:sessionId/force-checkout —— 强制签退（reason 必填）。 */
  forceCheckoutAttendanceSession(sessionId: number, reason: string): Promise<{ session: any }> {
    return request<{ session: any }>(
      'POST',
      `/attendance-sessions/${sessionId}/force-checkout`,
      { reason },
    );
  },

  // ===================== 服务记录（团队作用域） =====================
  /** GET /service-records —— 当前团队服务记录列表（摘要）。 */
  listServiceRecords(limit = 50): Promise<{ records: ServiceRecordView[] }> {
    return request<{ records: ServiceRecordView[] }>('GET', `/service-records?limit=${limit}`);
  },

  // ===================== 服务时长人工调整（P35-C3；团队作用域） =====================
  // 对接 P35-C2 后端审批状态机：申请 → 第二人审批/拒绝 → 原子落地。
  // 旧 direct adjust（POST /service-records/:id/adjust）已在 P35-C2 移除，前端不得再调用；
  // 任何时长修改必须经「申请 → 审批」工作流，前端不臆造审批态/时长。

  /** POST /service-records/:serviceRecordPublicId/adjustments —— 提交人工时长调整申请（权限 service.record.adjust）。 */
  requestServiceRecordAdjustment(
    serviceRecordPublicId: string,
    cmd: AdjustmentRequestCommand,
  ): Promise<{ adjustment: AdjustmentRequestView }> {
    return request<{ adjustment: AdjustmentRequestView }>(
      'POST',
      `/service-records/${serviceRecordPublicId}/adjustments`,
      cmd,
    );
  },

  /**
   * GET /service-records/:serviceRecordPublicId/adjustments —— 该服务记录的调整申请历史
   * （权限 view OR review）。P35-C3B：响应同时携带后端 capabilities（真实 permission 能力），
   * 前端据此驱动 canSubmit / canReview，不再按 legacy role 猜测 P35 权限。
   */
  listServiceRecordAdjustments(
    serviceRecordPublicId: string,
  ): Promise<{ adjustments: AdjustmentRequestView[]; capabilities: AdjustmentCapabilities | null }> {
    return request<{ adjustments: AdjustmentRequestView[]; capabilities: AdjustmentCapabilities | null }>(
      'GET',
      `/service-records/${serviceRecordPublicId}/adjustments`,
    );
  },

  /** POST /service-record-adjustments/:adjustmentPublicId/approve —— 审批通过并原子落地（权限 service.record.review）。 */
  approveServiceRecordAdjustment(
    adjustmentPublicId: string,
  ): Promise<{ record: ServiceRecordView }> {
    return request<{ record: ServiceRecordView }>(
      'POST',
      `/service-record-adjustments/${adjustmentPublicId}/approve`,
      {},
    );
  },

  /** POST /service-record-adjustments/:adjustmentPublicId/reject —— 拒绝（权限 service.record.review）。reason：trim 后 1–500。 */
  rejectServiceRecordAdjustment(
    adjustmentPublicId: string,
    reason: string,
  ): Promise<{ rejected: boolean }> {
    return request<{ rejected: boolean }>(
      'POST',
      `/service-record-adjustments/${adjustmentPublicId}/reject`,
      { reason },
    );
  },

  // ===================== 培训管理（training.course.manage） =====================

  /** GET /training/courses —— 本团队课程列表（分页）。 */
  listTrainingCourses(page = 1, pageSize = 20): Promise<{ items: CourseAdminRow[]; pagination: Pagination }> {
    return request<{ items: CourseAdminRow[]; pagination: Pagination }>(
      'GET',
      `/training/courses?page=${page}&page_size=${pageSize}`,
    );
  },

  /** GET /training/courses/:publicId —— 课程详情（含 lessons）。 */
  getTrainingCourse(publicId: string): Promise<{ course: any; lessons: LessonAdminRow[] }> {
    return request<{ course: any; lessons: LessonAdminRow[] }>('GET', `/training/courses/${publicId}`);
  },

  /** POST /training/admin/courses —— 创建课程。 */
  createTrainingCourse(cmd: CourseAdminInput): Promise<{ public_id: string }> {
    return request<{ public_id: string }>('POST', `/training/admin/courses`, cmd);
  },

  /** PUT /training/admin/courses/:publicId —— 更新课程。 */
  updateTrainingCourse(publicId: string, cmd: CourseAdminInput): Promise<{ updated: boolean }> {
    return request<{ updated: boolean }>('PUT', `/training/admin/courses/${publicId}`, cmd);
  },

  /** POST /training/admin/courses/:coursePublicId/lessons —— 创建章节。 */
  createLesson(coursePublicId: string, cmd: LessonAdminInput): Promise<{ public_id: string }> {
    return request<{ public_id: string }>(
      'POST',
      `/training/admin/courses/${coursePublicId}/lessons`,
      cmd,
    );
  },

  /** PUT /training/admin/courses/:coursePublicId/lessons/:lessonPublicId —— 更新章节。 */
  updateLesson(
    coursePublicId: string,
    lessonPublicId: string,
    cmd: LessonAdminInput,
  ): Promise<{ updated: boolean }> {
    return request<{ updated: boolean }>(
      'PUT',
      `/training/admin/courses/${coursePublicId}/lessons/${lessonPublicId}`,
      cmd,
    );
  },

  // ===================== 题库（exam.question.manage） =====================

  /** GET /exams/admin/questions —— 题库列表（分页）。 */
  listQuestions(page = 1, pageSize = 50): Promise<{ items: QuestionAdminRow[]; pagination: Pagination }> {
    return request<{ items: QuestionAdminRow[]; pagination: Pagination }>(
      'GET',
      `/exams/admin/questions?page=${page}&page_size=${pageSize}`,
    );
  },

  /** POST /exams/admin/questions —— 创建题目。 */
  createQuestion(cmd: QuestionAdminInput): Promise<{ public_id: string }> {
    return request<{ public_id: string }>('POST', `/exams/admin/questions`, cmd);
  },

  /** PUT /exams/admin/questions/:publicId —— 更新题目。 */
  updateQuestion(publicId: string, cmd: QuestionAdminInput): Promise<{ updated: boolean }> {
    return request<{ updated: boolean }>('PUT', `/exams/admin/questions/${publicId}`, cmd);
  },

  // ===================== 试卷（exam.paper.manage） =====================

  /** GET /exams/admin/papers —— 本团队试卷列表。 */
  listPapers(): Promise<{ papers: PaperAdminRow[] }> {
    return request<{ papers: PaperAdminRow[] }>('GET', `/exams/admin/papers`);
  },

  /** POST /exams/admin/papers —— 创建试卷。 */
  createPaper(cmd: PaperAdminInput): Promise<{ public_id: string }> {
    return request<{ public_id: string }>('POST', `/exams/admin/papers`, cmd);
  },

  /** PUT /exams/admin/papers/:publicId —— 更新试卷。 */
  updatePaper(publicId: string, cmd: PaperAdminInput): Promise<{ updated: boolean }> {
    return request<{ updated: boolean }>('PUT', `/exams/admin/papers/${publicId}`, cmd);
  },

  // ===================== 考试结果（exam.paper.manage） =====================

  /** GET /exams/admin/sessions —— 本团队考试结果/会话列表（分页）。 */
  listExamSessions(page = 1, pageSize = 50): Promise<{ sessions: SessionAdminRow[]; pagination: Pagination }> {
    return request<{ sessions: SessionAdminRow[]; pagination: Pagination }>(
      'GET',
      `/exams/admin/sessions?page=${page}&page_size=${pageSize}`,
    );
  },

  // ===================== 培训证书（certificate.certificate.view） =====================

  /** GET /certificates/admin —— 本团队培训证书列表（安全字段）。 */
  listTrainingCertificates(
    page = 1,
    pageSize = 50,
  ): Promise<{ certificates: CertAdminRow[]; pagination: Pagination }> {
    return request<{ certificates: CertAdminRow[]; pagination: Pagination }>(
      'GET',
      `/certificates/admin?page=${page}&page_size=${pageSize}`,
    );
  },

  // ===================== 公益社区内容管理（community admin） =====================
  /** GET /content/articles —— 本团队社区内容审核台列表（分页）。 */
  getContentArticles(page = 1, pageSize = 20): Promise<{ items: ContentArticleItem[]; pagination: Pagination }> {
    return request<{ items: ContentArticleItem[]; pagination: Pagination }>(
      'GET',
      `/content/articles?page=${page}&page_size=${pageSize}`,
    );
  },

  /** GET /content/articles/:id —— 本团队单篇内容详情（含附件/作者/状态）。 */
  getContentArticleDetail(publicId: string): Promise<ContentArticleDetail> {
    return request<ContentArticleDetail>('GET', `/content/articles/${publicId}`);
  },

  /** POST /content/articles —— 管理端创建内容（默认 DRAFT/PENDING）。 */
  createContentArticle(cmd: {
    title: string;
    body: string;
    attachment_file_public_ids?: string[];
    content_type?: string;
  }): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('POST', '/content/articles', cmd);
  },

  /** PUT /content/articles/:id —— 管理端编辑（后端重置为 DRAFT/PENDING）。 */
  updateContentArticle(
    publicId: string,
    patch: { title?: string; body?: string; attachment_file_public_ids?: string[] },
  ): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('PUT', `/content/articles/${publicId}`, patch);
  },

  /** POST /content/articles/:id/approve —— 审核通过并发布。 */
  approveContentArticle(publicId: string): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('POST', `/content/articles/${publicId}/approve`, {});
  },

  /** POST /content/articles/:id/reject —— 驳回。 */
  rejectContentArticle(publicId: string): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('POST', `/content/articles/${publicId}/reject`, {});
  },

  /** POST /content/articles/:id/unpublish —— 下架。 */
  unpublishContentArticle(publicId: string): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('POST', `/content/articles/${publicId}/unpublish`, {});
  },

  /** DELETE /content/articles/:id —— 删除（软删除）。 */
  deleteContentArticle(publicId: string): Promise<{ article_public_id: string }> {
    return request<{ article_public_id: string }>('DELETE', `/content/articles/${publicId}`);
  },
};

export default adminApi;