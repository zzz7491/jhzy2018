/**
 * 安全审计事件 Service（S2-6c-3，指令 §一 OPEN-7 冲突保护）。
 *
 * 背景：指令要求身份冲突必须"记录 security event / 安全审计事件"。
 * 现有 Schema **已存在** `security_events` 表（AUDIT_ONLY，0001_initial_schema），
 * 因此本阶段直接落库真实审计行，不做 mock；不新增表、不改 Schema。
 *
 * event_type 取值受表的 CHECK 约束锁定：
 *   'unauthorized' | 'abnormal_login' | 'risk_checkin' | 'replay'
 *   | 'multi_account' | 'permission_abnormal' | 'api_abnormal' | 'ai_abuse'
 * 身份冲突（同一微信凭证映射到两个不同 user 主体）归入 **'multi_account'**。
 *
 * 纪律：
 * - 审计行【绝不】包含 openid / unionid / 身份摘要 / token / session_key。
 * - 只记录内部 user id（审计追溯用），该信息【不会】出现在任何客户端响应中。
 * - 审计写入失败一律 fail-open（吞掉异常）：不得改变认证判定结果，不得向客户端暴露。
 * - 本文件不输出任何 console 日志。
 */

import type { D1Database } from '@cloudflare/workers-types';

/** security_events.event_type 的 CHECK 白名单（与 Schema 严格一致）。 */
export const SECURITY_EVENT_TYPES = [
  'unauthorized',
  'abnormal_login',
  'risk_checkin',
  'replay',
  'multi_account',
  'permission_abnormal',
  'api_abnormal',
  'ai_abuse',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/** 审计事件入参（全部可选 / 安全默认值；禁止塞入任何明文身份标识）。 */
export interface SecurityEventInput {
  eventType: SecurityEventType;
  /** 1=低 2=中 3=高 4=严重 */
  severity?: number;
  /** 主体 user id（可为 null：冲突场景下无法确定唯一主体时留空）。 */
  userId?: number | null;
  teamId?: number | null;
  targetType?: string | null;
  targetId?: number | null;
  /** JSON 可序列化摘要；禁止含 openid/unionid/hash/token。 */
  detail?: Record<string, string | number | boolean | null>;
  ipHash?: string | null;
  userAgent?: string | null;
  /** 关联 request id，便于链路追踪。 */
  traceId?: string | null;
}

/**
 * 安全事件Sink 接口（抽象层：便于将来替换为队列 / Logpush / 外部 SIEM，
 * 上层只依赖本接口，不依赖具体存储）。
 */
export interface SecurityEventSink {
  /** 记录一条审计事件；实现必须 fail-open（内部消化异常）。 */
  record(input: SecurityEventInput): Promise<void>;
}

/** 不落库实现（无 DB 场景 / 单元测试替身）。 */
export class NoopSecurityEventSink implements SecurityEventSink {
  async record(): Promise<void> {
    /* intentionally empty */
  }
}

/** D1 实现：写入 security_events（AUDIT_ONLY）。 */
export class D1SecurityEventSink implements SecurityEventSink {
  constructor(private readonly db: D1Database) {}

  async record(input: SecurityEventInput): Promise<void> {
    try {
      if (!SECURITY_EVENT_TYPES.includes(input.eventType)) return; // 防御：越界类型直接丢弃
      const severity = Math.min(4, Math.max(1, Math.floor(input.severity ?? 2)));
      const detail = input.detail == null ? null : JSON.stringify(input.detail);
      await this.db
        .prepare(
          `INSERT INTO security_events
             (event_type, severity, user_id, team_id, target_type, target_id,
              detail, ip_hash, user_agent, trace_id, handled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          input.eventType,
          severity,
          input.userId ?? null,
          input.teamId ?? null,
          input.targetType ?? null,
          input.targetId ?? null,
          detail,
          input.ipHash ?? null,
          input.userAgent ?? null,
          input.traceId ?? null,
        )
        .run();
    } catch {
      // fail-open：审计不可用不应阻断认证流程，也不应向客户端暴露。
    }
  }
}

/** 工厂：当前项目统一使用 D1 落库实现。 */
export function createSecurityEventSink(db: D1Database): SecurityEventSink {
  return new D1SecurityEventSink(db);
}

/**
 * 身份冲突审计（OPEN-7）：同一微信凭证的 unionid 与 openid 命中两个不同 user 主体。
 * 只记录内部 id，不记录任何微信标识。
 */
export async function recordIdentityConflict(
  sink: SecurityEventSink,
  params: { unionidUserId: number | null; openidUserId: number | null; traceId?: string | null },
): Promise<void> {
  await sink.record({
    eventType: 'multi_account',
    severity: 3,
    userId: params.unionidUserId ?? params.openidUserId ?? null,
    targetType: 'user_identity',
    targetId: params.openidUserId ?? null,
    detail: { reason: 'identity_conflict', channel: 'wechat_miniprogram' },
    traceId: params.traceId ?? null,
  });
}

/**
 * 异常登录检测（S2-6c-4）：登录成功且该用户【历史上】无相同 ip_hash / user_agent 的会话 → 记 abnormal_login。
 * - 在【创建新会话之前】调用：此时 DB 中仅有该用户的历史会话，当前新会话尚未插入，
 *   因此"查无历史匹配"= 新设备/新 IP（首登/新设备），符合异常登录审计语义。
 * - 不阻断登录（MVP fail-open：仅记录）；审计写入失败被 D1SecurityEventSink 内部消化。
 * - 绝不写入 openid/unionid/token。
 */
export async function detectAndRecordAbnormalLogin(
  sink: SecurityEventSink,
  db: D1Database,
  params: { userId: number; ipHash: string | null; userAgent: string | null; traceId?: string | null },
): Promise<void> {
  if (params.ipHash == null && params.userAgent == null) return;
  const known = await db
    .prepare(`SELECT 1 FROM sessions WHERE user_id = ? AND (ip_hash = ? OR user_agent = ?) LIMIT 1`)
    .bind(params.userId, params.ipHash ?? '', params.userAgent ?? '')
    .first();
  if (known == null) {
    await sink.record({
      eventType: 'abnormal_login',
      severity: 2,
      userId: params.userId,
      detail: { reason: 'new_device_or_ip' },
      ipHash: params.ipHash,
      userAgent: params.userAgent,
      traceId: params.traceId ?? null,
    });
  }
}
