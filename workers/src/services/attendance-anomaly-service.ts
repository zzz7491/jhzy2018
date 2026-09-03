/**
 * AttendanceAnomalyService（S2-6j V1）：考勤异常【处置】ONLY（handling）。
 *
 * 与 S2-6i AttendanceManagementService 严格同构（TEAM scope，管理员操作【他人】异常记录）。
 * 租户隔离下推到 Repository 的 WHERE id/team_id；service / route 层【不】先 SELECT 再比较 team_id
 * （那会构成 cross-team existence oracle）。跨团队 / 不存在统一 404；已处置（status!=1）→ 409（§1 状态机）。
 *
 * 范围纪律（§0）：只实现 list / detail / resolve（confirm|dismiss）+ 不可变审计事件。
 * 不实现 auto-detection / manual-creation / risk engine / location / device / time-window / shift /
 * settlement / service_records correction / points / certificates / review automation / implicit force checkout。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import type { Env } from '../env';
import {
  AttendanceAnomalyRepository,
  ANOMALY_TYPES,
  ANOMALY_STATUS,
  AnomalyDetailRow,
  AnomalyListRow,
  isAnomalyType,
} from '../repository/attendance-anomalies';
import {
  authRequired,
  notFound,
  teamScopeRequired,
  invalidParam,
  conflict,
  ConflictReason,
} from '../utils/errors';

/** resolution 上限（§4：max 1000）。 */
const RESOLUTION_MAX = 1000;
/**
 * 故障模式 2 专用越界状态值（TEST-ONLY，仅 local + JHZY_FAULT_INJECT=2 可达）。
 * 越出 attendance_anomalies.status CHECK (1..3)，使 batch 的 stmt[1]（UPDATE）必然失败，
 * 从而验证 stmt[0] 已执行的 INSERT 被真实回滚。
 */
const FAULT_STATUS = 9;

export interface AttendanceAnomalyDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
  env: Env;
}

/** list 返回结构。 */
export interface AnomalyListResult {
  anomalies: {
    id: number;
    session_id: number;
    anomaly_type: string;
    status: number;
    created_at: number;
    handled_at: number | null;
  }[];
  next_cursor: string | null;
}

/** detail / resolve 返回结构（含托管 session 视图，敏感字段不出现）。 */
export interface AnomalyDetailResult {
  id: number;
  session_id: number;
  anomaly_type: string;
  status: number;
  detail: string | null;
  created_at: number;
  handled_by: number | null;
  handled_at: number | null;
  resolution: string | null;
  session: {
    activity_id: number | null;
    user_id: number | null;
    checkin_at: number | null;
    checkout_at: number | null;
    status: number | null;
    review_status: number | null;
    service_date: number | null;
    slot: string | null;
  };
}

export class AttendanceAnomalyService {
  private readonly db: D1Database;
  private readonly auth: AuthContext;
  private readonly tenant: TenantContext;
  private readonly env: Env;
  private readonly repo: AttendanceAnomalyRepository;

  constructor(deps: AttendanceAnomalyDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.tenant = deps.tenant;
    this.env = deps.env;
    this.repo = new AttendanceAnomalyRepository({ db: deps.db, ctx: { auth: deps.auth, tenant: deps.tenant } });
  }

  /**
   * 公共前置：已认证 + 有 userId + 有合法团队上下文（TEAM scope 强制要求）。
   * - 未认证 → 401；无团队上下文（含 platform 角色）→ 403 TEAM_SCOPE_REQUIRED。
   */
  private requireActor(): { userId: number; teamId: number } {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    if (this.tenant.teamId == null) throw teamScopeRequired();
    return { userId: this.auth.userId, teamId: this.tenant.teamId };
  }

