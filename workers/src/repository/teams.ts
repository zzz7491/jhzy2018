/**
 * TeamRepository（S2-5 最小只读）。
 *
 * scope 事实（S2-3 矩阵）：
 * - teams：PLATFORM_GLOBAL（团队是平台级引用数据，已认证即可读单团详情）。
 * - team_members：TEAM_SCOPED（本阶段不提供成员列表端点）。
 */

import { BaseRepository } from './base';
import { notFound } from '../utils/errors';
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
}

export class TeamRepository extends BaseRepository {
  /** 按 ULID public_id 读取团队（PLATFORM_GLOBAL：不要求 team 上下文）。 */
  async findByPublicId(publicId: string): Promise<TeamRow> {
    // 双保险：即使路由层已校验，repository 仍拒绝非 ULID 输入。
    if (!isUlid(publicId)) throw notFound('Team');

    const row = await this.first<TeamRow>(
      `SELECT id, public_id, name, short_name, intro, cert_status, status, is_system, created_at
         FROM teams
        WHERE public_id = ? AND deleted_at IS NULL`,
      [publicId],
    );
    if (!row) throw notFound('Team');
    return row;
  }
}
