-- Add pipeline_stage to job_application_parse for Kanban hiring board
-- Valid stages: new → screening → interview → offer → hired / rejected

ALTER TABLE job_application_parse
  ADD COLUMN IF NOT EXISTS pipeline_stage text NOT NULL DEFAULT 'new';

-- Allow authenticated dashboard users to update pipeline_stage (for drag-and-drop)
CREATE POLICY "Authenticated users can update job_application_parse"
  ON job_application_parse FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
