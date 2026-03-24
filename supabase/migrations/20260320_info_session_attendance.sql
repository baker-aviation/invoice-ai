-- Stores attendance check results for info session meetings
CREATE TABLE IF NOT EXISTS info_session_attendance (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_code   TEXT NOT NULL,
  meet_link      TEXT,
  meeting_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  total_participants INTEGER DEFAULT 0,
  matched        JSONB DEFAULT '[]',
  unmatched      JSONB DEFAULT '[]',
  checked_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON info_session_attendance (meeting_date DESC);

ALTER TABLE info_session_attendance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read info_session_attendance"
  ON info_session_attendance FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role full access to info_session_attendance"
  ON info_session_attendance FOR ALL TO service_role USING (true) WITH CHECK (true);