  /**
   * 本地故障注入模式（§18 / §19 原子性证据）：仅 local 环境 + 显式 JHZY_FAULT_INJECT 时启用，
   * 生产（非 local）永不触发，无副作用。
   * - 0 = 关闭（默认，正常业务路径）。
   * - 1 = 令 batch 的 **stmt[0]（audit event INSERT）** 失败：event_type='__FAULT__' 违反
   *       attendance_events.event_type CHECK。证明整批失败 → UPDATE 从未生效 → 字段保持原值 / event 不存在。
   * - 2 = 令 batch 的 **stmt[1]（条件 UPDATE）** 失败：写入越界 status 违反 CHECK。此时 stmt[0] 的
   *       INSERT 已成功执行，故该模式证明【已执行语句被真实回滚】（event 不存在），即 db.batch 是真事务。
   */
  private faultMode(): 0 | 1 | 2 {
    if ((this.env?.ENVIRONMENT ?? 'local') !== 'local') return 0;
    const v = this.env?.JHZY_FAULT_INJECT ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.JHZY_FAULT_INJECT;
    if (v === '1') return 1;
    if (v === '2') return 2;
    return 0;
  }

  /** 冻结 schema 时间语义：所有 timestamp = INTEGER Unix epoch **seconds**（禁止毫秒）。 */
  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** resolution 规范化（§4）：必填、非空、≤1000。 */
  private normalizeResolution(resolution: unknown): string {
    if (resolution == null || typeof resolution !== 'string') {
      throw invalidParam('resolution', 'required');
    }
    const trimmed = resolution.trim();
    if (trimmed.length === 0) throw invalidParam('resolution', 'required');
    if (trimmed.length > RESOLUTION_MAX) throw invalidParam('resolution', 'too_long_max_1000');
    return trimmed;
  }

