import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * GET /api/admin/pilot-documents — list all documents (optional ?category= filter)
 * POST /api/admin/pilot-documents — upload a new document (multipart form)
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  let query = supa
    .from("pilot_documents")
    .select("*")
    .order("created_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[pilot-documents] list error:", error);
    return NextResponse.json({ error: "Failed to list documents" }, { status: 500 });
  }

  return NextResponse.json({ documents: data });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;
  const category = (formData.get("category") as string)?.trim();

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!category) {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  // Validate file type
  const allowedExtensions = /\.(pdf|mp4|mov|avi|mkv|webm|doc|docx|xls|xlsx|ppt|pptx|txt|csv|png|jpg|jpeg)$/i;
  if (!file.name.match(allowedExtensions)) {
    return NextResponse.json(
      { error: "File type not allowed. Accepted: PDF, video, Office docs, images, TXT, CSV." },
      { status: 400 },
    );
  }

  // Max 100MB
  if (file.size > 100 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 100MB)" }, { status: 400 });
  }

  try {
    // Upload to GCS
    const { Storage } = await import("@google-cloud/storage");
    let storage: InstanceType<typeof Storage>;
    const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64Key) {
      const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
      storage = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storage = new Storage();
    }

    const bucketName = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `pilot-documents/${category}/${Date.now()}-${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await storage.bucket(bucketName).file(gcsKey).save(buffer, {
      contentType: file.type || "application/octet-stream",
    });

    // Insert metadata row
    const supa = createServiceClient();
    const { data: row, error: insertErr } = await supa
      .from("pilot_documents")
      .insert({
        title,
        description,
        category,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        gcs_bucket: bucketName,
        gcs_key: gcsKey,
        size_bytes: buffer.length,
        uploaded_by: auth.userId,
      })
      .select("*")
      .single();

    if (insertErr) {
      console.error("[pilot-documents] insert error:", insertErr);
      return NextResponse.json({ error: "Failed to save document record" }, { status: 500 });
    }

    // Fire-and-forget: extract text from PDFs and ingest chunks for RAG
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      (async () => {
        try {
          const { PDFParse } = await import("pdf-parse");
          const parser = new PDFParse({ data: new Uint8Array(buffer) });
          const result = await parser.getText();
          const text = result.text?.trim();
          if (!text || text.length < 50) {
            await supa
              .from("pilot_documents")
              .update({ embedding_status: "no_text", chunk_count: 0 })
              .eq("id", row.id);
            return;
          }
          const { ingestDocumentChunks } = await import("@/lib/rag");
          await ingestDocumentChunks(row.id, text);
          console.log(`[pilot-documents] ingested chunks for doc ${row.id}`);
        } catch (err) {
          console.error(`[pilot-documents] ingestion error for doc ${row.id}:`, err);
          // Status already set to "error" by ingestDocumentChunks on failure
        }
      })();
    }

    return NextResponse.json({ ok: true, document: row }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pilot-documents] upload error:", message, err);
    return NextResponse.json({ error: `Upload failed: ${message}` }, { status: 500 });
  }
}
