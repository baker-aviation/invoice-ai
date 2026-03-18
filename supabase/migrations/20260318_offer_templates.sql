CREATE TABLE IF NOT EXISTS offer_templates (
  id serial PRIMARY KEY,
  role text NOT NULL UNIQUE, -- 'pic' or 'sic'
  name text NOT NULL,
  html_body text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
