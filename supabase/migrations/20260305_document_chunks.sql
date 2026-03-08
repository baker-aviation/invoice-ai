-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Document chunks table for RAG
CREATE TABLE document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   bigint NOT NULL REFERENCES pilot_documents(id) ON DELETE CASCADE,
  chunk_index   int NOT NULL,
  content       text NOT NULL,
  embedding     vector(1536),
  token_count   int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_chunks_document_id ON document_chunks(document_id);

-- IVFFlat index for cosine similarity search
-- Using 100 lists as a reasonable default; adjust after row count grows
CREATE INDEX idx_document_chunks_embedding ON document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Add embedding status columns to pilot_documents
ALTER TABLE pilot_documents
  ADD COLUMN embedding_status text DEFAULT NULL,
  ADD COLUMN chunk_count int DEFAULT 0;

-- RPC function for cosine similarity search
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  min_similarity float DEFAULT 0.70
)
RETURNS TABLE (
  id uuid,
  document_id bigint,
  chunk_index int,
  content text,
  similarity float,
  document_title text,
  document_category text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    pd.title AS document_title,
    pd.category AS document_category
  FROM document_chunks dc
  JOIN pilot_documents pd ON pd.id = dc.document_id
  WHERE pd.embedding_status = 'ready'
    AND 1 - (dc.embedding <=> query_embedding) >= min_similarity
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- RLS for document_chunks (same pattern as pilot_documents)
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to document_chunks"
  ON document_chunks FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read document_chunks"
  ON document_chunks FOR SELECT
  TO authenticated
  USING (true);
