-- 0014_attendance_participation_link.sql
-- S2-NEW-ARCH-P14：attendance_sessions ↔ activity_participations 显式关联。
-- 仅新增可空 participation_id 列 + 全状态查询索引 + 活跃参与 partial UNIQUE。
-- 不回填、不修改任何既有列/索引、不新增 team_id / occurrence_id / slot_id / position_id、
-- 不新增 ServiceRecord FK、不加 trigger / 时间窗口字段、不动 uq_active_attendance、不修 Attendance bug。
-- 以下 SQL 严格冻结，不得增加其他语句。

ALTER TABLE attendance_sessions
ADD COLUMN participation_id INTEGER
REFERENCES activity_participations(id)
ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_as_participation
ON attendance_sessions(participation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_participation
ON attendance_sessions(participation_id)
WHERE participation_id IS NOT NULL
AND status = 1
AND checkout_at IS NULL;
