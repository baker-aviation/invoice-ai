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
 * Multipart form: title, summary, category, video (optional .mov file)
 * Uploads video to GCS and posts summary to #pilots Slack channel.
 */
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

  const title = (formData.get("title") as string)?.trim();
  const summary = (formData.get("summary") as string)?.trim() || null;
  const category = (formData.get("category") as string)?.trim();
  const file = formData.get("video") as File | null;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!category || !CATEGORY_LABELS[category]) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  let gcsBucket: string | null = null;
  let gcsKey: string | null = null;
  let videoFilename: string | null = null;

  // Upload .mov video to GCS if provided
  if (file) {
    if (!file.name.match(/\.(mov|mp4|m4v)$/i)) {
      return NextResponse.json({ error: "Only .mov, .mp4, and .m4v video files are allowed" }, { status: 400 });
    }
    if (file.size > 500 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 400 });
    }

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
      const bucket = storage.bucket(gcsBucket);

      const safeName = file.name.replace(/\//g, "_");
      const ts = Date.now();
      gcsKey = `pilot-bulletins/${category}/${ts}-${safeName}`;
      videoFilename = file.name;

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const blob = bucket.file(gcsKey);
      await blob.save(buffer, {
        contentType: file.type || "video/quicktime",
      });
    } catch (err) {
      console.error("[pilot/bulletins] GCS upload error:", err);
      return NextResponse.json({ error: "Failed to upload video" }, { status: 500 });
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

  return NextResponse.json({ bulletin }, { status: 201 });
}
