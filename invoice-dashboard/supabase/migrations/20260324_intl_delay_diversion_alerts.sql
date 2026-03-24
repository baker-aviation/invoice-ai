-- Add 'delay' and 'diversion' to the intl_leg_alerts alert_type CHECK constraint
ALTER TABLE intl_leg_alerts
  DROP CONSTRAINT IF EXISTS intl_leg_alerts_alert_type_check;

ALTER TABLE intl_leg_alerts
  ADD CONSTRAINT intl_leg_alerts_alert_type_check
    CHECK (alert_type IN (
      'deadline_approaching', 'permit_resubmit', 'customs_conflict',
      'tail_change', 'schedule_change', 'delay', 'diversion'
    ));
