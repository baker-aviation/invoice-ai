import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/bulletins/[id] — single bulletin
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_bulletins")
    .select("*")
    .eq("id", bulletinId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  return NextResponse.json({ bulletin: data });
}

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

/**
 * PATCH /api/pilot/bulletins/[id] — update a bulletin (admin only)
 * JSON body: { title?, summary?, category?, video_filename? }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  let body: { title?: string; summary?: string; category?: string; video_filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) {
      return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    }
    updates.title = title;
  }

  if (body.summary !== undefined) {
    updates.summary = body.summary.trim() || null;
  }

  if (body.category !== undefined) {
    const category = body.category.trim();
    if (!CATEGORY_LABELS[category]) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    updates.category = category;
  }

  let uploadUrl: string | null = null;
  const videoFilename = body.video_filename?.trim() || null;

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

      const gcsBucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const safeName = videoFilename.replace(/\//g, "_");
      const ts = Date.now();
      const cat = (updates.category as string) || "general";
      const gcsKey = `pilot-bulletins/${cat}/${ts}-${safeName}`;

      const ext = videoFilename.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "mp4" ? "video/mp4"
        : ext === "m4v" ? "video/x-m4v"
        : "video/quicktime";

      const [url] = await storage.bucket(gcsBucket).file(gcsKey).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 30 * 60 * 1000,
        contentType,
      });
      uploadUrl = url;

      updates.video_gcs_bucket = gcsBucket;
      updates.video_gcs_key = gcsKey;
      updates.video_filename = videoFilename;
    } catch (err) {
      console.error("[pilot/bulletins] presign error:", err);
      return NextResponse.json({ error: `Failed to prepare video upload: ${err instanceof Error ? err.message : err}` }, { status: 500 });
    }
  }

  if (Object.keys(updates).length === 0 && !uploadUrl) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: bulletin, error: dbErr } = await supa
    .from("pilot_bulletins")
    .update(updates)
    .eq("id", bulletinId)
    .select("*")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins] update error:", dbErr);
    return NextResponse.json({ error: `Failed to update bulletin: ${dbErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ bulletin, upload_url: uploadUrl });
}

/**
 * DELETE /api/pilot/bulletins/[id] — delete a bulletin (admin only)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("pilot_bulletins")
    .delete()
    .eq("id", bulletinId);

  if (error) {
    console.error("[pilot/bulletins] delete error:", error);
    return NextResponse.json({ error: "Failed to delete bulletin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
