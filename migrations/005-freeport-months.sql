-- Month-end packages sent to Freeport. Portable SQL, all IF NOT EXISTS: Postgres
-- runs it through the migration runner and local SQLite runs it at startup.
-- A month with no row is open. 'Sent' locks the month's invoices; 'Correcting'
-- reopens it for the next revision (R1, R2...). Every sent package is kept with
-- an exact copy of its three files (base64), so what Freeport received can
-- always be downloaded again.

CREATE TABLE IF NOT EXISTS freeport_months (
  month TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  correction_reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS freeport_month_sends (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  revision INTEGER NOT NULL,
  package_number TEXT NOT NULL,
  reason TEXT,
  invoice_numbers TEXT NOT NULL,
  totals TEXT NOT NULL,
  consolidated_pdf TEXT NOT NULL,
  invoices_pdf TEXT NOT NULL,
  spreadsheet TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  UNIQUE (month, revision)
);
