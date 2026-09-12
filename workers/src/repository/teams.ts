/**
 * TeamRepository（S2-5 最小只读 + P30-P1A 团队上下文后端）。
 *
 * scope 事实（S2-3 矩阵）：
 * - teams：PLATFORM_GLOBAL（团队是平台级引用数据，已认证即可读单团详情）。
 * - team_members：TEAM_SCOPED（本阶段不提供成员列表端点）。
 * - user_roles：PLATFORM_GLOBAL 记录（含 scope_team_id 区分平台/团队级）。
 */

import { BaseRepository } from './base';
import { notFound, internalError } from '../utils/errors';
import { isUlid } from '../utils/validation';

export interface TeamRow {
  id: number;
  public_id: string;
  name: string;
  short_name: string | null;
  intro: string | null;
  cert_status: number;
  status: number;
  is_system: number;
  created_at: number;
  /**
   * 团队公开业务联系人名称（N0-E5B §THING18_CONTRACT = TEAM_PUBLIC_CONTACT）。
   *
   * NULL = 该团队尚未配置公开业务联系人（不是"未知"，也不继承 owner / user profile）。
   * 数据分类 = PUBLIC BUSINESS DATA（对报名者公开），与身份认证数据严格分离。
   */
  public_contact_name: string | null;
  /** 团队主动公开的业务联系电话（NULL = 未配置；非 trusted / identity phone）。 */
  public_contact_phone: string | null;
}

/**
 * 团队公开业务联系人的最小读视图（N0-E5B）。
 *
 * 刻意只含两个公开字段：这是未来 signup notification payload（thing18 / 联系电话）
 * 的唯一权威来源，绝不携带 owner 私人电话 / trusted phone / identity / openid。
 */
export interface PublicContactRow {
  public_contact_name: string | null;
  public_contact_phone: string | null;
}

/**
 * 团队公开业务联系人更新补丁（N0-E5B，窄更新）。
 *
 * 只允许两个字段；undefined = 不改动（partial update 语义）。
 * 规范化 / 校验由 TeamContactService 收口（单一 SSOT）。
 */
export interface PublicContactPatch {
  public_contact_name?: string | null;
  public_contact_phone?: string | null;
}

export type JoinStatus = 'created' | 'existing';

export class TeamRepository extends BaseRepository {
  /** 按 ULID public_id 读取团队（PLATFORM_GLOBAL：不要求 team 上下文）。 */
  async findByPublicId(publicId: string): Promise<TeamRow> {
    // 双保险：即使路由层已校验，repository 仍拒绝非 ULID 输入。
    if (!isUlid(publicId)) throw notFound('Team');

    const row = await this.first<TeamRow>(
      `SELECT id, public_id, name, short_name, intro, cert_status, status, is_system, created_at,
              public_contact_name, public_contact_phone
         FROM teams
        WHERE public_id = ? AND deleted_at IS NULL`,
      [publicId],
    );
    if (!row) throw notFound('Team');
    return row;
  }

  /**
   * 当前用户「真正拥有 TEAM 作用域」的团队列表（P30-P1A GET /mine）。
   * - 仅包含 user_roles 中存在 scope_team_id = team.id 的有效（角色未停用、未过期）绑定。
   * - 平台级绑定（scope_team_id IS NULL）不计入——它们不是「某个团队」的作用域。
   * - SELF：由调用方传入 userId，不读 request。
   * - 确定性排序：public_id ASC。
   */
  async listMine(userId: number): Promise<TeamRow[]> {
    const now = Math.floor(Date.now() / 1000);
    return this.all<TeamRow>(
      `SELECT t.public_id, t.name, t.short_name, t.intro, t.cert_status, t.status, t.is_system, t.created_at, t.id,
              t.public_contact_name, t.public_contact_phone
         FROM teams t
        WHERE t.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ?
             AND ur.scope_team_id = t.id
             AND r.status = 1
             AND (ur.expires_at IS NULL OR ur.expires_at > ?)
          )
        ORDER BY t.public_id ASC`,
      [userId, now],
    );
  }

