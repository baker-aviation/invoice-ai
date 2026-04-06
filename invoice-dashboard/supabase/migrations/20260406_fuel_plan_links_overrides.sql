-- Add overrides column to fuel_plan_links so user adjustments persist across page refreshes
ALTER TABLE fuel_plan_links
  ADD COLUMN IF NOT EXISTS overrides jsonb DEFAULT NULL;

COMMENT ON COLUMN fuel_plan_links.overrides IS 'User-submitted overrides (mlw, zfw, fee, waiver_gal, fuel_burn) keyed by leg index';
