-- Learned vendor → category rules.
-- When a user overrides a category on an invoice, we store the
-- vendor → category mapping here so future invoices from that
-- vendor automatically get the same category.

CREATE TABLE IF NOT EXISTS category_rules (
  vendor_normalized TEXT PRIMARY KEY,
  vendor_display TEXT NOT NULL,
  category TEXT NOT NULL,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_category_rules_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_category_rules_timestamp
  BEFORE UPDATE ON category_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_category_rules_timestamp();
