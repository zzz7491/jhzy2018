/**
 * TrainingRepository（P32-P2）—— courses / course_lessons / course_enrollments / learning_records 唯一写入口。
 *
 * scope 事实（S2-3 矩阵 / repository/tenant-scope.ts）：
 * - courses / course_lessons / course_enrollments = TEAM_SCOPED（含显式 team_id 列）→ 直接 WHERE team_id = ?；
 * - learning_records = USER_SCOPED（无 team_id 列）→ 由 user_id 归属 + 经 enrollment 派生团队校验。
 *
 * SQL 纪律：全部 prepare().bind()；public_id 一律 ULID（course/lesson 经 0022 新增）。
 * 本类不读 HTTP / 不决定身份；租户与身份由 RepositoryContext 注入。
 */

import { BaseRepository, type RepoDeps } from './base';
import { generateUlid } from '../utils/crypto';

// ===== 行类型 =====

export interface CourseRow {
  id: number;
  public_id: string;
  team_id: number;
  category_id: number | null;
  title: string;
  cover_file_id: number | null;
  summary: string | null;
  detail: string | null;
  required: number;
  required_minutes: number;
  sort: number;
  status: number;
  created_by: number | null;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

export interface CourseLessonRow {
  id: number;
  public_id: string;
  team_id: number;
  course_id: number;
  title: string;
  lesson_type: string;
  content: string | null;
  media_file_id: number | null;
  duration_min: number;
  sort: number;
  is_free: number;
  status: number;
  created_at: number;
  updated_at: number | null;
}

export interface CourseEnrollmentRow {
  id: number;
  user_id: number;
  course_id: number;
  team_id: number;
  progress: number;
  learned_minutes: number;
  status: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number | null;
}

export interface LearningRecordRow {
  id: number;
  enrollment_id: number;
  user_id: number;
  lesson_id: number;
  progress: number;
  learned_minutes: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number | null;
}

// ===== 写命令 =====

export interface CourseInput {
  title: string;
  summary?: string | null;
  detail?: string | null;
  required?: number;
  required_minutes?: number;
  sort?: number;
  status?: number;
}

export interface LessonInput {
  title: string;
  lesson_type: string;
  content?: string | null;
  duration_min?: number;
  sort?: number;
  is_free?: number;
  status?: number;
}

// ===== 视图类型（对外投影，零内部 numeric FK）=====

export interface CourseListView {
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

export interface LessonView {
  public_id: string;
  title: string;
  lesson_type: string;
  content: string | null;
  duration_min: number;
  sort: number;
  is_free: number;
  order: number;
  completed: boolean;
  progress: number;
}

export class TrainingRepository extends BaseRepository {
  constructor(deps: RepoDeps) {
    super(deps);
  }



  // ===== courses =====

  async listCourses(teamId: number, offset: number, limit: number): Promise<CourseRow[]> {
    this.ensureTableRead('courses');
    return this.all<CourseRow>(
      `SELECT * FROM courses
        WHERE team_id = ? AND status IN (1,2) AND deleted_at IS NULL
        ORDER BY sort ASC, created_at DESC
        LIMIT ? OFFSET ?`,
      [teamId, limit, offset],
    );
  }

  async countCourses(teamId: number): Promise<number> {
    this.ensureTableRead('courses');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM courses WHERE team_id = ? AND status IN (1,2) AND deleted_at IS NULL`,
      [teamId],
    );
    return r?.n ?? 0;
  }

  async findCourseByPublicId(teamId: number, coursePublicId: string): Promise<CourseRow | null> {
    this.ensureTableRead('courses');
    return this.first<CourseRow>(
      `SELECT * FROM courses WHERE team_id = ? AND public_id = ? AND deleted_at IS NULL`,
      [teamId, coursePublicId],
    );
  }

  async listLessonsOfCourse(teamId: number, courseId: number): Promise<CourseLessonRow[]> {
    this.ensureTableRead('course_lessons');
    return this.all<CourseLessonRow>(
      `SELECT * FROM course_lessons WHERE team_id = ? AND course_id = ? AND status = 1 ORDER BY sort ASC, id ASC`,
      [teamId, courseId],
    );
  }

  async findLessonByPublicId(
    teamId: number,
    courseId: number,
    lessonPublicId: string,
  ): Promise<CourseLessonRow | null> {
    this.ensureTableRead('course_lessons');
    return this.first<CourseLessonRow>(
      `SELECT * FROM course_lessons WHERE team_id = ? AND course_id = ? AND public_id = ?`,
      [teamId, courseId, lessonPublicId],
    );
  }

  /** 全部活跃 lesson 数（用于课程学习进度分母）。 */
  async countActiveLessons(teamId: number, courseId: number): Promise<number> {
    this.ensureTableRead('course_lessons');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM course_lessons WHERE team_id = ? AND course_id = ? AND status = 1`,
      [teamId, courseId],
    );
    return r?.n ?? 0;
  }

