import "server-only";
import OpenAI from "openai";
import { createServiceClient } from "@/lib/supabase/service";

// ---------------------------------------------------------------------------
// OpenAI embeddings client
// ---------------------------------------------------------------------------

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  _openai = new OpenAI({ apiKey });
  return _openai;
}

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping word-based chunks.
 * Target ~800 words per chunk with 150-word overlap.
 */
export function chunkText(
  text: string,
  chunkSize = 800,
  overlap = 150,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= chunkSize) return [words.join(" ")];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export async function embedText(text: string): Promise<number[]> {
  const openai = getOpenAI();
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return res.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const openai = getOpenAI();
  // OpenAI allows up to 2048 inputs per batch request
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Delete existing chunks for a document, chunk the text, embed, and insert
 * into document_chunks. Updates embedding_status on pilot_documents.
 */
export async function ingestDocumentChunks(
  documentId: number,
  text: string,
): Promise<{ chunkCount: number }> {
  const supa = createServiceClient();

  // Update status to processing
  await supa
    .from("pilot_documents")
    .update({ embedding_status: "processing" })
    .eq("id", documentId);

  try {
    // Clean up any existing chunks
    await supa.from("document_chunks").delete().eq("document_id", documentId);

    const cleanText = text.replace(/\s+/g, " ").trim();
    if (!cleanText || cleanText.length < 50) {
      await supa
        .from("pilot_documents")
        .update({ embedding_status: "no_text", chunk_count: 0 })
        .eq("id", documentId);
      return { chunkCount: 0 };
    }

    const chunks = chunkText(cleanText);
    const embeddings = await embedBatch(chunks);

    // Insert chunks in batches of 50
    const batchSize = 50;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize).map((content, j) => ({
        document_id: documentId,
        chunk_index: i + j,
        content,
        embedding: JSON.stringify(embeddings[i + j]),
        token_count: Math.ceil(content.split(/\s+/).length * 1.3), // rough word→token estimate
      }));

      const { error } = await supa.from("document_chunks").insert(batch);
      if (error) throw error;
    }

    await supa
      .from("pilot_documents")
      .update({ embedding_status: "ready", chunk_count: chunks.length })
      .eq("id", documentId);

    return { chunkCount: chunks.length };
  } catch (err) {
    console.error(`[rag] ingestion failed for document ${documentId}:`, err);
    await supa
      .from("pilot_documents")
      .update({ embedding_status: "error", chunk_count: 0 })
      .eq("id", documentId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export type RetrievedChunk = {
  id: string;
  document_id: number;
  chunk_index: number;
  content: string;
  similarity: number;
  document_title: string;
  document_category: string;
};

/**
 * Embed the query and find the most similar document chunks via RPC.
 */
export async function retrieveChunks(
  query: string,
  topK = 5,
  minSimilarity = 0.7,
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedText(query);
  const supa = createServiceClient();

  const { data, error } = await supa.rpc("match_document_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: topK,
    min_similarity: minSimilarity,
  });

  if (error) {
    console.error("[rag] retrieval error:", error);
    return [];
  }

  return (data ?? []) as RetrievedChunk[];
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/**
 * Format retrieved chunks into a context block for the system prompt.
 */
export function formatContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";

  const sections = chunks.map(
    (c, i) =>
      `[Source ${i + 1}: "${c.document_title}" (${c.document_category}) — chunk ${c.chunk_index + 1}]\n${c.content}`,
  );

  return `\n\n<baker_aviation_documents>\nThe following excerpts were retrieved from Baker Aviation's uploaded manuals and SOPs. Use them to answer the pilot's question. Cite the document title when referencing information from these sources.\n\n${sections.join("\n\n---\n\n")}\n</baker_aviation_documents>`;
}
