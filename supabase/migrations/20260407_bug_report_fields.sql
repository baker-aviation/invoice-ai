-- Add screenshot and reporter fields to admin_tickets for bug report widget
ALTER TABLE admin_tickets
  ADD COLUMN IF NOT EXISTS screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS reported_by TEXT;
