-- pipeline_runs: tracks each execution of every automated pipeline
-- Used by the /api/health dashboard to show actual run status
-- (instead of inferring from output data which can be misleading when
-- a pipeline runs successfully but has nothing to process)

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pipeline    text    NOT NULL,  -- e.g. 'flight-sync', 'job-parse', 'edct-pull'
  status      text    NOT NULL DEFAULT 'ok',  -- 'ok' | 'error'
  message     text,              -- optional summary, e.g. "parsed 3 applications"
  items       int     DEFAULT 0, -- number of items processed
  duration_ms int,               -- wall-clock ms
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for the health dashboard query: latest run per pipeline
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_created
  ON pipeline_runs (pipeline, created_at DESC);

-- Auto-prune: keep only last 7 days of runs
-- (run as a scheduled pg_cron job or manual cleanup)
COMMENT ON TABLE pipeline_runs IS 'Tracks automated pipeline executions for health monitoring. Prune rows older than 7 days periodically.';

-- RLS: service role only (backend services use service_role_key)
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON pipeline_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
