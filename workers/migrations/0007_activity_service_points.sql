-- 0007 activity_service_points (S2-NEW-ARCH-P3-0007)
-- Activity 级「可复用物理服务点目录」：南湖东门 / 游客中心 / 会景园入口 等。
-- 仅负责 CREATE TABLE + 一个显式业务索引；不插入任何历史数据（目录初始为空）。
-- 语义边界（冻结）：
--   本表只回答「某个 Activity 有哪些物理服务点」以及「点在哪里」。
--   不负责某场（Occurrence）是否启用该点 —— 那由未来独立的 occurrence_service_points 表决定。
--   不负责签到围栏半径、签到状态、credential、attendance、participation、slot、position、workflow、AI 字段。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；
--   本 SQL 不生成、也无 DEFAULT、绝不写入伪 ULID。
-- deleted_at 仅表示「该目录项的逻辑删除/废弃时间」，不是「本场停用」字段；
--   某场不用该点 ≠ 设置 deleted_at（由 occurrence_service_points 表达）。
-- 风格与 0001_initial_schema.sql / 0006 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT）。

CREATE TABLE IF NOT EXISTS activity_service_points (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,                  -- ULID（应用层生成，无 SQL DEFAULT）
  activity_id  INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,                         -- 短名：南湖东门
  address      TEXT,                                  -- 人类可读地址（可为空）：浙江省嘉兴市南湖区……
  latitude     REAL NOT NULL,                         -- 物理点本体纬度
  longitude    REAL NOT NULL,                         -- 物理点本体经度
  sort_order   INTEGER NOT NULL DEFAULT 0,            -- 配置界面多服务点排序
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,                               -- 可空：更新时间
  deleted_at   INTEGER                                -- 可空：逻辑删除/废弃时间（非「本场停用」）
);

-- 冻结的最小索引：仅一个显式业务索引。
-- public_id 的 UNIQUE 约束已自带唯一索引，覆盖「按 public_id 获取」查询，不重复建索引。
CREATE INDEX IF NOT EXISTS idx_asp_activity ON activity_service_points(activity_id);
