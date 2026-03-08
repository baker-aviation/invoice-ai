-- Pilot LMS: courses, modules, lessons, assignments, progress, quizzes
-- 2026-03-05

-- ============================================================
-- 1. lms_courses
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_courses (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text    NOT NULL,
  description text,
  category    text,
  status      text    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by  uuid    REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_courses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_courses"
  ON lms_courses FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read published courses"
  ON lms_courses FOR SELECT
  TO authenticated
  USING (status = 'published');

-- ============================================================
-- 2. lms_modules
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_modules (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  title       text   NOT NULL,
  sort_order  int    NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_modules"
  ON lms_modules FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read modules"
  ON lms_modules FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- 3. lms_lessons
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_lessons (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  module_id      bigint NOT NULL REFERENCES lms_modules(id) ON DELETE CASCADE,
  title          text   NOT NULL,
  lesson_type    text   NOT NULL CHECK (lesson_type IN ('video', 'document', 'quiz', 'text')),
  content_html   text,
  video_gcs_bucket text,
  video_gcs_key    text,
  video_filename   text,
  doc_gcs_bucket   text,
  doc_gcs_key      text,
  doc_filename     text,
  sort_order     int    NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_lessons"
  ON lms_lessons FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read lessons"
  ON lms_lessons FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- 4. lms_assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_assignments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  user_id     uuid   NOT NULL REFERENCES auth.users(id),
  assigned_by uuid   REFERENCES auth.users(id),
  due_date    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, user_id)
);

ALTER TABLE lms_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_assignments"
  ON lms_assignments FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read own assignments"
  ON lms_assignments FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 5. lms_progress
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_progress (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid   NOT NULL REFERENCES auth.users(id),
  lesson_id     bigint NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

ALTER TABLE lms_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_progress"
  ON lms_progress FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read own progress"
  ON lms_progress FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 6. lms_quiz_questions
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_quiz_questions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lesson_id       bigint NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  question        text   NOT NULL,
  options         jsonb  NOT NULL DEFAULT '[]'::jsonb,
  correct_answer  int    NOT NULL,
  sort_order      int    NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_quiz_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_quiz_questions"
  ON lms_quiz_questions FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read quiz questions"
  ON lms_quiz_questions FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- 7. lms_quiz_attempts
-- ============================================================
CREATE TABLE IF NOT EXISTS lms_quiz_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid   NOT NULL REFERENCES auth.users(id),
  question_id     bigint NOT NULL REFERENCES lms_quiz_questions(id) ON DELETE CASCADE,
  selected_answer int    NOT NULL,
  is_correct      boolean NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_quiz_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access on lms_quiz_attempts"
  ON lms_quiz_attempts FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read own quiz attempts"
  ON lms_quiz_attempts FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
