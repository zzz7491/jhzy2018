/**
 * NotificationRepository（N0-A 统一通知域 v1 —— IN_APP 闭环）。
 *
 * 冻结依据（NOTIFICATION_COMMUNICATION_REALITY_AUDIT / N0-A）：
 *   - 模型：notifications（内容 / 事件）+ notification_recipients（每用户投递态）。
 *   - recipient 是唯一权威：所有用户可见查询必须 JOIN notification_recipients
 *     并强制 nr.user_id = 当前用户；team_id 只是 OPTIONAL 上下文，不是读取权限。
 *   - 本轮【仅】IN_APP：不含任何微信 / 短信 / 投递重试 / provider 字段。
 *
 * scope 事实（repository/tenant-scope.ts）：
 *   - notification_recipients = USER_SCOPED（表级 guard 要求 userId）。
 *   - notifications = PLATFORM_GLOBAL（内容实体，team_id 可为 NULL；真实隔离由 recipient JOIN 保证）。
 *
 * 安全纪律：
 *   - 全部 SQL 参数化（prepare().bind()），禁止拼接用户输入。
 *   - 幂等由 DB 层 UNIQUE(idempotency_key) 保证，不是 service 层 SELECT-then-INSERT。
 *   - 不返回 idempotency_key / deleted_at / payload_json 等内部字段给 API 层。
 */

import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { BaseRepository } from './base';
import { generateUlid } from '../utils/crypto';
import { userScopeRequired } from '../utils/errors';
import type { Paginated } from '../types/api';

export type NotificationCategory =
  | 'system'
  | 'activity'
  | 'team'
  | 'training'
  | 'exam'
  | 'qualification'
  | 'points'
  | 'content';

export interface NotificationRow {
  id: number;
  public_id: string;
  team_id: number | null;
  event_type: string;
  category: NotificationCategory;
  title: string;
  summary: string | null;
  body: string | null;
  business_entity_type: string | null;
  business_entity_id: number | null;
  target_page: string | null;
  payload_json: string | null;
  created_by: number | null;
  created_at: number;
  deleted_at: number | null;
}

export interface NotificationRecipientRow {
  id: number;
  public_id: string;
  notification_id: number;
  user_id: number;
  read_at: number | null;
  created_at: number;
  deleted_at: number | null;
  idempotency_key: string;
}

/** 列表 DTO（不含正文 / payload / 内部字段）。 */
export interface NotificationListItem {
  id: string;
  event_type: string;
  category: NotificationCategory;
  title: string;
  summary: string | null;
  target_page: string | null;
  read: boolean;
  read_at: number | null;
  created_at: number;
}

/** 详情 DTO（含完整安全正文；仍不含 payload_json / idempotency_key）。 */
export interface NotificationDetail extends NotificationListItem {
  body: string | null;
  business_entity_type: string | null;
  business_entity_id: number | null;
}

export interface CreateNotificationInput {
  teamId?: number | null;
  eventType: string;
  category: NotificationCategory;
  title: string;
  summary?: string | null;
  body?: string | null;
  businessEntityType?: string | null;
  businessEntityId?: number | null;
  targetPage?: string | null;
  payload?: Record<string, unknown> | null;
  createdBy?: number | null;
  createdAt?: number;
}

/**
 * 通知插入门控片段（N0-E1）。
 *
 * 语义：一个自包含的 `EXISTS (...)` SQL 片段 + 其按序 params，由调用方（业务域 repository）
 * 构造并在同一 db.batch 内作为「共享 PRE-state 谓词 P」。当 P 落空时，被门控的
 * notifications / notification_recipients INSERT 各写 0 行（而非报错），从而与业务状态跃迁
 * 保持「全成或全 0」的原子一致。
 *
 * 安全：片段由服务端代码构造（仅含 `?` 占位符），不含任何用户输入拼接。
 */
export interface NotificationInsertGate {
  existsSql: string;
  params: unknown[];
}