  // ===== course_enrollments =====

  async findEnrollment(userId: number, courseId: number): Promise<CourseEnrollmentRow | null> {
    this.ensureTableRead('course_enrollments');
    return this.first<CourseEnrollmentRow>(
      `SELECT * FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      [userId, courseId],
    );
  }

  /**
   * 报名（INSERT，UNIQUE(user_id, course_id) 兜底）。
   * 返回 created=true（新报名）或 created=false（已报名，idempotent join）。
   */
  async insertEnrollment(
    userId: number,
    courseId: number,
    teamId: number,
    now: number,
  ): Promise<{ created: boolean; enrollmentId: number }> {
    this.ensureTableRead('course_enrollments');
    const existing = await this.findEnrollment(userId, courseId);
    if (existing) return { created: false, enrollmentId: existing.id };
    try {
      const res = await this.run(
        `INSERT INTO course_enrollments (user_id, course_id, team_id, progress, learned_minutes, status, created_at)
         VALUES (?, ?, ?, 0, 0, 1, ?)`,
        [userId, courseId, teamId, now],
      );
      const id = Number(res.meta?.last_row_id ?? 0);
      return { created: id > 0, enrollmentId: id };
    } catch (err) {
      // 并发重复报名：UNIQUE(user_id, course_id) → 幂等读回。
      const existing2 = await this.findEnrollment(userId, courseId);
      if (existing2) return { created: false, enrollmentId: existing2.id };
      throw err;
    }
  }

  // ===== learning_records（USER_SCOPED）=====

  async findLearningRecord(enrollmentId: number, lessonId: number): Promise<LearningRecordRow | null> {
    this.ensureTableRead('learning_records');
    return this.first<LearningRecordRow>(
      `SELECT * FROM learning_records WHERE enrollment_id = ? AND lesson_id = ?`,
      [enrollmentId, lessonId],
    );
  }

  /**
   * 学习进度 upsert（INSERT ... ON CONFLICT(enrollment_id, lesson_id) DO UPDATE）。
   * - progress 由服务端权威计算；completed_at 仅当 progress=100 时写入。
   * - learned_minutes 只允许增加（max 保留），禁止回退。
   */
  async upsertLearningRecord(
    enrollmentId: number,
    userId: number,
    lessonId: number,
    progress: number,
    learnedMinutes: number,
    now: number,
  ): Promise<void> {
    this.ensureTableRead('learning_records');
    await this.run(
      `INSERT INTO learning_records (enrollment_id, user_id, lesson_id, progress, learned_minutes, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? >= 100 THEN ? ELSE NULL END, ?, ?)
       ON CONFLICT(enrollment_id, lesson_id) DO UPDATE SET
         progress = MAX(learning_records.progress, excluded.progress),
         learned_minutes = MAX(learning_records.learned_minutes, excluded.learned_minutes),
         completed_at = COALESCE(learning_records.completed_at, excluded.completed_at),
         updated_at = excluded.updated_at`,
      [enrollmentId, userId, lessonId, progress, learnedMinutes, progress, now, now, now],
    );
  }

  /** 更新课程报名进度（服务端权威，聚合 learning_records）。 */
  async updateEnrollmentProgress(
    enrollmentId: number,
    teamId: number,
    progress: number,
    learnedMinutes: number,
    now: number,
  ): Promise<void> {
    this.ensureTableRead('course_enrollments');
    await this.run(
      `UPDATE course_enrollments
          SET progress = ?, learned_minutes = ?, status = CASE WHEN ? >= 100 THEN 3 ELSE status END,
              completed_at = CASE WHEN ? >= 100 THEN COALESCE(completed_at, ?) ELSE completed_at END,
              updated_at = ?
        WHERE id = ? AND team_id = ?`,
      [progress, learnedMinutes, progress, progress, now, now, enrollmentId, teamId],
    );
  }

  // ===== 我的学习进度（USER 归属；zero numeric FK 暴露）=====

  async listMyEnrollmentsByUser(userId: number): Promise<
    Array<{
      courseId: number;
      coursePublicId: string;
      title: string;
      summary: string | null;
      required: number;
      required_minutes: number;
      progress: number;
      learned_minutes: number;
      status: number;
      completed_at: number | null;
      enrollmentTeamId: number;
    }>
  > {
    this.ensureTableRead('course_enrollments');
    return this.all(
      `SELECT ce.course_id AS courseId, c.public_id AS coursePublicId, c.title, c.summary,
              c.required, c.required_minutes, ce.progress, ce.learned_minutes, ce.status,
              ce.completed_at, ce.team_id AS enrollmentTeamId
         FROM course_enrollments ce
         JOIN courses c ON c.id = ce.course_id
        WHERE ce.user_id = ?
        ORDER BY ce.updated_at DESC`,
      [userId],
    );
  }

  // ===== Admin CRUD（training.course.manage 由 route 层授权）=====

  async adminCreateCourse(teamId: number, createdBy: number, cmd: CourseInput, now: number): Promise<{ public_id: string }> {
    this.ensureTableRead('courses');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO courses
         (public_id, team_id, title, summary, detail, required, required_minutes, sort, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        teamId,
        cmd.title,
        cmd.summary ?? null,
        cmd.detail ?? null,
        cmd.required ?? 0,
        cmd.required_minutes ?? 0,
        cmd.sort ?? 0,
        cmd.status ?? 1,
        createdBy,
        now,
        now,
      ],
    );
    return { public_id: publicId };
  }

  async adminUpdateCourse(teamId: number, coursePublicId: string, cmd: CourseInput, now: number): Promise<boolean> {
    this.ensureTableRead('courses');
    const res = await this.run(
      `UPDATE courses
          SET title = ?, summary = ?, detail = ?, required = ?, required_minutes = ?, sort = ?, status = ?, updated_at = ?
        WHERE team_id = ? AND public_id = ?`,
      [
        cmd.title,
        cmd.summary ?? null,
        cmd.detail ?? null,
        cmd.required ?? 0,
        cmd.required_minutes ?? 0,
        cmd.sort ?? 0,
        cmd.status ?? 1,
        now,
        teamId,
        coursePublicId,
      ],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  async adminCreateLesson(
    teamId: number,
    courseId: number,
    cmd: LessonInput,
    now: number,
  ): Promise<{ public_id: string }> {
    this.ensureTableRead('course_lessons');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO course_lessons
         (public_id, team_id, course_id, title, lesson_type, content, duration_min, sort, is_free, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        teamId,
        courseId,
        cmd.title,
        cmd.lesson_type,
        cmd.content ?? null,
        cmd.duration_min ?? 0,
        cmd.sort ?? 0,
        cmd.is_free ?? 0,
        cmd.status ?? 1,
        now,
        now,
      ],
    );
    return { public_id: publicId };
  }

  async adminUpdateLesson(
    teamId: number,
    courseId: number,
    lessonPublicId: string,
    cmd: LessonInput,
    now: number,
  ): Promise<boolean> {
    this.ensureTableRead('course_lessons');
    const res = await this.run(
      `UPDATE course_lessons
          SET title = ?, lesson_type = ?, content = ?, duration_min = ?, sort = ?, is_free = ?, status = ?, updated_at = ?
        WHERE team_id = ? AND course_id = ? AND public_id = ?`,
      [
        cmd.title,
        cmd.lesson_type,
        cmd.content ?? null,
        cmd.duration_min ?? 0,
        cmd.sort ?? 0,
        cmd.is_free ?? 0,
        cmd.status ?? 1,
        now,
        teamId,
        courseId,
        lessonPublicId,
      ],
    );
    return (res.meta?.changes ?? 0) > 0;
  }
}

export default TrainingRepository;