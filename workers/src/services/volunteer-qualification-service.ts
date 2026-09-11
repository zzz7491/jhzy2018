/**
 * VolunteerQualificationService（P0-C 资格派生 + 门禁）。
 *
 * 公式（DERIVED FACT，无持久化 qualification_status）：
 *   VOLUNTEER_QUALIFIED =
 *     IDENTITY_2_FACTOR_VERIFIED AND WECHAT_PHONE_BOUND AND INITIAL_TRAINING_EXAM_PASSED
 *
 * 纪律（用户 P0-C §10 / §12 / §13）：
 *   - 不引用 volunteer_profiles.cert_status / users.status / team membership / team role / legacy admin approval。
 *   - 不向调用方暴露 PII；仅返回布尔事实 + 稳定 reason token（USER_SCOPED 投影）。
 *   - getVolunteerQualification(userId) 为唯一权威派生入口；assertVolunteerQualified 为门禁。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import { VolunteerQualificationRepository } from '../repository/volunteer-qualification-repository';
import { qualificationRequired, QualificationReason } from '../utils/errors';

/** 资格派生结果（USER_SCOPED 投影，无 PII）。 */
export interface VolunteerQualification {
  qualified: boolean;
  identity_verified: boolean;
  phone_bound: boolean;
  initial_training_exam_passed: boolean;
  /** 缺失项稳定 token：IDENTITY_REQUIRED / PHONE_REQUIRED / TRAINING_EXAM_REQUIRED（按字典序稳定）。 */
  reasons: string[];
}

export interface VolunteerQualificationDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export class VolunteerQualificationService {
  private readonly repo: VolunteerQualificationRepository;

  constructor(deps: VolunteerQualificationDeps) {
    this.repo = new VolunteerQualificationRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /** 实时派生三事实（无缓存，成本低；如未来需高并发可对结果做短 TTL）。 */
  async getVolunteerQualification(userId: number): Promise<VolunteerQualification> {
    const [identity_verified, phone_bound, initial_training_exam_passed] = await Promise.all([
      this.repo.existsIdentityVerified(userId),
      this.repo.existsPhoneBound(userId),
      this.repo.existsInitialTrainingExamPassed(userId),
    ]);

    const reasons: string[] = [];
    if (!identity_verified) reasons.push(QualificationReason.IDENTITY_REQUIRED);
    if (!phone_bound) reasons.push(QualificationReason.PHONE_REQUIRED);
    if (!initial_training_exam_passed) reasons.push(QualificationReason.TRAINING_EXAM_REQUIRED);

    return {
      qualified: reasons.length === 0,
      identity_verified,
      phone_bound,
      initial_training_exam_passed,
      reasons,
    };
  }

  /** 门禁：不满足资格 → 抛 403 QUALIFICATION_REQUIRED（details.reasons 携带缺失项）。 */
  async assertVolunteerQualified(userId: number): Promise<void> {
    const q = await this.getVolunteerQualification(userId);
    if (!q.qualified) {
      throw qualificationRequired(q.reasons);
    }
  }
}

/**
 * 服务/路由层便捷门禁（避免在各 use-case 内重复构造 repo/service）。
 * 严格限定传入的 (db, auth, tenant) 与 userId；不修改任何状态。
 */
export async function assertVolunteerQualified(
  db: D1Database,
  auth: AuthContext,
  tenant: TenantContext,
  userId: number,
): Promise<void> {
  const svc = new VolunteerQualificationService({ db, auth, tenant });
  await svc.assertVolunteerQualified(userId);
}
