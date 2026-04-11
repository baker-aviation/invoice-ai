-- Phase 6: track when a Slack alert was sent for a tail missing its channel.
-- Dedup window is enforced in app code (7 days) to avoid spam.
ALTER TABLE ics_sources
  ADD COLUMN IF NOT EXISTS slack_alerted_at TIMESTAMPTZ;
