-- Log of daily evening summary DMs sent to salespersons
CREATE TABLE IF NOT EXISTS salesperson_summary_sent (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salesperson_name text  NOT NULL,
  summary_date    date   NOT NULL,
  leg_count       int    NOT NULL DEFAULT 0,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salesperson_name, summary_date)
);

ALTER TABLE salesperson_summary_sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read salesperson_summary_sent"
  ON salesperson_summary_sent FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can write salesperson_summary_sent"
  ON salesperson_summary_sent FOR ALL TO service_role USING (true) WITH CHECK (true);
