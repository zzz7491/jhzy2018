-- =============================================================================
-- N0-F3 — 0039：notification_deliveries 重建 + RESERVED 状态 + authorization_event_id
--
-- 冻结依据（N0-F3 投递预留契约）：
--   delivery reservation = 单次 guarded INSERT…SELECT，把「一次性订阅授权权」锁成一条
--   RESERVED 投递行；仅 RESERVED 成功者才调用 provider（at-most-once claim）。
--   最终态（DELIVERED / PROVIDER_*）由 finalize 更新同一行得到。
--
-- 重建原因：SQLite/D1 的 CHECK 约束不可 ALTER，按项目既有 table-rebuild precedent
-- （0004_attendance_multi_participation）安全重建：
--   RENAME → 重建新表 → 迁数据 → DROP 旧表 → 再建索引（避免索引同名冲突）。
--
-- 保留（不动既有语义 / 数据）：
--   id / PK / 全部既有列 / 既有外键 / UNIQUE(user_id, idempotency_key) / 既有行 / 时间戳。
-- 新增：
--   status CHECK 支持 'RESERVED'；
--   authorization_event_id INTEGER NULL（预留所锚定的授权事件）；
--   硬唯一索引 UNIQUE(authorization_event_id)（N0-F3-R1：无 status 谓词）。
--     —— 任一 delivery 行占用该事件即「消费」该授权 grant（不论 RESERVED/DELIVERED/终态）；
--        terminal failure 亦视为已使用，再次发送须来自 NEW ACCEPT → NEW event.id（不得复用旧 event）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- 1. 重命名旧表为临时表（其索引随之更名，待 DROP 一并清除）
ALTER TABLE notification_deliveries RENAME TO _notification_deliveries_old;

-- 2. 重建新表（结构 = 旧表 + 新增项）
CREATE TABLE notification_deliveries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel               TEXT    NOT NULL CHECK (channel IN ('WECHAT_SUBSCRIBE')),
  template_key          TEXT    NOT NULL,
  provider_template_id  TEXT    NOT NULL,
  notification_id       INTEGER,                       -- 可空：关联 notifications.id；N0-D 不强制
  recipient_id          INTEGER,                       -- 可空：未来多收件人扩展
  status                TEXT    NOT NULL CHECK (status IN ('RESERVED','DELIVERED','NOT_ELIGIBLE','INVALID_PAYLOAD','PROVIDER_REJECTED','PROVIDER_ERROR','NETWORK_ERROR')),
  provider_message_id   TEXT,
  provider_error_code   TEXT,
  provider_error_message TEXT,                          -- 仅稳定 token，绝不存原始 errmsg / openid / secret
  authorization_event_id INTEGER,                       -- N0-F3：预留所锚定的授权事件 id（NULL = 非预留类记录 / 迁移前历史行）
  idempotency_key       TEXT,
  attempted_at          INTEGER NOT NULL,
  delivered_at          INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 幂等锚点：同一 user + idempotency_key 唯一（idempotency_key 为 NULL 时不冲突，允许多次自然调用）。
  UNIQUE (user_id, idempotency_key)
);

-- 3. 迁移既有行（authorization_event_id 统一 NULL；既有终态行不受影响，部分唯一索引对 NULL 键放行）
INSERT INTO notification_deliveries
  (id, user_id, channel, template_key, provider_template_id, notification_id, recipient_id,
   status, provider_message_id, provider_error_code, provider_error_message, authorization_event_id,
   idempotency_key, attempted_at, delivered_at, created_at)
SELECT
   id, user_id, channel, template_key, provider_template_id, notification_id, recipient_id,
   status, provider_message_id, provider_error_code, provider_error_message, NULL,
   idempotency_key, attempted_at, delivered_at, created_at
FROM _notification_deliveries_old;

-- 4. 丢弃旧表（同时清除其所有索引，避免与新表索引同名冲突）
DROP TABLE _notification_deliveries_old;

-- 5. 重建索引（此时旧表已不在，索引名无冲突）
CREATE INDEX IF NOT EXISTS idx_nd_user_tpl ON notification_deliveries(user_id, template_key);
CREATE INDEX IF NOT EXISTS idx_nd_idem ON notification_deliveries(idempotency_key);
-- 硬唯一索引（N0-F3-R1）：同一 authorization_event_id 最多一条 delivery claim，不论状态。
-- 任一 delivery 占用该事件即 burn，保证 ONE AUTHORIZATION EVENT → AT MOST ONE PROVIDER ATTEMPT。
CREATE UNIQUE INDEX IF NOT EXISTS uq_nd_auth_event
  ON notification_deliveries(authorization_event_id);
