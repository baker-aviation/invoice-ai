-- Duty alerts table: tracks 10/24 flight time and rest violations.
-- Used by the duty-monitor cron job for Slack alert deduplication.

CREATE TABLE IF NOT EXISTS duty_alerts (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tail_number       text NOT NULL,
  alert_type        text NOT NULL,          -- 'flight_time' or 'rest'
  severity          text NOT NULL,          -- 'red' or 'yellow'
  duty_period_key   text NOT NULL,          -- dedup key (tail|type|rounded timestamps)
  status            text NOT NULL DEFAULT 'projected',  -- 'projected', 'confirmed', 'cleared'
  projected_minutes float,                  -- flight time or rest minutes at detection
  confirmed_minutes float,                  -- actual minutes once confirmed
  breach_leg        text,                   -- e.g. "DAL → LAS"
  suggestion        text,                   -- fix suggestion text
  slack_ts          text,                   -- Slack message_ts for threading
  slack_channel     text,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  cleared_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Only one active alert per tail per duty period per alert type
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_alerts_dedup
  ON duty_alerts (tail_number, alert_type, duty_period_key)
  WHERE status != 'cleared';

CREATE INDEX IF NOT EXISTS idx_duty_alerts_status ON duty_alerts (status);
CREATE INDEX IF NOT EXISTS idx_duty_alerts_tail ON duty_alerts (tail_number);
