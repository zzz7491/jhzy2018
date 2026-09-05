-- 0011 occurrence_positions (S2-NEW-ARCH-P7-0011)
-- Occurrence 级「岗位启用关联」：某一场（activity_occurrences）启用某个 Activity 级岗位（activity_positions），
-- 并保存该场次层面的岗位配置（required_count / sort_order）。
-- 仅负责 CREATE TABLE + 两个显式索引；不插入任何历史数据（关联初始为空，Activity catalog ≠ 每场启用集合）。
-- 语义边界（冻结）：
--   required_count = 该场次该岗位的运营计划目标人数（软目标）：
--     0  = 未指定岗位目标需求人数
--     >0 = 计划需求人数
--     不是硬最大容量，不限制实际 Participation 超过该值（未来由 Participation 派生实际人数）。
--   与 activities.quota（整体活动报名硬上限）、activity_participation_slots.capacity（单时段参与硬上限）
--   三者语义互不相同；本表与二者之间不建立任何 SUM / <= / >= 数学约束。
--   不含 slot_id / time_slot_id：同一岗位在不同 Slot 的更细粒度人数留待未来 Slot × Position 关系设计。
--   不含 qualification / certificate / training / skill requirement：未来独立 requirement relation 再设计。
--   不含 team_id / activity_id：team 经 occurrence → activity 派生；occurrence 与 position 是否同属一个
--   Activity 由未来 Service 层校验（occurrence.activity_id === position.activity_id），DB 不保证。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；
--   本 SQL 不生成、也无 DEFAULT、绝不写入伪 ULID。
-- deleted_at = 该 Occurrence × Position 启用生命周期已废弃（软删）。
--   软删后重新启用：插入一条新关联记录（新生命周期），不清空旧行 deleted_at 复活旧生命周期。
-- 风格与 0006–0010 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT / partial UNIQUE）。

CREATE TABLE IF NOT EXISTS occurrence_positions (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,                  -- ULID（应用层生成，无 SQL DEFAULT）
  occurrence_id  INTEGER NOT NULL REFERENCES activity_occurrences(id) ON DELETE RESTRICT,
  position_id    INTEGER NOT NULL REFERENCES activity_positions(id) ON DELETE RESTRICT,
  required_count INTEGER NOT NULL DEFAULT 0 CHECK (required_count >= 0),
                 -- 0=未指定计划需求人数；>0=计划目标人数（软目标，非硬容量）
  sort_order     INTEGER NOT NULL DEFAULT 0,            -- 该 Occurrence 下岗位展示/管理顺序 override
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER,                               -- 可空：更新时间
  deleted_at     INTEGER                                -- 可空：该启用生命周期已废弃
);

-- 冻结的最小索引：
-- 1) partial UNIQUE：同一 occurrence + position 只能存在一条活跃关联；
--    软删行不占唯一槽，允许软删后创建新生命周期记录。
-- 2) 反查索引：某 Position 被哪些 Occurrence 使用。
-- public_id 的 UNIQUE 约束已自带唯一索引，覆盖「按 public_id 获取」查询，不重复建索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_opo_occ_pos_unique
  ON occurrence_positions(occurrence_id, position_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_opo_position
  ON occurrence_positions(position_id);
