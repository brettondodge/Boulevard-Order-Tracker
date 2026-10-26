-- Adds the Omega snapshot column to databases that ran 002 before it existed
-- (production ran 002 with the October 22, 2026 deploy). Postgres only; local
-- SQLite adds the column at startup in src/freeport/store.js.
ALTER TABLE freeport_invoices ADD COLUMN IF NOT EXISTS omega_snapshot TEXT;
