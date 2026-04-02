-- Add 'company' to jetinsight_documents entity_type
ALTER TABLE jetinsight_documents DROP CONSTRAINT IF EXISTS jetinsight_documents_entity_type_check;
ALTER TABLE jetinsight_documents ADD CONSTRAINT jetinsight_documents_entity_type_check
  CHECK (entity_type IN ('crew', 'aircraft', 'trip', 'company'));
