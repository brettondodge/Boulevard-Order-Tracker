-- Warranty entries are kept with the approved jobs (job_drafts) as kind
-- 'warranty': they are never deleted automatically, need no deposit, and
-- order materials the same way. housecall_job_link / hcp_job_id is the
-- warranty job (schedule, completion and Pipeline); the original job is for
-- reference only. Line items are typed by staff. Portable SQL; local SQLite
-- adds the same columns at startup. Never edit after deploy; add a new file.
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS line_items TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS problem TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS needed TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS original_job_link TEXT;
ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS original_job_number TEXT;
