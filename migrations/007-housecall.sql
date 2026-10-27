-- Housecall Pro connection. Portable SQL, all IF NOT EXISTS: Postgres runs it
-- through the migration runner and local SQLite runs it at startup.
-- hcp_jobs caches the HCP jobs that tracker orders belong to (status,
-- schedule, completion, invoice), kept current by webhooks and the hourly
-- sync. It holds no payload copies; HCP stays the source of truth.
CREATE TABLE IF NOT EXISTS hcp_jobs (
  id TEXT PRIMARY KEY,
  invoice_number TEXT,
  work_status TEXT,
  scheduled_start TEXT,
  scheduled_end TEXT,
  scheduled_local_date TEXT,
  assigned_names TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  deleted_at TEXT,
  invoice_sent_at TEXT,
  invoice_paid_at TEXT,
  outstanding_balance INTEGER,
  total_amount INTEGER,
  customer_name TEXT,
  original_estimate_id TEXT,
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

-- Last sync and webhook times shown on the admin screen.
CREATE TABLE IF NOT EXISTS hcp_state (
  name TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
