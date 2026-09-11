/**
 * ExamService（P32-P2）—— 考试会话业务逻辑：start / resume / submit / grade / auto-issue。
 *
 * 契约（P32-P1 series 冻结）：
 * - start：服务端抽 20 题（pick_rule）、钉入 exam_answers、写入不可变 snapshot；客户端只拿
 *   questionPublicId + stem/options（不含答案、不含 numeric id）。
 * - submit：body 仅 questionPublicId + selected；服务端校验"恰好 20、无重复、无外来、无缺漏"，
 *   从题库权威 answer 算分；score/passed 客户端不得传入。
 * - 并发：uq_exam_attempt + uq_exam_active_attempt 是 DB 终裁；start 输家 deterministic readback
 *   已有活跃会话；submit 并发以 conditional guard 收敛，唯一索引兜底真实回滚。
 * - status：1=IN_PROGRESS，3=COMPLETED；本域绝不写 2/4。
 * - 发证：仅服务端 submit 内；passed=1 且无 active cert 则原子发证 + 记 log + 消费号池；
 *   retake 完成不再发第二张；pool 竞争 → 整批 no-op → 重试。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { ExamRepository, type ExamPaperRow, type GradedAnswer } from '../repository/exam';
import { CertificateRepository } from '../repository/certificate';
import { invalidParam, authRequired, teamScopeRequired, notFound, conflict, ConflictReason, internalError } from '../utils/errors';
import { generateUlid } from '../utils/crypto';

export interface ExamServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env?: { ENVIRONMENT?: string; JHZY_FAULT_INJECT?: string };
}

/** P32 冻结：training paper 及格线固定 90（schema 默认 60 仅作文档）。 */
const TRAINING_PASS_SCORE = 90;
const EXAM_STATUS_COMPLETED = 3;

/**
 * P0-C 冻结：INITIAL_VOLUNTEER 资格试卷的 production invariant。
 * - 真实参与考试的题量必须恰为 20（在 start 抽题后校验 actual question count）。
 * - 及格线强制 90（不依赖行内 pass_score，避免误配）。
 * 仅对 exam_papers.purpose = 'INITIAL_VOLUNTEER' 生效；其它试卷行为不变。
 */
const INITIAL_VOLUNTEER_PURPOSE = 'INITIAL_VOLUNTEER';
const INITIAL_VOLUNTEER_EXAM_QUESTION_COUNT = 20;
const INITIAL_VOLUNTEER_PASS_SCORE = 90;

export interface ExamAttemptView {
  session_public_id: string;
  status: number;
  attempt_no: number;
  started_at: number;
  submitted_at: number | null;
  duration_min: number;
  total_score: number;
  pass_score: number;
  questions: Array<{
    question_public_id: string;
    stem: string;
    options: Array<{ key: string; text: string }>;
    order: number;
  }>;
}

export interface ExamResultView {
  session_public_id: string;
  status: number;
  score: number | null;
  passed: boolean | null;
  submitted_at: number | null;
  answers: Array<{ questionPublicId: string; selected: string | null; isCorrect: boolean | null }>;
  certificate: { public_id: string; cert_no: string; status: number } | null;
}

export interface SubmittedAnswer {
  questionPublicId: string;
  selected: string;
}

export class ExamService {
  private readonly repo: ExamRepository;
  private readonly certRepo: CertificateRepository;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly env: { ENVIRONMENT?: string; JHZY_FAULT_INJECT?: string };

  constructor(deps: ExamServiceDeps) {
    this.repo = new ExamRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.certRepo = new CertificateRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.env = deps.env ?? {};
  }

