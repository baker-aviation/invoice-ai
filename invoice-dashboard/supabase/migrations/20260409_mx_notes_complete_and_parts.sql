-- Add completed_at for MX completion workflow (#14)
-- Add parts_tools_needed for tracking parts/tools movement (#19)
-- Add mx_keywords for keyword search (#11)

ALTER TABLE ops_alerts
  ADD COLUMN IF NOT EXISTS completed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS completed_by text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS parts_tools_needed boolean DEFAULT false;

-- Keyword tracking table for MX notes search (#11)
CREATE TABLE IF NOT EXISTS mx_keywords (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  keyword text NOT NULL UNIQUE,
  usage_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast keyword lookup
CREATE INDEX IF NOT EXISTS idx_mx_keywords_keyword ON mx_keywords (keyword);
-- Index for fast completed status filtering
CREATE INDEX IF NOT EXISTS idx_ops_alerts_completed ON ops_alerts (completed_at) WHERE completed_at IS NOT NULL;
