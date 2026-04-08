-- Add "push-to-others" to admin_tickets section constraint
ALTER TABLE admin_tickets DROP CONSTRAINT IF EXISTS admin_tickets_section_check;
ALTER TABLE admin_tickets ADD CONSTRAINT admin_tickets_section_check
  CHECK (section IN ('general', 'crew-swap', 'international', 'current-ops', 'duty', 'notams', 'hiring', 'invoices', 'push-to-others'));
