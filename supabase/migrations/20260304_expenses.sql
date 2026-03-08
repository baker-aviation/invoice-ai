-- =============================================================================
-- Expenses table
-- Stores pilot-reported expense/fee data uploaded via CSV.
-- Dedup key: (expense_date, airport, vendor, amount) prevents duplicate rows
-- from overlapping CSV uploads.
-- =============================================================================

CREATE TABLE IF NOT EXISTS expenses (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_date    DATE NOT NULL,
  vendor          TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  receipts        TEXT DEFAULT '',
  airport         TEXT DEFAULT '',
  fbo             TEXT DEFAULT '',
  bill_to         TEXT DEFAULT '',
  created_by      TEXT DEFAULT '',
  gallons         NUMERIC(10, 2),
  amount          NUMERIC(10, 2) NOT NULL,
  repeats         TEXT DEFAULT 'No',
  uploaded_at     TIMESTAMPTZ DEFAULT now(),
  upload_batch    TEXT
);

-- Prevent duplicate rows from overlapping CSV uploads
ALTER TABLE expenses ADD CONSTRAINT expenses_dedup UNIQUE (expense_date, airport, vendor, amount);

-- Dashboard queries
CREATE INDEX idx_expenses_date   ON expenses (expense_date DESC);
CREATE INDEX idx_expenses_airport ON expenses (airport);
CREATE INDEX idx_expenses_batch  ON expenses (upload_batch);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read expenses"
  ON expenses FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert expenses"
  ON expenses FOR INSERT
  TO service_role
  WITH CHECK (true);
