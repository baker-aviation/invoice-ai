-- Add FBO operating hours columns to fbo_handling_fees.
-- Hours come from JetInsight airport page scraper (already parsed, just never stored).

ALTER TABLE fbo_handling_fees
  ADD COLUMN IF NOT EXISTS hours      TEXT DEFAULT '',       -- Raw hours string from JetInsight (e.g. "0600-2200", "24 Hours")
  ADD COLUMN IF NOT EXISTS phone      TEXT DEFAULT '',       -- FBO phone number
  ADD COLUMN IF NOT EXISTS is_24hr    BOOLEAN DEFAULT FALSE; -- Computed: true if hours indicates 24/7 ops

-- Index for quick "is this FBO open?" lookups by the van scheduler
CREATE INDEX IF NOT EXISTS idx_fbo_hours_airport
  ON fbo_handling_fees(airport_code, is_24hr);