/** 判定错误是否为 notification_recipients.idempotency_key 的 UNIQUE 冲突（幂等命中）。 */
function isIdempotencyConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : err == null ? '' : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeMsg = cause instanceof Error ? cause.message : cause == null ? '' : String(cause);
  const hay = `${msg}\n${causeMsg}`.toLowerCase();
  return (
    /unique constraint failed/.test(hay) &&
    /notification_recipients/.test(hay) &&
    /idempotency_key/.test(hay)
  );
}

export class NotificationRepository extends BaseRepository {
  private assertUserScoped(): void {
    if (this.ctx.tenant.userId == null) throw userScopeRequired();
  }

  // ===== 写入（内部 domain capability；无公开 create 端点）=====

  /** 创建通知内容行（不创建 recipient）。 */
  async createNotification(input: CreateNotificationInput): Promise<NotificationRow> {
    this.ensureTableRead('notifications');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO notifications
         (public_id, team_id, event_type, category, title, summary, body,
          business_entity_type, business_entity_id, target_page, payload_json,
          created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        input.teamId ?? null,
        input.eventType,
        input.category,
        input.title,
        input.summary ?? null,
        input.body ?? null,
        input.businessEntityType ?? null,
        input.businessEntityId ?? null,
        input.targetPage ?? null,
        input.payload == null ? null : JSON.stringify(input.payload),
        input.createdBy ?? null,
        input.createdAt ?? Math.floor(Date.now() / 1000),
      ],
    );
    return (await this.first<NotificationRow>(
      `SELECT * FROM notifications WHERE public_id = ?`,
      [publicId],
    ))!;
  }

  /**
   * 构造「通知内容 + 全部 recipient」的已 bind statement 序列（N0-E1 抽取；不含 db.batch）。
   *
   * 唯一权威 SQL 事实源：createIdempotent 与业务事件组合（ActivitySignupService.reviewSignup）
   * 都经本方法取 statement，杜绝第二份 INSERT SQL 漂移。
   *
   * - gate == null（N0-A create() 路径）：`INSERT ... VALUES`，与既有行为逐字节一致。
   * - gate != null（N0-E1 组合路径）：两条 INSERT 改为 `INSERT ... SELECT ... WHERE <gate>`，
   *   使「共享谓词落空 ⇒ 0 行」而非报错；recipient 以同批已落地的通知行 EXISTS 为闸门
   *   （gate 落空时通知行 0 行 → recipient 亦 0 行）。此处【无任何 ON CONFLICT / INSERT OR IGNORE】。
   *
   * 本方法【只构造、不执行】——执行方为 createIdempotent 或调用方的组合 db.batch。
   */
  buildCreateIdempotentStatements(p: {
    input: CreateNotificationInput;
    recipients: { userId: number; idempotencyKey: string }[];
    gate?: NotificationInsertGate | null;
  }): { statements: D1PreparedStatement[]; notifPublicId: string } {
    if (p.recipients.length === 0) {
      throw new Error('createIdempotent requires at least one recipient');
    }
    this.assertUserScoped();
    this.ensureTableRead('notifications');
    this.ensureTableRead('notification_recipients');

    const gate = p.gate ?? null;
    const notifPublicId = generateUlid();
    const now = p.input.createdAt ?? Math.floor(Date.now() / 1000);

    const notifCols = `(public_id, team_id, event_type, category, title, summary, body,
              business_entity_type, business_entity_id, target_page, payload_json,
              created_by, created_at)`;
    const notifVals: unknown[] = [
      notifPublicId,
      p.input.teamId ?? null,
      p.input.eventType,
      p.input.category,
      p.input.title,
      p.input.summary ?? null,
      p.input.body ?? null,
      p.input.businessEntityType ?? null,
      p.input.businessEntityId ?? null,
      p.input.targetPage ?? null,
      p.input.payload == null ? null : JSON.stringify(p.input.payload),
      p.input.createdBy ?? null,
      now,
    ];

    const stmts: D1PreparedStatement[] = [];
    if (gate == null) {
      stmts.push(
        this.db
          .prepare(`INSERT INTO notifications ${notifCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...(notifVals as never[])),
      );
    } else {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO notifications ${notifCols}
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${gate.existsSql}`,
          )
          .bind(...(notifVals as never[]), ...(gate.params as never[])),
      );
    }

    for (const rc of p.recipients) {
      if (gate == null) {
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO notification_recipients
                 (public_id, notification_id, user_id, read_at, created_at, idempotency_key)
               VALUES (?, (SELECT id FROM notifications WHERE public_id = ?), ?, NULL, ?, ?)`,
            )
            .bind(generateUlid(), notifPublicId, rc.userId, now, rc.idempotencyKey),
        );
      } else {
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO notification_recipients
                 (public_id, notification_id, user_id, read_at, created_at, idempotency_key)
               SELECT ?, (SELECT id FROM notifications WHERE public_id = ?), ?, NULL, ?, ?
                WHERE EXISTS (SELECT 1 FROM notifications WHERE public_id = ?)`,
            )
            .bind(generateUlid(), notifPublicId, rc.userId, now, rc.idempotencyKey, notifPublicId),
        );
      }
    }

    return { statements: stmts, notifPublicId };
  }

  /**
   * 原子幂等创建（N0-A ATOMIC IDEMPOTENCY FINAL FIX）。
   *
   * 核心机制：D1 batch（单事务，miniflare 不支持 SQL BEGIN/COMMIT）原子写入
   * 「通知内容 + 全部 recipient」，**全部不带 ON CONFLICT DO NOTHING / INSERT OR IGNORE**。
   *
   * - 任一 recipient 命中 notification_recipients.idempotency_key UNIQUE：
   *   整个 batch 失败并原子回滚（通知内容行一并撤销）——不存在「提交后补偿删除孤儿」的
   *   崩溃窗口；Worker crash 也不会留下孤儿通知。
   * - catch 仅识别 notification_recipients.idempotency_key 的 UNIQUE 冲突 → 查询既有通知
   *   返回（created=false）。
   * - 任何其他错误（FK / SQL / 不可用 / 非法数据）一律原样抛出，绝不吞掉或误判为幂等。
   *
   * 幂等责任完全在 NotificationService / repository 层（DB UNIQUE + 原子回滚），
   * 不依赖 caller 侧去重。
   *
   * 语句构造委托 buildCreateIdempotentStatements（单一 SQL 事实源）；本方法仅负责执行 + 幂等收敛。
   */
  async createIdempotent(p: {
    input: CreateNotificationInput;
    recipients: { userId: number; idempotencyKey: string }[];
  }): Promise<{ notification: NotificationRow; created: boolean }> {
    // 先经 builder（含 recipients 非空 / USER_SCOPED / 表级 guard），再取 anchorKey。
    const { statements, notifPublicId } = this.buildCreateIdempotentStatements(p);
    const anchorKey = p.recipients[0].idempotencyKey;

    try {
      await this.db.batch(statements);
    } catch (err) {
      // 仅识别「notification_recipients.idempotency_key」UNIQUE 冲突 → 视为幂等命中。
      if (isIdempotencyConflict(err)) {
        // 整批已原子回滚：本次通知内容行未落库。查询既有通知返回。
        const existing = await this.first<NotificationRow>(
          `SELECT n.* FROM notifications n
             JOIN notification_recipients nr ON nr.notification_id = n.id
            WHERE nr.idempotency_key = ? AND nr.deleted_at IS NULL AND n.deleted_at IS NULL
            LIMIT 1`,
          [anchorKey],
        );
        // 安全兜底：理论上冲突必有既有行；极端竞态下若无可查（不应发生），回退抛出原错误。
        if (existing != null) return { notification: existing, created: false };
      }
      // 其他一切 DB 错误（FK / SQL / 不可用 / 非法数据）原样抛出，绝不吞掉。
      throw err;
    }

    const notification = (await this.first<NotificationRow>(
      `SELECT * FROM notifications WHERE public_id = ?`,
      [notifPublicId],
    ))!;
    return { notification, created: true };
  }

  // ===== 读取（全部 USER_SCOPED：recipient.user_id 为唯一权威）=====

  /** 当前用户的通知列表（newest first：created_at DESC, id DESC）。 */
  async listByUser(
    userId: number,
    page: number,
    pageSize: number,
    offset: number,
  ): Promise<Paginated<NotificationListItem>> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    this.ensureTableRead('notifications');

    const totalRow = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id = ? AND nr.deleted_at IS NULL AND n.deleted_at IS NULL`,
      [userId],
    );
    const total = totalRow?.n ?? 0;

    const rows = await this.all<{
      public_id: string;
      event_type: string;
      category: NotificationCategory;
      title: string;
      summary: string | null;
      target_page: string | null;
      read_at: number | null;
      created_at: number;
    }>(
      `SELECT n.public_id, n.event_type, n.category, n.title, n.summary,
              n.target_page, nr.read_at, n.created_at
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id = ? AND nr.deleted_at IS NULL AND n.deleted_at IS NULL
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ? OFFSET ?`,
      [userId, pageSize, offset],
    );

    return {
      items: rows.map((r) => ({
        id: r.public_id,
        event_type: r.event_type,
        category: r.category,
        title: r.title,
        summary: r.summary,
        target_page: r.target_page,
        read: r.read_at != null,
        read_at: r.read_at,
        created_at: r.created_at,
      })),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /** 当前用户的单条通知详情；不存在或不属于该用户 → null（避免跨用户探测）。 */
  async getByUserAndPublicId(userId: number, publicId: string): Promise<NotificationDetail | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    this.ensureTableRead('notifications');

    const r = await this.first<{
      public_id: string;
      event_type: string;
      category: NotificationCategory;
      title: string;
      summary: string | null;
      body: string | null;
      business_entity_type: string | null;
      business_entity_id: number | null;
      target_page: string | null;
      read_at: number | null;
      created_at: number;
    }>(
      `SELECT n.public_id, n.event_type, n.category, n.title, n.summary, n.body,
              n.business_entity_type, n.business_entity_id, n.target_page,
              nr.read_at, n.created_at
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id = ? AND n.public_id = ?
          AND nr.deleted_at IS NULL AND n.deleted_at IS NULL
        LIMIT 1`,
      [userId, publicId],
    );
    if (r == null) return null;

    return {
      id: r.public_id,
      event_type: r.event_type,
      category: r.category,
      title: r.title,
      summary: r.summary,
      body: r.body,
      business_entity_type: r.business_entity_type,
      business_entity_id: r.business_entity_id,
      target_page: r.target_page,
      read: r.read_at != null,
      read_at: r.read_at,
      created_at: r.created_at,
    };
  }

  /** 当前用户未读数（read_at IS NULL 且未删除）。 */
  async countUnread(userId: number): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    this.ensureTableRead('notifications');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id = ? AND nr.read_at IS NULL
          AND nr.deleted_at IS NULL AND n.deleted_at IS NULL`,
      [userId],
    );
    return r?.n ?? 0;
  }

  /** 取当前用户的 recipient 行（authority：归属判定）。 */
  async findRecipientByNotificationPublicId(
    userId: number,
    publicId: string,
  ): Promise<NotificationRecipientRow | null> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    this.ensureTableRead('notifications');
    return this.first<NotificationRecipientRow>(
      `SELECT nr.* FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.user_id = ? AND n.public_id = ?
          AND nr.deleted_at IS NULL AND n.deleted_at IS NULL
        LIMIT 1`,
      [userId, publicId],
    );
  }

  // ===== 已读语义（幂等：保留首次 read_at）=====

  /** 仅当 read_at IS NULL 时写入；返回是否本次真正写入。 */
  async markReadIfUnread(recipientId: number, now: number): Promise<boolean> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    const res = await this.run(
      `UPDATE notification_recipients SET read_at = ?
        WHERE id = ? AND read_at IS NULL AND deleted_at IS NULL`,
      [now, recipientId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** 当前用户全部未读置为已读；返回受影响行数。 */
  async markAllRead(userId: number, now: number): Promise<number> {
    this.assertUserScoped();
    this.ensureTableRead('notification_recipients');
    const res = await this.run(
      `UPDATE notification_recipients SET read_at = ?
        WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
      [now, userId],
    );
    return res.meta?.changes ?? 0;
  }
}
