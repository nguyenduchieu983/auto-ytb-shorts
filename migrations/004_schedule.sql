CREATE TABLE IF NOT EXISTS video_schedule (
  id integer PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS video_schedule_batches (
  run_date text PRIMARY KEY,
  settings jsonb NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS video_schedule_runs (
  run_id text PRIMARY KEY REFERENCES daily_runs(id),
  run_date text NOT NULL REFERENCES video_schedule_batches(run_date),
  sequence integer NOT NULL,
  auto_publish boolean NOT NULL DEFAULT false,
  UNIQUE (run_date, sequence)
);
