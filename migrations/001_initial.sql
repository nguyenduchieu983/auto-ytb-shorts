CREATE TABLE IF NOT EXISTS daily_runs (
  id text PRIMARY KEY,
  run_date text NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'PENDING',
  mock boolean NOT NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pipeline_steps (
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  step text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  input_hash text,
  output jsonb,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, revision, step)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  step text NOT NULL,
  path text NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS news_items (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  canonical_url text NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  actor text NOT NULL,
  decision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision, decision)
);
CREATE TABLE IF NOT EXISTS upload_attempts (
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  status text NOT NULL,
  session_uri text,
  youtube_video_id text,
  response jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, revision)
);
CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  step text NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision, step)
);
CREATE TABLE IF NOT EXISTS pipeline_logs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  step text NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_costs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES daily_runs(id),
  revision integer NOT NULL,
  operation text NOT NULL,
  model text NOT NULL,
  reserved_usd numeric NOT NULL,
  input_tokens integer,
  output_tokens integer,
  provider_usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id bigint PRIMARY KEY,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (delivered_at, created_at);
CREATE INDEX IF NOT EXISTS news_runs_idx ON news_items (run_id);
