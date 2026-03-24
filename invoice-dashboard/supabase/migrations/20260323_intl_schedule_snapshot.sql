-- Track flight schedule snapshots on intl_trips so we can detect time changes
-- schedule_snapshot stores: { "flight_id": { "dep": "ISO timestamp", "arr": "ISO timestamp" }, ... }

ALTER TABLE intl_trips
  ADD COLUMN IF NOT EXISTS schedule_snapshot JSONB;

-- Add 'schedule_change' to the intl_leg_alerts alert_type CHECK constraint
-- Drop the old constraint and recreate with the new value
ALTER TABLE intl_leg_alerts
  DROP CONSTRAINT IF EXISTS intl_leg_alerts_alert_type_check;

ALTER TABLE intl_leg_alerts
  ADD CONSTRAINT intl_leg_alerts_alert_type_check
    CHECK (alert_type IN (
      'deadline_approaching', 'permit_resubmit', 'customs_conflict', 'tail_change', 'schedule_change'
    ));
