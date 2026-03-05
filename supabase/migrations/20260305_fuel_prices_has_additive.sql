-- Flag fuel price records that include FSII/Prist additives in the effective price.
-- Allows apples-to-apples comparison (additive adds ~$0.10-0.30/gal).
ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS has_additive BOOLEAN DEFAULT FALSE;
