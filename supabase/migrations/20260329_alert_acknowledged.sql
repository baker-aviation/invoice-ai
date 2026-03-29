-- Add acknowledgment tracking to invoice_alerts
ALTER TABLE invoice_alerts
  ADD COLUMN IF NOT EXISTS acknowledged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS acknowledged_by text,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
