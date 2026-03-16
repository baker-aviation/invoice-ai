-- Allow individual MX notes to be assigned to a specific van,
-- enabling an aircraft to appear on multiple van schedules.
CREATE TABLE IF NOT EXISTS mx_van_overrides (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mx_note_id uuid NOT NULL REFERENCES ops_alerts(id) ON DELETE CASCADE,
  van_id integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(mx_note_id)
);

CREATE INDEX idx_mx_van_overrides_van ON mx_van_overrides (van_id);
CREATE INDEX idx_mx_van_overrides_note ON mx_van_overrides (mx_note_id);
