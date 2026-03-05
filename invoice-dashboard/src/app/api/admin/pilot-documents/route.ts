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

  let body: { title?: string; description?: string; category?: string; filename?: string; contentType?: string; size?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const title = body.title?.trim();
  const description = body.description?.trim() || null;
  const category = body.category?.trim();
  const filename = body.filename?.trim();
  const contentType = body.contentType || "application/octet-stream";
  const size = body.size ?? 0;

  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!category) return NextResponse.json({ error: "category is required" }, { status: 400 });
  if (!filename) return NextResponse.json({ error: "filename is required" }, { status: 400 });

  // Validate file type
  const allowedExtensions = /\.(pdf|mp4|mov|avi|mkv|webm|doc|docx|xls|xlsx|ppt|pptx|txt|csv|png|jpg|jpeg)$/i;
  if (!filename.match(allowedExtensions)) {
    return NextResponse.json(
      { error: "File type not allowed. Accepted: PDF, video, Office docs, images, TXT, CSV." },
      { status: 400 },
    );
  }

  // Max 100MB
  if (size > 100 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 100MB)" }, { status: 400 });
  }

  try {
    // Generate a signed upload URL so the client uploads directly to GCS
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
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `pilot-documents/${category}/${Date.now()}-${safeName}`;

    const [uploadUrl] = await storage.bucket(bucketName).file(gcsKey).getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 30 * 60 * 1000, // 30 minutes
      contentType,
    });

    // Insert metadata row
    const supa = createServiceClient();
    const { data: row, error: insertErr } = await supa
      .from("pilot_documents")
      .insert({
        title,
        description,
        category,
        filename,
        content_type: contentType,
        gcs_bucket: bucketName,
        gcs_key: gcsKey,
        size_bytes: size,
        uploaded_by: auth.userId,
      })
      .select("*")
      .single();

    if (insertErr) {
      console.error("[pilot-documents] insert error:", insertErr);
      return NextResponse.json({ error: "Failed to save document record" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, document: row, uploadUrl }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pilot-documents] upload error:", message, err);
    return NextResponse.json({ error: `Upload failed: ${message}` }, { status: 500 });
  }
}
