/**
 * VolunteerQualificationRepository（P0-C 资格派生）。
 *
 * 职责（单一事实来源，无持久化 qualification_status）：
 *   - identity verified = 存在 identity_verifications.status = 'VERIFIED' 行（以「存在 VERIFIED」而非 getStatus 最新态，
 *     避免失败 attempt 掩盖既往核验，见 P0-C 审计 §2）。
 *   - phone bound      = 存在 phone_verifications.status = 'BOUND' 行（复用 P0-B 语义）。
 *   - initial training+exam passed = 该用户完成一门 INITIAL_VOLUNTEER 课程（course_enrollments.status=3 OR completed_at 非空）
 *     且通过关联 INITIAL_VOLUNTEER 试卷的考试（exam_sessions.passed=1 AND status=3）。
 *
 * 读取纪律（P0-C 审计 §9）：
 *   - 资格派生以 user_id 跨表联查 TEAM_SCOPED 表（courses/course_enrollments/exam_papers/exam_sessions），
 *     但仅取该 user_id 自身行，不泄露他人数据。
 *   - 本 repo 故意【绕过】BaseRepository.ensureTableRead 团队守卫：直接 db.prepare().bind() 只读，
 *     因为资格是「每用户」派生、不依赖 ctx.tenant.teamId（状态端点仅 auth required 即可工作）。
 *   - 本类不读 HTTP / 不决定身份；user_id 由调用方（service）显式传入。
 */

import { BaseRepository, type RepoDeps } from './base';

export class VolunteerQualificationRepository extends BaseRepository {
  /** 存在 VERIFIED 身份核验行（永久事实，P0-A 无 REVOKED 状态）。 */
  async existsIdentityVerified(userId: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT 1 FROM identity_verifications WHERE user_id = ? AND status = 'VERIFIED' LIMIT 1`,
      )
      .bind(userId)
      .first();
    return r != null;
  }

  /** 存在 BOUND 微信可信手机号绑定行。 */
  async existsPhoneBound(userId: number): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 FROM phone_verifications WHERE user_id = ? AND status = 'BOUND' LIMIT 1`)
      .bind(userId)
      .first();
    return r != null;
  }

  /**
   * 初始必训课程完成 + 关联初始试卷考试通过（EXAM_PASS_IMPLIES_TRAINING_COMPLETION = NO，
   * 故二者须同时成立）。
   * - courses.purpose = 'INITIAL_VOLUNTEER' AND deleted_at IS NULL
   * - course_enrollments.user_id = ? AND (status = 3 OR completed_at IS NOT NULL)
   * - exam_papers.course_id = 该课程 AND purpose = 'INITIAL_VOLUNTEER' AND deleted_at IS NULL
   * - exam_sessions.paper_id = 该试卷 AND user_id = ce.user_id AND passed = 1 AND status = 3
   *
   * 历史会话安全（P0-C FINAL SEMANTIC FIX）：仅凭 passed=1 AND status=3 不足以防「旧普通试卷会话
   * 在其试卷后来被标记为 INITIAL_VOLUNTEER 后直接满足资格」。故额外要求该 attempt 的【真实事实】：
   *   - es.score >= 90         —— 达到 INITIAL 资格线（普通试卷 60 分线通过的历史会话不满足）；
   *   - 实际题量 = 20         —— 以钉入的 exam_answers 行数（pull 抽题的真实题目集合）为准，
   *                              排除题量非 20（如 10/19/21 题）的历史尝试。
   * 二者均可由既有 session/answer 数据可靠证明，不依赖时间戳或推测。
   */
  async existsInitialTrainingExamPassed(userId: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT 1
           FROM course_enrollments ce
           JOIN courses c
             ON c.id = ce.course_id
            AND c.purpose = 'INITIAL_VOLUNTEER'
            AND c.deleted_at IS NULL
           JOIN exam_papers ep
             ON ep.course_id = c.id
            AND ep.purpose = 'INITIAL_VOLUNTEER'
            AND ep.deleted_at IS NULL
           JOIN exam_sessions es
             ON es.paper_id = ep.id
            AND es.user_id = ce.user_id
          WHERE ce.user_id = ?
            AND (ce.status = 3 OR ce.completed_at IS NOT NULL)
            AND es.passed = 1
            AND es.status = 3
            AND es.score IS NOT NULL
            AND es.score >= 90
            AND (SELECT COUNT(*) FROM exam_answers ea WHERE ea.session_id = es.id) = 20
          LIMIT 1`,
      )
      .bind(userId)
      .first();
    return r != null;
  }
}
