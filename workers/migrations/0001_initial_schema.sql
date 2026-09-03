-- =============================================================================
-- 嘉禾志愿 2.0 —— D1 Migration 0001：核心业务 Schema（S2-3 草案）
-- =============================================================================
-- 状态：本地 migration 草案，**未执行**、未建 D1、未运行 wrangler。
-- 范围：全部非 RBAC 表（users / teams / sessions(NEW) / 身份 / 活动与服务 /
--       学习考试证书 / 积分成长 / 内容 / 文件消息审计安全）+ 延后表结构。
-- 约定：INTEGER PK；public_id ULID（实体表）；INTEGER epoch 时间；TEXT+CHECK 枚举；
--       TEXT JSON；FK 启用；team_id 按 scope 分类（无 DEFAULT 0 哨兵）。
-- 幂等：全部 IF NOT EXISTS。PRAGMA defer_foreign_keys 延后 FK 校验到事务末。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 身份与账号域
-- -----------------------------------------------------------------------------

-- users：账号主体（PLATFORM_GLOBAL，无 team_id）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,                      -- ULID
  nickname      TEXT,
  avatar_file_id INTEGER,                                    -- 松散引用 files(id)，无 FK（打破 users↔files↔teams 环）
  cert_level    INTEGER NOT NULL DEFAULT 1 CHECK (cert_level IN (0,1,2)),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER DEFAULT NULL
);

-- teams：租户根（PLATFORM_GLOBAL，无 team_id）
CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,                      -- ULID
  name          TEXT NOT NULL,
  short_name    TEXT,
  logo_file_id  INTEGER,                                      -- 松散引用 files(id)，无 FK（打破环）
  intro         TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cert_status   INTEGER NOT NULL DEFAULT 0 CHECK (cert_status IN (0,1,2,3)),
  cert_reject_reason TEXT,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  settings      TEXT,                                      -- JSON
  is_system     INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_teams_cert ON teams(cert_status, status);

-- sessions（NEW）：Worker 鉴权会话（USER_SCOPED，跨团队；租户上下文由请求态决定，不存 team_id）
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,                        -- ULID（会话令牌载体）
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                        -- 单向哈希，不存明文
  ip_hash     TEXT,
  user_agent  TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2))  -- 1有效 2失效
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- user_identities（USER_SCOPED）
CREATE TABLE IF NOT EXISTS user_identities (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_type TEXT NOT NULL CHECK (identity_type IN ('wechat_openid','wechat_unionid','phone','username')),
  identity_hash TEXT NOT NULL,                             -- HMAC-SHA256 摘要
  active_marker INTEGER DEFAULT NULL CHECK (active_marker IS NULL OR active_marker = 1),  -- 1=生效；NULL=已撤销（哨兵列）
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  bound_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at    INTEGER DEFAULT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (identity_type, identity_hash, active_marker)
);
CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_identity_hash ON user_identities(identity_hash);

-- user_profiles（USER_SCOPED，user_id 即 PK）
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gender       INTEGER NOT NULL DEFAULT 0 CHECK (gender IN (0,1,2)),
  birthday     TEXT,                                       -- 'YYYY-MM-DD'
  region_code  TEXT,
  bio          TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER
);

