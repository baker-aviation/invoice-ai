-- Add rejection_type to track hard/soft/left_process rejections
ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS rejection_type TEXT;

-- Add index for rejection queries
CREATE INDEX IF NOT EXISTS idx_job_app_rejection_type
  ON job_application_parse (rejection_type)
  WHERE rejection_type IS NOT NULL;

-- Seed default rejection email templates into hiring_settings
INSERT INTO hiring_settings (key, value) VALUES
  ('rejection_email_soft', 'Dear {{name}},

Thank you for your interest in the Baker position and for taking the time to apply. We appreciate your enthusiasm for joining our team.

We will be reviewing applications on an ongoing basis, and if we see a strong fit, we will reach out to begin the interview process.

If you do not hear from us in the next few months, please feel free to reapply, as we are always happy to consider candidates again as our needs evolve.

Thank you again for your interest, and we wish you all the best in your job search.

Sincerely,
Hiring Team'),
  ('rejection_email_hard', 'Dear {{name}},

Thank you for your interest in the Baker position and for taking the time to apply. We appreciate the effort you put into your application.

After careful review, we have decided not to move forward with your application at this time.

Thank you again for your interest in joining our team and wish you all the best moving forward.

Sincerely,
Hiring Team'),
  ('rejection_email_left', 'Dear {{name}},

We noticed you have not continued with the interview process for the Baker position. We understand that circumstances change and respect your decision.

If you are still interested, please don''t hesitate to reach out — we would be happy to reconnect.

We wish you all the best.

Sincerely,
Hiring Team')
ON CONFLICT (key) DO NOTHING;
