-- 0013 activity_participations (S2-NEW-ARCH-P10-0013)
-- Participation = occurrence + slot 粒度（slot 可选，Position 仅为属性，不改变粒度）。
-- 代表：某个 Activity 级已批准 Signup，在某一个具体 Occurrence 中的一次实际参与/排班事实。
-- 它不是 Signup（活动级意图）、不是 Position/Slot 配置（0011/0012/0009）、不是 Attendance（签到过程）、不是 ServiceRecord（最终服务事实）。
-- 主链：User → Signup(Activity) → Participation → AttendanceSession → AttendanceEvent → ServiceRecord。
-- 语义边界（冻结，REV2）：
--   status: 1=assigned（已分配）, 2=cancelled（已取消）。最小状态机，不含 completed/no_show（由 Attendance/ServiceRecord 派生）。
--   cancelled_at: status=2 时由单条原子 UPDATE(status=2, cancelled_at=unixepoch()) 写入；status=1 时必须为 NULL。
--   不存 deleted_at：Participation 是业务事实台账，取消是状态变更而非删除，保留完整审计轨迹（历史共存）。
--   不存 participation_slot_position_id：slot_id + occurrence_position_id 直接表达；当二者同时非 NULL 时，未来 Service 必须校验
--     active participation_slot_positions(slot_id, occurrence_position_id) 存在（PSP 仅为配置来源锚，不直连 FK）。
--   不存 user_id / activity_id / team_id：由 signup / occurrence 派生，避免双源。
--   不存 service_point_id / occurrence_service_point_id：地点保持独立（禁止 Slot×Position×ServicePoint 三维组合）。
--   不存 required_count / capacity / quota / assigned_count / filled_count / actual_count：人数字段属计划/配置/派生层，Participation 只记录事实。
-- 活跃唯一性（DB 级强制，提交时生效，含并发/API retry）：
--   idx_ap_occ : 同 (signup, occurrence) 的 occurrence-level（slot_id IS NULL）至多一条 active → occurrence-only 与 occurrence+position 互斥（position 不改变粒度）。
--   idx_ap_slot: 同 (signup, occurrence, slot) 的 slot-level（slot_id NOT NULL）至多一条 active → slot-only 与 slot+position 互斥；
--               同 slot 不因不同 position 产生第二条 Participation（修复 REV1 冲突）。
-- 跨模式（occurrence-level vs slot-level）DB 不互阻，标注 CROSS-MODE DB ALLOW = EXPECTED，未来 Service 必须守卫。
-- 跨父级一致性（signup.activity_id === occurrence.activity_id；slot.occurrence_id === participation.occurrence_id；op.occurrence_id === participation.occurrence_id）
--   DB 不保证，标注 CROSS-PARENT DB ALLOW = EXPECTED，未来 Service 必须校验。
-- 初始为空表，不回填（旧 activity_signups / attendance_sessions 无法无歧义确定 occurrence/slot/position）。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；本 SQL 不生成、无 DEFAULT、绝不写伪 ULID。
-- 风格与 0006–0012 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT / partial UNIQUE 独立 CREATE UNIQUE INDEX）。

CREATE TABLE IF NOT EXISTS activity_participations (
  id                        INTEGER PRIMARY KEY,
  public_id                 TEXT NOT NULL UNIQUE,                       -- ULID（应用层生成，无 SQL DEFAULT）
  signup_id                 INTEGER NOT NULL REFERENCES activity_signups(id) ON DELETE RESTRICT,
  occurrence_id             INTEGER NOT NULL REFERENCES activity_occurrences(id) ON DELETE RESTRICT,
  slot_id                   INTEGER REFERENCES activity_participation_slots(id) ON DELETE RESTRICT,
                             -- 可空：NULL = occurrence-level Participation（无 slot）
  occurrence_position_id    INTEGER REFERENCES occurrence_positions(id) ON DELETE RESTRICT,
                             -- 可空：Position 仅为 Participation 属性，不改变 Participation 粒度
  status                    INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1, 2)),
                             -- 1=assigned, 2=cancelled
  cancelled_at              INTEGER,                                    -- 可空：status=2 时写入（原子 UPDATE）
  created_at                INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                INTEGER,                                    -- 可空：更新时间
  CHECK (
    (status = 1 AND cancelled_at IS NULL)
    OR
    (status = 2 AND cancelled_at IS NOT NULL)
  )
);

-- 冻结的最小索引（partial UNIQUE 必须用独立 CREATE UNIQUE INDEX ... WHERE，不得内联到 CREATE TABLE）：
-- 1) idx_ap_occ  : 同 (signup, occurrence) 的 occurrence-level 活跃 Participation 至多一条。
-- 2) idx_ap_slot : 同 (signup, occurrence, slot) 的 slot-level 活跃 Participation 至多一条。
-- public_id 的 UNIQUE 约束已自带唯一索引；idx_ap_occurrence / idx_ap_signup 覆盖协调员/用户视图列举。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_occ
  ON activity_participations(signup_id, occurrence_id)
  WHERE status = 1 AND slot_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_slot
  ON activity_participations(signup_id, occurrence_id, slot_id)
  WHERE status = 1 AND slot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ap_occurrence
  ON activity_participations(occurrence_id);

CREATE INDEX IF NOT EXISTS idx_ap_signup
  ON activity_participations(signup_id);
