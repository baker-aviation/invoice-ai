-- Add fuel_vendor column to track the fuel contract vendor separately from the FBO/vendor name
ALTER TABLE parsed_invoices
  ADD COLUMN IF NOT EXISTS fuel_vendor TEXT;

ALTER TABLE fuel_prices
  ADD COLUMN IF NOT EXISTS fuel_vendor TEXT;
