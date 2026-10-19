CREATE TABLE IF NOT EXISTS reels_settings (
  id integer PRIMARY KEY CHECK (id=1),
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reels_batches (
  id text PRIMARY KEY,
  run_date text NOT NULL,
  origin text NOT NULL,
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reels_jobs (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES reels_batches(id),
  sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  step text NOT NULL DEFAULT 'content',
  attempts integer NOT NULL DEFAULT 0,
  content jsonb,
  output jsonb,
  usage jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,sequence)
);
CREATE TABLE IF NOT EXISTS reels_logs (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES reels_jobs(id),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reels_jobs_status ON reels_jobs(status,created_at);
