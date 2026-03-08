-- Pilot Documents: document storage metadata and categories for pilot-facing SOPs, bulletins, training materials.

-- Categories table (admin-managed)
CREATE TABLE IF NOT EXISTS pilot_document_categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pilot_document_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON pilot_document_categories
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read categories" ON pilot_document_categories
  FOR SELECT TO authenticated USING (true);

-- Documents table
CREATE TABLE IF NOT EXISTS pilot_documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  description   text,
  category      text NOT NULL,
  filename      text NOT NULL,
  content_type  text,
  gcs_bucket    text NOT NULL,
  gcs_key       text NOT NULL,
  size_bytes    bigint,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pilot_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON pilot_documents
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read documents" ON pilot_documents
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_pilot_documents_category ON pilot_documents (category);
CREATE INDEX IF NOT EXISTS idx_pilot_documents_created_at ON pilot_documents (created_at DESC);

-- Seed a few default categories
INSERT INTO pilot_document_categories (name, sort_order) VALUES
  ('SOPs', 1),
  ('Bulletins', 2),
  ('Training Videos', 3)
ON CONFLICT (name) DO NOTHING;
