/**
 * ActivityRepository（S2-5 最小只读；S2-6g 增量：报名目标查询）。
 *
 * scope 事实（S2-3 矩阵）：
 * - activities：TEAM_SCOPED —— 查询【必须】限定 team_id = ctx.tenant.teamId，
 *   这是租户隔离的核心（A 团队用户不能读 B 团队活动）。
 *   注意：不能对全部表统一 WHERE team_id=?；仅 TEAM_SCOPED 表这样限定。
 * - activity_signups：TEAM_SCOPED 但 team_id 为派生（activity_id → activities.team_id），
 *   见 repository/activity-signups.ts（S2-6g），必须 JOIN activities 派生隔离。
 */

import { BaseRepository } from './base';
import { notFound, teamScopeRequired } from '../utils/errors';
import { isUlid } from '../utils/validation';
import type { Paginated } from '../types/api';

/**
 * 报名所需的最小活动视图（S2-6g）。
 *
 * 刻意与 ActivityRow 分离：本视图只含报名判定所需字段，
 * 不进入既有 GET /activities 响应结构（避免改动 S2-5 已冻结的响应契约）。
 */
export interface ActivitySignupTarget {
  id: number;
  team_id: number;
  status: number;
  allow_cancel: number;
  need_audit: number;
}

export interface ActivityRow {
  id: number;
  public_id: string;
  team_id: number;
  title: string;
  summary: string | null;
  start_time: number;
  end_time: number;
  signup_deadline: number | null;
  quota: number;
  signed_count: number;
  status: number;
  /** 活动级单次最大服务时长（分钟）；NULL = 该活动未冻结时长规则（未来 overlong detector 必须 SKIP）。S2-6k1 新增。 */
  max_session_minutes: number | null;
}

export class ActivityRepository extends BaseRepository {
  /** 团队活动分页列表（TEAM_SCOPED：强制 team_id 隔离）。 */
  async listByMyTeam(page: number, pageSize: number, offset: number): Promise<Paginated<ActivityRow>> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();

    const teamId = this.ctx.tenant.teamId;
    const items = await this.all<ActivityRow>(
      `SELECT id, public_id, team_id, title, summary, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes
         FROM activities
        WHERE team_id = ? AND deleted_at IS NULL
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );

    const totalRow = await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM activities WHERE team_id = ? AND deleted_at IS NULL`,
      [teamId],
    );
    const total = totalRow?.total ?? 0;
    return {
      items,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /** 按 ULID 读取单个活动（TEAM_SCOPED：team_id 双重限定 → 跨团队访问返回 404）。 */
  async findByPublicId(publicId: string): Promise<ActivityRow> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<ActivityRow>(
      `SELECT id, public_id, team_id, title, summary, start_time, end_time,
              signup_deadline, quota, signed_count, status, max_session_minutes
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }

  /**
   * 读取报名目标活动（S2-6g）。
   *
   * TEAM_SCOPED 双重限定：public_id = ? AND team_id = ? AND deleted_at IS NULL。
   * - 跨团队请求与不存在的活动走【同一 404 分支】，不泄露资源存在性（§十三）。
   * - 只返回报名判定字段，不查询 quota / signed_count —— 名额校验未冻结（OPEN BUSINESS RULE）。
   */
  async findSignupTargetByPublicId(publicId: string): Promise<ActivitySignupTarget> {
    this.ensureTableRead('activities');
    if (this.ctx.tenant.teamId == null) throw teamScopeRequired();
    if (!isUlid(publicId)) throw notFound('Activity');

    const row = await this.first<ActivitySignupTarget>(
      `SELECT id, team_id, status, allow_cancel, need_audit
         FROM activities
        WHERE public_id = ? AND team_id = ? AND deleted_at IS NULL`,
      [publicId, this.ctx.tenant.teamId],
    );
    if (!row) throw notFound('Activity');
    return row;
  }
}
