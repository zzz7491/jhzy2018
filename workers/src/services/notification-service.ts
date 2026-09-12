/**
 * NotificationService（N0-A 统一通知域 v1 —— IN_APP 闭环）。
 *
 * 职责边界：
 *   - 本 service 是【唯一】通知业务入口；route 只做参数解析与响应封装。
 *   - 本轮【只】IN_APP：不触发任何外部投递（微信 / 短信 / provider 一律不在本轮）。
 *   - 不接任何业务事件 producer（activity / team / training / exam / qualification）——N0-E。
 *
 * 冻结原则：
 *   - recipient.user_id 是唯一权威；team_id 仅 OPTIONAL 上下文，不参与读权限判定。
 *   - 幂等由 NotificationService 负责：同 idempotency_key 重试 → notifications delta=0、
 *     recipients delta=0、返回既有的通知、created=false；DB 层 UNIQUE(idempotency_key)
 *     作为原子冲突守卫（并发安全）。caller 提供语义键。
 *   - 内容最小化：禁存 PII / secret / token；不做整个业务对象 JSON dump。
 *
 * D1 事务说明：create() 在 D1 batch（单事务）内原子写入通知内容 + 全部 recipient，
 * 全部不带 ON CONFLICT DO NOTHING；首个 recipient 命中 notification_recipients.idempotency_key
 * UNIQUE 冲突则整批回滚（通知内容行一并撤销，无「提交后补偿删除」崩溃窗口），
 * 再查询并返回既有通知。绝不遗留无 recipient 的孤儿通知行；非幂等 DB 错误一律抛出。
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { AuthContext } from '../types/auth';
import type { TenantContext } from '../types/tenant';
import {
  NotificationRepository,
  type CreateNotificationInput,
  type NotificationCategory,
  type NotificationDetail,
  type NotificationInsertGate,
  type NotificationListItem,
} from '../repository/notification';
import { authRequired, invalidParam, notFound } from '../utils/errors';
import type { Paginated } from '../types/api';

const CATEGORIES: readonly NotificationCategory[] = [
  'system',
  'activity',
  'team',
  'training',
  'exam',
  'qualification',
  'points',
  'content',
];

const MAX_TITLE = 200;
const MAX_SUMMARY = 500;
const MAX_BODY = 4000;
const MAX_EVENT_TYPE = 80;
const MAX_TARGET_PAGE = 200;

/** payload 键名禁用词（防止误落 PII / 凭证；宁可拒绝也不静默落库）。 */
const PAYLOAD_DENY_KEY = /(id_?card|phone|mobile|token|secret|password|openid|unionid)/i;

export interface CreateNotificationCommand {
  /** 收件人（N0-A 仅支持显式用户列表；广播语义推迟到业务事件阶段）。 */
  recipientUserIds: number[];
  /**
   * 幂等键：调用方提供的语义键，必须包含 recipient 身份，
   * 例如 `activity.signup.approved:<signup_id>:<user_id>`。
   */
  idempotencyKey: string;
  eventType: string;
  category: NotificationCategory;
  title: string;
  summary?: string | null;
  body?: string | null;
  /** OPTIONAL 上下文：用户级 / 系统级通知为 null。 */
  teamId?: number | null;
  businessEntityType?: string | null;
  businessEntityId?: number | null;
  targetPage?: string | null;
  payload?: Record<string, unknown> | null;
  /** null = system。 */
  createdBy?: number | null;
}

export interface CreateNotificationResult {
  notification_id: string;
  /** 通知级幂等：true=本次新建通知，false=命中既有（同 idempotency_key 重试）。 */
  created: boolean;
  recipients: { user_id: number; created: boolean }[];
}

/**
 * 通知创建计划（N0-E1）：已 validated / normalized / idempotency-prepared 的
 * prepared statement 序列 + 通知 public_id。仅供调用方 push 进自己的原子 db.batch；
 * 本对象不含执行语义（NotificationService 不代为 db.batch）。
 */
export interface NotificationCreationPlan {
  statements: D1PreparedStatement[];
  notificationPublicId: string;
}

export interface NotificationServiceDeps {
  db: D1Database;
  auth: AuthContext;
  tenant: TenantContext;
}

export class NotificationService {
  private readonly repo: NotificationRepository;
  private readonly auth: AuthContext;

  constructor(deps: NotificationServiceDeps) {
    this.auth = deps.auth;
    this.repo = new NotificationRepository({
      db: deps.db,
      ctx: { auth: deps.auth, tenant: deps.tenant },
    });
  }

  private requireUserId(): number {
    if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();
    return this.auth.userId;
  }

  // ===== 内部 domain capability（无公开 create 端点；由 N0-E 业务事件调用）=====

