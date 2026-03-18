-- Rename "interview" stage to "interview_pre" for existing candidates
UPDATE job_application_parse SET pipeline_stage = 'interview_pre' WHERE pipeline_stage = 'interview';
UPDATE job_application_parse SET hiring_stage = 'interview_pre' WHERE hiring_stage = 'interview';