  /**
   * 本人加入目标团队（P30-P1A POST /:teamId/join）。
   *
   * 原子写入（单一 D1 batch = 事务）：
   *   1) team_members(team_id, user_id, team_role_code='member')
   *        —— ON CONFLICT (team_id, user_id) DO NOTHING（team_members UNIQUE(team_id,user_id)）
   *   2) user_roles(user_id, role_id=volunteer, scope_team_id=team_id)
   *        —— ON CONFLICT (user_id, role_id, scope_team_id) DO NOTHING
   *
   * - 幂等：重复 join 不新增任何行；status 依「join 前是否已是成员」判定（'existing' / 'created'）。
   * - 不授予任何管理角色（固定 member + volunteer）。
   * - teamId 为 teams.id（numeric），由路由层 findByPublicId 后传入，绝不来自客户端。
   */
  async joinTeam(teamId: number, userId: number): Promise<{ status: JoinStatus }> {
    // 预检是否已是成员（仅用于返回语义；写入仍走幂等 batch，保证两行最终一致）。
    const existingMember = await this.first<{ id: number }>(
      `SELECT id FROM team_members WHERE team_id = ? AND user_id = ?`,
      [teamId, userId],
    );

    // volunteer 角色 id（PLATFORM_GLOBAL；seed 已写入）。无专用 helper，最小 SELECT。
    const role = await this.first<{ id: number }>(
      `SELECT id FROM roles WHERE code = 'volunteer'`,
    );
    if (!role) throw internalError();

    const now = Math.floor(Date.now() / 1000);
    await this.batch([
      {
        sql: `INSERT INTO team_members (team_id, user_id, team_role_code, joined_at)
              VALUES (?, ?, 'member', ?)
              ON CONFLICT (team_id, user_id) DO NOTHING`,
        params: [teamId, userId, now],
      },
      {
        sql: `INSERT INTO user_roles (user_id, role_id, scope_team_id, granted_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT (user_id, role_id, scope_team_id) DO NOTHING`,
        params: [userId, role.id, teamId, now],
      },
    ]);

    return { status: existingMember ? 'existing' : 'created' };
  }

  // =========================================================================
  // N0-E5B：TEAM_PUBLIC_CONTACT（团队公开业务联系人）最小读写能力
  //
  // 说明：teams 为 PLATFORM_GLOBAL（可读），但【写】公开联系人必须限定在
  //   调用方当前团队上下文内 —— 收口在 service 层（active team == 目标团队），
  //   且本 repository 方法只接受服务端派生的 numeric teamId，绝不接受客户端提交。
  // =========================================================================

  /**
   * 按 numeric teamId 读取团队公开业务联系人（N0-E5B-4 §E）。
   *
   * 未来 signup notification payload 的【唯一权威查询入口】：
   *   activity.team_id（INTEGER NOT NULL REFERENCES teams(id)）→ 本方法。
   * 只返回两个公开字段；不 JOIN 任何用户 / 身份 / 手机相关表，杜绝隐私回退。
   *
   * @returns 团队存在且未删除 → PublicContactRow（字段可为 NULL = 未配置）；否则 null。
   */
  async findPublicContactByTeamId(teamId: number): Promise<PublicContactRow | null> {
    const row = await this.first<PublicContactRow>(
      `SELECT public_contact_name, public_contact_phone
         FROM teams
        WHERE id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    return row ?? null;
  }

  /**
   * 窄更新团队公开业务联系人（N0-E5B-2 §C1）。
   *
   * - 只写 public_contact_name / public_contact_phone 两列 + updated_at。
   * - undefined = 不改动（partial update）；显式 null = 清空为 NULL。
   * - 绝不触碰 teams 的其他列（不是任意 team profile patch）。
   * - 只按 id 定位（teamId 由 service 从 active team 派生后传入）。
   */
  async updatePublicContact(teamId: number, patch: PublicContactPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.public_contact_name !== undefined) {
      sets.push('public_contact_name = ?');
      params.push(patch.public_contact_name);
    }
    if (patch.public_contact_phone !== undefined) {
      sets.push('public_contact_phone = ?');
      params.push(patch.public_contact_phone);
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));

    await this.run(
      `UPDATE teams SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      [...params, teamId],
    );
  }
}
