-- Job progress on each supplier order, replacing the Google Sheet's Received /
-- Shop Location / Job Scheduled / Job Complete / Billed columns. Scheduled,
-- complete and invoiced describe the job, so the app writes them to every
-- order on the same job; shop_location is where this order's material sits.
-- Portable SQL: Postgres runs it through the migration runner, local SQLite
-- adds the same columns at startup. Never edit after deploy; add a new file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_location TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS job_scheduled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS schedule_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS job_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoiced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_reference TEXT;
