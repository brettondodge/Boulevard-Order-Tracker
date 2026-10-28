-- Invoicing on each supplier order: an unpaid invoice sent to the customer,
-- and the job paid in full. A completed, paid order shows under Archived for
-- 7 days, then is deleted. With Housecall Pro connected these come from the
-- HCP job: its outstanding balance and its invoices (the hcp_jobs columns).
-- Portable SQL; local SQLite adds the same columns at startup. Never edit
-- after deploy; add a new file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoiced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoiced_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_date TEXT;
ALTER TABLE hcp_jobs ADD COLUMN IF NOT EXISTS outstanding_balance INTEGER;
ALTER TABLE hcp_jobs ADD COLUMN IF NOT EXISTS invoice_sent_at TEXT;
ALTER TABLE hcp_jobs ADD COLUMN IF NOT EXISTS invoice_paid_at TEXT;
