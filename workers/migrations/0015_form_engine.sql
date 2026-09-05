-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0015：Generic Dynamic Form Engine（P20 REV2）
-- =============================================================================
-- 状态：P20 实现（S2-NEW-ARCH-P20）
-- 范围：
--   form_definitions         —— 表单模板（TEAM_SCOPED，真实 team_id）
--   form_definition_versions —— 冻结版本（DERIVED_TEAM → form_definitions；无 team_id）
--   form_bindings            —— definition ↔ consumer 绑定（TEAM_SCOPED，真实 team_id）
--   form_submissions         —— 提交（DERIVED_TEAM → form_definitions；无 team_id）
-- 约定：INTEGER PK；public_id = Crockford ULID UNIQUE；INTEGER epoch；TEXT JSON；FK 启用；
--       published_version_id 与含版本引用为 circular FK，采用「versions 先建 + ALTER ADD COLUMN
--       REFERENCES」安全补齐；PRAGMA defer_foreign_keys 延后校验到事务末。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1) form_definitions（先建，暂不含 circular 的 published_version_id 列，
--    该列在 3) 中以 ALTER ADD COLUMN ... REFERENCES 补齐）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_definitions (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  description TEXT,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)), -- 1 draft / 2 published / 3 archived
  allow_repeat INTEGER NOT NULL DEFAULT 0,                         -- definition 级当前策略（metadata，非 version snapshot）
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_form_def_team ON form_definitions(team_id, status);

-- ---------------------------------------------------------------------------
-- 2) form_definition_versions（DERIVED_TEAM → form_definitions；无 team_id 列）
--    schema_json 一经 published（published_at 非空）即不可变（service 强约束）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_definition_versions (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  definition_id INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE RESTRICT,
  version_no    INTEGER NOT NULL,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)), -- 1 draft / 2 published / 3 archived
  schema_json   TEXT NOT NULL DEFAULT '{"fields":[]}',
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at  INTEGER,
  UNIQUE (definition_id, version_no)
);
-- 每个 definition 至多一个 draft / 至多一个 published
CREATE UNIQUE INDEX IF NOT EXISTS uq_def_draft ON form_definition_versions(definition_id) WHERE status = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_def_published ON form_definition_versions(definition_id) WHERE status = 2;
CREATE INDEX IF NOT EXISTS idx_ver_def ON form_definition_versions(definition_id, status);

-- ---------------------------------------------------------------------------
-- 3) 补齐 circular FK：form_definitions.published_version_id → form_definition_versions
-- ---------------------------------------------------------------------------
-- SQLite：ALTER TABLE ADD COLUMN 允许带 REFERENCES（新列默认 NULL）。
-- 保持不变式 `published_version_id IS NOT NULL ⇔ status=published` 于 service/repository 层。
ALTER TABLE form_definitions ADD COLUMN published_version_id INTEGER REFERENCES form_definition_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4) form_bindings（TEAM_SCOPED，真实 team_id；definition↔consumer）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_bindings (
  id                 INTEGER PRIMARY KEY,
  public_id          TEXT NOT NULL UNIQUE,
  team_id            INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  definition_id      INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE RESTRICT,
  consumer_type      TEXT NOT NULL,          -- 已注册 resolver：'activity.signup'（P20）
  consumer_public_id TEXT,                   -- target 业务行 public_id；NULL = team 级默认模板
  is_default         INTEGER NOT NULL DEFAULT 0,
  status             INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)), -- 1 active / 2 archived
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER,
  CHECK (NOT (is_default = 1 AND consumer_public_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_binding_entity ON form_bindings(team_id, consumer_type, consumer_public_id)
  WHERE status = 1 AND consumer_public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_binding_default ON form_bindings(team_id, consumer_type)
  WHERE status = 1 AND is_default = 1;
CREATE INDEX IF NOT EXISTS idx_bind_lookup ON form_bindings(team_id, consumer_type, status);

-- ---------------------------------------------------------------------------
-- 5) form_submissions（DERIVED_TEAM → form_definitions；无 team_id 列）
--    重复守卫（allow_repeat / grain）由原子 INSERT…SELECT 谓词承担，故不设 grain UNIQUE。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_submissions (
  id                INTEGER PRIMARY KEY,
  public_id         TEXT NOT NULL UNIQUE,
  definition_id     INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE RESTRICT,
  version_id        INTEGER NOT NULL REFERENCES form_definition_versions(id) ON DELETE RESTRICT,
  submitter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  consumer_type     TEXT NOT NULL,
  consumer_public_id TEXT,
  consumer_key      TEXT NOT NULL,           -- consumer_type || ':' || COALESCE(consumer_public_id,'')
  answers_json      TEXT NOT NULL DEFAULT '{}',
  status            INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)), -- 1 draft / 2 submitted / 3 withdrawn / 4 invalidated
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER,
  submitted_at      INTEGER
);
-- 每 (definition, submitter, consumer) 至多一个 draft
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_draft ON form_submissions(definition_id, submitter_user_id, consumer_key)
  WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_sub_user ON form_submissions(submitter_user_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_version ON form_submissions(version_id);
CREATE INDEX IF NOT EXISTS idx_sub_def ON form_submissions(definition_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_defkey ON form_submissions(definition_id, submitter_user_id, consumer_key);