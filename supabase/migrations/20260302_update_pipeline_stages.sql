-- =============================================================================
-- Update hiring pipeline stages
-- Old: new, screening, phone_screen, interview, offer, hired, rejected
-- New: new, screening, info_session, prd_faa_review, interview, offer, hired
-- =============================================================================

-- Migrate old stage values to new ones
UPDATE job_application_parse SET pipeline_stage = 'info_session' WHERE pipeline_stage = 'phone_screen';
UPDATE job_application_parse SET pipeline_stage = 'new' WHERE pipeline_stage = 'rejected';
UPDATE job_application_parse SET hiring_stage = 'info_session' WHERE hiring_stage = 'phone_screen';
UPDATE job_application_parse SET hiring_stage = 'new' WHERE hiring_stage = 'rejected';
