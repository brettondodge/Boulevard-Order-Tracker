-- Freeport billing records. Portable SQL: Postgres runs it through the migration
-- runner; local SQLite runs it at startup (every statement is IF NOT EXISTS).
-- Money is stored in integer cents; quantities as canonical decimal text.
-- Items with custom_description take their spreadsheet description from each
-- invoice line (e.g. a windshield part number) instead of the item list.
-- omega_snapshot keeps what Omega said at the last import (JSON), so a later
-- import only overwrites fields Omega itself changed.

CREATE TABLE IF NOT EXISTS freeport_settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS freeport_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area_group TEXT NOT NULL,
  using_area_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS freeport_items (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  item_type TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  custom_description INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS freeport_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  omega_date TEXT,
  install_date TEXT,
  month_override TEXT,
  billing_month TEXT NOT NULL,
  order_number TEXT,
  account_code TEXT,
  omega_tax_cents INTEGER,
  drive_link TEXT,
  notes TEXT,
  omega_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'Needs review',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS freeport_invoices_billing_month ON freeport_invoices (billing_month);

CREATE TABLE IF NOT EXISTS freeport_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES freeport_invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  item_id TEXT,
  description TEXT,
  quantity TEXT NOT NULL,
  rate_cents INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS freeport_invoice_lines_invoice ON freeport_invoice_lines (invoice_id);
