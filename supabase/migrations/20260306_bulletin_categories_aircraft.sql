-- Add Citation X and Challenger 300 categories to pilot_bulletins.
ALTER TABLE pilot_bulletins DROP CONSTRAINT IF EXISTS pilot_bulletins_category_check;
ALTER TABLE pilot_bulletins ADD CONSTRAINT pilot_bulletins_category_check
  CHECK (category IN ('chief_pilot', 'operations', 'tims', 'maintenance', 'citation_x', 'challenger_300'));
