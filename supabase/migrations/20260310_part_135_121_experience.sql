-- Add Part 135 / Part 121 experience booleans
ALTER TABLE job_application_parse ADD COLUMN IF NOT EXISTS has_part_135 boolean;
ALTER TABLE job_application_parse ADD COLUMN IF NOT EXISTS has_part_121 boolean;
