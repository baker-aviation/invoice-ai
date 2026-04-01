-- Interest check tokens for "Still interested?" follow-up emails after info sessions
CREATE TABLE IF NOT EXISTS interest_check_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token       text NOT NULL UNIQUE,
  parse_id    bigint NOT NULL,
  response    text,            -- NULL = pending, 'yes', 'no'
  responded_at timestamptz,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interest_token ON interest_check_tokens (token);
CREATE INDEX IF NOT EXISTS idx_interest_parse_id ON interest_check_tokens (parse_id);

ALTER TABLE interest_check_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON interest_check_tokens
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Tracking columns on job_application_parse
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS interest_check_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS interest_check_response text;
