-- Additive module: no changes to tracker or identity tables.
CREATE TABLE IF NOT EXISTS freeport_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(kind, id)
);
CREATE TABLE IF NOT EXISTS freeport_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes_base64 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS freeport_invoice_claims (
  invoice_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS freeport_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  record_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
