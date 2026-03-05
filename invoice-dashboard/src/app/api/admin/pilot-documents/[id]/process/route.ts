import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";
import { ingestDocumentChunks } from "@/lib/rag";

/**
 * POST /api/admin/pilot-documents/[id]/process
 * Admin-only: re-process a document (download from GCS, re-extract text, re-embed).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const supa = createServiceClient();

  // Fetch the document
  const { data: doc, error: fetchErr } = await supa
    .from("pilot_documents")
    .select("id, content_type, gcs_bucket, gcs_key, filename")
    .eq("id", id)
    .single();

  if (fetchErr || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Only process PDFs
  const isPdf =
    doc.content_type === "application/pdf" ||
    doc.filename?.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json(
      { error: "Only PDF documents can be processed for RAG" },
      { status: 400 },
    );
  }

  try {
    // Download file from GCS
    const { Storage } = await import("@google-cloud/storage");
    let storage: InstanceType<typeof Storage>;
    const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64Key) {
      const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
      storage = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storage = new Storage();
    }

    const [buffer] = await storage
      .bucket(doc.gcs_bucket)
      .file(doc.gcs_key)
      .download();

    // Extract text
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    const text = parsed.text?.trim();

    if (!text || text.length < 50) {
      await supa
        .from("pilot_documents")
        .update({ embedding_status: "no_text", chunk_count: 0 })
        .eq("id", doc.id);
      return NextResponse.json({ status: "no_text", chunk_count: 0 });
    }

    // Ingest chunks
    const ingestion = await ingestDocumentChunks(doc.id, text);

    return NextResponse.json({
      status: "ready",
      chunk_count: ingestion.chunkCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pilot-documents] re-process error for doc ${id}:`, message, err);
    return NextResponse.json(
      { error: `Processing failed: ${message}` },
      { status: 500 },
    );
  }
}
