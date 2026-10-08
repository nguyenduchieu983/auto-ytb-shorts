-- Keep every existing run/revision/upload. Manual requests get independent idempotency keys.
ALTER TABLE daily_runs ADD COLUMN IF NOT EXISTS request_key text;
UPDATE daily_runs SET request_key = 'daily:' || run_date WHERE request_key IS NULL;
ALTER TABLE daily_runs ALTER COLUMN request_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daily_runs_request_key_idx ON daily_runs(request_key);
ALTER TABLE daily_runs DROP CONSTRAINT IF EXISTS daily_runs_run_date_key;
CREATE INDEX IF NOT EXISTS daily_runs_date_created_idx ON daily_runs(run_date,created_at);
