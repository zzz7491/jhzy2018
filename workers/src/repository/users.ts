/**
 * UserRepository（S2-5 最小只读）。
 *
 * scope 事实（S2-3 矩阵）：
 * - users：PLATFORM_GLOBAL（引用数据，已认证可读）。
 * - user_profiles：USER_SCOPED（仅本人；查询永远限定 user_id = ctx.userId）。
 *
 * 不读取 HTTP / Cookie；身份由 RepositoryContext 传入。
 */

import { BaseRepository } from './base';
import { notFound, userScopeRequired } from '../utils/errors';

export interface UserRow {
  id: number;
  public_id: string;
  nickname: string | null;
  cert_level: number;
  status: number;
  created_at: number;
}

export interface UserProfileRow {
  user_id: number;
  gender: number;
  birthday: string | null;
  region_code: string | null;
  bio: string | null;
}

export class UserRepository extends BaseRepository {
  /** 当前用户基础信息（仅限 auth.userId 本人；platform 角色亦仅读自己）。 */
  async findMe(): Promise<UserRow> {
    // USER_SCOPED 语义：必须带用户上下文（platform 角色的 tenant.userId 仍是本人）。
    if (this.ctx.tenant.userId == null) throw userScopeRequired();

    const row = await this.first<UserRow>(
      `SELECT id, public_id, nickname, cert_level, status, created_at
         FROM users
        WHERE id = ? AND deleted_at IS NULL`,
      [this.ctx.tenant.userId],
    );
    if (!row) throw notFound('User');
    return row;
  }

  /** 当前用户 profile（USER_SCOPED：永远限定本人 user_id）。 */
  async findMyProfile(): Promise<UserProfileRow | null> {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();

    return this.first<UserProfileRow>(
      `SELECT user_id, gender, birthday, region_code, bio
         FROM user_profiles
        WHERE user_id = ?`,
      [this.ctx.tenant.userId],
    );
  }
}
