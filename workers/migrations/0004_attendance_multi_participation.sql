-- 0004_attendance_multi_participation.sql
-- S2-6h-R2：解除 UNIQUE(signup_id) 的 1:1 硬绑定，支持"单次报名 → 多次参加"。
-- 新增每次参加锚点 service_date(INTEGER) + slot(TEXT)；新增 partial unique index 保证"每用户单一活跃会话"。
--
-- 业务背景：火车站志愿持续一周，志愿者报名一次后可在不同日期多次参加，每次产生独立 attendance_session。
-- 原 UNIQUE(signup_id) 把"一次报名"与"一次参加"绑死，无法满足真实需求（见 S2-6h-R1 复核）。
--
-- 实现策略（重建表，外键零悬空）：
--   SQLite 不允许 DROP INDEX 删除由 UNIQUE 约束自动生成的索引，也不支持 ALTER DROP CONSTRAINT（旧版）。
--   且 attendance_events / attendance_anomalies / service_records 经外键引用本表，故采用"四表整体重建"：
--   将四张表分别 RENAME 为 _old → 以正确 FK 目标（新 attendance_sessions）重建 → 迁数据 → 删 _old。
--   所有外键最终都指向重建后的 attendance_sessions，不存在悬空引用。
--   既有的 status / review_status / checkin_risk / effective_minutes 等列语义全部保留。
--   迁移后 d1_migrations 记录本文件，幂等于重跑（IF NOT EXISTS / 先判重）。

-- 1) 重命名四张表为 _old
ALTER TABLE attendance_sessions RENAME TO attendance_sessions_old;
ALTER TABLE attendance_events RENAME TO attendance_events_old;
ALTER TABLE attendance_anomalies RENAME TO attendance_anomalies_old;
ALTER TABLE service_records RENAME TO service_records_old;

-- 2) 重建 attendance_sessions（移除 UNIQUE(signup_id)，新增 service_date + slot）
CREATE TABLE attendance_sessions (
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
  service_date  INTEGER NOT NULL DEFAULT 0,
  slot          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER
);

-- 3) 重建 attendance_events（schema 不变，FK → 新 attendance_sessions）
CREATE TABLE attendance_events (
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
  factor_scores  TEXT,
  risk_score     INTEGER CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  disposition    TEXT CHECK (disposition IS NULL OR disposition IN ('pass','verify','review','reject')),
  verify_method  TEXT,
  nonce          TEXT UNIQUE,
  operator_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT,
  raw            TEXT,
  occurred_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 4) 重建 attendance_anomalies（schema 不变，FK → 新 attendance_sessions）
CREATE TABLE attendance_anomalies (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  anomaly_type TEXT NOT NULL CHECK (anomaly_type IN ('out_of_range','device_switch','multi_account','replay','cross_day','overlong','reverse_time')),
  detail       TEXT,
  handled_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at   INTEGER,
  resolution   TEXT,
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 5) 重建 service_records（schema 不变，FK → 新 attendance_sessions）
CREATE TABLE service_records (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  activity_id   INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  minutes       INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual','correction')),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  review_status INTEGER NOT NULL DEFAULT 0 CHECK (review_status IN (0,1,2)),
  service_date  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE (session_id)
);

-- 6) 迁数据（service_date 缺省 0 兼容历史行）
INSERT INTO attendance_sessions
  (id, signup_id, activity_id, user_id, team_id, checkin_at, checkout_at,
   status, checkin_risk, checkout_risk, device_changed, effective_minutes,
   review_status, created_at, updated_at)
SELECT
   id, signup_id, activity_id, user_id, team_id, checkin_at, checkout_at,
   status, checkin_risk, checkout_risk, device_changed, effective_minutes,
   review_status, created_at, updated_at
FROM attendance_sessions_old;

INSERT INTO attendance_events
  (id, session_id, activity_id, user_id, team_id, event_type, qr_time_slot, latitude,
   longitude, accuracy, distance, device_fp_hash, network_type, ip_hash, factor_scores,
   risk_score, disposition, verify_method, nonce, operator_id, reason, raw, occurred_at, created_at)
SELECT
   id, session_id, activity_id, user_id, team_id, event_type, qr_time_slot, latitude,
   longitude, accuracy, distance, device_fp_hash, network_type, ip_hash, factor_scores,
   risk_score, disposition, verify_method, nonce, operator_id, reason, raw, occurred_at, created_at
FROM attendance_events_old;

INSERT INTO attendance_anomalies
  (id, session_id, team_id, anomaly_type, detail, handled_by, handled_at, resolution, status, created_at)
SELECT
   id, session_id, team_id, anomaly_type, detail, handled_by, handled_at, resolution, status, created_at
FROM attendance_anomalies_old;

INSERT INTO service_records
  (id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, created_at, updated_at)
SELECT
   id, session_id, user_id, team_id, activity_id, minutes, source, status, review_status, service_date, created_at, updated_at
FROM service_records_old;

-- 7) 删除旧表
DROP TABLE attendance_events_old;
DROP TABLE attendance_anomalies_old;
DROP TABLE service_records_old;
DROP TABLE attendance_sessions_old;

-- 8) 索引（attendance_sessions 含单活跃会话约束 + 参加锚点索引）
CREATE INDEX IF NOT EXISTS idx_as_act ON attendance_sessions(activity_id, status);
CREATE INDEX IF NOT EXISTS idx_as_user ON attendance_sessions(user_id, checkin_at);
CREATE INDEX IF NOT EXISTS idx_as_review ON attendance_sessions(review_status, updated_at);
-- 单活跃会话约束：同一 user_id 至多一条 status=1 且 checkout_at IS NULL 的会话。
-- 允许"已签退(session 仍存) → 再次签到"产生新行；并发双签到由本索引兜底为 409。
-- 前置条件：创建索引时 DB 中不得存在"同用户多活跃会话"，否则索引创建失败。
-- （本地 fixture 经 teardown 保证清零；生产环境应用前需先清理多活跃会话，见报告 OPEN。）
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_attendance
  ON attendance_sessions(user_id) WHERE status = 1 AND checkout_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_as_servicedate ON attendance_sessions(service_date, user_id);
-- 报名维度回溯索引：UNIQUE(signup_id) 解除后，替代其查询能力（普通非唯一索引，允许 1 次报名 → N 次参加）。
CREATE INDEX IF NOT EXISTS idx_as_signup ON attendance_sessions(signup_id);
CREATE INDEX IF NOT EXISTS idx_ae_session ON attendance_events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_ae_act ON attendance_events(activity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_user ON attendance_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_device ON attendance_events(device_fp_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ae_risk ON attendance_events(risk_score, occurred_at);
CREATE INDEX IF NOT EXISTS idx_aa_status ON attendance_anomalies(status, created_at);
CREATE INDEX IF NOT EXISTS idx_aa_session ON attendance_anomalies(session_id);
CREATE INDEX IF NOT EXISTS idx_sr_user ON service_records(user_id, service_date);
CREATE INDEX IF NOT EXISTS idx_sr_team ON service_records(team_id, service_date);
CREATE INDEX IF NOT EXISTS idx_sr_act ON service_records(activity_id);