  /**
   * 命令校验 / 归一化 + recipient 幂等键派生（Notification Core 唯一事实源）。
   *
   * create() 与 buildCreationPlan() 共用本方法，确保「校验规则」与「`:u<userId>` 后缀生成」
   * 只有一个实现（N0-E1 §4：业务侧不得复制 Notification Core 规则）。
   */
  private normalizeCommand(cmd: CreateNotificationCommand): {
    input: CreateNotificationInput;
    recipients: { userId: number; idempotencyKey: string }[];
  } {
    const eventType = text(cmd.eventType, 'event_type', MAX_EVENT_TYPE);
    const title = text(cmd.title, 'title', MAX_TITLE);
    if (!CATEGORIES.includes(cmd.category)) {
      throw invalidParam('category', 'must be a supported notification category');
    }
    const summary = optionalText(cmd.summary, 'summary', MAX_SUMMARY);
    const body = optionalText(cmd.body, 'body', MAX_BODY);
    const targetPage = optionalText(cmd.targetPage, 'target_page', MAX_TARGET_PAGE);
    const key = text(cmd.idempotencyKey, 'idempotency_key', 200);
    if (cmd.recipientUserIds.length === 0) {
      throw invalidParam('recipient_user_ids', 'must contain at least one recipient');
    }
    assertSafePayload(cmd.payload);

    const recipients = cmd.recipientUserIds.map((userId) => ({
      userId,
      idempotencyKey: `${key}:u${userId}`,
    }));

    return {
      input: {
        teamId: cmd.teamId ?? null,
        eventType,
        category: cmd.category,
        title,
        summary,
        body,
        businessEntityType: cmd.businessEntityType ?? null,
        businessEntityId: cmd.businessEntityId ?? null,
        targetPage,
        payload: cmd.payload ?? null,
        createdBy: cmd.createdBy ?? null,
      },
      recipients,
    };
  }

  /** 创建通知 + 逐个收件人幂等投递（IN_APP）。 */
  async create(cmd: CreateNotificationCommand): Promise<CreateNotificationResult> {
    const { input, recipients } = this.normalizeCommand(cmd);

    // 原子幂等创建：同 idempotency_key 重试 → 不产生孤儿通知 / 重复 recipient，
    // 返回既有通知（created=false）；DB UNIQUE(idempotency_key) 为原子冲突守卫。
    const { notification, created } = await this.repo.createIdempotent({ input, recipients });

    return {
      notification_id: notification.public_id,
      created,
      recipients: recipients.map((r) => ({ user_id: r.userId, created })),
    };
  }

  /**
   * 构造「已校验 + 已归一化 + 幂等键已就绪」的通知创建计划（N0-E1 组合用）。
   *
   * - 与 create() 共用 normalizeCommand（校验 / 归一化 / `:u<userId>` 后缀 = 单一事实源）。
   * - 返回已 bind 的 prepared statements，供调用方 push 进自己的原子 db.batch；本方法【不执行】batch。
   * - gate 非空时通知 INSERT 受共享 PRE-state 谓词门控（由业务域构造），实现业务跃迁与
   *   通知「全成或全 0」的同批原子。
   */
  buildCreationPlan(
    cmd: CreateNotificationCommand,
    gate?: NotificationInsertGate | null,
  ): NotificationCreationPlan {
    const { input, recipients } = this.normalizeCommand(cmd);
    const { statements, notifPublicId } = this.repo.buildCreateIdempotentStatements({
      input,
      recipients,
      gate: gate ?? null,
    });
    return { statements, notificationPublicId: notifPublicId };
  }

  // ===== 用户侧读取（全部 SELF / USER_SCOPED）=====

  async listMine(page: number, pageSize: number, offset: number): Promise<Paginated<NotificationListItem>> {
    const userId = this.requireUserId();
    return this.repo.listByUser(userId, page, pageSize, offset);
  }

  async getMine(publicId: string): Promise<NotificationDetail> {
    const userId = this.requireUserId();
    const detail = await this.repo.getByUserAndPublicId(userId, publicId);
    // 不存在 / 属于他人 → 统一 NOT_FOUND（不泄露他人通知是否存在）。
    if (detail == null) throw notFound('Notification');
    return detail;
  }

  async unreadCount(): Promise<{ unread: number }> {
    const userId = this.requireUserId();
    return { unread: await this.repo.countUnread(userId) };
  }

  /** 幂等：已读再读不改变首次 read_at，仍返回成功。 */
  async markRead(publicId: string): Promise<{ id: string; read: true }> {
    const userId = this.requireUserId();
    const recipient = await this.repo.findRecipientByNotificationPublicId(userId, publicId);
    if (recipient == null) throw notFound('Notification');
    await this.repo.markReadIfUnread(recipient.id, Math.floor(Date.now() / 1000));
    return { id: publicId, read: true };
  }

  async markAllRead(): Promise<{ updated: number }> {
    const userId = this.requireUserId();
    const updated = await this.repo.markAllRead(userId, Math.floor(Date.now() / 1000));
    return { updated };
  }
}

// ===== 最小校验 helpers（不引入 validation framework）=====

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParam(name, 'must be a non-empty string');
  }
  if (value.length > max) throw invalidParam(name, `must be at most ${max} characters`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value == null || value === '') return null;
  return text(value, name, max);
}

function assertSafePayload(payload: Record<string, unknown> | null | undefined): void {
  if (payload == null) return;
  for (const k of Object.keys(payload)) {
    if (PAYLOAD_DENY_KEY.test(k)) {
      throw invalidParam('payload', 'must not contain PII or credential fields');
    }
  }
  if (JSON.stringify(payload).length > 4000) {
    throw invalidParam('payload', 'must be minimal business metadata');
  }
}
