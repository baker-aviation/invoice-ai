import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { presignUpload } from "@/lib/gcs-upload";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/pilot/bulletins/[id] — single bulletin with attachments
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
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
    .select("*, pilot_bulletin_attachments(id, filename, content_type, gcs_bucket, gcs_key, sort_order)")
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
 *
 * Attachments are managed via the /attachments sub-route.
 */
export async function PATCH(req: NextRequest, { params }: RouteCtx) {
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
  const cat = (updates.category as string) || "general";

  if (videoFilename) {
    try {
      const result = await presignUpload(videoFilename, `pilot-bulletins/${cat}`);
      uploadUrl = result.url;
      updates.video_gcs_bucket = result.bucket;
      updates.video_gcs_key = result.key;
      updates.video_filename = videoFilename;
    } catch (err) {
      console.error("[pilot/bulletins] video presign error:", err);
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
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
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
