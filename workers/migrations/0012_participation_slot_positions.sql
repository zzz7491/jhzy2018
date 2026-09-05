-- 0012 participation_slot_positions (S2-NEW-ARCH-P9-0012)
-- Slot × OccurrencePosition 配置关系：某一具体参与时段（activity_participation_slots 行）
-- 中，开放哪些场次岗位（occurrence_positions 行），以及该时段岗位的计划需求人数。
-- 仅负责 CREATE TABLE + 两个显式索引；不插入任何历史数据（关联初始为空，并非每个 Slot 都开放全部 Position）。
-- 语义边界（冻结）：
--   required_count = 该 Slot 该 OccurrencePosition 的运营计划目标人数（软目标）：
--     0  = 未指定该 Slot × Position 的计划需求人数
--     >0 = 计划需求人数
--     不是硬最大容量，不限制未来 Participation 超过该值（实际人数由未来 Participation 派生）。
--   权威层级：未存在有效 Slot × Position 配置时，缺口/排班以 occurrence_positions.required_count
--   （0011，occurrence-level baseline）为准；一旦该 occurrence_position 存在有效 0012 配置，
--   时段岗位缺口/排班/AI「哪个时段哪个岗位缺人」/细粒度需求展示均以本表 required_count 为权威粒度。
--   二者均为软计划值，不建立 SUM(0012.required_count) = 0011.required_count 数据库约束。
--   与 activity_participation_slots.capacity（整时段参与硬上限）语义不同，不建立任何数学 DB 约束。
--   不含 occurrence_id / position_id / activity_id / team_id：
--     slot_id → activity_participation_slots → activity_occurrences（派生 occurrence/activity/team）；
--     occurrence_position_id → occurrence_positions（派生 occurrence/position）。
--   跨 occurrence 一致性 DB 不保证：slot.occurrence_id 与 occurrence_position.occurrence_id 是否同属一个
--   Activity 由未来 Service 层校验，DB 不保证（CROSS-OCCURRENCE DB ALLOW = EXPECTED）。
--   不含 service_point_id / occurrence_service_point_id（地点保持独立，禁止 Slot×Position×ServicePoint 三维组合）。
--   不含 qualification / training / certificate / skill requirement（未来独立 requirement relation）。
--   不含 user_id / signup_id / participation_id / assigned_count / filled_count / actual_count（属 Participation 事实层）。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；
--   本 SQL 不生成、也无 DEFAULT、绝不写入伪 ULID。
-- deleted_at = 该 Slot × Position 配置生命周期已废弃（软删）。
--   软删后重新启用：插入一条新关联记录（新生命周期），不清空旧行 deleted_at 复活旧生命周期。
-- 风格与 0006–0011 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT / partial UNIQUE）。

CREATE TABLE IF NOT EXISTS participation_slot_positions (
  id                       INTEGER PRIMARY KEY,
  public_id                TEXT NOT NULL UNIQUE,                  -- ULID（应用层生成，无 SQL DEFAULT）
  slot_id                  INTEGER NOT NULL REFERENCES activity_participation_slots(id) ON DELETE RESTRICT,
  occurrence_position_id   INTEGER NOT NULL REFERENCES occurrence_positions(id) ON DELETE RESTRICT,
  required_count           INTEGER NOT NULL DEFAULT 0 CHECK (required_count >= 0),
                           -- 0=未指定计划需求人数；>0=计划目标人数（软目标，非硬容量）
  sort_order               INTEGER NOT NULL DEFAULT 0,            -- 同一 Slot 下岗位展示/排班顺序 override
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER,                               -- 可空：更新时间
  deleted_at               INTEGER                                -- 可空：该配置生命周期已废弃
);

-- 冻结的最小索引：
-- 1) partial UNIQUE：同一 Slot 下同一 occurrence_position 只能存在一条活跃配置；
--    软删行不占唯一槽，允许软删后创建新生命周期记录。
-- 2) 反查索引：某 OccurrencePosition 被哪些 Slot 使用。
-- public_id 的 UNIQUE 约束已自带唯一索引，覆盖「按 public_id 获取」查询，不重复建索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_psp_slot_pos_unique
  ON participation_slot_positions(slot_id, occurrence_position_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_psp_occurrence_position
  ON participation_slot_positions(occurrence_position_id);
