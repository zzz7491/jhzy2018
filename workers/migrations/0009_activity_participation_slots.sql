CREATE TABLE IF NOT EXISTS activity_participation_slots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT NOT NULL UNIQUE,
  occurrence_id INTEGER NOT NULL,
  name          TEXT NOT NULL,
  start_time    INTEGER NOT NULL,
  end_time      INTEGER NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  deleted_at    INTEGER,
  FOREIGN KEY (occurrence_id) REFERENCES activity_occurrences (id) ON DELETE RESTRICT,
  CHECK (start_time < end_time),
  CHECK (capacity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_aps_occurrence ON activity_participation_slots(occurrence_id, start_time);
