-- Volunteer response parsing from Slack #pilots thread
-- Stores parsed preferences (early/late/standby) from weekly volunteer thread

CREATE TABLE volunteer_responses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  swap_date DATE NOT NULL,
  slack_user_id TEXT NOT NULL,
  crew_member_id UUID REFERENCES crew_members(id) ON DELETE SET NULL,
  raw_text TEXT NOT NULL,
  parsed_preference TEXT NOT NULL CHECK (parsed_preference IN ('early', 'late', 'standby', 'early_and_late', 'unknown')),
  notes TEXT,                       -- free-text portion after keyword
  thread_ts TEXT NOT NULL,
  parsed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(swap_date, slack_user_id)
);

CREATE INDEX volunteer_responses_swap_date_idx ON volunteer_responses (swap_date);
CREATE INDEX volunteer_responses_crew_idx ON volunteer_responses (crew_member_id) WHERE crew_member_id IS NOT NULL;

-- Add slack_user_id to crew_members for Slack↔crew linking
ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS slack_user_id TEXT;
CREATE INDEX crew_members_slack_idx ON crew_members (slack_user_id) WHERE slack_user_id IS NOT NULL;

-- RLS
ALTER TABLE volunteer_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read volunteer_responses"
  ON volunteer_responses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access to volunteer_responses"
  ON volunteer_responses FOR ALL TO service_role USING (true) WITH CHECK (true);
