ALTER TABLE trip_salespersons
  ADD COLUMN IF NOT EXISTS origin_fbo TEXT,
  ADD COLUMN IF NOT EXISTS destination_fbo TEXT;
