-- MEL (Minimum Equipment List) items tracking
CREATE TABLE IF NOT EXISTS mel_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tail_number     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('A', 'B', 'C', 'D')),
  mel_reference   TEXT,                          -- e.g. "32-21-01"
  description     TEXT NOT NULL,
  deferred_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  expiration_date DATE,                          -- computed from category if null
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared')),
  cleared_by      UUID REFERENCES auth.users(id),
  cleared_at      TIMESTAMPTZ,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mel_items_tail ON mel_items(tail_number);
CREATE INDEX idx_mel_items_status ON mel_items(status);

-- Add scheduling fields to ops_alerts for MX note van assignment
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS assigned_van INTEGER;
