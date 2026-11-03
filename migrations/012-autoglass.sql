-- Autoglass Scanning. Portable SQL, all IF NOT EXISTS: Postgres runs it
-- through the migration runner and local SQLite runs it at startup. Never edit
-- after deploy; add a new file.

-- Receiving list: one row per scanned part. need / to_return are the Need and
-- Return boxes (one or neither). Clear list stamps cleared_at; the current
-- list is the rows without it.
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

-- Inventory: section 'stock' (kept on hand) or 'old' (leftovers to use up).
-- part_key is the part number without spaces, dashes or case; scanning the
-- same part into the same section adds to its quantity.
CREATE TABLE IF NOT EXISTS autoglass_inventory (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  part_number TEXT NOT NULL,
  part_key TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  shelf TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS autoglass_inventory_part ON autoglass_inventory (section, part_key);

-- Open Omega quotes and work orders that need an inventory part, as of the
-- last check. emailed_at is set once an old-inventory match has been emailed,
-- so each one is sent once.
CREATE TABLE IF NOT EXISTS autoglass_matches (
  item_id TEXT NOT NULL,
  job_number TEXT NOT NULL,
  job_status TEXT,
  part TEXT,
  vehicle TEXT,
  written_up TEXT,
  scheduled_date TEXT,
  found_at TEXT NOT NULL,
  emailed_at TEXT,
  PRIMARY KEY (item_id, job_number)
);

-- When the daily check last ran, and what it found.
CREATE TABLE IF NOT EXISTS autoglass_state (
  name TEXT PRIMARY KEY,
  value TEXT
);
