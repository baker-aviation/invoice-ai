import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/pilot/bulletins/[id]/download — redirect to signed GCS URL for the video
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
    .select("video_gcs_bucket, video_gcs_key, video_filename")
    .eq("id", bulletinId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  if (!data.video_gcs_bucket || !data.video_gcs_key) {
    return NextResponse.json({ error: "No video attached to this bulletin" }, { status: 404 });
  }

  const signedUrl = await signGcsUrl(data.video_gcs_bucket, data.video_gcs_key);
  if (!signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.redirect(signedUrl);
}
