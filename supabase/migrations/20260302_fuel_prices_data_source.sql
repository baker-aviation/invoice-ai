-- Add data_source column to fuel_prices to distinguish invoice-parsed data
-- from JetInsight seed data (or other imported sources).
--
-- Values: 'invoice' (default, from parsed PDFs), 'jetinsight' (FBO fees seed)

ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'invoice';

-- Relax the UNIQUE constraint on document_id: JetInsight seed rows use
-- synthetic document_ids (e.g. 'jetinsight-KFLL-2026-02') so they won't
-- collide with real invoice document_ids.

-- Index for filtering by source
CREATE INDEX IF NOT EXISTS idx_fuel_prices_data_source
  ON fuel_prices (data_source);
