-- P0-A（S2-6 志愿者准入 · 身份核验基础）：独立身份核验事实模型
--
-- 设计纪律：
-- - 身份状态真相 = identity_verifications 最新有效记录（单一事实来源 / SINGLE SOURCE OF TRUTH）。
-- - 不复用 users.status；不把 volunteer_profiles.cert_status 改语义为身份状态（CERT_STATUS_REPURPOSE_AS_IDENTITY_STATUS = NO）。
-- - id_card 明文永不落库：仅存 HMAC 指纹（identity_fingerprint）与脱敏展示（volunteer_profiles.id_card_mask）。
-- - NEW_QUALIFICATION_STORAGE_REQUIRED = NO：资格事实不在本阶段，本表只承载「身份核验」单一职责。

CREATE TABLE IF NOT EXISTS identity_verifications (
  id                   INTEGER PRIMARY KEY,
  public_id            TEXT NOT NULL UNIQUE,                      -- ULID
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('TENCENT','ALIYUN','OTHER','MANUAL','FAKE')),
  status               TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','MISMATCH','PROVIDER_ERROR','MANUAL_REVIEW','INVALID_INPUT')),
  identity_fingerprint TEXT NOT NULL,                            -- HMAC-SHA256(id_card, IDENTITY_HMAC_KEY)
  provider_request_id  TEXT,                                     -- 上游请求 id（可空）
  attempt_key          TEXT NOT NULL,                            -- 幂等键 = identity_fingerprint（同 user+同指纹 不重复收费）
  failure_reason_code  TEXT,                                     -- 内部枚举，绝不泄露给客户端
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER,
  verified_at          INTEGER                                   -- 仅 VERIFIED 有值
);

CREATE INDEX IF NOT EXISTS idx_iv_user ON identity_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_iv_fp ON identity_verifications(identity_fingerprint);
CREATE INDEX IF NOT EXISTS idx_iv_user_status ON identity_verifications(user_id, status);
