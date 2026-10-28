-- Housecall Pro connection. Portable SQL, all IF NOT EXISTS: Postgres runs it
-- through the migration runner and local SQLite runs it at startup.
-- hcp_jobs caches the HCP jobs that tracker orders point at (status,
-- schedule, completion, and the job's tags), kept current by webhooks and
-- the hourly sync. HCP stays the source of truth.
CREATE TABLE IF NOT EXISTS hcp_jobs (
  id TEXT PRIMARY KEY,
  invoice_number TEXT,
  work_status TEXT,
  scheduled_start TEXT,
  scheduled_local_date TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  deleted_at TEXT,
  tags TEXT,
  source_time TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hcp_jobs_invoice_number ON hcp_jobs (invoice_number);

-- One row per webhook delivery, so a repeated delivery is applied once.
CREATE TABLE IF NOT EXISTS hcp_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  job_id TEXT,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT
);

-- Connection state for the admin screen (last sync, last webhook, problems),
-- the HCP job type -> tracker category choices, and HCP tag ids.
CREATE TABLE IF NOT EXISTS hcp_state (
  name TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
