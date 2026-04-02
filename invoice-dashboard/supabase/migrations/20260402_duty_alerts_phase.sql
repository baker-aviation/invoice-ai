-- Add alert_phase to duty_alerts for 3-stage lifecycle:
-- "scheduled" = warning from schedule data only
-- "actual"    = warning updated with live fleet data
-- (final confirmation is tracked via status = confirmed/cleared)
ALTER TABLE duty_alerts ADD COLUMN IF NOT EXISTS alert_phase text;
