-- Salesperson Slack DM notification tables
-- Apply in Supabase SQL Editor

-- 1. Trip-salesperson mapping (from JetInsight CSV)
CREATE TABLE IF NOT EXISTS trip_salespersons (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     text    NOT NULL UNIQUE,
  tail_number text    NOT NULL,
  origin_icao text,
  destination_icao text,
  trip_start  date    NOT NULL,
  trip_end    date    NOT NULL,
  salesperson_name text NOT NULL,
  customer    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trip_salespersons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read trip_salespersons"
  ON trip_salespersons FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can write trip_salespersons"
  ON trip_salespersons FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Salesperson → Slack user ID lookup
CREATE TABLE IF NOT EXISTS salesperson_slack_map (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salesperson_name text   NOT NULL UNIQUE,
  slack_user_id    text   NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE salesperson_slack_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read salesperson_slack_map"
  ON salesperson_slack_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can write salesperson_slack_map"
  ON salesperson_slack_map FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Notification dedup tracker
CREATE TABLE IF NOT EXISTS salesperson_notifications_sent (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flight_id       text   NOT NULL,
  trip_id         text   NOT NULL,
  salesperson_name text  NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flight_id, trip_id)
);

ALTER TABLE salesperson_notifications_sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read salesperson_notifications_sent"
  ON salesperson_notifications_sent FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role can write salesperson_notifications_sent"
  ON salesperson_notifications_sent FOR ALL TO service_role USING (true) WITH CHECK (true);
