-- P0-B：微信可信手机号绑定事实表（独立 SSOT）。
--
-- 业务语义（冻结）：
--   WECHAT_PHONE_BOUND 只能来源于微信可信手机号授权事实。
--   与 volunteer_profiles.phone_enc / phone_mask（用户自填联系电话，休眠占位）物理与语义分离，
--   不得把自填 phone 当作可信微信手机号绑定事实。
--   user_identities(phone) 仍为休眠，本阶段不作为 SSOT。
--
-- scope：USER_SCOPED（仅本人可读写；repository 层强制 user_id = ctx.tenant.userId）。
-- status：仅 BOUND / PROVIDER_ERROR / INVALID_CODE，不引入 qualification_status / onboarding_status / MANUAL_REVIEW。

CREATE TABLE IF NOT EXISTS phone_verifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT    NOT NULL,
  user_id             INTEGER NOT NULL,
  provider            TEXT    NOT NULL CHECK (provider IN ('WECHAT')),
  phone_enc           TEXT    NOT NULL,                 -- 完整手机号 AES-256-GCM 加密（仅绑定成功行有值；失败行存空串）
  phone_hash          TEXT    NOT NULL,                 -- HMAC-SHA256(手机号)；用于去重/幂等
  phone_mask          TEXT    NOT NULL,                 -- 脱敏展示（前3+****+后4）；失败行存空串
  status              TEXT    NOT NULL CHECK (status IN ('BOUND','PROVIDER_ERROR','INVALID_CODE')),
  failure_reason_code TEXT,                             -- 原始上游语义（如 WECHAT_40029 / FAKE_INVALID_CODE），不向客户端回显
  provider_request_id TEXT,                             -- 微信 getuserphonenumber 无此字段 → 允许 NULL
  bound_at            INTEGER,                          -- 绑定成功时刻（unixepoch）；失败行为 NULL
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_phone_verifications_user        ON phone_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user_hash   ON phone_verifications(user_id, phone_hash);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user_status ON phone_verifications(user_id, status);
