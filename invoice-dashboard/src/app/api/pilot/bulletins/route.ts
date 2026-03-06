import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

/**
 * GET /api/pilot/bulletins — list bulletins
 * Optional ?category= filter
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const category = req.nextUrl.searchParams.get("category");
  const supa = createServiceClient();

  let query = supa
    .from("pilot_bulletins")
    .select("id, title, summary, category, published_at, video_filename, doc_filename, created_at")
    .order("published_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[pilot/bulletins] list error:", error);
    return NextResponse.json({ error: "Failed to list bulletins" }, { status: 500 });
  }

  return NextResponse.json({ bulletins: data });
}

/** Map file extension to MIME type for uploads */
function contentTypeForExt(ext: string | undefined): string {
  switch (ext) {
    case "mp4": return "video/mp4";
    case "m4v": return "video/x-m4v";
    case "mov": return "video/quicktime";
    case "pdf": return "application/pdf";
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/** Create a GCS Storage client */
async function getGcsStorage() {
  const { Storage } = await import("@google-cloud/storage");
  const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64Key) {
    const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
    return new Storage({ credentials: creds, projectId: creds.project_id });
  }
  return new Storage();
}

/** Generate a presigned upload URL for a file */
async function presignUpload(filename: string, gcsPrefix: string): Promise<{ bucket: string; key: string; url: string }> {
  const storage = await getGcsStorage();
  const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
  const safeName = filename.replace(/\//g, "_");
  const key = `${gcsPrefix}/${Date.now()}-${safeName}`;
  const ext = filename.split(".").pop()?.toLowerCase();
  const contentType = contentTypeForExt(ext);

  const [url] = await storage.bucket(bucket).file(key).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 30 * 60 * 1000, // 30 minutes
    contentType,
  });
  return { bucket, key, url };
}

/**
 * POST /api/pilot/bulletins — create a bulletin (admin only)
 * JSON body: { title, summary?, category, video_filename?, doc_filename? }
 *
 * Returns presigned GCS upload URLs for video and/or document if filenames provided.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { title?: string; summary?: string; category?: string; video_filename?: string; doc_filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  const summary = body.summary?.trim() || null;
  const category = body.category?.trim();
  const videoFilename = body.video_filename?.trim() || null;
  const docFilename = body.doc_filename?.trim() || null;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  let videoGcsBucket: string | null = null;
  let videoGcsKey: string | null = null;
  let uploadUrl: string | null = null;

  // Generate presigned upload URL if video will be attached
  if (videoFilename) {
    try {
      const result = await presignUpload(videoFilename, `pilot-bulletins/${category}`);
      videoGcsBucket = result.bucket;
      videoGcsKey = result.key;
      uploadUrl = result.url;
    } catch (err) {
      console.error("[pilot/bulletins] video presign error:", err);
      return NextResponse.json({ error: `Failed to prepare video upload: ${err instanceof Error ? err.message : err}` }, { status: 500 });
    }
  }

  let docGcsBucket: string | null = null;
  let docGcsKey: string | null = null;
  let docUploadUrl: string | null = null;

  // Generate presigned upload URL if document/image will be attached
  if (docFilename) {
    try {
      const result = await presignUpload(docFilename, `pilot-bulletins/${category}/docs`);
      docGcsBucket = result.bucket;
      docGcsKey = result.key;
      docUploadUrl = result.url;
    } catch (err) {
      console.error("[pilot/bulletins] doc presign error:", err);
      return NextResponse.json({ error: `Failed to prepare document upload: ${err instanceof Error ? err.message : err}` }, { status: 500 });
    }
  }

  // Insert into database
  const supa = createServiceClient();
  const { data: bulletin, error: dbErr } = await supa
    .from("pilot_bulletins")
    .insert({
      title,
      summary,
      category,
      created_by: auth.userId,
      video_gcs_bucket: videoGcsBucket,
      video_gcs_key: videoGcsKey,
      video_filename: videoFilename,
      doc_gcs_bucket: docGcsBucket,
      doc_gcs_key: docGcsKey,
      doc_filename: docFilename,
    })
    .select("id, title, summary, category, published_at, video_filename, doc_filename")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins] insert error:", dbErr);
    return NextResponse.json({ error: `Failed to create bulletin: ${dbErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ bulletin, upload_url: uploadUrl, doc_upload_url: docUploadUrl }, { status: 201 });
}
