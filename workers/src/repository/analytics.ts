/**
 * AnalyticsRepository（P37-C1）—— 数据运营运营概览专用聚合仓库。
 *
 * 设计纪律（P37-C1 §4 / §5 / §11 / §12 / §16）：
 * - 仅返回聚合数字（aggregate numbers），绝不返回 raw rows。
 * - 明确区分 TEAM 聚合与 PLATFORM 聚合两条路径：
 *     computeTeamMetrics   —— team_id 必须来自 server active team（ctx.tenant.teamId），
 *                             调用 ensureTableRead 守卫每张团队级表，绝不伪造 team context。
 *     computePlatformMetrics —— 专用平台级全量聚合路径，不依赖 active team，
 *                             不调用 ensureTableRead（route 已通过 analytics.platform.view 授权），
 *                             绝不以「普通 TEAM repository 模拟全平台」的方式实现（不拼 team_id）。
 * - 11 个指标定义严格锚定 P37-B / P37-C1 §5 冻结契约，不得自行改变。
 * - 所有 SQL 参数化（prepare().bind()），禁止字符串拼接用户输入。
 */

import { BaseRepository } from './base';
import { teamScopeRequired } from '../utils/errors';

/** 冻结的 V1 range 选项（P37-C1 §6 / §9）。定义为 repository 权威类型，service 反向引用，
 * 以避免 repository → services 的非法依赖方向（P36-C3-1 B1 分层架构约束）。 */
export type RangeKey = 'today' | '7d' | '30d' | 'month';

/** 冻结的 11 个 V1 指标快照。 */
export interface AnalyticsMetrics {
  volunteer_count: number;
  new_volunteer_count: number;
  activity_count: number;
  active_activity_count: number;
  service_participation_count: number;
  service_minutes_total: number;
  activity_review_pending: number;
  service_adjustment_pending: number;
  community_review_pending: number;
  ai_call_count: number;
  ai_active_user_count: number;
}

/** 已解析的查询区间（epoch 秒，半开 [start, end)）。 */
export interface ResolvedRange {
  range: RangeKey;
  start: number;
  end: number;
}

export const METRIC_KEYS: readonly (keyof AnalyticsMetrics)[] = [
  'volunteer_count',
  'new_volunteer_count',
  'activity_count',
  'active_activity_count',
  'service_participation_count',
  'service_minutes_total',
  'activity_review_pending',
  'service_adjustment_pending',
  'community_review_pending',
  'ai_call_count',
  'ai_active_user_count',
] as const;

