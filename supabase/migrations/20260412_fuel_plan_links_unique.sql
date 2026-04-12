-- Fix: fuel_plan_links had no unique constraint on (tail_number, date),
-- so the upsert logic in create-plan-link silently created duplicates
-- when maybeSingle() errored on multiple matches.

-- Step 1: Delete duplicates, keeping only the row with the latest expires_at per (tail, date).
DELETE FROM fuel_plan_links
WHERE id NOT IN (
  SELECT DISTINCT ON (tail_number, date) id
  FROM fuel_plan_links
  ORDER BY tail_number, date, expires_at DESC
);

-- Step 2: Add unique constraint so this can't happen again.
ALTER TABLE fuel_plan_links
  ADD CONSTRAINT fuel_plan_links_tail_date_unique UNIQUE (tail_number, date);
