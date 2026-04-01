-- Add custom_summary_hour + custom_summary_day to salesperson_slack_map
-- NULL hour = no extra summary. When set, an additional summary fires at that ET hour.
-- custom_summary_day controls whether the extra summary covers "today" or "tomorrow".
ALTER TABLE salesperson_slack_map
  ADD COLUMN IF NOT EXISTS custom_summary_hour smallint DEFAULT NULL
  CHECK (custom_summary_hour IS NULL OR (custom_summary_hour >= 0 AND custom_summary_hour <= 23));

ALTER TABLE salesperson_slack_map
  ADD COLUMN IF NOT EXISTS custom_summary_day text DEFAULT 'tomorrow'
  CHECK (custom_summary_day IN ('today', 'tomorrow'));

-- Add summary_type to salesperson_summary_sent so custom + default don't block each other
ALTER TABLE salesperson_summary_sent
  ADD COLUMN IF NOT EXISTS summary_type text NOT NULL DEFAULT 'default';

-- Replace the old unique constraint with one that includes summary_type
ALTER TABLE salesperson_summary_sent
  DROP CONSTRAINT IF EXISTS salesperson_summary_sent_salesperson_name_summary_date_key;

ALTER TABLE salesperson_summary_sent
  ADD CONSTRAINT salesperson_summary_sent_name_date_type_key
  UNIQUE (salesperson_name, summary_date, summary_type);
