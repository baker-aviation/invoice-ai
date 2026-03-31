-- Add custom_summary_hour to salesperson_slack_map
-- NULL = default (18 = 6pm ET), otherwise 0-23 ET hour
ALTER TABLE salesperson_slack_map
  ADD COLUMN IF NOT EXISTS custom_summary_hour smallint DEFAULT NULL
  CHECK (custom_summary_hour IS NULL OR (custom_summary_hour >= 0 AND custom_summary_hour <= 23));
