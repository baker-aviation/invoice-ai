-- Global alert acknowledgment: add acknowledged_by to track which admin acked
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS acknowledged_by UUID;
