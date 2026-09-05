-- 0006 activity_occurrences (S2-NEW-ARCH-P2-0006)
-- 活动场次表：Activity(招募主体) → Occurrence(场次)。
-- 仅负责 CREATE TABLE + CREATE INDEX；历史数据回填由 scripts/backfill_0006_occurrences.mjs 完成。
-- public_id 为 Crockford ULID，由应用层（src/utils/crypto.ts::generateUlid）生成；
-- 本 SQL 不生成、也无 DEFAULT、绝不写入伪 ULID。
-- 风格与 0001_initial_schema.sql 保持一致（INTEGER PRIMARY KEY / DEFAULT (unixepoch()) / ON DELETE RESTRICT / CHECK）。

CREATE TABLE IF NOT EXISTS activity_occurrences (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,                  -- ULID（应用层生成，无 SQL DEFAULT）
  activity_id  INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  start_time   INTEGER NOT NULL,                      -- epoch 秒（场次服务开始）
  end_time     INTEGER NOT NULL,                      -- epoch 秒（场次服务结束）
  status       INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1, 2, 3, 4)),  -- 1 scheduled / 2 in_progress / 3 completed / 4 cancelled
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER,
  CHECK (start_time < end_time)
);

-- 冻结的最小索引（不再增加 status 单列 / team_id / 其他组合索引）
CREATE INDEX IF NOT EXISTS idx_occ_activity_start ON activity_occurrences(activity_id, start_time);
CREATE INDEX IF NOT EXISTS idx_occ_start ON activity_occurrences(start_time);
