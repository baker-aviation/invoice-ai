-- Add diverted flag to flights table to protect diversion corrections from ICS sync overwrites
ALTER TABLE flights ADD COLUMN IF NOT EXISTS diverted BOOLEAN DEFAULT false;
