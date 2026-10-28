-- The tracker step (deposit_needed, need_to_order, waiting, received) whose
-- Pipeline column the tracker last moved this HCP job to, so each job moves
-- once per step and never backward. Local SQLite adds the same column at
-- startup. Never edit after deploy; add a new file.
ALTER TABLE hcp_jobs ADD COLUMN IF NOT EXISTS pipeline_step TEXT;
