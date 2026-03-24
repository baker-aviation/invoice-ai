-- Performance indexes & server-side cleanup RPCs to reduce Disk IO
-- Addresses: high IO consumption warning from Supabase (2026-03-19)

-- 1. fbo_advertised_prices: zero indexes, full table scan on every query
CREATE INDEX IF NOT EXISTS idx_fbo_advertised_prices_week_start
  ON fbo_advertised_prices (week_start DESC);

-- 2. flights.summary: ILIKE '%NOT FLYING%' causes full table scan
--    pg_trgm enables GIN index for pattern matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_flights_summary_trgm
  ON flights USING gin (summary gin_trgm_ops);

-- 3. ops_alerts: tail_number lookups for MX notes have no index
CREATE INDEX IF NOT EXISTS idx_ops_alerts_tail_type
  ON ops_alerts (tail_number, alert_type)
  WHERE acknowledged_at IS NULL;

-- 4. mel_items: dashboard sorts by expiration_date with no index
CREATE INDEX IF NOT EXISTS idx_mel_items_expiration
  ON mel_items (expiration_date ASC NULLS LAST)
  WHERE status = 'open';

-- 5. Server-side cleanup: delete flights where departure == arrival
--    Replaces client-side fetch-10k-then-filter pattern
CREATE OR REPLACE FUNCTION cleanup_same_airport_flights()
RETURNS INTEGER
LANGUAGE sql
AS $$
  WITH deleted AS (
    DELETE FROM flights
    WHERE departure_icao IS NOT NULL
      AND arrival_icao IS NOT NULL
      AND departure_icao = arrival_icao
    RETURNING id
  )
  SELECT count(*)::integer FROM deleted;
$$;

-- 6. Server-side cleanup: delete flights matching skip-summary keywords
CREATE OR REPLACE FUNCTION cleanup_flights_by_summary(keywords TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  total INTEGER := 0;
  kw TEXT;
  ct INTEGER;
BEGIN
  FOREACH kw IN ARRAY keywords LOOP
    WITH deleted AS (
      DELETE FROM flights WHERE summary ILIKE '%' || kw || '%' RETURNING id
    )
    SELECT count(*) INTO ct FROM deleted;
    total := total + ct;
  END LOOP;
  RETURN total;
END;
$$;
