-- Add previous_document_id to fuel_prices for linking to baseline invoice
ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS previous_document_id TEXT;