-- volunteer_profiles（USER_SCOPED，高敏；user_id 即 PK）
CREATE TABLE IF NOT EXISTS volunteer_profiles (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  real_name_enc       TEXT,                               -- AES-256 密文
  id_card_hash        TEXT,                               -- HMAC-SHA256
  id_card_mask        TEXT,                               -- 脱敏展示
  phone_enc           TEXT,
  phone_mask          TEXT,
  emergency_contact_enc TEXT,
  cert_status         INTEGER NOT NULL DEFAULT 0 CHECK (cert_status IN (0,1,2,3)),
  cert_reject_reason  TEXT,
  cert_audited_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cert_audited_at     INTEGER,
  total_minutes       INTEGER NOT NULL DEFAULT 0,
  total_times         INTEGER NOT NULL DEFAULT 0,
  growth_value        INTEGER NOT NULL DEFAULT 0,
  level_id            INTEGER REFERENCES volunteer_levels(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vp_level ON volunteer_profiles(level_id);
CREATE INDEX IF NOT EXISTS idx_vp_cert ON volunteer_profiles(cert_status);

-- user_preferences（USER_SCOPED，user_id 即 PK）
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_mode TEXT NOT NULL DEFAULT 'normal' CHECK (display_mode IN ('normal','senior')),
  font_scale   REAL NOT NULL DEFAULT 1.0,
  notify_settings TEXT,                                   -- JSON
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER
);

-- -----------------------------------------------------------------------------
-- 团队域（TEAM_SCOPED）
-- -----------------------------------------------------------------------------

-- activity_categories（PLATFORM_GLOBAL 引用数据）
CREATE TABLE IF NOT EXISTS activity_categories (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES activity_categories(id) ON DELETE SET NULL,
  name      TEXT NOT NULL,
  icon_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  sort      INTEGER NOT NULL DEFAULT 0,
  status    INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2))
);
CREATE INDEX IF NOT EXISTS idx_ac_parent ON activity_categories(parent_id, status);

