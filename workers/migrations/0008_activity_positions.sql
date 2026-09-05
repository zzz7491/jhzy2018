-- 0008 activity_positions (S2-NEW-ARCH-P4-0008)
-- Activity 级「岗位 / 职责目录」：秩序维护岗 / 游客引导岗 / 后勤保障岗 等。
-- 仅负责 CREATE TABLE + 一个显式业务索引；不插入任何历史数据（目录初始为空）。
-- 语义边界（冻结）：
--   本表只回答「某个 Activity 有哪些岗位 / 职责项」以及「岗位的稳定职责说明」。
--   同一 Activity 下可存在同名岗位（无 UNIQUE(activity_id,name)），但 public_id 唯一。
--   不负责某场（Occurrence）是否启用该岗位 —— 那由未来独立的 occurrence_positions 表决定。
--   不负责名额 / 配额 / 技能要求 / 证书要求 / 签到 / 考勤 / participation / slot / position workflow / AI 字段。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；
--   本 SQL 不生成、也无 DEFAULT、绝不写入伪 ULID。
-- deleted_at 仅表示「该目录项的逻辑删除/废弃时间」，不是「本场停用」字段；
--   某场不用该岗位 ≠ 设置 deleted_at（由 occurrence_positions 表达）。
-- 风格与 0001_initial_schema.sql / 0006 / 0007 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT）。

CREATE TABLE IF NOT EXISTS activity_positions (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,                  -- ULID（应用层生成，无 SQL DEFAULT）
  activity_id  INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,                         -- 短名：秩序维护岗
  description  TEXT,                                  -- 岗位稳定职责说明（可为空）
  sort_order   INTEGER NOT NULL DEFAULT 0,            -- 配置界面多岗位排序
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,                               -- 可空：更新时间
  deleted_at   INTEGER                                -- 可空：逻辑删除/废弃时间（非「本场停用」）
);

-- 冻结的最小索引：仅一个显式业务索引。
-- public_id 的 UNIQUE 约束已自带唯一索引，覆盖「按 public_id 获取」查询，不重复建索引。
CREATE INDEX IF NOT EXISTS idx_apo_activity ON activity_positions(activity_id);
