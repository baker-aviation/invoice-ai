-- SWIM (System Wide Information Management) integration tables
-- Data sourced from FAA SCDS: TFMS, STDDS, and NOTAM Distribution feeds

-- ── Flow control events (GDP, Ground Stops, CTOPs) from TFMS R14 Flow Data ──
CREATE TABLE IF NOT EXISTS swim_flow_control (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text NOT NULL,          -- 'GDP', 'GROUND_STOP', 'CTOP', 'AFP'
  airport_icao  text,                   -- affected airport (if applicable)
  status        text NOT NULL DEFAULT 'active',  -- 'active', 'expired', 'cancelled'
  severity      text NOT NULL DEFAULT 'warning', -- 'critical', 'warning', 'info'
  subject       text NOT NULL,          -- short description
  body          text,                   -- full details
  effective_at  timestamptz,            -- when it takes effect
  expires_at    timestamptz,            -- when it expires
  source_id     text UNIQUE,            -- SWIM message dedup key
  raw_xml       text,                   -- original FIXM XML (for debugging)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_swim_flow_control_airport ON swim_flow_control (airport_icao);
CREATE INDEX idx_swim_flow_control_active ON swim_flow_control (status, expires_at)
  WHERE status = 'active';

-- ── Flight positions from TFMS R14 Flight Data ──
CREATE TABLE IF NOT EXISTS swim_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acid            text,                 -- aircraft ID (callsign or tail)
  tail_number     text,                 -- normalized tail (N-number)
  departure_icao  text,
  arrival_icao    text,
  latitude        double precision,
  longitude       double precision,
  altitude_ft     integer,
  groundspeed_kt  integer,
  event_type      text,                 -- 'DEPARTURE', 'ARRIVAL', 'POSITION', 'FLIGHT_PLAN'
  event_time      timestamptz NOT NULL, -- when the event occurred
  source_id       text UNIQUE,          -- SWIM message dedup key
  raw_xml         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_swim_positions_tail ON swim_positions (tail_number, event_time DESC);
CREATE INDEX idx_swim_positions_event ON swim_positions (event_type, event_time DESC);

-- ── NOTAMs from AIM NMS Publication feed ──
CREATE TABLE IF NOT EXISTS swim_notams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notam_id        text UNIQUE NOT NULL, -- FAA NOTAM identifier (e.g. '01/234')
  airport_icao    text,
  classification  text,                 -- 'FDC', 'DOMESTIC', 'INTERNATIONAL'
  notam_type      text,                 -- 'NOTAM_RUNWAY', 'NOTAM_TFR', 'NOTAM_PPR', etc.
  status          text NOT NULL DEFAULT 'active',  -- 'active', 'cancelled', 'expired'
  subject         text NOT NULL,
  body            text,
  effective_at    timestamptz,
  expires_at      timestamptz,
  raw_xml         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_swim_notams_airport ON swim_notams (airport_icao);
CREATE INDEX idx_swim_notams_active ON swim_notams (status, expires_at)
  WHERE status = 'active';

-- RLS: service_role only (backend writes, dashboard reads via API)
ALTER TABLE swim_flow_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE swim_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE swim_notams ENABLE ROW LEVEL SECURITY;
