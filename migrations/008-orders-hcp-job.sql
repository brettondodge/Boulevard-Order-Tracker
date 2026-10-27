-- The Housecall Pro job an order belongs to (job_...), taken from the job
-- link, the approved job, or a job-number match. Local SQLite adds the same
-- column at startup. Never edit after deploy; add a new file.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hcp_job_id TEXT;
