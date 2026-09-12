-- =============================================================================
-- N0-D — 0036：投递事实表 + 一次性订阅消费锚点
--
-- 冻结依据（NOTIFICATION ARCHITECTURE = FROZEN）：
--   N0-C 已建立投递身份（notification_delivery_identities）+ 订阅授权
--   （wechat_subscription_consents）+ 模板映射（message_templates）。
--   N0-D 只补「投递事实」与「一次性订阅消费」两层，不发消息、不接业务事件。
--
-- 变更概要（纯增量，不改任何既有表结构语义）：
--   A. wechat_subscription_consents：追加 consumed_at（一次性订阅消费锚点）。
--      ACCEPT 成功投递 / 授权已失效后写入；eligibility 据此判定不可再发。
--   B. notification_deliveries（USER_SCOPED）：投递事实 / 尝试记录。
--      不存 raw openid / decrypted openid / AppSecret / access_token；
--      provider error message 经安全裁剪为稳定 token。
--
-- 安全纪律：
--   - 迁移不含任何明文 openid / Secret。
--   - encryption secret 由 Worker env 提供；本文件绝不写死。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A. 一次性订阅消费锚点 =====
ALTER TABLE wechat_subscription_consents ADD COLUMN consumed_at INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_wsc_consumed ON wechat_subscription_consents(user_id, template_key, consumed_at);

-- ===== B. notification_deliveries（USER_SCOPED）=====
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel               TEXT    NOT NULL CHECK (channel IN ('WECHAT_SUBSCRIBE')),
  template_key          TEXT    NOT NULL,
  provider_template_id  TEXT    NOT NULL,
  notification_id       INTEGER,                       -- 可空：关联 notifications.id；N0-D 不强制
  recipient_id          INTEGER,                       -- 可空：未来多收件人扩展
  status                TEXT    NOT NULL CHECK (status IN ('DELIVERED','NOT_ELIGIBLE','INVALID_PAYLOAD','PROVIDER_REJECTED','PROVIDER_ERROR','NETWORK_ERROR')),
  provider_message_id   TEXT,
  provider_error_code   TEXT,
  provider_error_message TEXT,                          -- 仅稳定 token，绝不存原始 errmsg / openid / secret
  idempotency_key       TEXT,
  attempted_at          INTEGER NOT NULL,
  delivered_at          INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 幂等锚点：同一 user + idempotency_key 唯一（idempotency_key 为 NULL 时不冲突，允许多次自然调用）。
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_nd_user_tpl ON notification_deliveries(user_id, template_key);
CREATE INDEX IF NOT EXISTS idx_nd_idem ON notification_deliveries(idempotency_key);
