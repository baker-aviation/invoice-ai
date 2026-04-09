-- Alert Workqueue: assignment, resolution tracking, comments, email threading
-- Phase 1: Core workqueue fields
-- Phase 2: Email ticket system

-- ============================================================
-- Phase 1: Assignment + Resolution on invoice_alerts
-- ============================================================

-- Assignment
ALTER TABLE invoice_alerts
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Resolution tracking
ALTER TABLE invoice_alerts
  ADD COLUMN IF NOT EXISTS resolution text DEFAULT 'havent_started',
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text;

-- Index for filtering by assignee and resolution status
CREATE INDEX IF NOT EXISTS idx_alerts_assigned_to ON invoice_alerts (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_resolution ON invoice_alerts (resolution);

-- ============================================================
-- Comments table (on-site threaded discussion per alert)
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_alert_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES invoice_alerts (id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_comments_alert_id ON invoice_alert_comments (alert_id);

-- ============================================================
-- Phase 2: Email ticket system
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_alert_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES invoice_alerts (id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  from_address text NOT NULL,
  to_addresses text[] NOT NULL DEFAULT '{}',
  cc_addresses text[] DEFAULT '{}',
  subject text NOT NULL,
  body_html text,
  body_text text,
  -- Graph API threading fields
  graph_message_id text,
  graph_conversation_id text,
  graph_internet_message_id text,
  -- Metadata
  sent_by text, -- internal user who triggered outbound
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_emails_alert_id ON invoice_alert_emails (alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_emails_conversation ON invoice_alert_emails (graph_conversation_id)
  WHERE graph_conversation_id IS NOT NULL;

-- ============================================================
-- Assignees registry (so we can add more people later)
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_assignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed initial assignees
INSERT INTO alert_assignees (name, email) VALUES
  ('Evan', NULL),
  ('Esteban Garcia', NULL)
ON CONFLICT DO NOTHING;
