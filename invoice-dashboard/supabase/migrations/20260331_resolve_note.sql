-- Add resolve_note column to parsed_invoices for review notes
ALTER TABLE parsed_invoices
  ADD COLUMN IF NOT EXISTS resolve_note TEXT;
