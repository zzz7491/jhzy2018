-- 0005_attendance_time_policy.sql
-- S2-6k1 V1 —— Attendance Time Foundation（最小 Time Policy schema delta）
--
-- 设计基线（用户 S2-6k1-P0 / S2-6k1-P0.5 冻结）：
--   1) activities.max_session_minutes  —— 活动级「单次最大服务时长」（活动特异性，NULL = 无冻结规则，
--      未来 overlong detector 必须 SKIP；不使用平台默认/team 默认/硬编码默认）。
--   2) attendance_sessions.business_service_date —— 业务自然日（Asia/Shanghai YYYY-MM-DD），
--      来源 = checkin_at；与旧 service_date（UTC epoch-day bucket）并存，旧字段语义不动。
--   3) 历史数据回填：仅用 SQLite/D1 原生 strftime 做 MIGRATION BACKFILL。
--
-- 严禁在 0005 加入：allow_cross_midnight / detector_key / anomaly UNIQUE / partial UNIQUE /
-- Cron scanner index / business_service_date index / anomaly index / rule_version /
-- device / location / risk 字段（遵循 NO QUERY → NO INDEX）。
--
-- ⚠️ MIGRATION BACKFILL ONLY 说明：
--   下方 strftime(..., '+8 hours') 仅用于「一次性历史数据回填」。
--   原因：现代中国志愿服务历史数据全部处于 UTC+8、无 DST 时期，与 runtime IANA 'Asia/Shanghai' 等价。
--   runtime 时间逻辑【绝对禁止】复制此 +8h 手工数学，必须使用 Intl.DateTimeFormat（见 src/utils/time.ts）。

-- A. activities：活动级单次最大服务时长（分钟）。NULL 合法（= 该活动未冻结时长规则）。
ALTER TABLE activities
  ADD COLUMN max_session_minutes INTEGER
  CHECK (max_session_minutes IS NULL OR max_session_minutes > 0);

-- B. attendance_sessions：业务自然日（Asia/Shanghai YYYY-MM-DD）。来源 = checkin_at。
ALTER TABLE attendance_sessions
  ADD COLUMN business_service_date TEXT;

-- C. 历史回填（MIGRATION BACKFILL ONLY，非 runtime）。
--    仅对已有 checkin_at 的历史会话回填；checkin_at IS NULL 的行保持 NULL。
UPDATE attendance_sessions
  SET business_service_date = strftime('%Y-%m-%d', checkin_at, 'unixepoch', '+8 hours')
  WHERE checkin_at IS NOT NULL;