export class AnalyticsRepository extends BaseRepository {
  // =========================================================================
  // TEAM scope：team_id 必须来自 server active team（ctx.tenant.teamId）。
  // =========================================================================
  async computeTeamMetrics(range: ResolvedRange): Promise<AnalyticsMetrics> {
    const teamId = this.ctx.tenant.teamId;
    if (teamId == null) throw teamScopeRequired();

    // 守卫：确认每张团队级表的可读性（绝不伪造 team context）。
    this.ensureTableRead('team_members');
    this.ensureTableRead('activities');
    this.ensureTableRead('service_records');
    this.ensureTableRead('service_record_adjustment_requests');
    this.ensureTableRead('content_articles');
    this.ensureTableRead('ai_usage_logs');

    const { start, end } = range;

    const volunteer_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM team_members WHERE team_id = ? AND join_status = 1`,
        [teamId],
      ))?.c ?? 0;

    const new_volunteer_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM team_members
          WHERE team_id = ? AND join_status = 1 AND joined_at >= ? AND joined_at < ?`,
        [teamId, start, end],
      ))?.c ?? 0;

    // activity_count：未删除且未取消的全部生命周期活动（含 DRAFT 0 / SIGNUP_OPEN 1 / IN_PROGRESS 2 /
    // ENDED 3 / UNPUBLISHED 5；排除 CANCELLED 4 与 deleted）—— 不受 range 影响。
    const activity_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities
          WHERE team_id = ? AND deleted_at IS NULL AND status <> 4`,
        [teamId],
      ))?.c ?? 0;

    // active_activity_count：已审核通过（audit_status=2）且处于开放/进行中（status IN (1,2)）——
    // 不受 range 影响。
    const active_activity_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities
          WHERE team_id = ? AND deleted_at IS NULL AND audit_status = 2 AND status IN (1, 2)`,
        [teamId],
      ))?.c ?? 0;

    const service_participation_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM service_records
          WHERE team_id = ? AND settlement_status = 1 AND service_date >= ? AND service_date < ?`,
        [teamId, start, end],
      ))?.c ?? 0;

    const sm = await this.first<{ s: number }>(
      `SELECT COALESCE(SUM(minutes), 0) AS s FROM service_records
        WHERE team_id = ? AND settlement_status = 1 AND service_date >= ? AND service_date < ?`,
      [teamId, start, end],
    );
    const service_minutes_total = Number(sm?.s ?? 0);

    const activity_review_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities
          WHERE team_id = ? AND deleted_at IS NULL AND audit_status = 1`,
        [teamId],
      ))?.c ?? 0;

    const service_adjustment_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM service_record_adjustment_requests
          WHERE team_id = ? AND status = 0`,
        [teamId],
      ))?.c ?? 0;

    const community_review_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM content_articles
          WHERE team_id = ? AND deleted_at IS NULL AND audit_status = 1 AND status <> 4`,
        [teamId],
      ))?.c ?? 0;

    const ai_call_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ai_usage_logs
          WHERE team_id = ? AND created_at >= ? AND created_at < ?`,
        [teamId, start, end],
      ))?.c ?? 0;

    const ai_active_user_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(DISTINCT user_id) AS c FROM ai_usage_logs
          WHERE team_id = ? AND created_at >= ? AND created_at < ?`,
        [teamId, start, end],
      ))?.c ?? 0;

    return {
      volunteer_count: Number(volunteer_count),
      new_volunteer_count: Number(new_volunteer_count),
      activity_count: Number(activity_count),
      active_activity_count: Number(active_activity_count),
      service_participation_count: Number(service_participation_count),
      service_minutes_total,
      activity_review_pending: Number(activity_review_pending),
      service_adjustment_pending: Number(service_adjustment_pending),
      community_review_pending: Number(community_review_pending),
      ai_call_count: Number(ai_call_count),
      ai_active_user_count: Number(ai_active_user_count),
    };
  }

  // =========================================================================
  // PLATFORM scope：专用全平台聚合路径。不依赖 active team，不伪造 team context，
  // 不以普通 TEAM 仓库模拟全平台（不拼 team_id）。route 已通过 analytics.platform.view 授权。
  // =========================================================================
  async computePlatformMetrics(range: ResolvedRange): Promise<AnalyticsMetrics> {
    const { start, end } = range;

    // volunteer_count / new_volunteer_count：PLATFORM_GLOBAL 引用数据 users。
    const volunteer_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM users WHERE status = 1 AND deleted_at IS NULL`,
      ))?.c ?? 0;

    const new_volunteer_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM users
          WHERE status = 1 AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`,
        [start, end],
      ))?.c ?? 0;

    // 以下为跨团队的 TEAM_SCOPED 表全量聚合（专用平台路径，不调用 ensureTableRead）。
    const activity_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities WHERE deleted_at IS NULL AND status <> 4`,
      ))?.c ?? 0;

    const active_activity_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities
          WHERE deleted_at IS NULL AND audit_status = 2 AND status IN (1, 2)`,
      ))?.c ?? 0;

    const service_participation_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM service_records
          WHERE settlement_status = 1 AND service_date >= ? AND service_date < ?`,
        [start, end],
      ))?.c ?? 0;

    const sm = await this.first<{ s: number }>(
      `SELECT COALESCE(SUM(minutes), 0) AS s FROM service_records
        WHERE settlement_status = 1 AND service_date >= ? AND service_date < ?`,
      [start, end],
    );
    const service_minutes_total = Number(sm?.s ?? 0);

    const activity_review_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM activities WHERE deleted_at IS NULL AND audit_status = 1`,
      ))?.c ?? 0;

    const service_adjustment_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM service_record_adjustment_requests WHERE status = 0`,
      ))?.c ?? 0;

    const community_review_pending =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM content_articles
          WHERE deleted_at IS NULL AND audit_status = 1 AND status <> 4`,
      ))?.c ?? 0;

    const ai_call_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ai_usage_logs WHERE created_at >= ? AND created_at < ?`,
        [start, end],
      ))?.c ?? 0;

    const ai_active_user_count =
      (await this.first<{ c: number }>(
        `SELECT COUNT(DISTINCT user_id) AS c FROM ai_usage_logs
          WHERE created_at >= ? AND created_at < ?`,
        [start, end],
      ))?.c ?? 0;

    return {
      volunteer_count: Number(volunteer_count),
      new_volunteer_count: Number(new_volunteer_count),
      activity_count: Number(activity_count),
      active_activity_count: Number(active_activity_count),
      service_participation_count: Number(service_participation_count),
      service_minutes_total,
      activity_review_pending: Number(activity_review_pending),
      service_adjustment_pending: Number(service_adjustment_pending),
      community_review_pending: Number(community_review_pending),
      ai_call_count: Number(ai_call_count),
      ai_active_user_count: Number(ai_active_user_count),
    };
  }
}
