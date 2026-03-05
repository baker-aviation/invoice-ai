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
    .select("id, title, summary, category, published_at, video_filename, created_at")
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

/**
 * POST /api/pilot/bulletins — create a bulletin (admin only)
 * JSON body: { title, summary?, category, video_filename? }
 *
 * If video_filename is provided, returns a presigned GCS upload URL
 * for the client to upload the video directly.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { title?: string; summary?: string; category?: string; video_filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = body.title?.trim();
  const summary = body.summary?.trim() || null;
  const category = body.category?.trim();
  const videoFilename = body.video_filename?.trim() || null;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  let gcsBucket: string | null = null;
  let gcsKey: string | null = null;
  let uploadUrl: string | null = null;

  // Generate presigned upload URL if video will be attached
  if (videoFilename) {
    try {
      const { Storage } = await import("@google-cloud/storage");
      let storage: InstanceType<typeof Storage>;

      const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
      if (b64Key) {
        const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
        storage = new Storage({ credentials: creds, projectId: creds.project_id });
      } else {
        storage = new Storage();
      }

      gcsBucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const safeName = videoFilename.replace(/\//g, "_");
      const ts = Date.now();
      gcsKey = `pilot-bulletins/${category}/${ts}-${safeName}`;

      const ext = videoFilename.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "mp4" ? "video/mp4"
        : ext === "m4v" ? "video/x-m4v"
        : "video/quicktime";

      const [url] = await storage.bucket(gcsBucket).file(gcsKey).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 30 * 60 * 1000, // 30 minutes
        contentType,
      });
      uploadUrl = url;
    } catch (err) {
      console.error("[pilot/bulletins] presign error:", err);
      return NextResponse.json({ error: "Failed to prepare video upload" }, { status: 500 });
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
      video_gcs_bucket: gcsBucket,
      video_gcs_key: gcsKey,
      video_filename: videoFilename,
    })
    .select("id, title, summary, category, published_at, video_filename")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins] insert error:", dbErr);
    return NextResponse.json({ error: "Failed to create bulletin" }, { status: 500 });
  }

  return NextResponse.json({ bulletin, upload_url: uploadUrl }, { status: 201 });
}
