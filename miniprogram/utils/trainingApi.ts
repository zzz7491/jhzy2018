// utils/trainingApi.ts
// 嘉禾志愿 2.0 志愿者端 学习培训 / 考试 / 证书 统一 v2 客户端（P32-P3）。
// 仅对接 /api/v2 后端；绝不调用 legacy PHP 端点。
// 复用与 activityApi 相同的 contract：Bearer / X-Team-Id / success envelope / backend error / network error。
//
// 团队上下文：培训 / 考试 / 证书均为【团队作用域】，自动注入 X-Team-Id = wx.getStorageSync('activeTeamPublicId')。
// 若未选择团队（activeTeamPublicId 为空），所有请求会收到 TEAM_SCOPE_REQUIRED(403)，
// 页面层据此提示「请先选择团队」并跳转团队选择页（不 fallback 到 PHP）。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

export interface CourseView {
  public_id: string;
  title: string;
  summary: string | null;
  required: number; // 1=必修 0=选修
  required_minutes: number;
  cover_url: string | null;
  status: number;
  lesson_count: number;
  enrolled: boolean;
  progress: number | null;
  completed: boolean;
  // P32-P3A：志愿者考试发现（后端权威）。无对应 active paper 时为 null。
  exam?: ExamRef | null;
  created_at: number;
}

// 课程关联的志愿者考试试卷（仅暴露 public_id 与资格判定，不含题目/答案/numeric id）。
export interface ExamRef {
  paper_public_id: string | null;
  eligible: boolean;
}

export interface LessonView {
  public_id: string;
  order: number;
  title: string;
  lesson_type: string;
  duration_min: number;
  is_free: number | boolean;
  completed: boolean;
  progress: number;
}

export interface MyProgressItem {
  course_public_id: string;
  title: string;
  summary: string | null;
  required: number;
  required_minutes: number;
  progress: number;
  learned_minutes: number;
  completed: boolean;
  completed_at: number | null;
}

export interface ExamQuestion {
  question_public_id: string;
  stem: string;
  options: Array<{ key: string; text: string }>;
  order: number;
}

export interface ExamAttempt {
  session_public_id: string;
  status: number; // 1=IN_PROGRESS 3=COMPLETED
  attempt_no: number;
  started_at: number;
  submitted_at: number | null;
  duration_min: number;
  total_score: number;
  pass_score: number;
  questions: ExamQuestion[];
}

export interface ExamResult {
  session_public_id: string;
  status: number;
  score: number | null;
  passed: boolean | null;
  submitted_at: number | null;
  answers: Array<{ questionPublicId: string; selected: string | null; isCorrect: boolean | null }>;
  certificate: { public_id: string; cert_no: string; status: number } | null;
}

export interface CertificateView {
  public_id: string;
  cert_no: string;
  cert_type: string;
  holder_name: string | null;
  issuer_name: string | null;
  issued_at: number;
  status: number;
  source_type: string | null;
  source_public_id: string | null;
  activity_public_id: string | null;
  course_public_id: string | null;
  // detail 视图可能额外携带（mine 不返回）：
  verify_code?: string;
  snapshot?: string | null;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function getActiveTeamId(): string {
  return wx.getStorageSync('activeTeamPublicId') || '';
}

export function hasTeamContext(): boolean {
  return getActiveTeamId().length > 0;
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

type RequestMethod = 'OPTIONS' | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'CONNECT';

function request<T>(method: RequestMethod, path: string, data?: any, opts: { teamScoped?: boolean } = {}): Promise<T> {
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
      url: V2_BASE + path,
      method: method,
      data,
      header,
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        const body = res.data;
        if (statusCode >= 200 && statusCode < 300) {
          // 成功信封：{ success:true, data, request_id }
          resolve((body && body.data !== undefined ? body.data : body) as T);
        } else {
          // 失败信封：{ success:false, error:{code,message,details} }
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        reject(buildError(0, null, true));
      },
    });
  });
}

// ===================== 培训（团队作用域） =====================

