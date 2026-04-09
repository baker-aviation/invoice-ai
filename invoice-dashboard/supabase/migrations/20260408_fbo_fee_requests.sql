-- Tracks outbound fee request emails sent to FBOs and their reply status.
-- Links to fbo_direct_fees once a reply is parsed.

CREATE TABLE IF NOT EXISTS fbo_fee_requests (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  airport_code        TEXT NOT NULL,
  fbo_name            TEXT NOT NULL,
  fbo_email           TEXT NOT NULL,
  aircraft_types      TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  -- Email tracking
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'sent', 'replied', 'parsed', 'failed', 'no_reply')),
  sent_at             TIMESTAMPTZ,
  sent_from           TEXT NOT NULL DEFAULT 'operations@baker-aviation.com',
  subject             TEXT NOT NULL DEFAULT '',
  graph_message_id    TEXT,
  conversation_id     TEXT,
  internet_message_id TEXT,

  -- Reply tracking
  reply_received_at   TIMESTAMPTZ,
  reply_message_id    TEXT,
  reply_body          TEXT DEFAULT '',
  reply_from          TEXT DEFAULT '',

  -- Parse results
  parsed_at           TIMESTAMPTZ,
  parse_confidence    TEXT DEFAULT ''
                      CHECK (parse_confidence IN ('', 'ai-parsed', 'confirmed', 'failed')),
  parse_errors        TEXT DEFAULT '',

  -- Batch tracking
  batch_id            TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fbo_fee_requests_status ON fbo_fee_requests(status);
CREATE INDEX idx_fbo_fee_requests_airport ON fbo_fee_requests(airport_code);
CREATE INDEX idx_fbo_fee_requests_conv ON fbo_fee_requests(conversation_id);
CREATE INDEX idx_fbo_fee_requests_batch ON fbo_fee_requests(batch_id);

ALTER TABLE fbo_fee_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON fbo_fee_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read" ON fbo_fee_requests
  FOR SELECT TO authenticated USING (true);

-- Auto-update trigger
CREATE OR REPLACE FUNCTION update_fbo_fee_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fbo_fee_requests_updated_at
  BEFORE UPDATE ON fbo_fee_requests
  FOR EACH ROW EXECUTE FUNCTION update_fbo_fee_requests_updated_at();
