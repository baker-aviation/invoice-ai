-- Add category_override column to parsed_invoices
-- Allows users to manually set the category, overriding auto-classification.
-- NULL = use auto-classification, non-null = user override.

ALTER TABLE parsed_invoices
ADD COLUMN IF NOT EXISTS category_override TEXT;

-- Index for filtering by category
CREATE INDEX IF NOT EXISTS idx_parsed_invoices_category_override
ON parsed_invoices (category_override)
WHERE category_override IS NOT NULL;
