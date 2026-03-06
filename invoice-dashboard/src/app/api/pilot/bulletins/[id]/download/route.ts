import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/pilot/bulletins/[id]/download — redirect to signed GCS URL
 *
 * ?attachment_id=N  → attachment from pilot_bulletin_attachments
 * ?type=doc         → legacy: old doc_* columns on bulletin
 * (default)         → video attachment
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

  const attachmentId = req.nextUrl.searchParams.get("attachment_id");
  const type = req.nextUrl.searchParams.get("type");

  const supa = createServiceClient();

  // New path: download a specific attachment by ID
  if (attachmentId) {
    const aid = Number(attachmentId);
    if (!aid || isNaN(aid)) {
      return NextResponse.json({ error: "Invalid attachment_id" }, { status: 400 });
    }

    const { data, error } = await supa
      .from("pilot_bulletin_attachments")
      .select("gcs_bucket, gcs_key")
      .eq("id", aid)
      .eq("bulletin_id", bulletinId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    const signedUrl = await signGcsUrl(data.gcs_bucket, data.gcs_key);
    if (!signedUrl) {
      return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
    }
    return NextResponse.redirect(signedUrl);
  }

  // Legacy path: video or doc_* columns
  const isDoc = type === "doc";

  const { data, error } = await supa
    .from("pilot_bulletins")
    .select("video_gcs_bucket, video_gcs_key, video_filename, doc_gcs_bucket, doc_gcs_key, doc_filename")
    .eq("id", bulletinId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  const bucket = isDoc ? data.doc_gcs_bucket : data.video_gcs_bucket;
  const key = isDoc ? data.doc_gcs_key : data.video_gcs_key;
  const label = isDoc ? "document" : "video";

  if (!bucket || !key) {
    return NextResponse.json({ error: `No ${label} attached to this bulletin` }, { status: 404 });
  }

  const signedUrl = await signGcsUrl(bucket, key);
  if (!signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.redirect(signedUrl);
}