-- team_members（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS team_members (
  id           INTEGER PRIMARY KEY,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_role_code TEXT NOT NULL DEFAULT 'member' CHECK (team_role_code IN ('owner','admin','auditor','member')),
  join_status  INTEGER NOT NULL DEFAULT 1 CHECK (join_status IN (1,2,3,4,5)),
  joined_at    INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tm_user ON team_members(user_id, join_status);

-- team_invites（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS team_invites (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at  INTEGER NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 100,
  used_count  INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ti_team ON team_invites(team_id);

-- -----------------------------------------------------------------------------
-- 活动与服务域（TEAM_SCOPED）
-- -----------------------------------------------------------------------------

-- activities（TEAM_SCOPED；平台活动归 platform_root 系统团队）
CREATE TABLE IF NOT EXISTS activities (
  id               INTEGER PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,                  -- ULID
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  category_id      INTEGER REFERENCES activity_categories(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  cover_file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
  summary          TEXT,
  detail           TEXT,
  start_time       INTEGER NOT NULL,
  end_time         INTEGER NOT NULL,
  signup_deadline  INTEGER,
  province         TEXT,
  city             TEXT,
  district         TEXT,
  address          TEXT,
  latitude         REAL,
  longitude        REAL,
  geo_radius       INTEGER NOT NULL DEFAULT 200,
  quota            INTEGER NOT NULL DEFAULT 0,
  signed_count     INTEGER NOT NULL DEFAULT 0,
  need_audit       INTEGER NOT NULL DEFAULT 0 CHECK (need_audit IN (0,1)),
  allow_cancel     INTEGER NOT NULL DEFAULT 1 CHECK (allow_cancel IN (0,1)),
  checkin_config   TEXT,                                   -- JSON
  risk_config      TEXT,                                   -- JSON
  duration_config  TEXT,                                   -- JSON
  points_config    TEXT,                                   -- JSON
  cert_config      TEXT,                                   -- JSON
  status           INTEGER NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 7),
  publish_audit_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at     INTEGER,
  created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER,
  deleted_at       INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_team ON activities(team_id, status, start_time);
CREATE INDEX IF NOT EXISTS idx_act_category ON activities(category_id);
CREATE INDEX IF NOT EXISTS idx_act_time ON activities(start_time, end_time);

-- activity_signups（TEAM_SCOPED 逻辑；team_id 由 activity_id 派生，不冗余存储）
CREATE TABLE IF NOT EXISTS activity_signups (
  id           INTEGER PRIMARY KEY,
  activity_id  INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  form_data    TEXT,                                       -- JSON（敏感项加密）
  review_status INTEGER NOT NULL DEFAULT 0 CHECK (review_status IN (0,1,2)),
  review_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_at    INTEGER,
  review_reason TEXT,
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  cancel_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,
  UNIQUE (user_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_signup_act ON activity_signups(activity_id, review_status, status);

-- attendance_sessions（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id            INTEGER PRIMARY KEY,
  signup_id     INTEGER NOT NULL REFERENCES activity_signups(id) ON DELETE RESTRICT,
  activity_id   INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  checkin_at    INTEGER,
  checkout_at   INTEGER,
  status        INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2,3,4)),
  checkin_risk  INTEGER,
  checkout_risk INTEGER,
  device_changed INTEGER NOT NULL DEFAULT 0 CHECK (device_changed IN (0,1)),
  effective_minutes INTEGER,
  review_status INTEGER NOT NULL DEFAULT 0 CHECK (review_status IN (0,1,2)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (signup_id)
);
CREATE INDEX IF NOT EXISTS idx_as_act ON attendance_sessions(activity_id, status);
CREATE INDEX IF NOT EXISTS idx_as_user ON attendance_sessions(user_id, checkin_at);
CREATE INDEX IF NOT EXISTS idx_as_review ON attendance_sessions(review_status, updated_at);

-- attendance_events（TEAM_SCOPED，append-only 原始证据）
CREATE TABLE IF NOT EXISTS attendance_events (
  id             INTEGER PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  activity_id    INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  event_type     TEXT NOT NULL CHECK (event_type IN ('checkin','checkout','heartbeat','force_checkout','anomaly','correction','manual')),
  qr_time_slot   INTEGER,
  latitude       REAL,
  longitude      REAL,
  accuracy       REAL,
  distance       INTEGER,
  device_fp_hash TEXT,
  network_type   TEXT CHECK (network_type IS NULL OR network_type IN ('wifi','4g','5g','unknown')),
  ip_hash        TEXT,
  factor_scores  TEXT,                                     -- JSON
  risk_score     INTEGER CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  disposition    TEXT CHECK (disposition IS NULL OR disposition IN ('pass','verify','review','reject')),
  verify_method  TEXT,
  nonce          TEXT UNIQUE,                              -- 幂等
  operator_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT,
  raw            TEXT,                                      -- JSON
  occurred_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ae_session ON attendance_events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_ae_act ON attendance_events(activity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_user ON attendance_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_device ON attendance_events(device_fp_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_risk ON attendance_events(risk_score, occurred_at);

-- attendance_devices（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS attendance_devices (
  id            INTEGER PRIMARY KEY,
  fp_hash       TEXT NOT NULL UNIQUE,
  user_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  risk_flag     INTEGER NOT NULL DEFAULT 0 CHECK (risk_flag IN (0,1,2))
);
CREATE INDEX IF NOT EXISTS idx_ad_risk ON attendance_devices(risk_flag, last_seen_at);

-- attendance_anomalies（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS attendance_anomalies (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  anomaly_type TEXT NOT NULL CHECK (anomaly_type IN ('out_of_range','device_switch','multi_account','replay','cross_day','overlong','reverse_time')),
  detail       TEXT,                                       -- JSON
  handled_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at   INTEGER,
  resolution   TEXT,
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aa_status ON attendance_anomalies(status, created_at);
CREATE INDEX IF NOT EXISTS idx_aa_session ON attendance_anomalies(session_id);

-- service_records（TEAM_SCOPED，权威时长）
CREATE TABLE IF NOT EXISTS service_records (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  activity_id   INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  minutes       INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual','correction')),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  review_status INTEGER NOT NULL DEFAULT 0 CHECK (review_status IN (0,1,2)),
  service_date  INTEGER NOT NULL,                          -- epoch（date 粒度）
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (session_id)
);
CREATE INDEX IF NOT EXISTS idx_sr_user ON service_records(user_id, service_date);
CREATE INDEX IF NOT EXISTS idx_sr_team ON service_records(team_id, service_date);
CREATE INDEX IF NOT EXISTS idx_sr_act ON service_records(activity_id);

-- service_record_audits（TEAM_SCOPED，append-only）
CREATE TABLE IF NOT EXISTS service_record_audits (
  id                INTEGER PRIMARY KEY,
  service_record_id INTEGER NOT NULL REFERENCES service_records(id) ON DELETE RESTRICT,
  team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  old_minutes       INTEGER NOT NULL,
  new_minutes       INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  operator_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trace_id          TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sra_record ON service_record_audits(service_record_id);
CREATE INDEX IF NOT EXISTS idx_sra_team ON service_record_audits(team_id, created_at);

-- -----------------------------------------------------------------------------
-- 学习 / 考试 / 证书域
-- -----------------------------------------------------------------------------

-- courses（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,                     -- ULID
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  category_id    INTEGER REFERENCES activity_categories(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  cover_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  summary        TEXT,
  detail         TEXT,
  required       INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  required_minutes INTEGER NOT NULL DEFAULT 0,
  sort           INTEGER NOT NULL DEFAULT 0,
  status         INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER,
  deleted_at     INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_course_team ON courses(team_id, status, sort);

-- course_lessons（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS course_lessons (
  id           INTEGER PRIMARY KEY,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  lesson_type  TEXT NOT NULL DEFAULT 'article' CHECK (lesson_type IN ('video','article','audio')),
  content      TEXT,
  media_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  duration_min INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0,
  is_free      INTEGER NOT NULL DEFAULT 0 CHECK (is_free IN (0,1)),
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cl_course ON course_lessons(course_id, sort);

-- course_enrollments（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS course_enrollments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  progress     INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  learned_minutes INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  completed_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,
  UNIQUE (user_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_ce_course ON course_enrollments(course_id, status);

-- learning_records（USER_SCOPED，无 team_id）
CREATE TABLE IF NOT EXISTS learning_records (
  id            INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES course_enrollments(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lesson_id     INTEGER NOT NULL REFERENCES course_lessons(id) ON DELETE RESTRICT,
  progress      INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  learned_minutes INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (enrollment_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lr_user ON learning_records(user_id, updated_at);

-- exam_questions（PLATFORM_GLOBAL 题库）
CREATE TABLE IF NOT EXISTS exam_questions (
  id            INTEGER PRIMARY KEY,
  question_type TEXT NOT NULL DEFAULT 'single' CHECK (question_type IN ('single','multiple','judge')),
  stem          TEXT NOT NULL,
  options       TEXT NOT NULL,                            -- JSON [{key,text}]
  answer        TEXT NOT NULL,
  analysis      TEXT,
  difficulty    INTEGER NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 5),
  tags          TEXT,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_eq_type ON exam_questions(question_type, difficulty);
CREATE INDEX IF NOT EXISTS idx_eq_status ON exam_questions(status);

-- exam_papers（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS exam_papers (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,                      -- ULID
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  course_id     INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  pick_rule     TEXT NOT NULL,                            -- JSON
  total_score   INTEGER NOT NULL DEFAULT 100,
  pass_score    INTEGER NOT NULL DEFAULT 60,
  duration_min  INTEGER NOT NULL DEFAULT 60,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_ep_team ON exam_papers(team_id, status);

-- exam_sessions（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS exam_sessions (
  id            INTEGER PRIMARY KEY,
  paper_id      INTEGER NOT NULL REFERENCES exam_papers(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  attempt_no    INTEGER NOT NULL DEFAULT 1,
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  submitted_at  INTEGER,
  score         REAL,
  passed        INTEGER CHECK (passed IS NULL OR passed IN (0,1)),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  blur_count    INTEGER NOT NULL DEFAULT 0,
  snapshot      TEXT,                                      -- JSON
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_es_user ON exam_sessions(user_id, paper_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_es_team ON exam_sessions(team_id, submitted_at);

-- exam_answers（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS exam_answers (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  session_id  INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES exam_questions(id) ON DELETE RESTRICT,
  user_answer TEXT,
  is_correct  INTEGER CHECK (is_correct IS NULL OR is_correct IN (0,1)),
  score       REAL,
  answered_at INTEGER,
  UNIQUE (session_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_ea_question ON exam_answers(question_id, is_correct);

-- certificate_templates（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS certificate_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  cert_type   TEXT NOT NULL CHECK (cert_type IN ('training','activity','honor')),
  layout      TEXT NOT NULL,                               -- JSON
  bg_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER,
  deleted_at  INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_ct_type ON certificate_templates(cert_type, status);

-- certificates（TEAM_SCOPED；平台证书归 platform_root 团队）
CREATE TABLE IF NOT EXISTS certificates (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,                      -- ULID
  cert_no       TEXT NOT NULL UNIQUE,
  verify_code   TEXT NOT NULL UNIQUE,
  template_id   INTEGER NOT NULL REFERENCES certificate_templates(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  cert_type     TEXT NOT NULL CHECK (cert_type IN ('training','activity','honor')),
  source_type   TEXT CHECK (source_type IS NULL OR source_type IN ('course','exam','activity','manual')),
  source_id     INTEGER,
  holder_name   TEXT,
  issuer_name   TEXT,
  snapshot      TEXT,                                       -- JSON
  file_id       INTEGER REFERENCES files(id) ON DELETE SET NULL,
  issued_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(user_id, cert_type);
CREATE INDEX IF NOT EXISTS idx_cert_team ON certificates(team_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_cert_source ON certificates(source_type, source_id);

-- certificate_logs（TEAM_SCOPED，append-only）
CREATE TABLE IF NOT EXISTS certificate_logs (
  id            INTEGER PRIMARY KEY,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('issue','revoke','reissue','regenerate')),
  reason        TEXT,
  operator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_cl_cert ON certificate_logs(certificate_id);

-- id_pools（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS id_pools (
  id          INTEGER PRIMARY KEY,
  pool_type   TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','volunteer')),
  code        TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
  assigned_to INTEGER,
  assigned_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (pool_type, code)
);
CREATE INDEX IF NOT EXISTS idx_ip_status ON id_pools(pool_type, status);

-- -----------------------------------------------------------------------------
-- 积分与成长域
-- -----------------------------------------------------------------------------

-- points_ledger（USER_SCOPED，append-only，无 team_id；团队归属经 source 引用）
CREATE TABLE IF NOT EXISTS points_ledger (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction     INTEGER NOT NULL CHECK (direction IN (1,2)),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('activity','training','exam','exchange','manual','reward')),
  source_type   TEXT,
  source_id     INTEGER,
  request_id    TEXT NOT NULL UNIQUE,                       -- 幂等键
  remark        TEXT,
  operator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pl_user ON points_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pl_source ON points_ledger(source_type, source_id);

-- points_accounts（USER_SCOPED，user_id 即 PK，无 team_id）
CREATE TABLE IF NOT EXISTS points_accounts (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance       INTEGER NOT NULL DEFAULT 0,
  total_earned  INTEGER NOT NULL DEFAULT 0,
  total_spent   INTEGER NOT NULL DEFAULT 0,
  last_ledger_id INTEGER,
  last_checked_at INTEGER,
  updated_at    INTEGER
);

-- growth_rules（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS growth_rules (
  id          INTEGER PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('service_minute','service_times','continuous','training','exam','contribution')),
  name        TEXT NOT NULL,
  value       INTEGER NOT NULL,
  calc_mode   TEXT NOT NULL DEFAULT 'fixed' CHECK (calc_mode IN ('fixed','per_unit','formula')),
  params      TEXT,                                        -- JSON
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gr_action ON growth_rules(action_type, enabled);

-- growth_records（USER_SCOPED，append-only，无 team_id）
CREATE TABLE IF NOT EXISTS growth_records (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rule_id     INTEGER REFERENCES growth_rules(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  value       INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  source_type TEXT,
  source_id   INTEGER,
  request_id  TEXT NOT NULL UNIQUE,                         -- 幂等键
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_gr_user ON growth_records(user_id, created_at);

-- volunteer_levels（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS volunteer_levels (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,                       -- ULID
  level_no     INTEGER NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  icon_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  min_growth   INTEGER NOT NULL DEFAULT 0,
  min_minutes  INTEGER NOT NULL DEFAULT 0,
  min_times    INTEGER NOT NULL DEFAULT 0,
  benefits     TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER
);

-- level_change_logs（AUDIT_ONLY，team_id NULL）
CREATE TABLE IF NOT EXISTS level_change_logs (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_level   INTEGER,
  to_level     INTEGER NOT NULL,
  change_type  TEXT NOT NULL CHECK (change_type IN ('upgrade','downgrade')),
  growth_snapshot INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_lcl_user ON level_change_logs(user_id, created_at);

-- honors（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS honors (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,                         -- ULID
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  description TEXT,
  icon_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_honor_team ON honors(team_id);

-- badges（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS badges (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,                         -- ULID
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  icon_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  condition_json TEXT,                                      -- JSON
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (team_id, code)
);
CREATE INDEX IF NOT EXISTS idx_badge_team ON badges(team_id);

-- user_badges（USER_SCOPED，team_id 可 NULL）
CREATE TABLE IF NOT EXISTS user_badges (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE RESTRICT,
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  granted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  source_type TEXT,
  source_id   INTEGER,
  UNIQUE (user_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_ub_team ON user_badges(team_id);

-- -----------------------------------------------------------------------------
-- 积分商城（DEFER：非 2.0 MVP 核心；表结构保留）
-- -----------------------------------------------------------------------------

-- mall_products（TEAM_SCOPED，DEFER）
CREATE TABLE IF NOT EXISTS mall_products (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,                      -- ULID
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  cover_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  detail        TEXT,
  points_price  INTEGER NOT NULL,
  stock         INTEGER NOT NULL DEFAULT 0,
  sold_count    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_mp_team ON mall_products(team_id, status, sort);

-- mall_orders（TEAM_SCOPED，DEFER）
CREATE TABLE IF NOT EXISTS mall_orders (
  id            INTEGER PRIMARY KEY,
  order_no      TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  product_id    INTEGER NOT NULL REFERENCES mall_products(id) ON DELETE RESTRICT,
  product_title TEXT NOT NULL,
  points        INTEGER NOT NULL,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  verify_code   TEXT NOT NULL UNIQUE,
  verified_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mo_user ON mall_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mo_team ON mall_orders(team_id, status);

-- -----------------------------------------------------------------------------
-- 内容域（TEAM_SCOPED 为主）
-- -----------------------------------------------------------------------------

-- content_categories（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS content_categories (
  id          INTEGER PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('announcement','story','policy','knowledge','platform')),
  parent_id   INTEGER REFERENCES content_categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2))
);
CREATE INDEX IF NOT EXISTS idx_cc_type ON content_categories(content_type, status, sort);

-- content_articles（TEAM_SCOPED；平台内容归 platform_root 团队）
CREATE TABLE IF NOT EXISTS content_articles (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,                      -- ULID
  content_type   TEXT NOT NULL CHECK (content_type IN ('announcement','story','policy','knowledge','platform')),
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
CREATE INDEX IF NOT EXISTS idx_ca_team ON content_articles(team_id, content_type, audit_status, status);
CREATE INDEX IF NOT EXISTS idx_ca_pub ON content_articles(content_type, status, published_at);
CREATE INDEX IF NOT EXISTS idx_ca_act ON content_articles(activity_id);
CREATE INDEX IF NOT EXISTS idx_ca_author ON content_articles(author_id, created_at);

-- content_comments（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS content_comments (
  id          INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('article','activity','comment')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  content     TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  audit_status INTEGER NOT NULL DEFAULT 1 CHECK (audit_status IN (1,2,3)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cc_target ON content_comments(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_user ON content_comments(user_id, created_at);

-- content_likes（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS content_likes (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('article','activity','comment')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (target_type, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_target ON content_likes(target_type, target_id);

-- content_reports（TEAM_SCOPED，多态举报）
CREATE TABLE IF NOT EXISTS content_reports (
  id            INTEGER PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('article','comment','activity','team','user')),
  target_id     INTEGER NOT NULL,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  reporter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason_type   TEXT NOT NULL CHECK (reason_type IN ('illegal','ad','infringe','fake','abuse','other')),
  description   TEXT,
  evidence      TEXT,                                       -- JSON
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  handler_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution    TEXT,
  handled_at    INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cr_status ON content_reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cr_target ON content_reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_cr_team ON content_reports(team_id, status);
CREATE INDEX IF NOT EXISTS idx_cr_reporter ON content_reports(reporter_id, created_at);

-- content_audit_logs（TEAM_SCOPED，冗余 team_id 便于审计查询）
CREATE TABLE IF NOT EXISTS content_audit_logs (
  id           INTEGER PRIMARY KEY,
  target_type  TEXT NOT NULL CHECK (target_type IN ('article','comment','activity','team','user')),
  target_id    INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('submit','approve','reject','publish','unpublish','delete','restore')),
  from_status  TEXT,
  to_status    TEXT,
  reason       TEXT,
  operator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  ip_hash      TEXT,
  trace_id     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_cal_target ON content_audit_logs(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cal_operator ON content_audit_logs(operator_id, created_at);

-- content_attachments（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS content_attachments (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('article','comment','activity','team','user')),
  target_id   INTEGER NOT NULL,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  title       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  source_note TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ca_target ON content_attachments(target_type, target_id);

-- -----------------------------------------------------------------------------
-- 文件 / 消息 / 审计 / 安全域
-- -----------------------------------------------------------------------------

-- files（TEAM_SCOPED，R2 元数据）
CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,                      -- ULID
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  uploader_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  original_name  TEXT,
  object_key     TEXT NOT NULL,                             -- R2 key
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  checksum       TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','team','private')),
  exif_stripped  INTEGER NOT NULL DEFAULT 0 CHECK (exif_stripped IN (0,1)),
  scan_status    INTEGER NOT NULL DEFAULT 0 CHECK (scan_status IN (0,1,2)),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at     INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_team ON files(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_file_uploader ON files(uploader_id);

-- notifications（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  notif_type  TEXT NOT NULL CHECK (notif_type IN ('signup','audit','activity','cert','points','system','content')),
  title       TEXT NOT NULL,
  content     TEXT,
  target_type TEXT,
  target_id   INTEGER,
  is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  read_at     INTEGER,
  channel     TEXT NOT NULL DEFAULT 'inapp' CHECK (channel IN ('inapp','wechat_subscribe','sms')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_team ON notifications(team_id, created_at);

-- message_templates（PLATFORM_GLOBAL）
CREATE TABLE IF NOT EXISTS message_templates (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('inapp','wechat_subscribe','sms')),
  wx_template_id TEXT,
  title         TEXT,
  content_tpl   TEXT NOT NULL,
  variables     TEXT,                                       -- JSON
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (code, channel)
);

-- operation_logs（AUDIT_ONLY，team_id NULL）
CREATE TABLE IF NOT EXISTS operation_logs (
  id            INTEGER PRIMARY KEY,
  operator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  operator_role TEXT,
  team_id       INTEGER DEFAULT NULL,
  module        TEXT NOT NULL CHECK (module IN ('activity','user','points','service','content','system','team','rbac')),
  action        TEXT NOT NULL CHECK (action IN ('create','update','delete','approve','adjust','login','export')),
  target_type   TEXT,
  target_id     INTEGER,
  before_json   TEXT,                                        -- JSON（敏感脱敏）
  after_json    TEXT,                                        -- JSON（敏感脱敏）
  risk_level    INTEGER NOT NULL DEFAULT 1 CHECK (risk_level IN (1,2,3)),
  ip_hash       TEXT,
  user_agent    TEXT,
  trace_id      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ol_operator ON operation_logs(operator_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ol_target ON operation_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ol_module ON operation_logs(module, action, created_at);
CREATE INDEX IF NOT EXISTS idx_ol_risk ON operation_logs(risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_ol_team ON operation_logs(team_id, created_at);

-- security_events（AUDIT_ONLY，team_id NULL）
CREATE TABLE IF NOT EXISTS security_events (
  id            INTEGER PRIMARY KEY,
  event_type    TEXT NOT NULL CHECK (event_type IN ('unauthorized','abnormal_login','risk_checkin','replay','multi_account','permission_abnormal','api_abnormal','ai_abuse')),
  severity      INTEGER NOT NULL DEFAULT 2 CHECK (severity BETWEEN 1 AND 4),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id       INTEGER DEFAULT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  detail        TEXT,                                        -- JSON
  ip_hash       TEXT,
  user_agent    TEXT,
  trace_id      TEXT,
  handled       INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1,2)),
  handled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at    INTEGER,
  resolution    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_se_type ON security_events(event_type, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_se_handled ON security_events(handled, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_se_user ON security_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_team ON security_events(team_id, created_at);

-- sensitive_data_access_logs（AUDIT_ONLY，team_id NULL）
CREATE TABLE IF NOT EXISTS sensitive_data_access_logs (
  id             INTEGER PRIMARY KEY,
  operator_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id        INTEGER DEFAULT NULL,
  field_name     TEXT NOT NULL CHECK (field_name IN ('id_card','phone','real_name')),
  access_reason  TEXT NOT NULL,
  access_type    TEXT NOT NULL DEFAULT 'view' CHECK (access_type IN ('view','export','decrypt')),
  ip_hash        TEXT,
  trace_id       TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sdal_operator ON sensitive_data_access_logs(operator_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sdal_target ON sensitive_data_access_logs(target_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sdal_field ON sensitive_data_access_logs(field_name, created_at);

-- client_errors（AUDIT_ONLY，无 team_id）
CREATE TABLE IF NOT EXISTS client_errors (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app          TEXT NOT NULL CHECK (app IN ('miniprogram','admin','h5')),
  app_version  TEXT,
  page         TEXT,
  error_type   TEXT,
  message      TEXT,
  stack        TEXT,
  device_fp_hash TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ce_created ON client_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_ce_app ON client_errors(app, error_type, created_at);

-- ai_conversations（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS ai_conversations (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  capability  TEXT NOT NULL CHECK (capability IN ('volunteer_assist','growth','learning','policy','activity_copy','analytics')),
  provider    TEXT,
  model       TEXT,
  messages    TEXT,                                        -- JSON（脱敏）
  tool_calls  TEXT,                                        -- JSON
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aic_user ON ai_conversations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aic_team ON ai_conversations(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aic_cap ON ai_conversations(capability, created_at);

-- ai_usage_logs（TEAM_SCOPED）
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aul_team ON ai_usage_logs(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aul_provider ON ai_usage_logs(provider, created_at);

-- -----------------------------------------------------------------------------
-- 迁移支撑（DEFER，仅 1.0→2.0 迁移期用）
-- -----------------------------------------------------------------------------

-- legacy_id_maps（PLATFORM_GLOBAL，DEFER）
CREATE TABLE IF NOT EXISTS legacy_id_maps (
  id           INTEGER PRIMARY KEY,
  legacy_table TEXT NOT NULL,
  legacy_id    TEXT NOT NULL,
  new_table    TEXT NOT NULL,
  new_id       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (legacy_table, legacy_id, new_table)
);
CREATE INDEX IF NOT EXISTS idx_lim_new ON legacy_id_maps(new_table, new_id);

-- migration_issues（AUDIT_ONLY，DEFER）
CREATE TABLE IF NOT EXISTS migration_issues (
  id            INTEGER PRIMARY KEY,
  batch_no      TEXT,
  legacy_table  TEXT,
  legacy_id     TEXT,
  issue_type    TEXT NOT NULL CHECK (issue_type IN ('orphan','duplicate','dirty','missing','conflict')),
  description   TEXT NOT NULL,
  suggestion    TEXT,
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  handled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mi_status ON migration_issues(status, created_at);
CREATE INDEX IF NOT EXISTS idx_mi_batch ON migration_issues(batch_no, issue_type);

-- =============================================================================
-- 0001 结束。RBAC 表在 0002_rbac_structure.sql。
-- 本文件为本地草案，未执行、未建 D1、未运行 wrangler。
-- =============================================================================
