CREATE TABLE IF NOT EXISTS occurrence_service_points (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id        TEXT NOT NULL UNIQUE,
  occurrence_id    INTEGER NOT NULL,
  service_point_id INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER,
  deleted_at       INTEGER,
  FOREIGN KEY (occurrence_id) REFERENCES activity_occurrences (id) ON DELETE RESTRICT,
  FOREIGN KEY (service_point_id) REFERENCES activity_service_points (id) ON DELETE RESTRICT
);

-- 仅约束「活跃」关联：同一 occurrence + service_point 只能有一条 deleted_at IS NULL 的行。
-- 软删后允许重新建立新关联，旧历史行保留（不通过清空 deleted_at 覆盖历史生命周期）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_osp_occ_sp_unique
  ON occurrence_service_points (occurrence_id, service_point_id)
  WHERE deleted_at IS NULL;

-- 反向查询：某 ServicePoint 被哪些 Occurrence 使用。
CREATE INDEX IF NOT EXISTS idx_osp_service_point
  ON occurrence_service_points (service_point_id);
