/**
 * CertificateService（P32-P2）—— 证书读端点业务逻辑（mine / detail / verify）。
 *
 * 纪律：
 * - 发证只发生在 ExamService.submit 的原子 batch 内（服务端）；本服务只读。
 * - 不暴露 id_card / numeric internal ids / private user metadata。
 * - mine：USER_SCOPED 归属（user_id = 当前用户）；detail：持证者本人或同团队管理员。
 * - verify：公开验真，仅安全字段（cert_no / cert_type / holder_name / issuer_name / issued_at / status）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  CertificateRepository,
  type CertificateListView,
  type CertificateVerifyView,
} from '../repository/certificate';
import { authRequired, notFound } from '../utils/errors';
import { authorizePermission } from '../middleware/rbac';
import type { Env } from '../env';

export interface CertificateServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env?: Env;
}

export class CertificateService {
  private readonly repo: CertificateRepository;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly env: Env;

  constructor(deps: CertificateServiceDeps) {
    this.repo = new CertificateRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.env = deps.env ?? ({ DB: deps.db } as unknown as Env);
  }

  async mine(): Promise<{ certificates: CertificateListView[] }> {
    const userId = this.getUserId();
    const certs = await this.repo.listCertsByUser(userId);
    return { certificates: certs };
  }

  /**
   * 证书详情。归属规则（对齐 frozen catalog "本人查看走归属规则"）：
   * - 持证者本人（SELF，user_id === 当前用户）→ 直接允许（不要求 TEAM cert.view）。
   * - 非本人 → 需同团队 + certificate.certificate.view（DB-backed）才可查（团队管理员浏览）。
   * 不满足 → 404（不泄露存在性）。
   */
  async detail(certificatePublicId: string) {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    const detail = await this.repo.getCertDetailByPublicId(certificatePublicId);
    if (!detail) throw notFound('Certificate');
    const isOwner = detail.user_id === this.auth.userId;
    if (!isOwner) {
      // 团队管理员浏览：需同团队 + cert.view
      if (this.tenant.teamId == null || detail.team_id !== this.tenant.teamId) throw notFound('Certificate');
      await authorizePermission(this.env, this.auth, 'certificate.certificate.view');
    }
    return {
      certificate: {
        public_id: detail.public_id,
        cert_no: detail.cert_no,
        cert_type: detail.cert_type,
        holder_name: detail.holder_name,
        issuer_name: detail.issuer_name,
        issued_at: detail.issued_at,
        status: detail.status,
        source_type: detail.source_type,
        source_public_id: detail.source_public_id,
        activity_public_id: detail.activity_public_id,
        course_public_id: detail.course_public_id,
      },
    };
  }

  async verify(certNo?: unknown, verifyCode?: unknown): Promise<{ certificate: CertificateVerifyView | null }> {
    const no = typeof certNo === 'string' ? certNo.trim() : '';
    const code = typeof verifyCode === 'string' ? verifyCode.trim() : '';
    if (no === '' && code === '') throw notFound('Certificate');
    const view = await this.repo.verifyCert(no, code || undefined);
    return { certificate: view };
  }

  private getUserId(): number {
    const uid = this.repo['ctx'].auth.userId;
    if (uid == null) throw authRequired();
    return uid;
  }
}

export default CertificateService;