  private requireActor(): { userId: number; teamId: number } {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: this.auth.userId, teamId: this.tenant.teamId };
  }

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** 本地故障注入（仅 local + 显式开关；生产永不触发）。1=cert INSERT CHECK 违例；2=log action CHECK 违例。 */
  private faultMode(): 0 | 1 | 2 {
    if ((this.env.ENVIRONMENT ?? 'local') !== 'local') return 0;
    const v = this.env.JHZY_FAULT_INJECT;
    if (v === '1') return 1;
    if (v === '2') return 2;
    return 0;
  }

  // ===== start =====

  async start(paperPublicId: string): Promise<{ attempt: ExamAttemptView }> {
    const { teamId, userId } = this.requireActor();
    const paper = await this.repo.findPaperByPublicId(teamId, paperPublicId);
    if (!paper || paper.status !== 1) throw notFound('Exam paper');

    // 1) 单活跃 attempt（DB 终裁；预检仅给更友好错误 + readback 路径）
    const active = await this.repo.findActiveSessionByUserPaper(userId, paper.id);
    if (active) {
      return { attempt: await this.toAttemptView(active.id, teamId) };
    }

    // 2) max_attempts 上限（真实 schema 支持；预检非原子，唯一索引兜底）
    const attempts = await this.repo.countUserAttempts(userId, paper.id);
    if (attempts >= paper.max_attempts) {
      throw conflict(ConflictReason.EXAM_MAX_ATTEMPTS_REACHED);
    }

    // 3) 服务端抽题（pick_rule → 恰好 count；题量不足 start 前拒绝）
    let rule: Record<string, unknown>;
    try {
      rule = JSON.parse(paper.pick_rule);
    } catch {
      rule = { count: 20 };
    }
    if (typeof rule !== 'object' || rule == null) rule = { count: 20 };
    if (typeof rule.count !== 'number') rule.count = 20;
    const questions = await this.repo.drawQuestions(rule);
    if (questions.length !== rule.count) {
      throw invalidParam('pick_rule', `expected ${rule.count} questions but got ${questions.length}`);
    }
    // P0-C：INITIAL_VOLUNTEER 资格试卷的 production invariant —— 真实抽到的题目必须恰为 20。
    // 这是「实际参与该考试的题目集合」的可靠 backend authority point（start 抽题后、落库前）。
    if (paper.purpose === INITIAL_VOLUNTEER_PURPOSE && questions.length !== INITIAL_VOLUNTEER_EXAM_QUESTION_COUNT) {
      throw invalidParam(
        'pick_rule',
        `INITIAL_VOLUNTEER exam requires exactly ${INITIAL_VOLUNTEER_EXAM_QUESTION_COUNT} questions but got ${questions.length}`,
      );
    }

    // 4) 原子 start（session + pinned answers）
    const now = this.nowSeconds();
    const outcome = await this.repo.startSessionAtomically(paper.id, teamId, userId, questions, now);
    return { attempt: await this.toAttemptView(outcome.sessionId, teamId) };
  }

  // ===== resume / get =====

  async getSession(sessionPublicId: string): Promise<{ attempt: ExamAttemptView }> {
    const { teamId } = this.requireActor();
    const session = await this.repo.findSessionByPublicId(teamId, sessionPublicId);
    if (!session) throw notFound('Exam session');
    return { attempt: await this.toAttemptView(session.id, teamId) };
  }

  // ===== submit =====

  async submit(sessionPublicId: string, body: { answers?: unknown }): Promise<{ result: ExamResultView }> {
    const { teamId, userId } = this.requireActor();
    const session = await this.repo.findSessionByPublicId(teamId, sessionPublicId);
    if (!session) throw notFound('Exam session');
    if (session.user_id !== userId) throw notFound('Exam session');
    const paper = await this.repo.findPaperById(session.paper_id);
    if (!paper) throw notFound('Exam paper');

    // idempotent replay: 已 COMPLETED → 直接读回已有权威 result
    if (session.status === EXAM_STATUS_COMPLETED) {
      return { result: await this.buildResult(session.id, teamId, sessionPublicId) };
    }

    // 校验 body.answers
    const answers = this.validateAnswerBody(body);

    // 服务端权威取分：读取本 session 钉住的题 + 题库权威 answer
    const pinned = await this.repo.listPinnedQuestions(session.id, teamId);
    const byPublicId = new Map(pinned.map((p) => [p.questionPublicId, p]));
    if (pinned.length !== answers.length) {
      throw invalidParam('answers', `expected ${pinned.length} answers but got ${answers.length}`);
    }
    const seen = new Set<string>();
    const graded: GradedAnswer[] = [];
    for (const a of answers) {
      if (seen.has(a.questionPublicId)) throw invalidParam('answers', 'duplicate question');
      seen.add(a.questionPublicId);
      const q = byPublicId.get(a.questionPublicId);
      if (!q) throw invalidParam('answers', 'question not in this attempt');
      const correct = this.isCorrect(q.answer, q.question_type, a.selected);
      graded.push({
        questionPublicId: a.questionPublicId,
        selected: a.selected,
        isCorrect: correct,
        score: correct ? 1 : 0,
      });
    }

    const score = Math.round((graded.filter((g) => g.isCorrect).length / graded.length) * paper.total_score);
    const passScore = this.resolvePassScore(paper);
    const passed = score >= passScore;

    // 决定是否发证：passed && 无 active cert
    const needIssue = passed && !(await this.certRepo.hasActiveTrainingCert(userId, session.paper_id));
    let certNoCandidate: string | null = null;
    let certPublicId: string | null = null;
    let verifyCode: string | null = null;
    let templateId: number | null = null;
    if (needIssue) {
      certNoCandidate = await this.certRepo.pickCertTrnCandidate();
      if (certNoCandidate == null) {
        // 号池耗尽：整体 no-op（session 保持 IN_PROGRESS），客户端可稍后重试
        throw conflict(ConflictReason.EXAM_POOL_EXHAUSTED);
      }
      const template = await this.certRepo.findTrainingTemplate();
      if (!template) throw internalError();
      templateId = template.id;
      certPublicId = generateUlid();
      verifyCode = generateUlid();
    }

    const now = this.nowSeconds();
    const fault = this.faultMode();
    console.error('[DEBUG] faultMode:', fault, 'JHZY_FAULT_INJECT:', this.env.JHZY_FAULT_INJECT);
    const outcome = await this.repo.submitAndMaybeIssueAtomically({
      sessionId: session.id,
      sessionPublicId,
      teamId,
      userId,
      paperId: session.paper_id,
      passed,
      score,
      graded,
      certNoCandidate,
      certPublicId,
      verifyCode,
      templateId,
      snapshotCert: JSON.stringify({
        certType: 'training',
        holderName: null,
        issuerName: null,
        paperPublicId: paper.public_id,
        passed,
        score,
      }),
      now,
      faultCertType: fault === 1 ? '__FAULT__' : undefined,
      faultLogAction: fault === 2 ? '__FAULT__' : undefined,
    });

    if (outcome.retryRequired) {
      throw conflict(ConflictReason.EXAM_POOL_EXHAUSTED); // 号池竞争：确定性冲突，客户端可重试
    }

    return { result: await this.buildResult(session.id, teamId, sessionPublicId) };
  }

  private resolvePassScore(paper: Pick<ExamPaperRow, 'pass_score' | 'purpose'>): number {
    // P0-C：INITIAL_VOLUNTEER 资格试卷及格线强制 90（production invariant，不依赖行内 pass_score）。
    if (paper.purpose === INITIAL_VOLUNTEER_PURPOSE) return INITIAL_VOLUNTEER_PASS_SCORE;
    // 其余试卷保持自身 pass_score（schema 默认 60 仅作 doc；非法 0 回退 TRAINING_PASS_SCORE）。
    return paper.pass_score > 0 ? paper.pass_score : TRAINING_PASS_SCORE;
  }

  // ===== helpers =====

  private validateAnswerBody(body: { answers?: unknown }): SubmittedAnswer[] {
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      throw invalidParam('answers', 'required non-empty array');
    }
    return body.answers.map((a, i) => {
      const item = a as { questionPublicId?: unknown; selected?: unknown };
      if (typeof item?.questionPublicId !== 'string' || item.questionPublicId.trim() === '') {
        throw invalidParam(`answers[${i}].questionPublicId`, 'required');
      }
      if (typeof item.selected !== 'string') {
        throw invalidParam(`answers[${i}].selected`, 'required');
      }
      if (item.selected.length > 1000) {
        throw invalidParam(`answers[${i}].selected`, 'too_long');
      }
      return { questionPublicId: item.questionPublicId, selected: item.selected };
    });
  }

  private isCorrect(canonical: string, qtype: string, selected: string): boolean {
    const norm = (s: string) =>
      s
        .split(/[,，]/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
        .sort()
        .join(',');
    if (qtype === 'multiple') {
      return norm(canonical) === norm(selected);
    }
    return canonical.trim().toUpperCase() === selected.trim().toUpperCase();
  }

  private async toAttemptView(sessionId: number, teamId: number): Promise<ExamAttemptView> {
    const session = await this.repo.findSessionByPublicId(teamId, (await this.getSessionPublicId(sessionId)));
    if (!session) throw notFound('Exam session');
    const paper = await this.repo.findPaperById(session.paper_id);
    if (!paper) throw notFound('Exam paper');
    const pinned = await this.repo.listPinnedQuestions(session.id, teamId);
    const snapshot = this.parseSnapshot(session.snapshot);
    const questions = pinned.map((p, idx) => {
      const snap = snapshot.questions.find((q: any) => q.publicId === p.questionPublicId);
      return {
        question_public_id: p.questionPublicId,
        stem: snap?.stem ?? '',
        options: snap?.options ?? [],
        order: idx + 1,
      };
    });
    return {
      session_public_id: session.public_id,
      status: session.status,
      attempt_no: session.attempt_no,
      started_at: session.started_at,
      submitted_at: session.submitted_at,
      duration_min: paper.duration_min,
      total_score: paper.total_score,
      pass_score: this.resolvePassScore(paper),
      questions,
    };
  }

  private async getSessionPublicId(sessionId: number): Promise<string> {
    const r = await this.repo['first']<{ public_id: string }>(
      `SELECT public_id FROM exam_sessions WHERE id = ?`,
      [sessionId],
    );
    if (!r) throw notFound('Exam session');
    return r.public_id;
  }

  private parseSnapshot(raw: string | null): {
    questions: Array<{ publicId: string; stem?: string; options?: Array<{ key: string; text: string }> }>;
  } {
    try {
      const obj = raw ? JSON.parse(raw) : {};
      return { questions: Array.isArray(obj.questions) ? obj.questions : [] };
    } catch {
      return { questions: [] };
    }
  }

  private async buildResult(sessionId: number, teamId: number, sessionPublicId: string): Promise<ExamResultView> {
    const session = await this.repo.findSessionByPublicId(teamId, sessionPublicId);
    if (!session) throw notFound('Exam session');
    const answers = await this.repo.listSessionAnswers(sessionId, teamId);
    let certificate = null;
    if (session.paper_id != null) {
      const cert = await this.repo['first']<{ public_id: string; cert_no: string; status: number }>(
        `SELECT public_id, cert_no, status FROM certificates
          WHERE user_id = ? AND exam_paper_id = ? AND status = 1 ORDER BY issued_at DESC LIMIT 1`,
        [session.user_id, session.paper_id],
      );
      certificate = cert ?? null;
    }
    return {
      session_public_id: session.public_id,
      status: session.status,
      score: session.score,
      passed: session.passed == null ? null : session.passed === 1,
      submitted_at: session.submitted_at,
      answers: answers.map((a) => ({
        questionPublicId: a.questionPublicId,
        selected: a.selected,
        isCorrect: a.isCorrect == null ? null : a.isCorrect === 1,
      })),
      certificate,
    };
  }
}

export default ExamService;