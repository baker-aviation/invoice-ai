-- =============================================================================
-- Fuel price tracking table
-- Stores per-gallon fuel prices extracted from parsed invoices.
-- Used to detect price increases at the same airport (>=4% threshold).
-- =============================================================================

CREATE TABLE IF NOT EXISTS fuel_prices (
  id                        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id               TEXT NOT NULL UNIQUE,
  parsed_invoice_id         TEXT,
  airport_code              TEXT,
  vendor_name               TEXT,
  base_price_per_gallon     NUMERIC(10, 5) NOT NULL,
  effective_price_per_gallon NUMERIC(10, 5) NOT NULL,
  gallons                   NUMERIC(10, 2),
  fuel_total                NUMERIC(10, 2),
  invoice_date              DATE,
  tail_number               TEXT,
  currency                  TEXT DEFAULT 'USD',
  associated_line_items     JSONB,
  price_change_pct          NUMERIC(6, 2),
  previous_price            NUMERIC(10, 5),
  alert_sent                BOOLEAN DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT now()
);

-- Price comparison queries: recent prices at an airport
CREATE INDEX idx_fuel_prices_airport_date
  ON fuel_prices (airport_code, invoice_date DESC);

-- Dashboard: most recent fuel prices
CREATE INDEX idx_fuel_prices_created
  ON fuel_prices (created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE fuel_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read fuel_prices"
  ON fuel_prices FOR SELECT
  TO authenticated
  USING (true);
