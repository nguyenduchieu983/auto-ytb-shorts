CREATE TABLE IF NOT EXISTS runtime_heartbeats (
  id text PRIMARY KEY,
  pid integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
