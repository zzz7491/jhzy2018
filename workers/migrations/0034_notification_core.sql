-- =============================================================================
-- N0-A — 0034：统一通知域 v1（IN_APP 闭环）
--
-- 冻结依据（workers/NOTIFICATION_COMMUNICATION_REALITY_AUDIT.md）：
--   PRIMARY_CHANNELS = IN_APP + WECHAT_SUBSCRIBE；本轮【仅】IN_APP。
--   SMS = RESERVED_ONLY —— 本迁移不含任何 SMS 字段 / 表 / 凭证。
--   NOTIFICATION_TEAM_SCOPE = OPTIONAL —— team_id 必须可为 NULL。
--   notification_deliveries = DEFERRED TO N0-D（本迁移不创建）。
--
-- 变更概要：
--   A. notifications 重建：
--      - team_id 由 NOT NULL 放宽为 NULLABLE（用户级 / 系统级通知无 team）。
--      - 新增 public_id / event_type / category / summary / body /
--        business_entity_type / business_entity_id / target_page / payload_json /
--        created_by / deleted_at。
--      - 移除 user_id / is_read / read_at / channel：每用户投递态归属
--        notification_recipients，不再冗余在内容表（统一通知域冻结模型）。
--      - 历史行 1:1 迁移为 notification_recipients，read_at / created_at 保留，
--        notif_type 保留为 event_type = 'legacy.<notif_type>'，不丢数据。
--   B. 新建 notification_recipients（USER_SCOPED）：每用户投递态 + idempotency_key UNIQUE。
--   C. 索引 / 唯一约束。
--
-- 安全重建顺序（不可调换）：
--   1) 暂存历史 recipient 语义到 _n0a_legacy_recipients（在旧表 DROP 之前）
--   2) CREATE notifications_new → INSERT…SELECT → DROP notifications
--      → ALTER TABLE notifications_new RENAME TO notifications
--   3) CREATE notification_recipients（此时 FK 目标已是新表）
--      → 从 _n0a_legacy_recipients 回填 → DROP 暂存表
--   该顺序保证：任何时刻都不存在指向被 DROP 表的悬空 FK（0019 教训）。
--
-- 不创建：notification_deliveries / wechat_subscription_state / sms_* /
--         outbox / retry_jobs / 任何微信或短信字段。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A1. 暂存历史 recipient 语义（必须在 DROP 旧表之前）=====
CREATE TABLE IF NOT EXISTS _n0a_legacy_recipients AS
SELECT id AS notification_id, user_id, read_at, created_at FROM notifications;

-- ===== A2. notifications 新表 =====
CREATE TABLE IF NOT EXISTS notifications_new (
  id                   INTEGER PRIMARY KEY,
  public_id            TEXT    NOT NULL,                                   -- ULID（应用层生成）
  team_id              INTEGER REFERENCES teams(id) ON DELETE RESTRICT,    -- OPTIONAL：用户级/系统级通知为 NULL
  event_type           TEXT    NOT NULL,                                   -- 稳定业务事件 token（如 activity.signup.approved）
  category             TEXT    NOT NULL CHECK (category IN (
                         'system','activity','team','training','exam','qualification','points','content')),
  title                TEXT    NOT NULL,
  summary              TEXT,                                               -- 列表预览
  body                 TEXT,                                               -- 详情正文
  business_entity_type TEXT,                                               -- 关联业务实体类型（无 JSON dump）
  business_entity_id   INTEGER,
  target_page          TEXT,                                               -- 前端跳转页（仅真实存在路由）
  payload_json         TEXT,                                               -- 最小业务 metadata JSON；禁 PII / secret / token
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,    -- NULL = system
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at           INTEGER
);

INSERT INTO notifications_new
  (id, public_id, team_id, event_type, category, title, summary, body,
   business_entity_type, business_entity_id, target_page, payload_json,
   created_by, created_at, deleted_at)
SELECT
  id,
  '01NTF' || printf('%021d', id),            -- 26 位 Crockford 合法（排除 I/L/O/U）
  team_id,
  'legacy.' || notif_type,
  CASE notif_type
    WHEN 'signup'   THEN 'activity'
    WHEN 'audit'    THEN 'activity'
    WHEN 'activity' THEN 'activity'
    WHEN 'cert'     THEN 'training'
    WHEN 'points'   THEN 'points'
    WHEN 'system'   THEN 'system'
    WHEN 'content'  THEN 'content'
    ELSE 'system'
  END,
  title,
  NULL,
  content,
  target_type,
  target_id,
  NULL,
  NULL,
  NULL,
  created_at,
  NULL
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

-- ===== B. notification_recipients（USER_SCOPED 每用户投递态）=====
CREATE TABLE IF NOT EXISTS notification_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id        TEXT    NOT NULL,                                            -- ULID
  notification_id  INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          INTEGER,                                                     -- NULL = 未读
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at       INTEGER,
  -- 幂等键（caller 提供语义键；必须包含 recipient 身份以支持未来广播去重）
  idempotency_key  TEXT    NOT NULL
);

-- 历史行 1:1 回填（幂等键带 legacy: 前缀，显式标识迁移来源）
INSERT INTO notification_recipients
  (public_id, notification_id, user_id, read_at, created_at, deleted_at, idempotency_key)
SELECT
  '01NTR' || printf('%021d', notification_id),
  notification_id,
  user_id,
  read_at,
  created_at,
  NULL,
  'legacy:notification:' || printf('%d', notification_id)
FROM _n0a_legacy_recipients;

DROP TABLE _n0a_legacy_recipients;

-- ===== C. 索引 / 唯一约束 =====
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_public_id   ON notifications(public_id);
CREATE INDEX        IF NOT EXISTS idx_notif_team_created ON notifications(team_id, created_at);
CREATE INDEX        IF NOT EXISTS idx_notif_event        ON notifications(event_type, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nrec_public_id    ON notification_recipients(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nrec_idempotency  ON notification_recipients(idempotency_key);
CREATE INDEX        IF NOT EXISTS idx_nrec_user         ON notification_recipients(user_id, deleted_at, created_at);
CREATE INDEX        IF NOT EXISTS idx_nrec_notification ON notification_recipients(notification_id);
