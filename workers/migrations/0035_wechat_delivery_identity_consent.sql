-- =============================================================================
-- N0-C — 0035：微信投递身份 + 订阅授权同意（WECHAT_SUBSCRIBE 渠道基础）
--
-- 冻结依据（NOTIFICATION ARCHITECTURE = FROZEN）：
--   PRIMARY_CHANNELS = IN_APP + WECHAT_SUBSCRIBE；SMS = RESERVED_ONLY（不实现）。
--   模型三分（禁止合并为一个 boolean）：
--     USER_NOTIFICATION_PREFERENCE   （用户产品偏好）          —— 本轮不建
--     WECHAT_SUBSCRIPTION_PERMISSION （微信客户端授权结果）    —— 本轮建（consents）
--     DELIVERY_ELIGIBILITY           （发送当下综合判定）      —— N0-D 才建
--   N0-C 只建立 B（微信授权）+ delivery identity 基础；不做投递资格引擎、不发消息。
--
-- 变更概要（纯增量，不改任何既有表结构）：
--   A. notification_delivery_identities（USER_SCOPED）：
--      独立投递身份存储。raw openid 只在此【加密静态存储】（encrypt at rest），
--      并保存 HMAC 摘要（external_id_hash）用于 dedupe / lookup / 安全比较。
--      【绝不】把 raw openid 写回 user_identities（那里只存 identity_hash）。
--   B. wechat_subscription_consents（USER_SCOPED）：
--      每用户 × 每模板的微信订阅授权结果（ACCEPT / REJECT / BAN），
--      基于 wx.requestSubscribeMessage 的真实返回语义；requestSubscribeMessage
--      调用成功 ≠ ACCEPT，必须存每个 template 的真实结果。
--   C. message_templates 映射：复用既有 message_templates（PLATFORM_GLOBAL），
--      以 (code, channel='wechat_subscribe') → wx_template_id 建立
--      「内部稳定 template key → 微信 provider template id」映射基础。
--      仅导入已在旧前端 subscribe 页面中【真实存在】的模板 ID（verbatim，不编造）；
--      若某 key 已存在则 INSERT OR IGNORE 不动既有行。
--
-- 明确不创建（DEFERRED）：
--   notification_deliveries / delivery attempts / retry_count / provider response /
--   provider message id / delivery status machine（→ N0-D）；
--   sms_* / outbox / wechat_subscription_state 之外的任何发送态；
--   user_notification_preference（用户偏好层，N0-C 不实现）。
--
-- 安全纪律：
--   - 迁移不含任何明文 openid / Secret；encrypted_external_id 由应用层加密后写入。
--   - encryption secret 由 Worker env（DELIVERY_IDENTITY_ENC_KEY）提供，绝不写死于此。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A. notification_delivery_identities（USER_SCOPED）=====
-- 独立于 user_identities 的投递身份存储（禁止把 raw openid 塞回 user_identities）。
-- status / provider 采用 N0-C 规格的枚举等价 TEXT（用户 §3 允许 enum equivalent）。
CREATE TABLE IF NOT EXISTS notification_delivery_identities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              TEXT    NOT NULL CHECK (provider IN ('WECHAT_MINIPROGRAM')),
  encrypted_external_id TEXT    NOT NULL,   -- AES-GCM 密文（v1.<iv>.<ciphertext>，base64url）；可解密供未来 N0-D touser
  external_id_hash      TEXT    NOT NULL,   -- HMAC-SHA256 摘要（域分隔）；用于 dedupe / lookup / 比较（不可逆）
  status                TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER,
  -- 幂等锚点：同一 user + provider + external identity 唯一（重复登录 = UPSERT，不产生重复行）
  UNIQUE (user_id, provider, external_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_ndi_user ON notification_delivery_identities(user_id, provider, status);

-- ===== B. wechat_subscription_consents（USER_SCOPED）=====
-- 每用户 × 每模板的授权结果（current record；重复上报同一结果 = 幂等 UPSERT）。
-- template_id 冗余保存接收当下的 provider id（便于审计）；权威映射仍以 message_templates 为准。
CREATE TABLE IF NOT EXISTS wechat_subscription_consents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key  TEXT    NOT NULL,   -- 内部稳定 key（= message_templates.code）
  template_id   TEXT    NOT NULL,   -- 微信 provider template id（= message_templates.wx_template_id）
  consent_state TEXT    NOT NULL CHECK (consent_state IN ('ACCEPT','REJECT','BAN')),
  requested_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  responded_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- 幂等锚点：同一 user + template 唯一（重复上报 = UPSERT 更新，不产生无限重复行）
  UNIQUE (user_id, template_key)
);
CREATE INDEX IF NOT EXISTS idx_wsc_user ON wechat_subscription_consents(user_id, template_key);

-- ===== C. template 映射（复用 message_templates；仅导入旧前端真实存在的模板 ID）=====
-- 来源：miniprogram/pages/subscribe/subscribe.ts 的硬编码 templates（verbatim 导入，不编造）。
-- channel='wechat_subscribe'，code = 内部稳定 template key，wx_template_id = 微信 provider 模板 id。
INSERT OR IGNORE INTO message_templates (code, channel, wx_template_id, title, content_tpl, status)
VALUES
  ('signup',      'wechat_subscribe', '_x9D2d6Ae7wuiewEp4XTPVsSd061O4lPaLreJdZQwM4', '报名结果提醒',  '', 1),
  ('certify',     'wechat_subscribe', 'eu4viO-Ex0YqXnVfXsRAAPOIFsZc_AC7LsVVW4ug8Yw', '实名认证通知',  '', 1),
  ('change',      'wechat_subscribe', 'wQtwe8L7l-u6YFzMtHRbXNrXvZVRacbPGEZMgVTHMZ8', '活动变更通知',  '', 1),
  ('training',    'wechat_subscribe', 'JRKyGhoWQ9XNxt7_bAQxMgj8IoJTgs4qiQKo2vqhBa8', '活动培训提醒',  '', 1),
  ('points',      'wechat_subscribe', 'sGepFsMsjkIGL-ph7mjCNHb9aKG11sh89J55qB3bEok', '积分变动提醒',  '', 1),
  ('verify',      'wechat_subscribe', 'PcOdV5nYPj89BY-b_C5n1FNjmq7G9mqQQBlQU1pEE9A', '核销成功通知',  '', 1),
  ('audit',       'wechat_subscribe', 'k6azwIXNr-D-u322U91vZXQet_MUtaLpqxtqDL6NG-A', '审核通过提醒',  '', 1),
  ('start',       'wechat_subscribe', 'SrFXViQy2FVmi34qEtJmcbMPOR_cqNHn74zo0eA4eSA', '活动开始通知',  '', 1),
  ('checkin',     'wechat_subscribe', 'QVakhEJ7nDaB6seNZWBzPcn2HD4oL3Gdp8-VUw7UZTY', '签到提醒',      '', 1),
  ('book',        'wechat_subscribe', 'Lx4Vpm2T7TTdzXjy2XJS8-Uc6jnxan7vNlewfJSmTqk', '预约通知',      '', 1),
  ('newActivity', 'wechat_subscribe', 'Pq6jAdefsEM5kRG6tFryCmA-ddWBwC8Gybe33DOpHFw', '新活动发布提醒', '', 1);
