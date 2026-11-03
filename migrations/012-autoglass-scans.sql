-- Autoglass Scanning: one row per scanned part. need / to_return are the
-- Need and Return boxes (one or neither). Clear list stamps cleared_at; the
-- current list is the rows without it. Portable SQL, all IF NOT EXISTS:
-- Postgres runs it through the migration runner and local SQLite runs it at
-- startup. Never edit after deploy; add a new file.
CREATE TABLE IF NOT EXISTS autoglass_scans (
  id TEXT PRIMARY KEY,
  part_number TEXT NOT NULL,
  need INTEGER NOT NULL DEFAULT 0,
  to_return INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  scanned_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  cleared_at TEXT
);

CREATE INDEX IF NOT EXISTS autoglass_scans_current ON autoglass_scans (cleared_at, scanned_at);
