-- Add pin/review columns to parsed_invoices
ALTER TABLE parsed_invoices
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_note TEXT,
  ADD COLUMN IF NOT EXISTS pinned_by TEXT,
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pin_resolved BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Index for active pins (Needs Review tab)
CREATE INDEX IF NOT EXISTS idx_parsed_invoices_pinned
  ON parsed_invoices(pinned) WHERE pinned = true;
