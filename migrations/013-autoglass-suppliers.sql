-- Autoglass Scanning: Receiving is split into a PLK list and a PGW list
-- (supplier 'plk' or 'pgw'). Scans from before the split are on the PLK list.
-- Portable SQL; local SQLite adds the same column at startup. Never edit after
-- deploy; add a new file.
ALTER TABLE autoglass_scans ADD COLUMN IF NOT EXISTS supplier TEXT NOT NULL DEFAULT 'plk';
