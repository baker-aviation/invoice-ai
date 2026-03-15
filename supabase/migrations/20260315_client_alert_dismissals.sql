-- Server-side storage for client alert dismissals (Baker PPR, after-hours, etc.)
-- Replaces localStorage so dismissals are global and attributed to a user.
CREATE TABLE IF NOT EXISTS client_alert_dismissals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_key text NOT NULL UNIQUE,
  dismissed_by uuid NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_client_alert_dismissals_key ON client_alert_dismissals (alert_key);
