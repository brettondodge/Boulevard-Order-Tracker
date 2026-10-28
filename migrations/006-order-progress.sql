-- Job progress on each supplier order: where its material sits in the shop,
-- whether the job is scheduled (and when) and whether it is complete. Each
-- order keeps its own values. With Housecall Pro connected, scheduled and
-- complete come from HCP.
-- Portable SQL: Postgres runs it through the migration runner, local SQLite
-- adds the same columns at startup. Never edit after deploy; add a new file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_location TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS job_scheduled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS schedule_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS job_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_date TEXT;
