/**
 * TrainingService（P32-P2）—— 学习培训业务逻辑。
 *
 * 纪律：
 * - 学习进度服务端权威：progress/completed 一律由服务端聚合 learning_records 计算，
 *   客户端只上报"本次学习时长 / 章节完成标记"，绝不自定"课程完成"。
 * - user/team 内部 id 一律服务端派生；对外只暴露 public_id。
 * - course_enrollments 为 TEAM_SCOPED；learning_records 为 USER_SCOPED。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { TrainingRepository, type CourseInput, type LessonInput } from '../repository/training';
import { ExamRepository } from '../repository/exam';
import { invalidParam, authRequired, teamScopeRequired, notFound } from '../utils/errors';

export interface TrainingServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export class TrainingService {
  private readonly repo: TrainingRepository;
  private readonly examRepo: ExamRepository;

  constructor(deps: TrainingServiceDeps) {
    this.repo = new TrainingRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.examRepo = new ExamRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  private requireActor(): { userId: number; teamId: number } {
    const auth = this.repo['ctx'].auth;
    if (!auth.authenticated || auth.userId == null) throw authRequired();
    if (this.repo['ctx'].tenant.teamId == null) throw teamScopeRequired();
    return { userId: auth.userId, teamId: this.repo['ctx'].tenant.teamId };
  }

  // ===== Volunteer 读 =====

  async listCourses(page: number, pageSize: number) {
    const { teamId } = this.requireActor();
    const offset = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      this.repo.listCourses(teamId, offset, pageSize),
      this.repo.countCourses(teamId),
    ]);
    const items = await Promise.all(rows.map((r) => this.toCourseView(r)));
    return {
      items,
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    };
  }

  async getCourse(coursePublicId: string) {
    const { teamId, userId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    const lessons = await this.repo.listLessonsOfCourse(teamId, course.id);
    const enrollment = await this.repo.findEnrollment(userId, course.id);
    return {
      course: await this.toCourseView(course),
      lessons: await Promise.all(
        lessons.map(async (l, idx) => {
          const rec = enrollment ? await this.repo.findLearningRecord(enrollment.id, l.id) : null;
          return {
            public_id: l.public_id,
            order: idx + 1,
            title: l.title,
            lesson_type: l.lesson_type,
            duration_min: l.duration_min,
            is_free: l.is_free,
            completed: !!rec?.completed_at,
            progress: rec?.progress ?? 0,
          };
        }),
      ),
    };
  }

  async getLesson(coursePublicId: string, lessonPublicId: string) {
    const { teamId, userId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    const lesson = await this.repo.findLessonByPublicId(teamId, course.id, lessonPublicId);
    if (!lesson) throw notFound('Lesson');
    const enrollment = await this.repo.findEnrollment(userId, course.id);
    const rec = enrollment ? await this.repo.findLearningRecord(enrollment.id, lesson.id) : null;
    return {
      public_id: lesson.public_id,
      title: lesson.title,
      lesson_type: lesson.lesson_type,
      content: lesson.content,
      duration_min: lesson.duration_min,
      is_free: lesson.is_free,
      completed: !!rec?.completed_at,
      progress: rec?.progress ?? 0,
    };
  }

  async enroll(coursePublicId: string) {
    const { teamId, userId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    const now = Math.floor(Date.now() / 1000);
    const { created } = await this.repo.insertEnrollment(userId, course.id, teamId, now);
    return { enrolled: true, created };
  }

  /**
   * 汇报学习进度。客户端仅允许传 learned_seconds（整数 >= 0）与 completed（布尔）。
   * 服务端权威计算：
   * - lesson record progress = completed ? 100 : min(99, 按 learned_seconds 与 duration 折算)
   * - 聚合 course_enrollments.progress = 已 complete lessons / 全部 active lessons * 100
   */
  async reportProgress(
    coursePublicId: string,
    lessonPublicId: string,
    body: { learned_seconds?: unknown; completed?: unknown },
  ) {
    const { teamId, userId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    const lesson = await this.repo.findLessonByPublicId(teamId, course.id, lessonPublicId);
    if (!lesson) throw notFound('Lesson');

    const completed = body.completed === true;
    const learnedSecondsRaw = body.learned_seconds;
    const learnedSeconds =
      typeof learnedSecondsRaw === 'number' && Number.isFinite(learnedSecondsRaw) && learnedSecondsRaw >= 0
        ? Math.floor(learnedSecondsRaw)
        : 0;
    if (learnedSeconds > 10 * 3600) throw invalidParam('learned_seconds', 'too_large');

    let enrollment = await this.repo.findEnrollment(userId, course.id);
    if (!enrollment) {
      const now = Math.floor(Date.now() / 1000);
      const res = await this.repo.insertEnrollment(userId, course.id, teamId, now);
      if (res.created) {
        enrollment = {
          id: res.enrollmentId,
          user_id: userId,
          course_id: course.id,
          team_id: teamId,
          progress: 0,
          learned_minutes: 0,
          status: 1,
          completed_at: null,
          created_at: now,
          updated_at: now,
        };
      } else {
        // 并发报名竞争：确定性读回
        enrollment = await this.repo.findEnrollment(userId, course.id);
      }
    }
    if (!enrollment) throw notFound('Course enrollment');

    const now = Math.floor(Date.now() / 1000);
    const prev = await this.repo.findLearningRecord(enrollment.id, lesson.id);
    const prevLearnedMinutes = prev?.learned_minutes ?? 0;
    const addLearnedMinutes = Math.ceil(learnedSeconds / 60);
    const learnedMinutes = prevLearnedMinutes + addLearnedMinutes;

    // lesson 级 progress：completed 到位或按 duration 折算（封顶 99，防自判完成）
    const lessonProgress = completed
      ? 100
      : lesson.duration_min > 0
        ? Math.min(99, Math.round((learnedMinutes / lesson.duration_min) * 100))
        : 0;

    await this.repo.upsertLearningRecord(enrollment.id, userId, lesson.id, lessonProgress, learnedMinutes, now);

    // 聚合课程进度：分母 = active lessons；分子 = completed lessons
    const list = await this.repo.listLessonsOfCourse(teamId, course.id);
    const total = list.length;
    let done = 0;
    for (const l of list) {
      const rec = await this.repo.findLearningRecord(enrollment.id, l.id);
      if (rec?.completed_at) done += 1;
    }
    const courseProgress = total > 0 ? Math.round((done / total) * 100) : 0;
    await this.repo.updateEnrollmentProgress(enrollment.id, teamId, courseProgress, learnedMinutes, now);

    return {
      lesson: { public_id: lesson.public_id, progress: lessonProgress, completed: lessonProgress >= 100 },
      course: { public_id: course.public_id, progress: courseProgress, completed: courseProgress >= 100 },
    };
  }

  async myProgress() {
    const { userId } = this.requireActor();
    const rows = await this.repo.listMyEnrollmentsByUser(userId);
    return {
      items: rows.map((r) => ({
        course_public_id: r.coursePublicId,
        title: r.title,
        summary: r.summary,
        required: r.required,
        required_minutes: r.required_minutes,
        progress: r.progress,
        learned_minutes: r.learned_minutes,
        completed: r.status === 3 || r.completed_at != null,
        completed_at: r.completed_at,
      })),
    };
  }

  // ===== Admin CRUD（授权在 route 层）=====

  async adminCreateCourse(cmd: CourseInput) {
    const { teamId, userId } = this.requireActor();
    this.validateCourse(cmd);
    return this.repo.adminCreateCourse(teamId, userId, cmd, Math.floor(Date.now() / 1000));
  }

  async adminUpdateCourse(coursePublicId: string, cmd: CourseInput) {
    const { teamId } = this.requireActor();
    this.validateCourse(cmd);
    const ok = await this.repo.adminUpdateCourse(teamId, coursePublicId, cmd, Math.floor(Date.now() / 1000));
    if (!ok) throw notFound('Course');
  }

  async adminCreateLesson(coursePublicId: string, cmd: LessonInput) {
    const { teamId, userId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    this.validateLesson(cmd);
    return this.repo.adminCreateLesson(teamId, course.id, cmd, Math.floor(Date.now() / 1000));
  }

  async adminUpdateLesson(coursePublicId: string, lessonPublicId: string, cmd: LessonInput) {
    const { teamId } = this.requireActor();
    const course = await this.repo.findCourseByPublicId(teamId, coursePublicId);
    if (!course) throw notFound('Course');
    this.validateLesson(cmd);
    const ok = await this.repo.adminUpdateLesson(teamId, course.id, lessonPublicId, cmd, Math.floor(Date.now() / 1000));
    if (!ok) throw notFound('Lesson');
  }

  private validateCourse(cmd: CourseInput): void {
    if (typeof cmd.title !== 'string' || cmd.title.trim() === '') {
      throw invalidParam('title', 'required non-empty string');
    }
    if (cmd.required_minutes !== undefined && (typeof cmd.required_minutes !== 'number' || cmd.required_minutes < 0)) {
      throw invalidParam('required_minutes', 'must be >= 0');
    }
    if (cmd.required !== undefined && cmd.required !== 0 && cmd.required !== 1) {
      throw invalidParam('required', 'must be 0 or 1');
    }
    if (cmd.status !== undefined && cmd.status !== 1 && cmd.status !== 2 && cmd.status !== 3) {
      throw invalidParam('status', 'must be 1,2,3');
    }
  }

  private validateLesson(cmd: LessonInput): void {
    if (typeof cmd.title !== 'string' || cmd.title.trim() === '') {
      throw invalidParam('title', 'required non-empty string');
    }
    if (!['video', 'article', 'audio'].includes(cmd.lesson_type)) {
      throw invalidParam('lesson_type', 'must be video|article|audio');
    }
    if (cmd.duration_min !== undefined && (typeof cmd.duration_min !== 'number' || cmd.duration_min < 0)) {
      throw invalidParam('duration_min', 'must be >= 0');
    }
  }

  private async toCourseView(course: {
    id: number;
    team_id: number;
    public_id: string;
    title: string;
    summary: string | null;
    required: number;
    required_minutes: number;
    projectName?: string;
    status: number;
    created_at: number;
  }) {
    const { teamId, userId } = this.requireActor();
    const lessons = await this.repo.countActiveLessons(teamId, course.id);
    const enrollment = await this.repo.findEnrollment(userId, course.id);
    const completed = (enrollment?.status ?? 0) === 3 || enrollment?.completed_at != null;
    // 志愿者考试发现（P32-P3A）：返回当前课程关联的、已发布(active)的志愿考试 paper。
    // 一课可能多卷，确定性取「最近创建的 active paper」；无则 exam=null（前端显示不可考）。
    // eligibility 由后端权威判定：用户已完成本课程（enrollment 完成）才视为可考。
    const paper = await this.examRepo.findActivePaperByCourseId(teamId, course.id);
    const exam = paper ? { paper_public_id: paper.public_id, eligible: completed } : null;
    return {
      public_id: course.public_id,
      title: course.title,
      summary: course.summary,
      required: course.required,
      required_minutes: course.required_minutes,
      cover_url: null,
      status: course.status,
      lesson_count: lessons,
      enrolled: !!enrollment,
      progress: enrollment?.progress ?? null,
      completed,
      exam,
      created_at: course.created_at,
    };
  }
}

export default TrainingService;