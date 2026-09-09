-- =============================================================================
-- P33-P3B-2A — 0025：content_comments.public_id 最终收口为 NOT NULL UNIQUE
--
-- 前提（由 rollout 顺序强制）：0024 已执行，且 scripts/backfill_p33_comments.mjs
--   已为全部 NULL public_id 赋值，并经 scripts/verify_p33_comments.mjs 验收通过。
--
-- 若仍有任意 public_id 为 NULL 未回填：
--   下列 INSERT … SELECT 会因目标列 public_id NOT NULL 约束失败 → 迁移中止（ROLLBACK），
--   绝不静默生成伪 ULID / 假值。
--
-- 仅 schema 变化：
--   public_id TEXT NOT NULL   （列级 NOT NULL）
--   + 命名唯一索引 idx_comment_public_id（UNIQUE）—— 等价于 public_id TEXT NOT NULL UNIQUE
-- 保留全部原字段 / CHECK / FK / 默认值：
--   id, target_type, target_id, user_id, team_id, content, status, audit_status,
--   created_at, updated_at
--
-- 不增加：author_id / deleted_at / 其它 V1 外字段。
-- 不修改：status / audit_status 数值含义、其它列。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content_comments_new (
  id            INTEGER PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('article','activity','comment')),
  target_id     INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  public_id     TEXT NOT NULL,                              -- ULID（应用层生成；本 SQL 不生成）
  content       TEXT NOT NULL,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  audit_status  INTEGER NOT NULL DEFAULT 1 CHECK (audit_status IN (1,2,3)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);

-- 若任何 public_id 为 NULL，下列 INSERT 触发 NOT NULL 约束失败 → 迁移中止（不生成假值）。
INSERT INTO content_comments_new
  (id, target_type, target_id, user_id, team_id, public_id, content, status, audit_status, created_at, updated_at)
SELECT
  id, target_type, target_id, user_id, team_id, public_id, content, status, audit_status, created_at, updated_at
FROM content_comments;

DROP TABLE content_comments;
ALTER TABLE content_comments_new RENAME TO content_comments;

CREATE INDEX IF NOT EXISTS idx_cc_target ON content_comments(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_user    ON content_comments(user_id, created_at);
-- 最终唯一约束（等价 public_id TEXT NOT NULL UNIQUE）
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_public_id ON content_comments(public_id);
