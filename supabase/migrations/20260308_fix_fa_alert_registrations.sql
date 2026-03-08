-- Fix fa_alert_registrations: replace partial unique index with a proper
-- UNIQUE constraint so Supabase upsert(onConflict: "tail") works correctly.

DROP INDEX IF EXISTS idx_fa_alert_reg_tail;
ALTER TABLE fa_alert_registrations ADD CONSTRAINT fa_alert_reg_tail_unique UNIQUE (tail);
