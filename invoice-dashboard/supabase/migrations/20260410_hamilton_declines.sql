-- Hamilton integration: declined trips tracking
-- Config table (same pattern as jetinsight_config)

CREATE TABLE IF NOT EXISTS hamilton_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Declined trips table

CREATE TABLE IF NOT EXISTS hamilton_declined_trips (
  id BIGSERIAL PRIMARY KEY,
  hamilton_trip_id TEXT UNIQUE NOT NULL,
  display_code TEXT,
  operator_status TEXT,
  sales_agent_id TEXT,
  auto_quoted BOOLEAN,
  lowest_price NUMERIC,
  contact_name TEXT,
  contact_email TEXT,
  contact_company TEXT,
  departure_airport TEXT,
  arrival_airport TEXT,
  departure_date TIMESTAMPTZ,
  pax INTEGER,
  aircraft_category TEXT,
  leg_count INTEGER DEFAULT 1,
  pipeline_id TEXT,
  hamilton_created_at TIMESTAMPTZ,
  hamilton_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_hamilton_declines_agent
  ON hamilton_declined_trips (sales_agent_id);
CREATE INDEX IF NOT EXISTS idx_hamilton_declines_departure
  ON hamilton_declined_trips (departure_date);
CREATE INDEX IF NOT EXISTS idx_hamilton_declines_agent_departure
  ON hamilton_declined_trips (sales_agent_id, departure_date);

-- Agent name mapping table (lightweight, avoids JSON blob in config)

CREATE TABLE IF NOT EXISTS hamilton_sales_agents (
  agent_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Summary function for decline counts by agent within a date range

CREATE OR REPLACE FUNCTION hamilton_decline_summary(date_from TEXT)
RETURNS TABLE (
  "salesAgentId" TEXT,
  "salesAgentName" TEXT,
  count BIGINT,
  "totalValue" NUMERIC
) AS $$
  SELECT
    d.sales_agent_id AS "salesAgentId",
    a.agent_name AS "salesAgentName",
    COUNT(*) AS count,
    COALESCE(SUM(d.lowest_price), 0) AS "totalValue"
  FROM hamilton_declined_trips d
  LEFT JOIN hamilton_sales_agents a ON a.agent_id = d.sales_agent_id
  WHERE d.departure_date >= date_from::timestamptz
  GROUP BY d.sales_agent_id, a.agent_name
  ORDER BY count DESC;
$$ LANGUAGE sql STABLE;
