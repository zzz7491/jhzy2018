-- 0019_service_record_audits_fk_repair.sql
-- 修复 service_record_audits.service_record_id 的悬空 FK（0004 rename 遗留缺陷）。
--   0004 将 service_records RENAME TO service_records_old 时，SQLite 连带改写了本表 FK 引用，
--   随后旧表被 DROP，导致本表 FK 悬空指向不存在的 service_records_old。
--   本迁移仅修此一处：service_record_id → service_records(id) ON DELETE RESTRICT。
--   不动 0004，不动 points/permission/其它历史 schema；其余 FK / 列 / 默认值 / 索引原样保留。
--
-- 固定重建顺序（不可调换、不可省略）：
--   RENAME service_record_audits → service_record_audits_old
--   → CREATE 新表（显式 12 列）
--   → INSERT…SELECT 显式 12 列迁数据
--   → DROP service_record_audits_old
--   → 重建同名索引
--
-- Failure-safe 原则（重要，不可违反）：
--   若迁移在 RENAME 之后、DROP 之前异常中断，service_record_audits_old 是
--   唯一完整的历史数据载体。此时再次执行本迁移：service_record_audits 已不存在，
--   开头 ALTER TABLE RENAME 会直接失败（或 _old 已存在导致后续步骤报错），
--   即"重跑必须 FAIL / BLOCK"。严禁在 RENAME 前以任何语句（DROP / 判重清理）
--   自动删除 _old —— 那会抹掉中断场景下唯一可恢复的数据。
--   本迁移不做幂等重建，不声称"可安全重跑"。

ALTER TABLE service_record_audits
  RENAME TO service_record_audits_old;

-- 2) 重建（显式写全 12 列，保留真实约束；不新增 UNIQUE / CHECK / 字段）
CREATE TABLE service_record_audits (
  id                        INTEGER PRIMARY KEY,
  service_record_id         INTEGER NOT NULL REFERENCES service_records(id) ON DELETE RESTRICT,
  team_id                   INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  old_minutes               INTEGER NOT NULL,
  new_minutes               INTEGER NOT NULL,
  reason                    TEXT NOT NULL,
  operator_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trace_id                  TEXT,
  created_at                INTEGER NOT NULL DEFAULT (unixepoch()),
  old_points_awarded_units  INTEGER NOT NULL DEFAULT 0,
  new_points_awarded_units  INTEGER NOT NULL DEFAULT 0
);

-- 3) 迁数据（显式 12 列，禁止 SELECT *）
INSERT INTO service_record_audits
  (id, service_record_id, team_id, old_minutes, new_minutes,
   reason, operator_id, approved_by, trace_id, created_at,
   old_points_awarded_units, new_points_awarded_units)
SELECT
  id, service_record_id, team_id, old_minutes, new_minutes,
  reason, operator_id, approved_by, trace_id, created_at,
  old_points_awarded_units, new_points_awarded_units
FROM service_record_audits_old;

-- 4) 删除旧表
DROP TABLE service_record_audits_old;

-- 5) 重建同名索引（old 表 drop 后索引随之消失，需重建）
CREATE INDEX IF NOT EXISTS idx_sra_record ON service_record_audits(service_record_id);
CREATE INDEX IF NOT EXISTS idx_sra_team   ON service_record_audits(team_id, created_at);
