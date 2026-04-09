-- Meetings: video upload → transcription → AI ticket generation
-- Used by Super Admin "Meetings" tab

CREATE TABLE meetings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT 'Untitled Meeting',
  video_gcs_key TEXT,
  transcript    TEXT,
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                CHECK (status IN ('processing','transcribed','generating','tickets_ready','error')),
  error_message TEXT,
  duration_sec  INTEGER,
  screenshot_count INTEGER DEFAULT 0,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meeting_screenshots (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id    BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  gcs_key       TEXT NOT NULL,
  time_sec      NUMERIC(8,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_screenshots_meeting ON meeting_screenshots(meeting_id);

CREATE TABLE meeting_tickets (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id      BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  ticket_type     TEXT NOT NULL DEFAULT 'task'
                  CHECK (ticket_type IN ('task','bug','feature','action_item','follow_up')),
  priority        TEXT DEFAULT 'medium'
                  CHECK (priority IN ('critical','high','medium','low')),
  assignee_hint   TEXT,
  timestamp_secs  NUMERIC(8,2)[],
  screenshot_ids  BIGINT[],
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','pushed_to_linear')),
  admin_ticket_id BIGINT,
  linear_issue_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_tickets_meeting ON meeting_tickets(meeting_id);

-- RLS: meetings are super_admin only (enforced at API level)
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_tickets ENABLE ROW LEVEL SECURITY;

-- Service-role bypass (API routes use service key)
CREATE POLICY meetings_service ON meetings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY meeting_screenshots_service ON meeting_screenshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY meeting_tickets_service ON meeting_tickets FOR ALL USING (true) WITH CHECK (true);
