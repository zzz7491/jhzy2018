-- =============================================================================
-- P33-P3B-2A — 0024：社区内容 schema 收口（Stage 1）
--
-- 仅两处 schema 变化：
--   (A) content_articles.content_type CHECK 增加 'post'
--       （安全 rebuild：保留全部字段 / 默认值 / CHECK / FK / 现有数据 / 4 个索引）
--   (B) content_comments 新增 public_id TEXT（Stage 1：可空）
--       并建 UNIQUE index idx_comment_public_id
--       （SQLite UNIQUE 允许多个 NULL；此阶段 != NOT NULL UNIQUE）
--
-- 冻结状态枚举（不得更改数值含义）：
--   content_articles.status       1=DRAFT 2=PUBLISHED 3=UNPUBLISHED 4=DELETED
--   content_articles.audit_status 0=NOT_SUBMITTED 1=PENDING 2=APPROVED 3=REJECTED 4=EXEMPT
--   content_comments.status       1/2/3（独立于 article）
--   content_comments.audit_status 1/2/3（独立于 article）
--
-- 禁止：使用 ulid() SQL 函数（不存在）；不得改 status / audit_status 数值含义；
--       不得新增 author_id / deleted_at 等 V1 外字段。
--
-- 后续 0025 将 public_id 升级为 NOT NULL UNIQUE（须先由
--   scripts/backfill_p33_comments.mjs 为全部 NULL 赋值，并经 verify 验收）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- (A) content_articles：content_type 增加 'post'（rebuild 保留全部现有定义）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_articles_new (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,                      -- ULID（应用层生成，无 SQL DEFAULT）
  content_type   TEXT NOT NULL CHECK (content_type IN ('announcement','story','policy','knowledge','platform','post')),
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  category_id    INTEGER REFERENCES content_categories(id) ON DELETE SET NULL,
  activity_id    INTEGER REFERENCES activities(id) ON DELETE SET NULL,
  author_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  cover_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  summary        TEXT,
  content        TEXT,
  anonymous      INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status         INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  audit_status   INTEGER NOT NULL DEFAULT 0 CHECK (audit_status IN (0,1,2,3,4)),
  audit_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  audit_at       INTEGER,
  audit_reason   TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  sort           INTEGER NOT NULL DEFAULT 0,
  view_count     INTEGER NOT NULL DEFAULT 0,
  like_count     INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  report_count   INTEGER NOT NULL DEFAULT 0,
  effective_at   INTEGER,
  expire_at      INTEGER,
  published_at   INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER,
  deleted_at     INTEGER DEFAULT NULL
);

INSERT INTO content_articles_new SELECT * FROM content_articles;
DROP TABLE content_articles;
ALTER TABLE content_articles_new RENAME TO content_articles;

-- 恢复 4 个 article 索引（rebuild 过程中随旧表一并移除，必须重建）
CREATE INDEX IF NOT EXISTS idx_ca_team   ON content_articles(team_id, content_type, audit_status, status);
CREATE INDEX IF NOT EXISTS idx_ca_pub    ON content_articles(content_type, status, published_at);
CREATE INDEX IF NOT EXISTS idx_ca_act    ON content_articles(activity_id);
CREATE INDEX IF NOT EXISTS idx_ca_author ON content_articles(author_id, created_at);

-- -----------------------------------------------------------------------------
-- (B) content_comments：新增 public_id（Stage 1：可空 + 唯一索引）
-- -----------------------------------------------------------------------------
ALTER TABLE content_comments ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_public_id ON content_comments(public_id);
-- 注意：SQLite UNIQUE 允许多个 NULL；此阶段 public_id 仍可空。
-- 不得声称“nullable + unique”已等价于 NOT NULL UNIQUE；NOT NULL 收口在 0025 完成。
