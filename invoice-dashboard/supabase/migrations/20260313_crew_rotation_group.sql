ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS rotation_group text
  CHECK (rotation_group IN ('A', 'B'));
