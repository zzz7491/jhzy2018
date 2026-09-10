-- =============================================================================
-- P36-C1 — 0029：嘉禾 AI V1 基础层（schema foundation）
--
-- 仅两处 schema 变化（最小）：
--   (A) ai_conversations 收口重建：
--       + public_id TEXT NOT NULL        （ULID，应用层 generateUlid() 生成；本 SQL 不生成）
--       + updated_at INTEGER             （可空：最后活跃时间，用于历史排序）
--       + title TEXT                     （可空：会话标题，服务端由首条用户消息截断生成）
--       并重建全部既有索引 + 新增历史查询索引 (user_id, updated_at)。
--   (B) ai_usage_logs 仅追加索引 (user_id, created_at)（用于未来 best-effort 频率统计）。
--
-- 重建安全前提（已由事实取证，非假定）：
--   - 全仓库（src / scripts / tests / miniprogram）【无任何】写入 ai_conversations 的代码；
--   - 无任何表以 FK 引用 ai_conversations / ai_usage_logs；
--   - 本地 dev D1 实测：ai_conversations rows=0、ai_usage_logs rows=0。
--   故重建等价于空表迁移；如下列表 INSERT … SELECT 遇到任意 public_id 为 NULL 的历史行，
--   将因 NOT NULL 约束失败 → 迁移中止（ROLLBACK），绝不静默生成伪 ULID / 假值（沿用 0025 纪律）。
--
-- 明确【不】变更：
--   - capability CHECK（仍为 6 枚举：volunteer_assist / growth / learning / policy /
--     activity_copy / analytics）
--   - status CHECK（仍为 1,2,3；数值语义冻结，不得无证据修改）
--       · 证据：docs/migrations/0001_initial_schema/up.sql:1141 与
--               docs/security/sql/schema.sql:1152 —— ai_conversations.status COMMENT
--               '1=成功 2=失败 3=被限流'（既有定义，本迁移不改动）
--   - ai_usage_logs.status CHECK (1,2,3)（既有 DDL 无 COMMENT → 语义未定义，本迁移不定义）
--   - 其余全部既有列 / FK / 默认值 / 数据
--
-- 明确【不】新增：provider table / model table / prompt table / message table /
--   knowledge table / vector table / quota table。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- (A) ai_conversations 收口重建
-- -----------------------------------------------------------------------------

-- 步骤 1：先以可空列形式加入 public_id（本 SQL 不生成 ULID；仅为其后 SELECT 能引用该列）。
ALTER TABLE ai_conversations ADD COLUMN public_id TEXT;

-- 步骤 2：重建表，public_id 收口为 NOT NULL，并新增 updated_at / title。
CREATE TABLE IF NOT EXISTS ai_conversations_new (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  public_id     TEXT NOT NULL,                              -- ULID（应用层生成；本 SQL 不生成）
  capability    TEXT NOT NULL CHECK (capability IN ('volunteer_assist','growth','learning','policy','activity_copy','analytics')),
  provider      TEXT,
  model         TEXT,
  messages      TEXT,                                       -- JSON（脱敏）
  tool_calls    TEXT,                                       -- JSON
  title         TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);

-- 若任何历史行 public_id 为 NULL，下列 INSERT 触发 NOT NULL 约束失败 → 迁移中止（不生成假值）。
INSERT INTO ai_conversations_new
  (id, user_id, team_id, public_id, capability, provider, model, messages, tool_calls, title,
   prompt_tokens, completion_tokens, latency_ms, status, created_at, updated_at)
SELECT
  id, user_id, team_id, public_id, capability, provider, model, messages, tool_calls, NULL,
  prompt_tokens, completion_tokens, latency_ms, status, created_at, NULL
FROM ai_conversations;

DROP TABLE ai_conversations;
ALTER TABLE ai_conversations_new RENAME TO ai_conversations;

-- 步骤 3：重建既有索引（DROP TABLE 已一并移除），并新增历史查询索引 + 唯一索引。
CREATE INDEX IF NOT EXISTS idx_aic_user ON ai_conversations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aic_team ON ai_conversations(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aic_cap ON ai_conversations(capability, created_at);
-- 历史会话列表排序（newest first）
CREATE INDEX IF NOT EXISTS idx_aic_user_updated ON ai_conversations(user_id, updated_at);
-- public_id 唯一（等价 public_id TEXT NOT NULL UNIQUE）
CREATE UNIQUE INDEX IF NOT EXISTS idx_aic_public_id ON ai_conversations(public_id);

-- -----------------------------------------------------------------------------
-- (B) ai_usage_logs：仅追加索引（无表重建、无列变更）
--     用途：未来 best-effort 频率统计（COUNT by user_id within window）。
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_aul_user_created ON ai_usage_logs(user_id, created_at);
