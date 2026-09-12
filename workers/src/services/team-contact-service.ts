/**
 * TeamContactService（N0-E5B）—— 团队公开业务联系人（TEAM_PUBLIC_CONTACT）业务逻辑层。
 *
 * 冻结语义（N0-E5 §THING18_CONTRACT = TEAM_PUBLIC_CONTACT）：
 *   团队管理员主动填写、并明确公开给活动报名者的业务联系人信息。
 *   它不等于 owner 私人电话 / trusted WeChat phone / identity verification phone /
 *   volunteer profile phone / emergency contact / creator nickname / raw openid。
 *
 * 纪律（与全仓一致）：
 * - 数据分类 = PUBLIC BUSINESS DATA（对报名者公开），与身份认证数据严格分离。
 * - team_id 一律服务端派生（R1 铁律）：只接受调用方【当前团队上下文】的 active team，
 *   绝不接受客户端提交的 team_id / 内部 id。
 * - 目标团队（URL :id）必须等于 active team，否则 404（跨团队隔离，不泄露存在性）。
 * - 写入是窄更新：只碰 public_contact_name / public_contact_phone；不是任意 team profile patch。
 * - 规范化 / 校验是本文件的单一 SSOT（对称于 ActivityAdminService.normalizeAddress）。
 * - 隐私：响应永不携带 trusted phone / identity / emergency contact / openid / hash。
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  TeamRepository,
  type PublicContactRow,
  type PublicContactPatch,
} from '../repository/teams';
import { invalidParam, teamScopeRequired, authRequired, notFound } from '../utils/errors';
import type { RepositoryContext } from '../types/tenant';

export interface TeamContactDeps {
  db: D1Database;
  ctx: RepositoryContext;
}

/** 公开业务联系人名称长度上限（人类可读，如「张老师 / 嘉禾志愿服务中心」）。 */
export const PUBLIC_CONTACT_NAME_MAX_LENGTH = 100;

/**
 * 公开业务联系电话长度上限。
 *
 * 保守上限：业务联系电话可能是 手机 / 座机 / 带区号 / 公开服务热线，
 * 因此【不】使用严格的中国大陆手机正则（对照 form-service 的 PHONE_RE 不适用此处）。
 */
export const PUBLIC_CONTACT_PHONE_MAX_LENGTH = 32;

/**
 * 业务联系电话保守字符集：仅 数字 / 空格 / 连字符 / 加号 / 圆括号。
 * 额外要求至少包含 1 位数字（纯符号 / 纯字母一律拒绝）。
 */
const PUBLIC_CONTACT_PHONE_RE = /^[0-9 +()\-]+$/;

/** 请求体中允许出现的字段（窄端点；其余键一律 400，防止借 PATCH 篡改其他团队数据）。 */
export const PUBLIC_CONTACT_ALLOWED_FIELDS = ['public_contact_name', 'public_contact_phone'] as const;

export class TeamContactService {
  private readonly repo: TeamRepository;
  private readonly ctx: RepositoryContext;

  constructor(deps: TeamContactDeps) {
    this.repo = new TeamRepository(deps);
    this.ctx = deps.ctx;
  }

  /**
   * 公开业务联系人名称规范化（单一 SSOT）。
   * - undefined → 不改动（由调用方决定是否写入 patch）
   * - null → null（清空）
   * - 非 string → 400
   * - trim 后为空串 → null
   * - trim 后长度 > PUBLIC_CONTACT_NAME_MAX_LENGTH → 400
   */
  private normalizeName(raw: unknown, field: string): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
      throw invalidParam(field, 'must be a string or null');
    }
    const v = raw.trim();
    if (v === '') return null;
    if (v.length > PUBLIC_CONTACT_NAME_MAX_LENGTH) {
      throw invalidParam(field, `must be <= ${PUBLIC_CONTACT_NAME_MAX_LENGTH} characters`);
    }
    return v;
  }

  /**
   * 公开业务联系电话规范化（单一 SSOT，保守校验）。
   * - undefined → 不改动（由调用方决定是否写入 patch）
   * - null → null（清空）
   * - 非 string → 400
   * - trim 后为空串 → null
   * - trim 后长度 > PUBLIC_CONTACT_PHONE_MAX_LENGTH → 400
   * - 字符集不合法（含字母等）或缺少数位 → 400
   */
  private normalizePhone(raw: unknown, field: string): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
      throw invalidParam(field, 'must be a string or null');
    }
    const v = raw.trim();
    if (v === '') return null;
    if (v.length > PUBLIC_CONTACT_PHONE_MAX_LENGTH) {
      throw invalidParam(field, `must be <= ${PUBLIC_CONTACT_PHONE_MAX_LENGTH} characters`);
    }
    if (!PUBLIC_CONTACT_PHONE_RE.test(v) || !/[0-9]/.test(v)) {
      throw invalidParam(field, 'must contain only digits, spaces, + - ( ) and at least one digit');
    }
    return v;
  }

  /**
   * 解析并收口目标团队：必须处于当前团队上下文，且 URL :id 等于 active team。
   * - 无 active team（平台上下文 / 未选团队）→ 403 TEAM_SCOPE_REQUIRED（禁止平台级任意改动）。
   * - 团队不存在 / 已删除 → 404。
   * - 目标团队 != active team → 404（跨团队隔离，不泄露存在性）。
   */
  private async requireScopedTeam(teamPublicId: string): Promise<number> {
    const teamId = this.ctx.tenant.teamId;
    if (this.ctx.auth.userId == null) throw authRequired();
    if (teamId == null) throw teamScopeRequired();

    const team = await this.repo.findByPublicId(teamPublicId); // 非法 ULID / 不存在 → 404
    if (team.id !== teamId) throw notFound('Team');
    return teamId;
  }

  /** 读取团队公开业务联系人（窄读，仅两个公开字段）。 */
  async getPublicContact(teamPublicId: string): Promise<PublicContactRow> {
    const teamId = await this.requireScopedTeam(teamPublicId);
    const row = await this.repo.findPublicContactByTeamId(teamId);
    return row ?? { public_contact_name: null, public_contact_phone: null };
  }

  /**
   * 更新团队公开业务联系人（窄写）。
   *
   * @param body 已通过路由层 allowlist（仅 public_contact_name / public_contact_phone）。
   *             至少需提供 1 个字段；两字段均缺省 → 400。
   */
  async updatePublicContact(
    teamPublicId: string,
    body: Record<string, unknown>,
  ): Promise<PublicContactRow> {
    const teamId = await this.requireScopedTeam(teamPublicId);

    const hasName = Object.prototype.hasOwnProperty.call(body, 'public_contact_name');
    const hasPhone = Object.prototype.hasOwnProperty.call(body, 'public_contact_phone');
    if (!hasName && !hasPhone) {
      throw invalidParam('body', 'at least one of public_contact_name / public_contact_phone is required');
    }

    const patch: PublicContactPatch = {};
    // 规范化先于任何写入（校验失败 → 不落库）。
    if (hasName) patch.public_contact_name = this.normalizeName(body.public_contact_name, 'public_contact_name');
    if (hasPhone) patch.public_contact_phone = this.normalizePhone(body.public_contact_phone, 'public_contact_phone');

    await this.repo.updatePublicContact(teamId, patch);
    const row = await this.repo.findPublicContactByTeamId(teamId);
    return row ?? { public_contact_name: null, public_contact_phone: null };
  }
}