  private toListView(rows: AnomalyListRow[]): AnomalyListResult['anomalies'] {
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      anomaly_type: r.anomaly_type,
      status: r.status,
      created_at: r.created_at,
      handled_at: r.handled_at,
    }));
  }

  private toDetailView(row: AnomalyDetailRow): AnomalyDetailResult {
    return {
      id: row.id,
      session_id: row.session_id,
      anomaly_type: row.anomaly_type,
      status: row.status,
      detail: row.detail,
      created_at: row.created_at,
      handled_by: row.handled_by,
      handled_at: row.handled_at,
      resolution: row.resolution,
      session: {
        activity_id: row.activity_id,
        user_id: row.user_id,
        checkin_at: row.checkin_at,
        checkout_at: row.checkout_at,
        status: row.attendance_status,
        review_status: row.review_status,
        service_date: row.service_date,
        slot: row.slot,
      },
    };
  }

  /**
   * 列表（GET /api/v2/attendance-anomalies）。
   * 解析并校验 status / anomaly_type / limit / cursor（§10），全部下推 TEAM 作用域。
   */
  async list(params: {
    status?: unknown;
    anomalyType?: unknown;
    limit?: unknown;
    cursor?: unknown;
  }): Promise<AnomalyListResult> {
    const actor = this.requireActor();

    // status 过滤（仅 1/2/3）
    let status: number | undefined;
    if (params.status != null && params.status !== '') {
      const n = Number(params.status);
      if (!Number.isInteger(n) || n < 1 || n > 3) throw invalidParam('status', 'must be 1,2,3');
      status = n;
    }
    // anomaly_type 过滤（7 类冻结值）
    let anomalyType: string | undefined;
    if (params.anomalyType != null && params.anomalyType !== '') {
      const t = String(params.anomalyType);
      if (!isAnomalyType(t)) throw invalidParam('anomaly_type', 'must be one of 7 frozen types');
      anomalyType = t;
    }
    // limit clamp（default 20, min 1, max 100）
    let limit = 20;
    if (params.limit != null && params.limit !== '') {
      const n = Number(params.limit);
      if (!Number.isInteger(n) || n < 1) throw invalidParam('limit', 'must be integer >= 1');
      limit = Math.min(n, 100);
    }
    // cursor 解析（明文 "created_at|id"，与 ORDER BY created_at DESC, id DESC 对应的严格小于游标）
    let cursorCreatedAt: number | undefined;
    let cursorId: number | undefined;
    if (params.cursor != null && params.cursor !== '') {
      const parts = String(params.cursor).split('|');
      if (parts.length !== 2) throw invalidParam('cursor', 'invalid');
      const ca = Number(parts[0]);
      const ci = Number(parts[1]);
      if (!Number.isInteger(ca) || !Number.isInteger(ci)) throw invalidParam('cursor', 'invalid');
      cursorCreatedAt = ca;
      cursorId = ci;
    }

    // 多取 1 行判断是否有下一页（不污染返回给客户端的 limit 语义）。
    const rows = await this.repo.listAnomalies({
      teamId: actor.teamId,
      status,
      anomalyType,
      limit: limit + 1,
      cursorCreatedAt,
      cursorId,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = hasMore && last != null ? `${last.created_at}|${last.id}` : null;

    return { anomalies: this.toListView(page), next_cursor: nextCursor };
  }

  /** 详情（GET /api/v2/attendance-anomalies/:anomalyId）。跨团队/不存在 → 404。 */
  async detail(anomalyId: number): Promise<AnomalyDetailResult> {
    const actor = this.requireActor();
    const row = await this.repo.findTeamAnomaly(anomalyId, actor.teamId);
    if (row == null) throw notFound('Attendance anomaly');
    return this.toDetailView(row);
  }

  /**
   * 处置（POST /api/v2/attendance-anomalies/:anomalyId/resolve）。
   * 决策 confirm→status=2 / dismiss→status=3（§1 状态机，客户端不得直接传 status 数字）。
   * 原子 batch：audit event INSERT + 条件 UPDATE，共享 PRE-state 谓词 P=(id AND team_id AND status=1)。
   * changes=0 → TEAM 作用域再查区分 404 / 409（已处置禁止 reopen/undo）。
   */
  async resolve(anomalyId: number, body: { decision?: unknown; resolution?: unknown }): Promise<AnomalyDetailResult> {
    const actor = this.requireActor();

    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'dismiss') {
      throw invalidParam('decision', 'must be confirm|dismiss');
    }
    const newStatus = decision === 'confirm' ? ANOMALY_STATUS.CONFIRMED : ANOMALY_STATUS.DISMISSED;
    const resolution = this.normalizeResolution(body.resolution);

    const now = this.nowSeconds(); // 冻结 schema：Unix epoch seconds（绝不写入毫秒）
    const fault = this.faultMode();
    // 故障模式 1 → stmt[0] INSERT 违反 event_type CHECK；模式 2 → stmt[1] UPDATE 违反 status CHECK。
    const eventType = fault === 1 ? '__FAULT__' : 'anomaly';
    const writeStatus = fault === 2 ? FAULT_STATUS : newStatus;
    const raw = JSON.stringify({ action: 'anomaly_resolve', decision });

    const changes = await this.repo.resolveAnomalyAtomically(
      anomalyId,
      actor.teamId,
      writeStatus,
      eventType,
      resolution,
      raw,
      actor.userId,
      now,
    );

    if (changes === 0) {
      const row = await this.repo.findTeamAnomaly(anomalyId, actor.teamId);
      if (row == null) throw notFound('Attendance anomaly'); // 跨团队 / 不存在 → 404
      // 行存在但 status != 1（已 CONFIRMED/DISMISSED）→ 重复处置 409（§1 状态机）。
      throw conflict(ConflictReason.ATTENDANCE_ANOMALY_ALREADY_HANDLED);
    }

    const row = await this.repo.findTeamAnomaly(anomalyId, actor.teamId);
    if (row == null) throw notFound('Attendance anomaly'); // 理论不可达（changes>0 即存在）
    return this.toDetailView(row);
  }
}