/** GET /training/courses —— 本团队课程列表（分页）。 */
export function listCourses(page = 1, pageSize = 20): Promise<{ items: CourseView[]; pagination: { page: number; page_size: number; total: number; total_pages: number } }> {
  return request('GET', `/training/courses?page=${page}&page_size=${pageSize}`);
}

/** GET /training/courses/:coursePublicId —— 课程详情（含 lessons）。 */
export function getCourse(coursePublicId: string): Promise<{ course: CourseView; lessons: LessonView[] }> {
  return request('GET', `/training/courses/${coursePublicId}`);
}

/** GET /training/courses/:coursePublicId/lessons/:lessonPublicId —— 章节详情。 */
export function getLesson(coursePublicId: string, lessonPublicId: string): Promise<LessonView> {
  return request('GET', `/training/courses/${coursePublicId}/lessons/${lessonPublicId}`);
}

/** POST /training/courses/:coursePublicId/enroll —— 报名学习。 */
export function enroll(coursePublicId: string): Promise<{ enrolled: boolean; created: boolean }> {
  return request('POST', `/training/courses/${coursePublicId}/enroll`, {});
}

/** POST /training/courses/:coursePublicId/lessons/:lessonPublicId/progress —— 进度上报。 */
export function reportProgress(
  coursePublicId: string,
  lessonPublicId: string,
  body: { learned_seconds?: number; completed?: boolean },
): Promise<{ lesson: { public_id: string; progress: number; completed: boolean }; course: { public_id: string; progress: number; completed: boolean } }> {
  return request('POST', `/training/courses/${coursePublicId}/lessons/${lessonPublicId}/progress`, body);
}

/** GET /training/my-progress —— 我的学习进度（USER 归属；仍注入 X-Team-Id 以定位团队课程）。 */
export function myProgress(): Promise<{ items: MyProgressItem[] }> {
  return request('GET', `/training/my-progress`);
}

// ===================== 考试（团队作用域） =====================

/** POST /exams/:paperPublicId/start —— 开始考试（服务端抽 20 题、钉入、不可变 snapshot）。 */
export function startExam(paperPublicId: string): Promise<{ attempt: ExamAttempt }> {
  return request('POST', `/exams/${paperPublicId}/start`, {});
}

/** GET /exams/sessions/:sessionPublicId —— 会话详情（resume：同集 20 题）。 */
export function getExamSession(sessionPublicId: string): Promise<{ attempt: ExamAttempt }> {
  return request('GET', `/exams/sessions/${sessionPublicId}`);
}

/** POST /exams/sessions/:sessionPublicId/submit —— 提交 + 服务端评分 +（条件）自动发证。 */
export function submitExam(sessionPublicId: string, answers: Array<{ questionPublicId: string; selected: string }>): Promise<{ result: ExamResult }> {
  return request('POST', `/exams/sessions/${sessionPublicId}/submit`, { answers });
}

/** GET /exams/sessions/:sessionPublicId/result —— 权威结果。 */
export function getExamResult(sessionPublicId: string): Promise<{ result: ExamResult }> {
  return request('GET', `/exams/sessions/${sessionPublicId}/result`);
}

// ===================== 证书（团队作用域） =====================

/** GET /certificates/mine —— 我的证书（USER 归属）。 */
export function listMyCertificates(): Promise<{ certificates: CertificateView[] }> {
  return request('GET', `/certificates/mine`);
}

/** GET /certificates/:certificatePublicId —— 证书详情（持证者本人 / 团队管理员）。 */
export function getCertificate(certificatePublicId: string): Promise<{ certificate: CertificateView }> {
  return request('GET', `/certificates/${certificatePublicId}`);
}

export const trainingApi = {
  listCourses,
  getCourse,
  getLesson,
  enroll,
  reportProgress,
  myProgress,
  startExam,
  getExamSession,
  submitExam,
  getExamResult,
  listMyCertificates,
  getCertificate,
};

export default trainingApi;
