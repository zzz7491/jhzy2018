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
}

export interface ActivityScalarUpdate {
  title?: string;
  summary?: string | null;
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
  status?: number;
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

  /** POST /activities/:id/publish —— 发布草稿（status 0 → 1）。 */
  publishActivity(publicId: string): Promise<{ activity: { public_id: string; status: number } }> {
    return request<{ activity: { public_id: string; status: number } }>(
      'POST',
      `/activities/${publicId}/publish`,
      {},
    );
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