-- =============================================================================
-- N0-F3 — 0040：授权事件表 + consents.current_authorization_event_id
--
-- 冻结契约（N0-F3 事件权威投影）：
--   GENERATION_IDENTITY = AUTHORIZATION_EVENT_ID
--     —— 授权事件表 id 即「生成身份」（每次 wx.requestSubscribeMessage 调用 = 一次生成）。
--   CURRENT_EVENT_MEANING = LATEST_AUTHORIZATION_EVENT
--     —— consent 的 current_authorization_event_id 永远指向最新一次授权事件；
--        所有状态 ACCEPT / REJECT / BAN 都推进投影（单调 ADVANCE）。
--   REQUEST IDEMPOTENCY = UNIQUE(user_id, template_key, authorization_request_id)
--     —— 同一请求（前端每次 invocation 生成稳定 id，retry 复用）首写胜出，重复上报不产生新事件。
--   projection authority = STORED authorization event row
--     —— HTTP body 的 state 仅首次 INSERT 落库；后续投影一律来自「已存储事件行」，
--        不信任任何 replay body。
--   baseline 方案 C：既有 wechat_subscription_consents 行（来自 0035/0036）的
--     current_authorization_event_id = NULL（不回填合成事件）。其资格判定依赖
--     JOIN e.id = c.current_authorization_event_id AND e.state='ACCEPT'，
--     故旧行在用户「重新真实授权」（产生真实事件）之前不通过投递资格——
--     保守且安全，不伪造历史授权。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ===== A. 授权事件表（AUTHORIZATION_EVENT_ID = 生成身份）=====
CREATE TABLE IF NOT EXISTS wechat_subscription_authorization_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,   -- AUTHORIZATION_EVENT_ID（生成身份）
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key             TEXT    NOT NULL,                   -- 内部稳定 key（= message_templates.code）
  template_id              TEXT    NOT NULL,                   -- 微信 provider template id（= message_templates.wx_template_id）
  state                    TEXT    NOT NULL CHECK (state IN ('ACCEPT','REJECT','BAN')),
  authorization_request_id TEXT    NOT NULL,                   -- 前端每次 invocation 生成稳定 id（retry 复用）
  requested_at             INTEGER NOT NULL,                   -- 首次请求时刻（不被 replay 覆盖）
  responded_at             INTEGER NOT NULL,                   -- 授权结果时刻
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  -- 请求幂等：同一 user + template + request 唯一（重复上报 = 首写胜出，不产生新事件）。
  UNIQUE (user_id, template_key, authorization_request_id)
);
CREATE INDEX IF NOT EXISTS idx_wsae_user_tpl ON wechat_subscription_authorization_events(user_id, template_key);
CREATE INDEX IF NOT EXISTS idx_wsae_req
  ON wechat_subscription_authorization_events(user_id, template_key, authorization_request_id);

-- ===== B. consents 增加 current_authorization_event_id（可空；ADD COLUMN 受 0036 先例支持）=====
-- 旧行保持 NULL（baseline 方案 C）；新授权经 0039/本迁移后的 upsertConsent 写入最新事件 id。
ALTER TABLE wechat_subscription_consents ADD COLUMN current_authorization_event_id INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_wsc_cur_evt ON wechat_subscription_consents(current_authorization_event_id);
