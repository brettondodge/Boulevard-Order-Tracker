-- Equipment and serial numbers from Omega's custom fields, kept on each invoice
-- for the invoice screen and merged PDF (not the Freeport spreadsheet).
-- Postgres only; local SQLite adds the columns at startup in src/freeport/store.js.
ALTER TABLE freeport_invoices ADD COLUMN IF NOT EXISTS equipment_number TEXT;
ALTER TABLE freeport_invoices ADD COLUMN IF NOT EXISTS serial_number TEXT;
