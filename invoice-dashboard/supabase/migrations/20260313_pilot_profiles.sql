-- Pilot profiles, onboarding checklist, and time-off requests
-- Part of the Pilot Profile & Onboarding System

-- ---------------------------------------------------------------------------
-- pilot_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pilot_profiles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid UNIQUE REFERENCES auth.users(id),
  crew_member_id uuid UNIQUE REFERENCES crew_members(id),
  application_id bigint REFERENCES job_applications(id),
  full_name   text NOT NULL,
  email       text,
  phone       text,
  role        text NOT NULL CHECK (role IN ('PIC', 'SIC')),
  home_airports text[] DEFAULT '{}',
  aircraft_types text[] DEFAULT '{}',
  hire_date   date,
  employee_id text,
  medical_class text,
  medical_expiry date,
  passport_expiry date,
  onboarding_complete boolean NOT NULL DEFAULT false,
  available_to_fly boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pilot_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_pilot_profiles"
  ON pilot_profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "service_role_all_pilot_profiles"
  ON pilot_profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- pilot_onboarding_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pilot_onboarding_items (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pilot_profile_id  bigint NOT NULL REFERENCES pilot_profiles(id) ON DELETE CASCADE,
  item_key          text NOT NULL,
  item_label        text NOT NULL,
  required_for      text NOT NULL DEFAULT 'all' CHECK (required_for IN ('all', 'pic_only')),
  completed         boolean NOT NULL DEFAULT false,
  completed_at      timestamptz,
  completed_by      uuid REFERENCES auth.users(id),
  notes             text,
  UNIQUE (pilot_profile_id, item_key)
);

ALTER TABLE pilot_onboarding_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_onboarding_items"
  ON pilot_onboarding_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "service_role_all_onboarding_items"
  ON pilot_onboarding_items FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- pilot_time_off_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pilot_time_off_requests (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pilot_profile_id  bigint NOT NULL REFERENCES pilot_profiles(id) ON DELETE CASCADE,
  request_type      text NOT NULL CHECK (request_type IN ('time_off', 'standby')),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  reason            text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by       uuid REFERENCES auth.users(id),
  reviewed_at       timestamptz,
  review_notes      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pilot_time_off_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_time_off"
  ON pilot_time_off_requests FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "service_role_all_time_off"
  ON pilot_time_off_requests FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
